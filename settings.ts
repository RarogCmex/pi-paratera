/**
 * In-pi settings for the PARATERA MaaS provider.
 *
 * Pattern follows pi-volcengine: a small JSON store under pi's agent config
 * dir (`getAgentDir()`: $PI_CODING_AGENT_DIR, else ~/.pi/agent), a single
 * `/paratera` slash command with a subcommand tree + pure autocomplete, and
 * pure payload helpers that index.ts wires into `before_provider_request`.
 *
 * Store file: <agentDir>/paratera.json  (default ~/.pi/agent/paratera.json)
 *   { "version": 1, "cacheRetention": "long" | "short",
 *     "baseUrl": "https://…/v1", "updatedAt": "..." }
 *
 * `baseUrl` is a persisted endpoint override: $PARATERA_BASE_URL env wins over
 * it, the built-in DEFAULT_BASE_URL applies when neither is set. Unlike
 * volcengine (per-subscription gateway ids) paratera publishes one shared
 * endpoint, so the shipped default is a REAL working URL and the override
 * exists for private/dedicated deployments and mirrors.
 *
 * `cacheRetention: "long"` makes the payload hook inject
 * `prompt_cache_retention: "24h"` (+ `prompt_cache_key` on chat routes) for
 * verified models — without requiring the global PI_CACHE_RETENTION=long env
 * var. If pi already sent the field (env long), the hook is a no-op.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// settings store
// ---------------------------------------------------------------------------

export type CacheRetentionMode = "long" | "short";

export interface ParateraSettings {
	version: 1;
	cacheRetention: CacheRetentionMode;
	/** Persisted endpoint override; undefined = built-in default. */
	baseUrl?: string;
	/** Measured output caps per model id, from the free pre-inference probe
	 *  (`/paratera models probe`): applied over family defaults for unknown
	 *  ids on every catalog merge, so a probed cap survives refreshes and
	 *  restarts. Entries below 1024 are treated as junk and dropped. */
	maxTokens?: Record<string, number>;
	updatedAt?: string;
}

export const SETTINGS_FILE_NAME = "paratera.json";
export const DEFAULT_SETTINGS: ParateraSettings = { version: 1, cacheRetention: "short" };

/** Agent config dir from the host, so $PI_CODING_AGENT_DIR and rebranded
 *  distributions (custom CONFIG_DIR_NAME) are honored instead of a hardcoded
 *  `~/.pi/agent`. Resolved per call (default parameter), not at import time. */
export function settingsPath(baseDir: string = getAgentDir()): string {
	return join(baseDir, SETTINGS_FILE_NAME);
}

/** Missing/corrupt/foreign-version files degrade to defaults — a broken
 *  settings file must never break pi startup. */
export function loadSettings(file: string = settingsPath()): ParateraSettings {
	try {
		if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ParateraSettings> | null;
		if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return { ...DEFAULT_SETTINGS };
		const baseUrl = typeof parsed.baseUrl === "string" ? normalizeBaseUrl(parsed.baseUrl) : undefined;
		const maxTokens: Record<string, number> = {};
		if (parsed.maxTokens && typeof parsed.maxTokens === "object") {
			for (const [id, value] of Object.entries(parsed.maxTokens)) {
				if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1024) {
					maxTokens[id] = value;
				}
			}
		}
		return {
			version: 1,
			cacheRetention: parsed.cacheRetention === "long" ? "long" : "short",
			...(baseUrl ? { baseUrl } : {}),
			...(Object.keys(maxTokens).length ? { maxTokens } : {}),
			...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/**
 * Validates + normalizes a candidate endpoint URL: http(s) only, no inner
 * whitespace, parseable, trailing slashes stripped. Returns undefined when
 * the value is unusable (same "never trust stored junk" stance as the store).
 */
export function normalizeBaseUrl(value: string | undefined | null): string | undefined {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return undefined;
	if (!/^https?:\/\//i.test(trimmed)) return undefined;
	if (/\s/.test(trimmed)) return undefined;
	try {
		new URL(trimmed);
	} catch {
		return undefined;
	}
	return trimmed.replace(/\/+$/, "");
}

export function saveSettings(
	patch: {
		cacheRetention?: CacheRetentionMode;
		baseUrl?: string | null;
		/** Merged into the stored map (never clears it — junk is filtered on load). */
		maxTokens?: Record<string, number>;
	},
	file: string = settingsPath(),
): ParateraSettings {
	const current = loadSettings(file);
	let baseUrl = current.baseUrl;
	if (patch.baseUrl === null) {
		baseUrl = undefined; // explicit clear (`url reset`)
	} else if (patch.baseUrl !== undefined) {
		baseUrl = normalizeBaseUrl(patch.baseUrl) ?? baseUrl;
	}
	const maxTokens = { ...current.maxTokens, ...patch.maxTokens };
	const next: ParateraSettings = {
		version: 1,
		cacheRetention: patch.cacheRetention ?? current.cacheRetention,
		...(baseUrl ? { baseUrl } : {}),
		...(Object.keys(maxTokens).length ? { maxTokens } : {}),
		updatedAt: new Date().toISOString(),
	};
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

/**
 * Platform-correct shell snippet for exporting an env var, used in user-facing
 * hints. win32 → PowerShell (`$env:NAME="value"`); elsewhere → POSIX `export`.
 * Pure: `platform` is injectable for tests.
 */
export function envSetHint(name: string, value: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? `$env:${name}="${value}"` : `export ${name}=${value}`;
}

/** `cache` subcommand argument parsing: on/long/24h → long, off/short → short. */
export function parseCacheArg(arg: string | undefined): CacheRetentionMode | "status" | undefined {
	const value = (arg ?? "").trim().toLowerCase();
	if (value === "" || value === "status") return "status";
	if (["on", "long", "24h", "enable", "enabled", "true"].includes(value)) return "long";
	if (["off", "short", "default", "disable", "disabled", "false"].includes(value)) return "short";
	return undefined;
}

// ---------------------------------------------------------------------------
// cache-retention payload injection (pure)
// ---------------------------------------------------------------------------

/** OpenAI-family prompt_cache_key length cap (pi-ai clamps the same way). */
export const MAX_CACHE_KEY_LENGTH = 64;

export function clampCacheKey(value: string): string {
	return value.length > MAX_CACHE_KEY_LENGTH ? value.slice(0, MAX_CACHE_KEY_LENGTH) : value;
}

export interface CacheRetentionOptions {
	/** Effective long-retention preference (settings or PI_CACHE_RETENTION=long). */
	enabled: boolean;
	/** Model ids whose routes accepted prompt_cache_retention (probe 2026-09-19). */
	supportedModels: ReadonlySet<string>;
	/** pi session id — becomes prompt_cache_key on chat routes (pi only sends
	 *  it there under its own long mode). */
	sessionId?: string;
}

/**
 * Adds `prompt_cache_retention:"24h"` to a payload when the setting is on, the
 * model is verified, and pi has not already sent the field. Chat payloads also
 * gain `prompt_cache_key` (clamped session id) because pi-ai omits it there
 * outside its own long mode.
 * Returns the replacement payload, or undefined to keep the original.
 */
export function applyCacheRetention(payload: unknown, options: CacheRetentionOptions): unknown {
	if (!options.enabled) return undefined;
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as Record<string, unknown>;
	if (typeof p.model !== "string" || !options.supportedModels.has(p.model)) return undefined;
	if (p.prompt_cache_retention !== undefined) return undefined; // pi already sent it
	const isResponses = p.input !== undefined && p.store === false;
	const isChat = p.messages !== undefined;
	if (!isResponses && !isChat) return undefined;
	const next: Record<string, unknown> = { ...p, prompt_cache_retention: "24h" };
	if (isChat && next.prompt_cache_key === undefined && options.sessionId) {
		next.prompt_cache_key = clampCacheKey(options.sessionId);
	}
	return next;
}

// ---------------------------------------------------------------------------
// /paratera command catalog + autocomplete
// ---------------------------------------------------------------------------

export interface CommandArg {
	name: string;
	description: string;
}

export interface CommandSpec {
	name: string;
	description: string;
	args?: readonly CommandArg[];
}

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

export function parateraCommands(): CommandSpec[] {
	return [
		{
			name: "status",
			description: "Base URL, key source, cache mode, catalog size, current model",
		},
		{
			name: "cache",
			description: "24h prompt-cache retention for verified routes (persisted)",
			args: [
				{ name: "on", description: "Inject prompt_cache_retention:24h on supported models" },
				{ name: "off", description: "Only pi's default caching (PI_CACHE_RETENTION still applies)" },
				{ name: "status", description: "Show current cache mode and supported routes" },
			],
		},
		{
			name: "url",
			description: "Endpoint URL override: probe and persist a custom gateway base URL",
			args: [
				{ name: "status", description: "Effective endpoint + source (env/settings/default)" },
				{ name: "set", description: "Probe, then persist a custom base URL (bare `set` prompts in the TUI)" },
				{ name: "check", description: "Probe a URL (or the effective one) without saving" },
				{ name: "reset", description: "Clear the saved override" },
			],
		},
		{
			name: "keys",
			description: "API key tools",
			args: [{ name: "check", description: "Validate the resolved key against the gateway (zero inference)" }],
		},
		{
			name: "models",
			description: "Model catalog tools",
			args: [
				{ name: "refresh", description: "Force GET /v1/models refresh and persist the overlay" },
				{
					name: "probe <id>",
					description: "Output-cap probe of one model (free when rejected pre-inference; an uncapped model generates a billed completion)",
				},
			],
		},
		{
			name: "transport",
			description: "Transparent connect-retry for the flaky China-hosted endpoint",
			args: [
				{ name: "status", description: "Dispatcher install state + last retried connect error" },
				{ name: "off", description: "Disable retries now (persist via PARATERA_TRANSPORT_RETRY=off)" },
				{ name: "on", description: "Re-enable retries (removes the session kill-switch)" },
			],
		},
	];
}

function item(value: string, label: string, description: string): CompletionItem {
	return { value, label, description };
}

/** `cache [on|off|status]` */
export function argsHint(command: CommandSpec): string {
	if (!command.args?.length) return "";
	return ` [${command.args.map((a) => a.name).join("|")}]`;
}

/** `cache [on|off|status] — …` for usage lines. */
export function formatCommandLine(command: CommandSpec): string {
	return `${command.name}${argsHint(command)} — ${command.description}`;
}

/**
 * Argument autocomplete for `/paratera` (TUI CombinedAutocompleteProvider
 * contract: `prefix` is the text after the command name, a chosen `value`
 * replaces it whole — hence nested values are `"cache on"`, not `"on"`).
 */
export function completeArgs(prefix: string, commands: readonly CommandSpec[]): CompletionItem[] | null {
	const text = prefix.trimStart();
	const space = text.indexOf(" ");
	if (space === -1) {
		if (text.length > 0) {
			const exact = commands.find((c) => c.name === text);
			if (exact?.args?.length) {
				const nested = exact.args.map((a) => item(`${exact.name} ${a.name}`, a.name, a.description));
				return nested.length > 0 ? nested : null;
			}
		}
		const items = commands
			.filter((c) => c.name.startsWith(text))
			.map((c) => item(`${c.name} `, `${c.name}${argsHint(c)}`, c.description));
		return items.length > 0 ? items : null;
	}

	const name = text.slice(0, space);
	const rest = text.slice(space).trimStart();
	if (rest.includes(" ")) return null;

	const command = commands.find((c) => c.name === name);
	if (!command?.args?.length) return null;

	const items = command.args
		.filter((a) => a.name.startsWith(rest))
		.map((a) => item(`${name} ${a.name}`, a.name, a.description));
	return items.length > 0 ? items : null;
}

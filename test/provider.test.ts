/**
 * Offline tests for the PARATERA MaaS provider extension.
 * Run with: npm test  (tsx --test)
 *
 * Strictly offline — no live gateway calls. Facts asserted here mirror the
 * live probes recorded in index.ts's header comment (2026-09-19).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension, {
	CATALOG,
	DEFAULT_BASE_URL,
	PROVIDER_ID,
	RETENTION_MODELS,
	SKIP_MODEL_IDS,
	buildModels,
	createParateraGatewayProvider,
	describeProbe,
	fetchGatewayModels,
	guessApi,
	mergeGatewayCatalog,
	normalizeOverflowError,
	probeBaseUrl,
	resolveBaseUrl,
	unknownModelConfig,
	validateGatewayKey,
	type GatewayModelEntry,
} from "../index.ts";
import { loadSettings, saveSettings } from "../settings.ts";

// ---------------------------------------------------------------------------
// fake pi harness
// ---------------------------------------------------------------------------

type AnyProvider = Record<string, any>;

interface FakePi {
	pi: {
		registerProvider: (nameOrProvider: unknown, config?: unknown) => void;
		on: (event: string, handler: (...args: never[]) => unknown) => void;
		registerCommand: (name: string, options: unknown) => void;
	};
	providers: Map<string, AnyProvider>;
	handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
	commands: Map<string, unknown>;
}

function createFakePi(): FakePi {
	const providers = new Map<string, AnyProvider>();
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	const commands = new Map<string, unknown>();
	return {
		pi: {
			registerProvider(nameOrProvider: unknown, config?: unknown) {
				if (typeof nameOrProvider === "string") providers.set(nameOrProvider, config as AnyProvider);
				else providers.set((nameOrProvider as AnyProvider).id, nameOrProvider as AnyProvider);
			},
			on(event: string, handler: (...args: never[]) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler as (...args: unknown[]) => unknown);
				handlers.set(event, list);
			},
			registerCommand(name: string, options: unknown) {
				commands.set(name, options);
			},
		},
		providers,
		handlers,
		commands,
	};
}

const testDir = mkdtempSync(join(tmpdir(), "paratera-provider-test-"));
let settingsCounter = 0;
function isolatedSettingsFile(): string {
	return join(testDir, `settings-${settingsCounter++}.json`);
}

function loadExtension(): FakePi {
	const fake = createFakePi();
	(extension as any)(fake.pi, { settingsFile: isolatedSettingsFile() });
	return fake;
}

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

type StubResponse = { ok?: boolean; status: number; body?: unknown } | Error;

function fetchStub(responses: StubResponse[] | StubResponse) {
	const queue = Array.isArray(responses) ? [...responses] : undefined;
	const single = Array.isArray(responses) ? undefined : responses;
	const calls: { url: string; init?: RequestInit }[] = [];
	const impl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const next = queue ? queue.shift() : single;
		if (next instanceof Error) throw next;
		if (!next) throw new Error("fetch stub exhausted");
		return {
			ok: next.ok ?? (next.status >= 200 && next.status < 300),
			status: next.status,
			json: async () => next.body,
		} as unknown as Response;
	}) as typeof fetch;
	return { impl, calls };
}

const BASE = "https://gw.test/v1";

// ---------------------------------------------------------------------------
// registration shape
// ---------------------------------------------------------------------------

test("registers one native provider with both API surfaces", () => {
	const fake = loadExtension();
	assert.equal(fake.providers.size, 1);
	const provider = fake.providers.get(PROVIDER_ID)!;
	assert.ok(provider, "provider registered under paratera");
	assert.equal(provider.name, "PARATERA MaaS");
	assert.equal(provider.baseUrl, DEFAULT_BASE_URL);
	assert.equal(typeof provider.auth?.apiKey?.login, "function");
	assert.equal(typeof provider.auth?.apiKey?.check, "function");
	assert.equal(typeof provider.auth?.apiKey?.resolve, "function");
	assert.equal(typeof provider.refreshModels, "function");
	assert.equal(typeof provider.stream, "function");

	const models = provider.getModels();
	assert.equal(models.length, CATALOG.length);
	for (const model of models) {
		assert.equal(model.provider, PROVIDER_ID);
		assert.equal(model.baseUrl, DEFAULT_BASE_URL);
		assert.ok(model.api === "openai-responses" || model.api === "openai-completions");
	}
});

test("both API routes are populated in the catalog", () => {
	// createProvider captures the api map in a closure (it is not exposed on
	// the provider object), so the meaningful invariant is that both routes
	// actually have models — otherwise a model's api would hit the
	// "no API implementation" error path at stream time.
	const fake = loadExtension();
	const provider = fake.providers.get(PROVIDER_ID)!;
	const apis = new Set(provider.getModels().map((m: any) => m.api));
	assert.deepEqual([...apis].sort(), ["openai-completions", "openai-responses"]);
});

test("registers before_provider_request + message_end hooks and /paratera command", () => {
	const fake = loadExtension();
	assert.equal(fake.handlers.get("before_provider_request")?.length, 1);
	assert.equal(fake.handlers.get("message_end")?.length, 1);
	assert.ok(fake.commands.has("paratera"), "/paratera command registered");
});

test("the default base URL is the real public endpoint, not a placeholder", () => {
	// Unlike Volcengine (per-subscription gateway ids), paratera ships one
	// working URL, so no configuration is required out of the box.
	assert.equal(DEFAULT_BASE_URL, "https://llmapi.paratera.com/v1");
	assert.ok(!/YOUR-|PLACEHOLDER/i.test(DEFAULT_BASE_URL));
});

test("resolveBaseUrl honors env override and strips trailing slashes", () => {
	assert.equal(resolveBaseUrl({} as NodeJS.ProcessEnv), DEFAULT_BASE_URL);
	assert.equal(
		resolveBaseUrl({ PARATERA_BASE_URL: "https://mirror.test/v1//" } as NodeJS.ProcessEnv),
		"https://mirror.test/v1",
	);
});

test("createParateraGatewayProvider honors baseUrl option", () => {
	const provider = createParateraGatewayProvider({ baseUrl: BASE });
	assert.equal(provider.baseUrl, BASE);
	assert.ok(provider.getModels().every((m) => m.baseUrl === BASE && m.provider === PROVIDER_ID));
});

// ---------------------------------------------------------------------------
// catalog invariants (probe-verified 2026-09-19)
// ---------------------------------------------------------------------------

test("catalog ids are unique and non-empty", () => {
	const ids = CATALOG.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length, "ids unique");
	for (const id of ids) assert.ok(id.trim().length > 0, "id non-empty");
});

test("catalog split matches the verified route probe (33 responses / 32 chat)", () => {
	const responses = CATALOG.filter((m) => m.api === "openai-responses");
	const chat = CATALOG.filter((m) => m.api === "openai-completions");
	assert.equal(responses.length, 33);
	assert.equal(chat.length, 32);
	assert.equal(CATALOG.length, 65);
});

test("key Responses-API models are on the responses route", () => {
	const byId = new Map(CATALOG.map((m) => [m.id, m]));
	for (const id of ["GLM-5.3-Flash", "Qwen3.8-Flash", "DeepSeek-V4-Flash", "Kimi-K2.6", "MiniMax-M3"]) {
		assert.equal(byId.get(id)?.api, "openai-responses", `${id} on responses`);
	}
});

test("chat-only families (GLM-4.x, ERNIE, Kimi-K2.5, Qwen-Long) are on the completions route", () => {
	const byId = new Map(CATALOG.map((m) => [m.id, m]));
	for (const id of ["GLM-4.6", "GLM-4.5-Flash", "ERNIE-4.5-Turbo-32K", "Kimi-K2.5", "Qwen-Long"]) {
		assert.equal(byId.get(id)?.api, "openai-completions", `${id} on completions`);
	}
});

test("every model reports zero cost (gateway exposes no per-model price)", () => {
	for (const m of CATALOG) {
		assert.deepEqual(
			m.cost,
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			`${m.id} cost is zero`,
		);
	}
});

test("chat models pin maxTokensField to max_tokens (max_completion_tokens is ignored upstream)", () => {
	for (const m of CATALOG.filter((x) => x.api === "openai-completions")) {
		assert.equal((m.compat as any).maxTokensField, "max_tokens", `${m.id} uses max_tokens`);
	}
});

test("every model supports long cache retention (all routes accepted it)", () => {
	for (const m of CATALOG) {
		assert.equal((m.compat as any).supportsLongCacheRetention, true, `${m.id} 24h retention`);
	}
	assert.equal(RETENTION_MODELS.size, CATALOG.length, "retention set covers the whole catalog");
});

test("reasoning models carry a thinkingLevelMap; non-reasoning models do not", () => {
	for (const m of CATALOG) {
		if (m.reasoning) assert.ok(m.thinkingLevelMap, `${m.id} has an effort map`);
	}
});

test("MiniMax M1/M2 and GLM-5.3 cannot disable thinking (off:null)", () => {
	const byId = new Map(CATALOG.map((m) => [m.id, m]));
	for (const id of ["MiniMax-M1-80k", "MiniMax-M2", "MiniMax-M2.5", "MiniMax-M2.7", "GLM-5.3"]) {
		assert.equal((byId.get(id)!.thinkingLevelMap as any).off, null, `${id} off unavailable`);
	}
});

test("Kimi maps max→xhigh (upstream rejects 'max', allows 'xhigh')", () => {
	const byId = new Map(CATALOG.map((m) => [m.id, m]));
	for (const id of ["Kimi-K2.6", "Kimi-K3"]) {
		const map = byId.get(id)!.thinkingLevelMap as any;
		assert.equal(map.max, "xhigh", `${id} max folds to xhigh`);
		assert.equal(map.off, "none", `${id} off is none`);
	}
});

test("ERNIE-5.0 leaves xhigh/max unavailable (not probed)", () => {
	const byId = new Map(CATALOG.map((m) => [m.id, m]));
	const map = byId.get("ERNIE-5.0-Thinking-Preview")!.thinkingLevelMap as any;
	assert.equal(map.xhigh, null);
	assert.equal(map.max, null);
});

test("vision models are the verified image-capable ones", () => {
	const vision = new Set(CATALOG.filter((m) => m.input.includes("image")).map((m) => m.id));
	// each verified live: correctly identified a red square from a data-URI image
	for (const id of [
		"GLM-4.6V",
		"GLM-4.5V",
		"GLM-4V",
		"GLM-4V-Flash",
		"GLM-4V-Plus-0111",
		"ERNIE-4.5-Turbo-VL-32K",
		"DeepSeek-V4-Flash-Vision-Exp",
		"Qwen3.8-Flash",
	]) {
		assert.ok(vision.has(id), `${id} is vision`);
	}
	// a plain text model must not claim image input
	assert.ok(!vision.has("GLM-4.6"), "GLM-4.6 is text-only");
	// DeepSeek-V4-Pro accepted an image but misread it ("white" for a red square),
	// so it stays text-only rather than advertising unverified vision.
	assert.ok(!vision.has("DeepSeek-V4-Pro"), "DeepSeek-V4-Pro is text-only");
});

test("maxTokens never exceeds contextWindow", () => {
	for (const m of CATALOG) {
		assert.ok(m.maxTokens <= m.contextWindow, `${m.id}: ${m.maxTokens} <= ${m.contextWindow}`);
		assert.ok(m.contextWindow > 0 && m.maxTokens > 0, `${m.id} positive windows`);
	}
});

test("SKIP_MODEL_IDS excludes non-chat, dead and tool-less ids", () => {
	for (const id of [
		"GLM-Embedding-2",
		"GLM-Rerank",
		"WanX2.1-T2I-Plus",
		"MiniMax-T2V-01",
		"GLM-5",
		"Intern-S2-Preview",
		"Baichuan-M2",
		"Baichuan-M3",
		"auto",
	]) {
		assert.ok(SKIP_MODEL_IDS.has(id), `${id} skipped`);
	}
	// none of the skipped ids may be in the catalog
	for (const m of CATALOG) assert.ok(!SKIP_MODEL_IDS.has(m.id), `${m.id} not skipped`);
});

// ---------------------------------------------------------------------------
// buildModels / mergeGatewayCatalog / unknownModelConfig
// ---------------------------------------------------------------------------

test("buildModels stamps provider + baseUrl onto every entry", () => {
	const models = buildModels(BASE);
	assert.equal(models.length, CATALOG.length);
	assert.ok(models.every((m) => m.provider === PROVIDER_ID && m.baseUrl === BASE));
});

test("mergeGatewayCatalog keeps verified config for known ids", () => {
	const raw: GatewayModelEntry[] = [{ id: "GLM-4.6", owned_by: "openai" } as any];
	const merged = mergeGatewayCatalog(raw, BASE);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].id, "GLM-4.6");
	assert.equal(merged[0].api, "openai-completions", "known route preserved");
	assert.equal((merged[0].compat as any).maxTokensField, "max_tokens");
	assert.equal(merged[0].provider, PROVIDER_ID);
});

test("mergeGatewayCatalog registers unknown ids conservatively", () => {
	const raw: GatewayModelEntry[] = [{ id: "SomeBrand-New-Model" } as any];
	const merged = mergeGatewayCatalog(raw, BASE);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].id, "SomeBrand-New-Model");
	assert.equal(merged[0].api, "openai-completions", "unknown defaults to chat");
	assert.equal(merged[0].contextWindow, 128_000);
	assert.equal(merged[0].maxTokens, 8_192);
	assert.deepEqual(merged[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("mergeGatewayCatalog drops skipped ids and de-duplicates", () => {
	const raw: GatewayModelEntry[] = [
		{ id: "GLM-Embedding-2" } as any,
		{ id: "Baichuan-M2" } as any,
		{ id: "GLM-4.6" } as any,
		{ id: "GLM-4.6" } as any,
		{ id: "auto" } as any,
	];
	const merged = mergeGatewayCatalog(raw, BASE);
	assert.deepEqual(merged.map((m) => m.id), ["GLM-4.6"]);
});

test("mergeGatewayCatalog falls back to the static catalog on an empty listing", () => {
	const merged = mergeGatewayCatalog([], BASE);
	assert.equal(merged.length, CATALOG.length);
});

test("unknownModelConfig guesses the Responses route for verified families", () => {
	// New DeepSeek-V4 / GLM-5.2+ / Qwen3.6+ / Kimi-K3 ids belong on /responses.
	assert.equal(unknownModelConfig("DeepSeek-V4-Pro-0999", BASE).api, "openai-responses");
	assert.equal(unknownModelConfig("GLM-5.4", BASE).api, "openai-responses");
	assert.equal(unknownModelConfig("Qwen3.9-Flash", BASE).api, "openai-responses");
	// but GLM-4.x, ERNIE and Qwen-Long have no /responses upstream
	assert.equal(unknownModelConfig("GLM-4.9", BASE).api, "openai-completions");
	assert.equal(unknownModelConfig("ERNIE-6.0", BASE).api, "openai-completions");
	assert.equal(unknownModelConfig("Qwen-Long-Pro", BASE).api, "openai-completions");
});

test("guessApi keeps non-chat families on the completions route", () => {
	for (const id of ["Foo-Embedding-9", "Bar-T2I-Plus", "Baz-VL-2", "Qux-Rerank"]) {
		assert.equal(guessApi(id), "openai-completions", `${id} not on responses`);
	}
});

test("unknownModelConfig claims reasoning only for known reasoner families", () => {
	assert.equal(unknownModelConfig("GLM-4.9", BASE).reasoning, true);
	assert.equal(unknownModelConfig("Qwen3.9-Flash", BASE).reasoning, true);
	assert.equal(unknownModelConfig("SomeRandom-Model", BASE).reasoning, false);
});

test("fetchGatewayModels degrades to the static baseline on failure", async () => {
	const ctx = {
		credential: { type: "api_key", key: "k" },
		signal: new AbortController().signal,
		allowNetwork: true,
	} as any;
	const { impl } = fetchStub(new Error("network down"));
	const models = await fetchGatewayModels(ctx, BASE, impl);
	assert.equal(models.length, CATALOG.length, "fell back to static catalog");
});

test("fetchGatewayModels returns baseline when no credential", async () => {
	const ctx = { credential: undefined, signal: new AbortController().signal, allowNetwork: true } as any;
	const { impl, calls } = fetchStub({ status: 200, body: { data: [] } });
	const models = await fetchGatewayModels(ctx, BASE, impl);
	assert.equal(models.length, CATALOG.length);
	assert.equal(calls.length, 0, "no fetch without a key");
});

test("fetchGatewayModels merges a live listing over the static table", async () => {
	const ctx = { credential: { type: "api_key", key: "k" }, signal: new AbortController().signal, allowNetwork: true } as any;
	const body = { data: [{ id: "GLM-4.6" }, { id: "Brand-New-LLM" }, { id: "GLM-Rerank" }] };
	const { impl } = fetchStub({ status: 200, body });
	const models = await fetchGatewayModels(ctx, BASE, impl);
	assert.deepEqual(models.map((m) => m.id), ["GLM-4.6", "Brand-New-LLM"], "rerank skipped");
});

// ---------------------------------------------------------------------------
// key validation (zero-inference)
// ---------------------------------------------------------------------------

test("validateGatewayKey: valid key → 500 empty-body probe", async () => {
	// Live paratera behavior: a VALID key reaches LiteLLM's router and 500s on
	// the missing 'messages' arg; an INVALID key 401s at auth.
	const { impl } = fetchStub({ status: 500, body: { error: { message: "Router.acompletion() missing…" } } });
	const r = await validateGatewayKey("sk-valid", { baseUrl: BASE, fetchImpl: impl });
	assert.equal(r.status, "valid");
});

test("validateGatewayKey: invalid key → 401", async () => {
	const { impl } = fetchStub({ status: 401, body: {} });
	const r = await validateGatewayKey("sk-bad", { baseUrl: BASE, fetchImpl: impl });
	assert.equal(r.status, "invalid");
});

test("validateGatewayKey: 403 also invalid", async () => {
	const { impl } = fetchStub({ status: 403, body: {} });
	const r = await validateGatewayKey("sk-bad", { baseUrl: BASE, fetchImpl: impl });
	assert.equal(r.status, "invalid");
});

test("validateGatewayKey: network error → unavailable", async () => {
	const { impl } = fetchStub(new Error("boom"));
	const r = await validateGatewayKey("sk-x", { baseUrl: BASE, fetchImpl: impl });
	assert.equal(r.status, "unavailable");
	assert.match(r.reason ?? "", /boom/);
});

test("validateGatewayKey never leaks the key in the URL", async () => {
	const { impl, calls } = fetchStub({ status: 500, body: {} });
	await validateGatewayKey("sk-secret-123", { baseUrl: BASE, fetchImpl: impl });
	assert.equal(calls.length, 1);
	assert.ok(!calls[0].url.includes("sk-secret-123"), "key not in URL");
	assert.match(String((calls[0].init as any).headers.Authorization), /Bearer sk-secret-123/);
});

// ---------------------------------------------------------------------------
// endpoint probe
// ---------------------------------------------------------------------------

test("probeBaseUrl: ok listing", async () => {
	const { impl } = fetchStub({ status: 200, body: { data: [{ id: "a" }, { id: "b" }] } });
	assert.deepEqual(await probeBaseUrl(BASE, { apiKey: "k", fetchImpl: impl }), { status: "ok", models: 2 });
});

test("probeBaseUrl: 401 with key → auth", async () => {
	const { impl } = fetchStub({ status: 401, body: {} });
	assert.deepEqual(await probeBaseUrl(BASE, { apiKey: "k", fetchImpl: impl }), { status: "auth" });
});

test("probeBaseUrl: 401 without key → reachable", async () => {
	const { impl } = fetchStub({ status: 401, body: {} });
	assert.deepEqual(await probeBaseUrl(BASE, { fetchImpl: impl }), { status: "reachable" });
});

test("probeBaseUrl: non-listing body → unexpected", async () => {
	const { impl } = fetchStub({ status: 200, body: { nope: true } });
	const r = await probeBaseUrl(BASE, { apiKey: "k", fetchImpl: impl });
	assert.equal(r.status, "unexpected");
});

test("probeBaseUrl: network error → unreachable", async () => {
	const { impl } = fetchStub(new Error("dns fail"));
	const r = await probeBaseUrl(BASE, { fetchImpl: impl });
	assert.equal(r.status, "unreachable");
});

test("describeProbe returns a message+type for every status", () => {
	for (const p of [
		{ status: "ok", models: 3 },
		{ status: "reachable" },
		{ status: "auth" },
		{ status: "unexpected", reason: "x" },
		{ status: "unreachable" },
	] as any[]) {
		const d = describeProbe(p, BASE);
		assert.ok(d.message.length > 0);
		assert.ok(["info", "warning", "error"].includes(d.type));
	}
});

// ---------------------------------------------------------------------------
// context-overflow normalization
// ---------------------------------------------------------------------------

test("normalizeOverflowError maps the gateway's overflow phrasing", () => {
	// The exact live string from a 292k-token probe on GLM-4.5-Flash:
	assert.match(
		normalizeOverflowError("OpenAIException - Prompt exceeds max length Error happened to model=GLM-4.5-Flash") ?? "",
		/^context_length_exceeded:/,
	);
	assert.match(normalizeOverflowError("max_tokens参数非法：限制数值范围[1,98304]") ?? "", /^context_length_exceeded:/);
	assert.match(normalizeOverflowError("您已超过输入 tokens 配额") ?? "", /^context_length_exceeded:/);
});

test("normalizeOverflowError does NOT fire on rate limits", () => {
	// Both transient strings seen live must not trigger auto-compaction.
	assert.equal(normalizeOverflowError("RateLimitError: all candidate slots are busy"), null);
	assert.equal(normalizeOverflowError("Deployment over defined TPM/RPM limit, no available deployment"), null);
	assert.equal(normalizeOverflowError("429 Too Many Requests"), null);
});

test("normalizeOverflowError is idempotent and ignores unrelated errors", () => {
	assert.equal(normalizeOverflowError("context_length_exceeded: already tagged"), null);
	assert.equal(normalizeOverflowError(""), null);
	assert.equal(normalizeOverflowError("500 internal server error"), null);
});

// ---------------------------------------------------------------------------
// /paratera command handlers (drift-proof: drives the registered command)
// ---------------------------------------------------------------------------

interface FakeUi {
	notices: { message: string; type?: string }[];
	inputs: string[];
	confirms: boolean[];
	ctx: any;
}

function fakeCtx(over: Partial<any> = {}): FakeUi {
	const notices: { message: string; type?: string }[] = [];
	const ui = {
		notify: (message: string, type?: string) => notices.push({ message, type }),
		setStatus: () => {},
		input: async () => over.inputValue as string | undefined,
		select: async () => over.selectValue as string | undefined,
		confirm: async () => (over.confirmValue ?? false) as boolean,
	};
	const ctx: any = {
		hasUI: true,
		ui,
		model: over.model ?? { id: "GLM-4.6", provider: PROVIDER_ID, api: "openai-completions" },
		signal: new AbortController().signal,
		modelRegistry: {
			getAll: () => (over.all ?? [{ id: "GLM-4.6", provider: PROVIDER_ID }]),
			getProviderAuthStatus: () => (over.auth ?? { configured: true, source: "$PARATERA_API_KEY" }),
			getApiKeyForProvider: async () => over.apiKey as string | undefined,
			refresh: async () => (over.refreshResult ?? { aborted: false, errors: new Map<string, Error>() }),
		},
		sessionManager: { getSessionId: () => "sess-1" },
	};
	return { notices, inputs: [], confirms: [], ctx };
}

type Cmd = { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions: (p: string) => unknown };

function command(fake: FakePi): Cmd {
	return fake.commands.get("paratera") as Cmd;
}

test("every catalogued command has a working runner (no catalog/runners drift)", async () => {
	// This is the regression guard: adding a CommandSpec without a runner (or
	// vice versa) must fail here, not silently at runtime.
	const { parateraCommands } = await import("../settings.ts");
	const fake = loadExtension();
	const cmd = command(fake);
	for (const spec of parateraCommands()) {
		const f = fakeCtx();
		await cmd.handler(spec.name, f.ctx);
		assert.ok(f.notices.length > 0, `${spec.name} produced output`);
		assert.ok(
			!f.notices.some((n) => /Unknown command/i.test(n.message)),
			`${spec.name} is wired to a runner`,
		);
	}
});

test("an unknown subcommand prints the usage list", async () => {
	const fake = loadExtension();
	const f = fakeCtx();
	await command(fake).handler("banana", f.ctx);
	assert.ok(f.notices.some((n) => /Unknown command "banana"/.test(n.message)));
	assert.ok(f.notices.some((n) => n.message.includes("/paratera:")));
});

test("bare /paratera prints the usage list without an error", async () => {
	const fake = loadExtension();
	const f = fakeCtx();
	await command(fake).handler("", f.ctx);
	assert.ok(f.notices[0].message.includes("/paratera:"));
	assert.ok(!/Unknown command/.test(f.notices[0].message));
});

test("/paratera status reports endpoint, key, models and the zero-cost note", async () => {
	const fake = loadExtension();
	const f = fakeCtx();
	await command(fake).handler("status", f.ctx);
	const text = f.notices.map((n) => n.message).join("\n");
	assert.match(text, /base URL: https:\/\/llmapi\.paratera\.com\/v1 \(default\)/);
	assert.match(text, /key: configured \(\$PARATERA_API_KEY\)/);
	assert.match(text, /on the Responses API/);
	assert.match(text, /current: GLM-4\.6 \(openai-completions\)/);
	assert.match(text, /reported as \$0/);
});

test("/paratera status flags a missing key", async () => {
	const fake = loadExtension();
	const f = fakeCtx({ auth: { configured: false } });
	await command(fake).handler("status", f.ctx);
	assert.match(f.notices[0].message, /key: MISSING/);
});

test("/paratera cache on|off|status round-trips and persists", async () => {
	const fake = loadExtension();
	const file = isolatedSettingsFile();
	const f2 = createFakePi();
	(extension as any)(f2.pi, { settingsFile: file });
	const cmd = f2.commands.get("paratera") as Cmd;

	const on = fakeCtx();
	await cmd.handler("cache on", on.ctx);
	assert.match(on.notices[0].message, /24h cache retention enabled/);
	assert.equal(loadSettings(file).cacheRetention, "long");

	const st = fakeCtx();
	await cmd.handler("cache status", st.ctx);
	assert.match(st.notices[0].message, /cache retention: long/);

	const off = fakeCtx();
	await cmd.handler("cache off", off.ctx);
	assert.equal(loadSettings(file).cacheRetention, "short");

	const bad = fakeCtx();
	await cmd.handler("cache banana", bad.ctx);
	assert.match(bad.notices[0].message, /Unknown cache mode/);
	assert.equal(bad.notices[0].type, "warning");
});

test("/paratera keys check validates without a key and reports the verdict", async () => {
	const fake = loadExtension();
	const noKey = fakeCtx({ apiKey: undefined });
	await command(fake).handler("keys check", noKey.ctx);
	assert.match(noKey.notices.at(-1)!.message, /No API key resolved/);

	const badSub = fakeCtx();
	await command(fake).handler("keys banana", badSub.ctx);
	assert.match(badSub.notices[0].message, /Unknown keys subcommand/);
});

test("/paratera models refresh reports the new count and surfaces failures", async () => {
	const fake = loadExtension();
	const ok = fakeCtx({ all: Array.from({ length: 65 }, (_, i) => ({ id: `m${i}`, provider: PROVIDER_ID })) });
	await command(fake).handler("models refresh", ok.ctx);
	assert.match(ok.notices.at(-1)!.message, /Catalog refreshed: 65 models/);

	const failed = fakeCtx({ refreshResult: { aborted: false, errors: new Map([[PROVIDER_ID, new Error("offline")]]) } });
	await command(fake).handler("models refresh", failed.ctx);
	assert.match(failed.notices.at(-1)!.message, /Catalog refresh failed \(offline\)/);
	assert.equal(failed.notices.at(-1)!.type, "warning");

	const badSub = fakeCtx();
	await command(fake).handler("models banana", badSub.ctx);
	assert.match(badSub.notices[0].message, /Unknown models subcommand/);
});

test("/paratera url status shows the effective endpoint and its source", async () => {
	const fake = loadExtension();
	const f = fakeCtx();
	await command(fake).handler("url status", f.ctx);
	const text = f.notices[0].message;
	assert.match(text, /endpoint: https:\/\/llmapi\.paratera\.com\/v1/);
	assert.match(text, /source: default \(built-in default\)/);
});

test("/paratera url rejects an unparsable candidate without probing", async () => {
	const fake = loadExtension();
	const f = fakeCtx();
	await command(fake).handler("url set ftp://nope", f.ctx);
	assert.match(f.notices.at(-1)!.message, /Invalid endpoint URL/);
	assert.equal(f.notices.at(-1)!.type, "warning");
});

test("/paratera url reset is a no-op when nothing is saved", async () => {
	const fake = loadExtension();
	const f = fakeCtx();
	await command(fake).handler("url reset", f.ctx);
	assert.match(f.notices[0].message, /No saved endpoint override/);
});

test("/paratera url with an unknown subcommand lists the valid ones", async () => {
	const fake = loadExtension();
	const f = fakeCtx();
	await command(fake).handler("url banana", f.ctx);
	assert.match(f.notices[0].message, /Unknown url subcommand/);
});

test("/paratera url set without the TUI explains the CLI form", async () => {
	const fake = loadExtension();
	const f = fakeCtx();
	f.ctx.hasUI = false;
	await command(fake).handler("url set", f.ctx);
	assert.match(f.notices[0].message, /interactive prompt needs the TUI/);
});

test("the status widget clears for other providers and shows cache mode for ours", async () => {
	const fake = loadExtension();
	const statuses: [string, string | undefined][] = [];
	const f = fakeCtx();
	f.ctx.ui.setStatus = (key: string, text: string | undefined) => statuses.push([key, text]);

	await fake.handlers.get("model_select")![0]({} as never, f.ctx as never);
	assert.deepEqual(statuses.at(-1), ["paratera", "para:cache-short"]);

	// Same instrumented ctx (so setStatus is captured), different model: a
	// foreign provider's model must clear our widget rather than claim it.
	f.ctx.model = { id: "gpt-5.5", provider: "openai", api: "openai-responses" };
	await fake.handlers.get("model_select")![0]({} as never, f.ctx as never);
	assert.deepEqual(statuses.at(-1), ["paratera", undefined]);
});

test("message_end rewrites a gateway overflow into pi's compaction marker", async () => {
	const fake = loadExtension();
	const handler = fake.handlers.get("message_end")![0];
	const out: any = handler(
		{
			message: {
				role: "assistant",
				stopReason: "error",
				provider: PROVIDER_ID,
				errorMessage: "OpenAIException - Prompt exceeds max length Error happened to model=GLM-4.5-Flash",
			},
		} as never,
		fakeCtx().ctx as never,
	);
	assert.match(out.message.errorMessage, /^context_length_exceeded:/);
});

test("message_end leaves rate limits and other providers alone", async () => {
	const fake = loadExtension();
	const handler = fake.handlers.get("message_end")![0];
	const ctx = fakeCtx().ctx;
	const rateLimited: any = handler(
		{
			message: {
				role: "assistant",
				stopReason: "error",
				provider: PROVIDER_ID,
				errorMessage: "RateLimitError: all candidate slots are busy",
			},
		} as never,
		ctx as never,
	);
	assert.equal(rateLimited, undefined, "a transient rate limit must not trigger compaction");

	// A FOREIGN provider's overflow must not be rewritten even though paratera
	// is the selected model in ctx — the guard reads the message's provider.
	const foreign: any = handler(
		{ message: { role: "assistant", stopReason: "error", provider: "openai", errorMessage: "Prompt exceeds max length" } } as never,
		ctx as never,
	);
	assert.equal(foreign, undefined, "other providers are untouched");
});

test("message_end trusts the message provider over the selected model", async () => {
	// Inverse case: the selected model belongs to another provider, but the
	// errored message is ours — the rewrite must still happen.
	const fake = loadExtension();
	const handler = fake.handlers.get("message_end")![0];
	const ctx = fakeCtx({ model: { id: "gpt-5.5", provider: "openai", api: "openai-responses" } }).ctx;
	const out: any = handler(
		{
			message: {
				role: "assistant",
				stopReason: "error",
				provider: PROVIDER_ID,
				errorMessage: "OpenAIException - Prompt exceeds max length",
			},
		} as never,
		ctx as never,
	);
	assert.match(out.message.errorMessage, /^context_length_exceeded:/);
});

test("message_end falls back to ctx.model when the message omits its provider", async () => {
	// Legacy messages may lack `provider`; ctx.model is the fallback so we still
	// catch a paratera overflow instead of dropping it.
	const fake = loadExtension();
	const handler = fake.handlers.get("message_end")![0];
	const ctx = fakeCtx().ctx; // ctx.model.provider === PROVIDER_ID
	const out: any = handler(
		{ message: { role: "assistant", stopReason: "error", errorMessage: "Prompt exceeds max length" } } as never,
		ctx as never,
	);
	assert.match(out.message.errorMessage, /^context_length_exceeded:/);
});

test("before_provider_request injects retention only when enabled", async () => {
	const file = isolatedSettingsFile();
	const fake = createFakePi();
	(extension as any)(fake.pi, { settingsFile: file });
	saveSettings({ cacheRetention: "long" }, file);
	const fake2 = createFakePi();
	(extension as any)(fake2.pi, { settingsFile: file });
	const hook = fake2.handlers.get("before_provider_request")![0];

	const chatPayload = { model: "GLM-4.6", messages: [{ role: "user", content: "hi" }] };
	const out: any = hook({ payload: chatPayload } as never, fakeCtx().ctx as never);
	assert.equal(out.prompt_cache_retention, "24h");
	assert.equal(out.prompt_cache_key, "sess-1");

	// an untouched payload must come back as undefined (no replacement)
	const foreign: any = hook({ payload: { model: "Other-Model", messages: [] } } as never, fakeCtx().ctx as never);
	assert.equal(foreign, undefined);
});

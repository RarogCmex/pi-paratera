/**
 * Offline tests for the PARATERA settings store and command autocomplete.
 * Run with: npm test  (tsx --test)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_SETTINGS,
	MAX_CACHE_KEY_LENGTH,
	SETTINGS_FILE_NAME,
	applyCacheRetention,
	argsHint,
	clampCacheKey,
	completeArgs,
	envSetHint,
	formatCommandLine,
	loadSettings,
	normalizeBaseUrl,
	parateraCommands,
	parseCacheArg,
	saveSettings,
	settingsPath,
	type ParateraSettings,
} from "../settings.ts";

const testDir = mkdtempSync(join(tmpdir(), "paratera-settings-test-"));
let counter = 0;
function tmpFile(): string {
	return join(testDir, `s-${counter++}.json`);
}

// ---------------------------------------------------------------------------
// measured maxTokens map (models probe persistence)
// ---------------------------------------------------------------------------

test("saveSettings merges maxTokens entries and loadSettings restores them", () => {
	const file = tmpFile();
	const first = saveSettings({ maxTokens: { "Brand-New-LLM": 32_768 } }, file);
	assert.equal(first.maxTokens?.["Brand-New-LLM"], 32_768);
	// a second probe for a different model must not drop the first
	const second = saveSettings({ maxTokens: { "Another-LLM": 65_536 } }, file);
	assert.deepEqual(second.maxTokens, { "Brand-New-LLM": 32_768, "Another-LLM": 65_536 });
	const reloaded = loadSettings(file);
	assert.deepEqual(reloaded.maxTokens, { "Brand-New-LLM": 32_768, "Another-LLM": 65_536 });
});

test("loadSettings drops junk maxTokens values (non-numeric, <1024) but keeps good ones", () => {
	const file = tmpFile();
	writeFileSync(
		file,
		JSON.stringify({
			version: 1,
			cacheRetention: "long",
			maxTokens: { good: 4096, tiny: 100, notANumber: "999999", nul: null },
		}),
		"utf8",
	);
	const reloaded = loadSettings(file);
	assert.deepEqual(reloaded.maxTokens, { good: 4096 });
});

// ---------------------------------------------------------------------------
// store basics
// ---------------------------------------------------------------------------

test("settings file name is paratera.json", () => {
	assert.equal(SETTINGS_FILE_NAME, "paratera.json");
	assert.match(settingsPath("/base"), /paratera\.json$/);
	assert.equal(settingsPath("/base"), join("/base", "paratera.json"));
});

test("defaults to short cache retention and no baseUrl override", () => {
	assert.equal(DEFAULT_SETTINGS.cacheRetention, "short");
	assert.equal(DEFAULT_SETTINGS.baseUrl, undefined);
	assert.equal(DEFAULT_SETTINGS.version, 1);
});

test("loadSettings on a missing file returns defaults", () => {
	const s = loadSettings(join(testDir, "does-not-exist.json"));
	assert.deepEqual(s, DEFAULT_SETTINGS);
});

test("loadSettings tolerates corrupt JSON", () => {
	const f = tmpFile();
	writeFileSync(f, "{not json", "utf8");
	assert.deepEqual(loadSettings(f), DEFAULT_SETTINGS);
});

test("loadSettings rejects a foreign schema version", () => {
	const f = tmpFile();
	writeFileSync(f, JSON.stringify({ version: 99, cacheRetention: "long" }), "utf8");
	assert.deepEqual(loadSettings(f), DEFAULT_SETTINGS);
});

test("loadSettings rejects non-object payloads", () => {
	for (const junk of ["null", "42", '"str"', "[]"]) {
		const f = tmpFile();
		writeFileSync(f, junk, "utf8");
		const s = loadSettings(f);
		assert.equal(s.cacheRetention, "short", `junk ${junk} degrades`);
	}
});

test("saveSettings round-trips cacheRetention", () => {
	const f = tmpFile();
	const saved = saveSettings({ cacheRetention: "long" }, f);
	assert.equal(saved.cacheRetention, "long");
	assert.ok(saved.updatedAt, "updatedAt stamped");
	assert.deepEqual(loadSettings(f).cacheRetention, "long");
});

test("saveSettings preserves an unrelated field", () => {
	const f = tmpFile();
	saveSettings({ baseUrl: "https://a.test/v1" }, f);
	const next = saveSettings({ cacheRetention: "long" }, f);
	assert.equal(next.baseUrl, "https://a.test/v1", "baseUrl kept");
	assert.equal(next.cacheRetention, "long");
});

test("saveSettings baseUrl:null clears the override", () => {
	const f = tmpFile();
	saveSettings({ baseUrl: "https://a.test/v1" }, f);
	const cleared = saveSettings({ baseUrl: null }, f);
	assert.equal(cleared.baseUrl, undefined);
	assert.equal(loadSettings(f).baseUrl, undefined);
});

test("saveSettings ignores an unusable baseUrl, keeping the previous one", () => {
	const f = tmpFile();
	saveSettings({ baseUrl: "https://good.test/v1" }, f);
	const next = saveSettings({ baseUrl: "ftp://nope" }, f);
	assert.equal(next.baseUrl, "https://good.test/v1");
});

test("saveSettings creates parent directories", () => {
	const f = join(testDir, "nested", "deeper", "paratera.json");
	saveSettings({ cacheRetention: "long" }, f);
	assert.ok(existsSync(f));
});

test("the stored file is pretty-printed JSON", () => {
	const f = tmpFile();
	saveSettings({ cacheRetention: "long" }, f);
	const raw = readFileSync(f, "utf8");
	assert.ok(raw.includes("\n"), "multi-line");
	assert.ok(raw.endsWith("\n"), "trailing newline");
	assert.deepEqual(JSON.parse(raw).version, 1);
});

// ---------------------------------------------------------------------------
// normalizeBaseUrl
// ---------------------------------------------------------------------------

test("normalizeBaseUrl accepts http(s) and strips trailing slashes", () => {
	assert.equal(normalizeBaseUrl("https://llmapi.paratera.com/v1"), "https://llmapi.paratera.com/v1");
	assert.equal(normalizeBaseUrl("https://a.test/v1///"), "https://a.test/v1");
	assert.equal(normalizeBaseUrl("http://localhost:8899/v1"), "http://localhost:8899/v1");
});

test("normalizeBaseUrl rejects junk", () => {
	for (const bad of ["", "   ", "ftp://a.test", "llmapi.paratera.com/v1", "not a url", "https://a.test/v 1", null, undefined]) {
		assert.equal(normalizeBaseUrl(bad as any), undefined, `rejects ${JSON.stringify(bad)}`);
	}
});

test("loadSettings normalizes a stored baseUrl", () => {
	const f = tmpFile();
	writeFileSync(f, JSON.stringify({ version: 1, cacheRetention: "short", baseUrl: "https://a.test/v1//" }), "utf8");
	assert.equal(loadSettings(f).baseUrl, "https://a.test/v1");
});

test("loadSettings drops a corrupt stored baseUrl", () => {
	const f = tmpFile();
	writeFileSync(f, JSON.stringify({ version: 1, cacheRetention: "short", baseUrl: "javascript:alert(1)" }), "utf8");
	assert.equal(loadSettings(f).baseUrl, undefined);
});

// ---------------------------------------------------------------------------
// envSetHint / parseCacheArg
// ---------------------------------------------------------------------------

test("envSetHint is POSIX by default and PowerShell on win32", () => {
	assert.equal(envSetHint("PARATERA_API_KEY", "sk-x", "linux"), "export PARATERA_API_KEY=sk-x");
	assert.equal(envSetHint("PARATERA_API_KEY", "sk-x", "darwin"), "export PARATERA_API_KEY=sk-x");
	assert.equal(envSetHint("PARATERA_API_KEY", "sk-x", "win32"), '$env:PARATERA_API_KEY="sk-x"');
});

test("parseCacheArg maps synonyms and rejects unknowns", () => {
	for (const v of ["on", "long", "24h", "enable", "enabled", "true", "ON", " Long "]) {
		assert.equal(parseCacheArg(v), "long", `${v} → long`);
	}
	for (const v of ["off", "short", "default", "disable", "disabled", "false"]) {
		assert.equal(parseCacheArg(v), "short", `${v} → short`);
	}
	assert.equal(parseCacheArg(""), "status");
	assert.equal(parseCacheArg(undefined), "status");
	assert.equal(parseCacheArg("status"), "status");
	assert.equal(parseCacheArg("banana"), undefined);
});

// ---------------------------------------------------------------------------
// applyCacheRetention (pure payload hook)
// ---------------------------------------------------------------------------

const SUPPORTED = new Set(["GLM-4.6", "Qwen3.8-Flash"]);

test("injects prompt_cache_retention on a chat payload", () => {
	const out = applyCacheRetention(
		{ model: "GLM-4.6", messages: [{ role: "user", content: "hi" }] },
		{ enabled: true, supportedModels: SUPPORTED, sessionId: "sess-1" },
	) as any;
	assert.equal(out.prompt_cache_retention, "24h");
	assert.equal(out.prompt_cache_key, "sess-1", "chat routes also get the cache key");
});

test("injects retention on a responses payload without a cache key", () => {
	const out = applyCacheRetention(
		{ model: "Qwen3.8-Flash", input: [], store: false },
		{ enabled: true, supportedModels: SUPPORTED, sessionId: "sess-1" },
	) as any;
	assert.equal(out.prompt_cache_retention, "24h");
	assert.equal(out.prompt_cache_key, undefined, "responses route keeps pi's own key");
});

test("is a no-op when disabled", () => {
	assert.equal(
		applyCacheRetention({ model: "GLM-4.6", messages: [] }, { enabled: false, supportedModels: SUPPORTED }),
		undefined,
	);
});

test("is a no-op for unsupported or unknown models", () => {
	assert.equal(
		applyCacheRetention({ model: "Other-Model", messages: [] }, { enabled: true, supportedModels: SUPPORTED }),
		undefined,
	);
});

test("is a no-op when pi already sent the field (PI_CACHE_RETENTION=long)", () => {
	assert.equal(
		applyCacheRetention(
			{ model: "GLM-4.6", messages: [], prompt_cache_retention: "24h" },
			{ enabled: true, supportedModels: SUPPORTED },
		),
		undefined,
	);
});

test("does not mutate the original payload", () => {
	const original: any = { model: "GLM-4.6", messages: [{ role: "user", content: "hi" }] };
	const out: any = applyCacheRetention(original, { enabled: true, supportedModels: SUPPORTED, sessionId: "s" });
	assert.equal(original.prompt_cache_retention, undefined, "original untouched");
	assert.notEqual(out, original, "returns a new object");
	assert.equal(out.prompt_cache_retention, "24h");
});

test("ignores non-payload shapes", () => {
	for (const bad of [null, undefined, 42, "str", { model: "GLM-4.6" }]) {
		assert.equal(applyCacheRetention(bad, { enabled: true, supportedModels: SUPPORTED }), undefined);
	}
});

test("clamps prompt_cache_key to the OpenAI-family limit", () => {
	assert.equal(MAX_CACHE_KEY_LENGTH, 64);
	const long = "x".repeat(200);
	assert.equal(clampCacheKey(long).length, 64);
	assert.equal(clampCacheKey("short"), "short");
	const out: any = applyCacheRetention(
		{ model: "GLM-4.6", messages: [] },
		{ enabled: true, supportedModels: SUPPORTED, sessionId: long },
	);
	assert.equal(out.prompt_cache_key.length, 64);
});

test("keeps an existing prompt_cache_key", () => {
	const out: any = applyCacheRetention(
		{ model: "GLM-4.6", messages: [], prompt_cache_key: "mine" },
		{ enabled: true, supportedModels: SUPPORTED, sessionId: "other" },
	);
	assert.equal(out.prompt_cache_key, "mine");
});

// ---------------------------------------------------------------------------
// /paratera command catalog + autocomplete
// ---------------------------------------------------------------------------

test("the command catalog covers every runner", () => {
	const names = parateraCommands().map((c) => c.name);
	assert.deepEqual(names, ["status", "cache", "url", "keys", "models", "transport"]);
	for (const c of parateraCommands()) {
		assert.ok(c.description.length > 0, `${c.name} described`);
	}
});

test("argsHint / formatCommandLine render usage lines", () => {
	const status = parateraCommands().find((c) => c.name === "status")!;
	const cache = parateraCommands().find((c) => c.name === "cache")!;
	assert.equal(argsHint(status), "");
	assert.equal(argsHint(cache), " [on|off|status]");
	assert.match(formatCommandLine(cache), /^cache \[on\|off\|status\] — /);
});

test("completeArgs lists top-level commands by prefix", () => {
	const cmds = parateraCommands();
	const all = completeArgs("", cmds)!;
	assert.equal(all.length, cmds.length);
	assert.ok(all.every((i) => i.value.endsWith(" ")), "top-level values carry a trailing space");
	const c = completeArgs("ca", cmds)!;
	assert.equal(c.length, 1);
	assert.equal(c[0].value, "cache ");
});

test("completeArgs offers nested subcommands for a bare command name", () => {
	const nested = completeArgs("cache", parateraCommands())!;
	assert.deepEqual(nested.map((i) => i.value), ["cache on", "cache off", "cache status"]);
});

test("completeArgs filters nested subcommands by prefix", () => {
	// Order follows the declaration order in parateraCommands(): status, set.
	const r = completeArgs("url s", parateraCommands())!;
	assert.deepEqual(r.map((i) => i.value), ["url status", "url set"]);
	const c = completeArgs("url ch", parateraCommands())!;
	assert.deepEqual(c.map((i) => i.value), ["url check"]);
});

test("nested completion values replace the whole prefix (TUI contract)", () => {
	// A chosen value must be the full argument string, not just the leaf word.
	const items = completeArgs("cache o", parateraCommands())!;
	assert.deepEqual(items.map((i) => i.value), ["cache on", "cache off"]);
});

test("completeArgs returns null when nothing matches", () => {
	assert.equal(completeArgs("zzz", parateraCommands()), null);
	assert.equal(completeArgs("cache zzz", parateraCommands()), null);
	assert.equal(completeArgs("status x", parateraCommands()), null);
	assert.equal(completeArgs("cache on off", parateraCommands()), null, "too many words");
});

test("completeArgs handles leading whitespace", () => {
	const items = completeArgs("   cache ", parateraCommands())!;
	assert.equal(items.length, 3);
});

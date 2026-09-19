/**
 * Offline tests for the transparent connect-retry transport layer.
 * Run with: npm test  (tsx --test)
 *
 * Strictly offline: every failure is simulated, no gateway is contacted and
 * the process-global undici dispatcher is never mutated.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	CONNECT_ERROR_CODES,
	clearGuardedOrigins,
	connectErrorCode,
	connectRetryDelayMs,
	bufferRequestBody,
	createSelectiveDispatcher,
	describeConnectFailure,
	dispatchWithConnectRetry,
	ensureTransportInstalled,
	guardOrigin,
	isConnectError,
	isGuardedOrigin,
	isOurDispatcher,
	markDispatcher,
	setTransportRetryEnabled,
	transportRetryDisabled,
	unguardOrigin,
	withConnectRetry,
	withConnectRetryFetch,
	type DispatchTarget,
} from "../transport.ts";

/** Build an Error shaped exactly like the real failure: a bare
 *  `TypeError: fetch failed` whose `.cause` carries the undici code. */
function connectError(code = "UND_ERR_CONNECT_TIMEOUT"): TypeError {
	const cause = Object.assign(new Error("Connect Timeout Error"), { code });
	return Object.assign(new TypeError("fetch failed"), { cause });
}

/** Zero-delay sleep so retry tests run instantly. */
const noSleep = async () => {};

// ---------------------------------------------------------------------------
// error classification
// ---------------------------------------------------------------------------

test("detects the real-world error shape (TypeError + cause.code)", () => {
	const err = connectError();
	assert.equal(connectErrorCode(err), "UND_ERR_CONNECT_TIMEOUT");
	assert.ok(isConnectError(err));
});

test("detects a bare error carrying the code directly", () => {
	assert.ok(isConnectError(Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" })));
	assert.ok(isConnectError(Object.assign(new Error("x"), { code: "ECONNRESET" })));
});

test("walks a deep cause chain", () => {
	const deep = new Error("outer", { cause: new Error("mid", { cause: connectError("EAI_AGAIN") }) });
	assert.equal(connectErrorCode(deep), "EAI_AGAIN");
});

test("does NOT classify unrelated errors as connect failures", () => {
	assert.equal(connectErrorCode(new Error("boom")), undefined);
	assert.equal(connectErrorCode(Object.assign(new Error("x"), { code: "ERR_BAD_REQUEST" })), undefined);
	assert.equal(connectErrorCode(null), undefined);
	assert.equal(connectErrorCode(undefined), undefined);
	assert.equal(connectErrorCode("string"), undefined);
	assert.equal(connectErrorCode(42), undefined);
	assert.ok(!isConnectError(new Error("boom")));
});

test("cause-chain walk terminates on a cyclic chain", () => {
	const a: any = new Error("a");
	a.cause = a; // cycle — must not hang
	assert.equal(connectErrorCode(a), undefined);
});

test("every retryable code is a pre-response (connect/socket) failure", () => {
	// These must all fire before the server sees the request, so retrying can
	// never double-charge. An HTTP status (429/500) must NOT be in this set —
	// those are pi-ai's job and may have already executed.
	for (const code of CONNECT_ERROR_CODES) {
		assert.ok(/^(UND_ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE)/.test(code), `${code} is a connect/socket code`);
	}
	assert.ok(CONNECT_ERROR_CODES.has("UND_ERR_CONNECT_TIMEOUT"), "the observed paratera failure is covered");
});

test("describeConnectFailure names the URL, the code and the transience", () => {
	const msg = describeConnectFailure("https://llmapi.paratera.com/v1/models", connectError());
	assert.match(msg, /llmapi\.paratera\.com/);
	assert.match(msg, /UND_ERR_CONNECT_TIMEOUT/);
	assert.match(msg, /transient/i);
});

// ---------------------------------------------------------------------------
// withConnectRetry
// ---------------------------------------------------------------------------

test("withConnectRetry passes a first-try success straight through", async () => {
	let calls = 0;
	const out = await withConnectRetry(async () => {
		calls++;
		return "ok";
	}, { sleep: noSleep });
	assert.equal(out, "ok");
	assert.equal(calls, 1);
});

test("withConnectRetry recovers from a transient connect error", async () => {
	let calls = 0;
	const out = await withConnectRetry(
		async () => {
			calls++;
			if (calls < 3) throw connectError();
			return "recovered";
		},
		{ sleep: noSleep },
	);
	assert.equal(out, "recovered");
	assert.equal(calls, 3);
});

test("withConnectRetry gives up after maxRetries and rethrows the original", async () => {
	let calls = 0;
	await assert.rejects(
		withConnectRetry(
			async () => {
				calls++;
				throw connectError();
			},
			{ maxRetries: 2, sleep: noSleep },
		),
		(err: any) => {
			assert.equal(err.cause.code, "UND_ERR_CONNECT_TIMEOUT", "original error preserved");
			return true;
		},
	);
	assert.equal(calls, 3, "1 initial + 2 retries");
});

test("withConnectRetry does NOT retry non-connect errors", async () => {
	let calls = 0;
	await assert.rejects(
		withConnectRetry(
			async () => {
				calls++;
				throw new Error("HTTP 401 invalid key");
			},
			{ sleep: noSleep },
		),
	);
	assert.equal(calls, 1, "no retry on a non-connect failure");
});

test("withConnectRetry does NOT retry a 429/500 (pi-ai owns those)", async () => {
	// A real HTTP response means the server saw the request; retrying could
	// double-execute. Only connect-phase failures are ours to retry.
	let calls = 0;
	const httpError = Object.assign(new Error("429 Too Many Requests"), { status: 429, headers: new Headers() });
	await assert.rejects(
		withConnectRetry(
			async () => {
				calls++;
				throw httpError;
			},
			{ sleep: noSleep },
		),
	);
	assert.equal(calls, 1);
});

test("withConnectRetry reports each retry via onRetry", async () => {
	const seen: { attempt: number; code: string; delayMs: number }[] = [];
	let n = 0;
	await withConnectRetry(
		async () => {
			if (n++ < 2) throw connectError("ECONNRESET");
			return "done";
		},
		{ sleep: noSleep, onRetry: (i) => seen.push(i) },
	);
	assert.equal(seen.length, 2);
	assert.deepEqual(seen.map((s) => s.attempt), [1, 2]);
	assert.ok(seen.every((s) => s.code === "ECONNRESET"));
	assert.ok(seen.every((s) => s.delayMs > 0));
});

test("withConnectRetry stops on an already-aborted signal", async () => {
	let calls = 0;
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(
		withConnectRetry(
			async () => {
				calls++;
				throw connectError();
			},
			{ sleep: noSleep },
			ac.signal,
		),
	);
	assert.equal(calls, 1, "aborts instead of retrying");
});

test("connectRetryDelayMs grows exponentially, respects the floor and the cap", () => {
	const cfg = { maxRetries: 5, minDelayMs: 400, maxDelayMs: 5_000 };
	const d0 = connectRetryDelayMs(0, cfg);
	const d1 = connectRetryDelayMs(1, cfg);
	const d2 = connectRetryDelayMs(2, cfg);
	assert.ok(d0 >= 400 && d0 <= 5_000, `d0=${d0}`);
	// jitter means exact ordering can invert at the cap, so assert trend below it
	assert.ok(d2 > d1 || d2 === cfg.maxDelayMs, `d2=${d2} d1=${d1}`);
	// far-out attempts clamp to the ceiling
	assert.equal(connectRetryDelayMs(20, cfg), cfg.maxDelayMs);
	assert.equal(connectRetryDelayMs(0, cfg) >= cfg.minDelayMs, true, "never below the floor");
});

// ---------------------------------------------------------------------------
// withConnectRetryFetch
// ---------------------------------------------------------------------------

test("withConnectRetryFetch retries a connect error then succeeds", async () => {
	let calls = 0;
	const base = (async () => {
		calls++;
		if (calls < 2) throw connectError();
		return { ok: true, status: 200, json: async () => ({ data: [] }) };
	}) as unknown as typeof fetch;
	const wrapped = withConnectRetryFetch(base, { sleep: noSleep });
	const res = await wrapped("https://llmapi.paratera.com/v1/models");
	assert.equal((res as any).status, 200);
	assert.equal(calls, 2);
});

test("withConnectRetryFetch passes through when disabled", async () => {
	setTransportRetryEnabled(false);
	try {
		let calls = 0;
		const base = (async () => {
			calls++;
			throw connectError();
		}) as unknown as typeof fetch;
		const wrapped = withConnectRetryFetch(base, { sleep: noSleep });
		await assert.rejects(() => wrapped("https://x.test/v1"));
		assert.equal(calls, 1, "no retry when disabled");
	} finally {
		setTransportRetryEnabled(true);
	}
});

// ---------------------------------------------------------------------------
// kill switch
// ---------------------------------------------------------------------------

test("transportRetryDisabled honors env values and the session override", () => {
	assert.equal(transportRetryDisabled({} as NodeJS.ProcessEnv), false);
	for (const v of ["off", "0", "false", "disable", "disabled", " OFF "]) {
		assert.equal(
			transportRetryDisabled({ PARATERA_TRANSPORT_RETRY: v } as NodeJS.ProcessEnv),
			true,
			`${v} disables`,
		);
	}
	assert.equal(transportRetryDisabled({ PARATERA_TRANSPORT_RETRY: "on" } as NodeJS.ProcessEnv), false);

	setTransportRetryEnabled(false);
	assert.equal(transportRetryDisabled({} as NodeJS.ProcessEnv), true, "session override wins");
	setTransportRetryEnabled(true);
	assert.equal(transportRetryDisabled({} as NodeJS.ProcessEnv), false, "override cleared");
});

// ---------------------------------------------------------------------------
// origin guard
// ---------------------------------------------------------------------------

test("guardOrigin scopes retries to the gateway origin only", () => {
	clearGuardedOrigins();
	guardOrigin("https://llmapi.paratera.com/v1");
	assert.ok(isGuardedOrigin("https://llmapi.paratera.com"), "exact origin");
	assert.ok(isGuardedOrigin("https://llmapi.paratera.com:443/v1/chat/completions"), "with path/port");
	assert.ok(!isGuardedOrigin("https://api.openai.com"), "other origins untouched");
	assert.ok(!isGuardedOrigin("https://evil.com/https://llmapi.paratera.com"), "no substring match");
	assert.ok(!isGuardedOrigin(undefined), "undefined origin is not guarded");
	assert.ok(!isGuardedOrigin("not a url"), "unparsable origin is not guarded");

	guardOrigin("https://mirror.test/v1");
	assert.ok(isGuardedOrigin("https://mirror.test"), "second origin guarded too");
	unguardOrigin("https://mirror.test/v1");
	assert.ok(!isGuardedOrigin("https://mirror.test"), "unguard removes it");
	assert.ok(isGuardedOrigin("https://llmapi.paratera.com"), "first origin survives");
	clearGuardedOrigins();
});

test("guardOrigin ignores an unparsable base URL", () => {
	clearGuardedOrigins();
	guardOrigin("not a url at all");
	assert.equal(isGuardedOrigin("anything"), false);
});

// ---------------------------------------------------------------------------
// request body buffering (retry needs a reproducible body)
// ---------------------------------------------------------------------------

test("bufferRequestBody keeps reproducible bodies as-is", async () => {
	assert.equal(await bufferRequestBody(undefined), undefined);
	assert.equal(await bufferRequestBody(null), null);
	assert.equal(await bufferRequestBody('{"a":1}'), '{"a":1}');
	const bytes = new Uint8Array([1, 2, 3]);
	assert.equal(await bufferRequestBody(bytes), bytes);
});

test("bufferRequestBody converts a one-shot async iterator into bytes", async () => {
	// fetch hands undici an async iterator that cannot be replayed; without
	// buffering, the retry would send an empty body.
	async function* gen() {
		yield new TextEncoder().encode('{"model":');
		yield '"GLM-4.6"}';
	}
	const out = await bufferRequestBody(gen());
	assert.ok(out instanceof Uint8Array);
	assert.equal(new TextDecoder().decode(out as Uint8Array), '{"model":"GLM-4.6"}');
});

// ---------------------------------------------------------------------------
// dispatchWithConnectRetry
// ---------------------------------------------------------------------------

/** A fake undici target: fails the first `failures` dispatches with a connect
 *  error delivered to onResponseError, then succeeds. */
function fakeTarget(failures: number) {
	let n = 0;
	const dispatched: Record<string, unknown>[] = [];
	const target: DispatchTarget = {
		dispatch(opts: unknown, handler: unknown): boolean {
			const h = handler as Record<string, any>;
			dispatched.push(opts as Record<string, unknown>);
			if (n++ < failures) {
				queueMicrotask(() => h.onResponseError?.(null, connectError()));
			} else {
				queueMicrotask(() => {
					h.onResponseStart?.(null, 200, [], "");
					h.onResponseData?.(null, new TextEncoder().encode("hello"));
					h.onResponseEnd?.(null, {});
				});
			}
			return true;
		},
	};
	return { target, dispatched, attempts: () => n };
}

function collectingHandler() {
	const events: string[] = [];
	let error: unknown;
	return {
		events,
		get error() {
			return error;
		},
		handler: {
			onRequestStart: () => events.push("start"),
			onResponseStart: () => events.push("respStart"),
			onResponseData: () => events.push("data"),
			onResponseEnd: () => events.push("respEnd"),
			onResponseError: (_c: unknown, e: unknown) => {
				error = e;
				events.push("error");
			},
		} as Record<string, unknown>,
	};
}

test("dispatchWithConnectRetry delivers a clean response untouched", async () => {
	const { target, attempts } = fakeTarget(0);
	const h = collectingHandler();
	dispatchWithConnectRetry(target, { origin: "https://llmapi.paratera.com", path: "/v1/models" }, h.handler, {
		config: { maxRetries: 2, minDelayMs: 1, maxDelayMs: 10 },
		sleep: noSleep,
	});
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(h.events, ["respStart", "data", "respEnd"]);
	assert.equal(h.error, undefined);
	assert.equal(attempts(), 1);
});

test("dispatchWithConnectRetry retries a connect error then succeeds", async () => {
	const { target, attempts } = fakeTarget(2);
	const h = collectingHandler();
	const retries: number[] = [];
	dispatchWithConnectRetry(target, { origin: "https://llmapi.paratera.com", path: "/v1/chat/completions", body: "{}" }, h.handler, {
		config: { maxRetries: 3, minDelayMs: 1, maxDelayMs: 10 },
		sleep: noSleep,
		onRetry: (i) => retries.push(i.attempt),
	});
	await new Promise((r) => setTimeout(r, 30));
	assert.deepEqual(h.events, ["respStart", "data", "respEnd"], "final success delivered");
	assert.equal(h.error, undefined);
	assert.equal(attempts(), 3, "2 failures + 1 success");
	assert.deepEqual(retries, [1, 2]);
});

test("dispatchWithConnectRetry reuses the buffered body on every attempt", async () => {
	const { target, dispatched } = fakeTarget(2);
	async function* gen() {
		yield new TextEncoder().encode('{"model":"GLM-4.6"}');
	}
	const h = collectingHandler();
	dispatchWithConnectRetry(target, { origin: "https://llmapi.paratera.com", path: "/v1/chat/completions", body: gen() }, h.handler, {
		config: { maxRetries: 3, minDelayMs: 1, maxDelayMs: 10 },
		sleep: noSleep,
	});
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(dispatched.length, 3);
	// every attempt must carry the SAME reproducible bytes, not a spent iterator
	for (const d of dispatched) {
		assert.ok(d.body instanceof Uint8Array, "body buffered to bytes");
		assert.equal(new TextDecoder().decode(d.body as Uint8Array), '{"model":"GLM-4.6"}');
	}
});

test("dispatchWithConnectRetry rewrites the final connect error into an actionable message", async () => {
	const { target, attempts } = fakeTarget(99); // always fails
	const h = collectingHandler();
	dispatchWithConnectRetry(target, { origin: "https://llmapi.paratera.com", path: "/v1/models" }, h.handler, {
		config: { maxRetries: 1, minDelayMs: 1, maxDelayMs: 5 },
		sleep: noSleep,
	});
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(h.events.at(-1), "error");
	const err = h.error as Error & { code?: string; cause?: unknown };
	assert.match(err.message, /llmapi\.paratera\.com/);
	assert.match(err.message, /transient/i);
	assert.equal(err.code, "UND_ERR_CONNECT_TIMEOUT", "code preserved for callers");
	assert.ok(err.cause, "original error kept as cause");
	assert.equal(attempts(), 2, "1 initial + 1 retry");
});

test("dispatchWithConnectRetry does NOT retry once a response has started", async () => {
	// A mid-stream error means the server already accepted and executed the
	// request — retrying could double-bill. Must surface immediately.
	let dispatched = 0;
	const target: DispatchTarget = {
		dispatch(_opts, handler) {
			dispatched++;
			const h = handler as Record<string, any>;
			queueMicrotask(() => {
				h.onResponseStart?.(null, 200, [], "");
				h.onResponseError?.(null, connectError("ECONNRESET"));
			});
			return true;
		},
	};
	const h = collectingHandler();
	dispatchWithConnectRetry(target, { origin: "https://llmapi.paratera.com", path: "/v1/chat/completions" }, h.handler, {
		config: { maxRetries: 3, minDelayMs: 1, maxDelayMs: 5 },
		sleep: noSleep,
	});
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(dispatched, 1, "no retry after the response started");
	assert.ok(h.events.includes("respStart"));
	assert.equal((h.error as Error).message, "fetch failed", "raw error, not the rewritten hint");
});

test("dispatchWithConnectRetry does NOT retry a non-connect handler error", async () => {
	let dispatched = 0;
	const target: DispatchTarget = {
		dispatch(_opts, handler) {
			dispatched++;
			queueMicrotask(() => (handler as any).onResponseError?.(null, new Error("boom")));
			return true;
		},
	};
	const h = collectingHandler();
	dispatchWithConnectRetry(target, { origin: "https://llmapi.paratera.com", path: "/v1" }, h.handler, {
		config: { maxRetries: 3, minDelayMs: 1, maxDelayMs: 5 },
		sleep: noSleep,
	});
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(dispatched, 1);
	assert.equal((h.error as Error).message, "boom");
});

test("dispatchWithConnectRetry honors an aborted signal", async () => {
	const { target, attempts } = fakeTarget(99);
	const ac = new AbortController();
	ac.abort();
	const h = collectingHandler();
	dispatchWithConnectRetry(target, { origin: "https://llmapi.paratera.com", path: "/v1", signal: ac.signal }, h.handler, {
		config: { maxRetries: 3, minDelayMs: 1, maxDelayMs: 5 },
		sleep: noSleep,
	});
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(attempts(), 0, "never dispatched when pre-aborted");
	assert.equal(h.events.at(-1), "error");
});

// ---------------------------------------------------------------------------
// selective dispatcher (origin scoping)
// ---------------------------------------------------------------------------

test("createSelectiveDispatcher retries only guarded origins", async () => {
	clearGuardedOrigins();
	guardOrigin("https://llmapi.paratera.com/v1");
	const { target, attempts } = fakeTarget(1);
	const d = createSelectiveDispatcher(target, {
		config: { maxRetries: 2, minDelayMs: 1, maxDelayMs: 5 },
		sleep: noSleep,
	});
	const h = collectingHandler();
	d.dispatch({ origin: "https://llmapi.paratera.com", path: "/v1/models" }, h.handler);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(h.events.at(-1), "respEnd", "guarded origin retried and succeeded");
	assert.equal(attempts(), 2);

	// an unguarded origin must pass straight through with no retry wrapper
	const { target: other, attempts: otherAttempts } = fakeTarget(1);
	const d2 = createSelectiveDispatcher(other, {
		config: { maxRetries: 2, minDelayMs: 1, maxDelayMs: 5 },
		sleep: noSleep,
	});
	const h2 = collectingHandler();
	d2.dispatch({ origin: "https://api.openai.com", path: "/v1/chat/completions" }, h2.handler);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(h2.events.at(-1), "error", "unguarded origin gets the raw failure");
	assert.equal(otherAttempts(), 1, "no retry off-origin");
	clearGuardedOrigins();
});

test("createSelectiveDispatcher delegates close/destroy", async () => {
	clearGuardedOrigins();
	let closed = false;
	let destroyed = false;
	const target: DispatchTarget = {
		dispatch: () => true,
		close: () => {
			closed = true;
		},
		destroy: () => {
			destroyed = true;
		},
	};
	const d = createSelectiveDispatcher(target, { config: { maxRetries: 1, minDelayMs: 1, maxDelayMs: 2 } });
	await d.close();
	await d.destroy();
	assert.ok(closed && destroyed);
});

test("createSelectiveDispatcher passes through when disabled", async () => {
	clearGuardedOrigins();
	guardOrigin("https://llmapi.paratera.com/v1");
	setTransportRetryEnabled(false);
	try {
		const { target, attempts } = fakeTarget(1);
		const d = createSelectiveDispatcher(target, {
			config: { maxRetries: 2, minDelayMs: 1, maxDelayMs: 5 },
			sleep: noSleep,
		});
		const h = collectingHandler();
		d.dispatch({ origin: "https://llmapi.paratera.com", path: "/v1/models" }, h.handler);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(attempts(), 1, "disabled ⇒ single attempt");
		assert.equal(h.events.at(-1), "error");
	} finally {
		setTransportRetryEnabled(true);
		clearGuardedOrigins();
	}
});

// ---------------------------------------------------------------------------
// ensureTransportInstalled (idempotency + fail-open)
// ---------------------------------------------------------------------------

function fakeUndici() {
	let globalDispatcher: unknown = { dispatch: () => true };
	const set: unknown[] = [];
	return {
		set,
		deps: {
			getGlobalDispatcher: () => globalDispatcher,
			setGlobalDispatcher: (d: unknown) => {
				globalDispatcher = d;
				set.push(d);
			},
			adapt: (duck: any) => {
				const obj = Object.assign(Object.create(null), duck);
				markDispatcher(obj);
				return obj;
			},
		},
	};
}

test("ensureTransportInstalled is a no-op without a guarded origin", () => {
	clearGuardedOrigins();
	const { deps, set } = fakeUndici();
	const res = ensureTransportInstalled(deps, { config: { maxRetries: 1, minDelayMs: 1, maxDelayMs: 2 } });
	assert.deepEqual(res, { installed: false, already: false });
	assert.equal(set.length, 0, "global dispatcher untouched");
});

test("ensureTransportInstalled installs once and reports 'already' after", () => {
	clearGuardedOrigins();
	guardOrigin("https://llmapi.paratera.com/v1");
	const { deps, set } = fakeUndici();
	const opts = { config: { maxRetries: 1, minDelayMs: 1, maxDelayMs: 2 } };
	const first = ensureTransportInstalled(deps, opts);
	assert.equal(first.installed, true);
	assert.ok(isOurDispatcher(first.dispatcher));
	assert.equal(set.length, 1);

	const second = ensureTransportInstalled(deps, opts);
	assert.equal(second.installed, false);
	assert.equal(second.already, true);
	assert.equal(set.length, 1, "not installed twice");
	clearGuardedOrigins();
});

test("ensureTransportInstalled is disabled by the kill switch", () => {
	clearGuardedOrigins();
	guardOrigin("https://llmapi.paratera.com/v1");
	setTransportRetryEnabled(false);
	try {
		const { deps, set } = fakeUndici();
		const res = ensureTransportInstalled(deps, { config: { maxRetries: 1, minDelayMs: 1, maxDelayMs: 2 } });
		assert.deepEqual(res, { installed: false, already: false });
		assert.equal(set.length, 0);
	} finally {
		setTransportRetryEnabled(true);
		clearGuardedOrigins();
	}
});

test("ensureTransportInstalled fails open when the dispatcher throws", () => {
	clearGuardedOrigins();
	guardOrigin("https://llmapi.paratera.com/v1");
	const throwingDeps = {
		getGlobalDispatcher: () => {
			throw new Error("undici exploded");
		},
		setGlobalDispatcher: () => {},
		adapt: (d: any) => d,
	};
	const res = ensureTransportInstalled(throwingDeps, { config: { maxRetries: 1, minDelayMs: 1, maxDelayMs: 2 } });
	assert.equal(res.installed, false, "never throws at the caller");
	clearGuardedOrigins();
});

test("markDispatcher/isOurDispatcher round-trip and reject foreign objects", () => {
	const obj = {};
	assert.equal(isOurDispatcher(obj), false);
	markDispatcher(obj);
	assert.equal(isOurDispatcher(obj), true);
	assert.equal(isOurDispatcher(undefined), false);
	assert.equal(isOurDispatcher(null), false);
	assert.equal(isOurDispatcher({}), false);
	// the mark must be non-enumerable so it never leaks into serialization
	assert.deepEqual(Object.keys(obj), []);
});

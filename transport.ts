/**
 * Transparent transport hardening for the PARATERA MaaS gateway.
 *
 * The endpoint is hosted in China and intermittently drops connections:
 * undici (pi-coding-agent's bundled fetch) fails with
 * `UND_ERR_CONNECT_TIMEOUT` / `UND_ERR_SOCKET` while curl to the same URL
 * connects in ~0.2–1.2s (observed live 2026-09-19). These are CONNECT-phase
 * failures — they happen before any request byte reaches the server, so
 * retrying is safe: no double-execution, no double-billing. Headers/body
 * timeouts are excluded on purpose (see CONNECT_ERROR_CODES below).
 *
 * pi-ai does NOT retry them. Its `retryProviderRequest` only retries errors
 * that look like provider errors (`isProviderError` requires `status` +
 * `headers`); a connect failure is a bare `TypeError: fetch failed` with a
 * `cause.code`, so it is rethrown immediately and the whole turn fails. This
 * module fills that gap at two layers:
 *
 *   1. `withConnectRetry` — a promise wrapper for the extension's own
 *      control-plane fetches (key validation, endpoint probe, catalog
 *      refresh). Pure and directly unit-testable.
 *
 *   2. `ensureTransportInstalled` — an origin-scoped undici dispatcher
 *      wrapper (pi-nvidia-plus pattern) that transparently retries connect
 *      errors on inference streams too, which go through the OpenAI SDK →
 *      global fetch → undici and cannot be wrapped any other way. undici is
 *      injected by the caller (the entrypoint resolves pi's own copy), so this
 *      module stays pure.
 *
 * Everything fails open: if undici cannot be resolved, or anything throws
 * inside the wrapper, the request is passed through untouched. The wrapper
 * only ever acts on requests whose origin is guarded (the effective gateway
 * base URL); all other traffic delegates to the previous global dispatcher.
 *
 * Kill switch: set PARATERA_TRANSPORT_RETRY=off to disable both layers.
 */

/** Connect/socket error codes worth retrying. All occur before the request is
 *  sent, so a retry cannot double-charge. Sourced from pi-nvidia-plus's
 *  PROXY_CONNECT_CODES minus `UND_ERR_HEADERS_TIMEOUT`/`UND_ERR_BODY_TIMEOUT`:
 *  those two can fire *after* the request already reached the server (it
 *  accepted the connection but never finished responding), so a retry could
 *  re-execute paid inference — they are deliberately left un-retried. */
export const CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
	"ECONNRESET",
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EPIPE",
]);

/** Walk an error's `.cause` chain for a known connect code. undici wraps the
 *  real failure: `TypeError: fetch failed` → `cause: ConnectTimeoutError` with
 *  `code: "UND_ERR_CONNECT_TIMEOUT"`. */
export function connectErrorCode(err: unknown): string | undefined {
	let current: unknown = err;
	for (let depth = 0; current && depth < 8; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && CONNECT_ERROR_CODES.has(code)) return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

export function isConnectError(err: unknown): boolean {
	return connectErrorCode(err) !== undefined;
}

/** Human-readable failure for a gateway we could not even connect to. */
export function describeConnectFailure(url: string, cause: unknown): string {
	const code = connectErrorCode(cause);
	const detail = code ?? (cause instanceof Error ? cause.message : String(cause));
	return (
		`Could not connect to the PARATERA gateway at ${url} (${detail}). ` +
		`The endpoint is hosted in China and drops connections intermittently; ` +
		`this is usually transient — retry shortly.`
	);
}

export interface ConnectRetryConfig {
	/** Retries *after* the first attempt (so maxRetries:2 ⇒ up to 3 attempts). */
	maxRetries: number;
	/** Base backoff delay, ms. */
	minDelayMs: number;
	/** Backoff ceiling, ms. */
	maxDelayMs: number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Called before each scheduled retry. */
	onRetry?: (info: { attempt: number; code: string; delayMs: number }) => void;
}

export const DEFAULT_CONNECT_RETRY: ConnectRetryConfig = {
	maxRetries: 2,
	minDelayMs: 400,
	maxDelayMs: 5_000,
};

/** Exponential backoff with jitter, floored at minDelayMs and capped at
 *  maxDelayMs. `attempt` is 0-based (0 ⇒ first retry). */
export function connectRetryDelayMs(attempt: number, config: ConnectRetryConfig): number {
	const expo = config.minDelayMs * 2 ** Math.max(0, attempt);
	const jittered = expo * (1 - Math.random() * 0.25);
	return Math.min(Math.max(jittered, config.minDelayMs), config.maxDelayMs);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Session kill-switch (`/paratera transport off`), overrides the env var. */
let retryOverride: boolean | undefined;

export function setTransportRetryEnabled(enabled: boolean): void {
	retryOverride = enabled ? undefined : false;
}

/** True when the retry kill-switch is engaged (env or session override). */
export function transportRetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (retryOverride === false) return true;
	const v = env.PARATERA_TRANSPORT_RETRY?.trim().toLowerCase();
	return v === "off" || v === "0" || v === "false" || v === "disable" || v === "disabled";
}

/**
 * Run an async op, transparently retrying connect-phase failures. Used for the
 * extension's control-plane fetches. Non-connect errors, and an aborted
 * signal, propagate immediately. Returns the op's value on the first success.
 */
export async function withConnectRetry<T>(
	op: () => Promise<T>,
	config: Partial<ConnectRetryConfig> = {},
	signal?: AbortSignal,
): Promise<T> {
	const cfg: ConnectRetryConfig = { ...DEFAULT_CONNECT_RETRY, ...config };
	const sleep = cfg.sleep ?? defaultSleep;
	let attempt = 0;
	for (;;) {
		try {
			return await op();
		} catch (err) {
			if (signal?.aborted) throw err;
			const code = connectErrorCode(err);
			if (code === undefined || attempt >= cfg.maxRetries) throw err;
			const delayMs = connectRetryDelayMs(attempt, cfg);
			cfg.onRetry?.({ attempt: attempt + 1, code, delayMs });
			attempt++;
			await sleep(delayMs, signal);
			if (signal?.aborted) throw err;
		}
	}
}

/**
 * Wrap a fetch implementation so every call retries connect failures. Keeps
 * the `typeof fetch` signature so it can be dropped into the provider factory
 * and the control-plane helpers unchanged.
 */
export function withConnectRetryFetch(
	base: typeof fetch,
	config: Partial<ConnectRetryConfig> = {},
	onRetry?: ConnectRetryConfig["onRetry"],
): typeof fetch {
	const wrapped = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		if (transportRetryDisabled()) return base(input, init);
		const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
		return withConnectRetry(() => base(input, init), { ...config, onRetry }, init?.signal ?? undefined);
	}) as typeof fetch;
	return wrapped;
}

// ---------------------------------------------------------------------------
// undici dispatcher wrapper (inference streams)
// ---------------------------------------------------------------------------

export interface DispatchTarget {
	dispatch(opts: unknown, handler: unknown): boolean;
	close?(): Promise<void> | void;
	destroy?(): Promise<void> | void;
}

/** Origins (scheme://host[:port]) whose connect errors we transparently retry.
 *  Populated from the effective gateway base URL; everything else passes
 *  through to the previous global dispatcher untouched. */
const guardedOrigins = new Set<string>();

export function guardOrigin(baseUrl: string): void {
	try {
		guardedOrigins.add(new URL(baseUrl).origin);
	} catch {
		// ignore unparsable base URLs
	}
}

export function unguardOrigin(baseUrl: string): void {
	try {
		guardedOrigins.delete(new URL(baseUrl).origin);
	} catch {
		// ignore
	}
}

export function isGuardedOrigin(origin: unknown): boolean {
	if (origin === undefined || origin === null) return false;
	try {
		return guardedOrigins.has(new URL(origin.toString()).origin);
	} catch {
		return false;
	}
}

/** Reset guarded origins (tests). */
export function clearGuardedOrigins(): void {
	guardedOrigins.clear();
}

/**
 * Reproducible request body. `fetch` hands undici a one-shot async iterator;
 * a retry cannot reuse it (it is marked consumed after the first pass), so we
 * buffer iterators to bytes. Strings/ArrayBufferViews are already reproducible.
 * paratera request bodies are small JSON, so buffering is harmless.
 */
export async function bufferRequestBody(body: unknown): Promise<unknown> {
	if (body === undefined || body === null) return body;
	if (typeof body === "string" || ArrayBuffer.isView(body)) return body;
	const asyncIter = (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
	if (typeof asyncIter !== "function") return body;
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
		const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
		chunks.push(bytes);
		total += bytes.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function callHandler(real: Record<string, unknown> | null, name: string, ...args: unknown[]): unknown {
	const fn = real?.[name];
	if (typeof fn !== "function") return undefined;
	return (fn as (...a: unknown[]) => unknown).apply(real, args);
}

export interface DispatcherRetryOptions {
	config: ConnectRetryConfig;
	onRetry?: ConnectRetryConfig["onRetry"];
	/** Sleep between attempts (injectable for tests). Default: setTimeout. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Dispatch `opts` to `target`, transparently retrying connect-phase errors up
 * to `maxRetries` times. Only retries while no response has started (a connect
 * error means the server never saw the request). Once bytes flow, the handler
 * is wired straight through. The final, un-retryable connect error is rewritten
 * into a clear message (`.code`/`.cause` preserved) before delivery.
 */
export function dispatchWithConnectRetry(
	target: DispatchTarget,
	opts: Record<string, unknown>,
	realHandler: Record<string, unknown> | null,
	options: DispatcherRetryOptions,
): void {
	const cfg = options.config;
	const sleep = options.sleep ?? defaultSleep;
	const signal = opts.signal as AbortSignal | undefined;

	const attempt = (n: number, body: unknown): void => {
		if (signal?.aborted) {
			callHandler(realHandler, "onResponseError", null, new Error("aborted"));
			return;
		}
		let started = false;
		const wrapped: Record<string, unknown> = {
			onRequestStart: (conn: unknown, ctx: unknown) => callHandler(realHandler, "onRequestStart", conn, ctx),
			onResponseStarted: () => callHandler(realHandler, "onResponseStarted"),
			onResponseStart: (conn: unknown, status: unknown, headers: unknown, statusMessage: unknown) => {
				started = true;
				return callHandler(realHandler, "onResponseStart", conn, status, headers, statusMessage);
			},
			onResponseData: (conn: unknown, chunk: unknown) => callHandler(realHandler, "onResponseData", conn, chunk),
			onResponseEnd: (conn: unknown, trailers: unknown) => callHandler(realHandler, "onResponseEnd", conn, trailers),
			onRequestUpgrade: (conn: unknown, status: unknown, headers: unknown, socket: unknown) => {
				started = true;
				return callHandler(realHandler, "onRequestUpgrade", conn, status, headers, socket);
			},
			onResponseError: (conn: unknown, err: unknown) => {
				const code = connectErrorCode(err);
				// Retry only pre-response connect errors with budget left.
				if (!started && code !== undefined && n < cfg.maxRetries && !signal?.aborted) {
					const delayMs = connectRetryDelayMs(n, cfg);
					options.onRetry?.({ attempt: n + 1, code, delayMs });
					void sleep(delayMs, signal).then(() => {
						if (signal?.aborted) callHandler(realHandler, "onResponseError", conn, err);
						else attempt(n + 1, body);
					});
					return;
				}
				// Give up: rewrite a connect failure into something actionable.
				const delivered = !started && code !== undefined ? rewriteConnectError(opts, err) : err;
				return callHandler(realHandler, "onResponseError", conn, delivered);
			},
			// Old undici protocol fallback.
			onError: (err: unknown) => callHandler(realHandler, "onError", err),
		};
		try {
			target.dispatch({ ...opts, body }, wrapped);
		} catch (err) {
			callHandler(realHandler, "onResponseError", null, err);
		}
	};

	void bufferRequestBody(opts.body)
		.then((body) => attempt(0, body))
		.catch((err) => callHandler(realHandler, "onResponseError", null, err));
}

function rewriteConnectError(opts: Record<string, unknown>, err: unknown): unknown {
	let url = "the gateway";
	try {
		const origin = (opts.origin as string | undefined) ?? "";
		const path = (opts.path as string | undefined) ?? "";
		if (origin) url = `${origin}${path}`;
	} catch {
		// keep the generic label
	}
	const wrapped = new Error(describeConnectFailure(url, err));
	wrapped.cause = err;
	const code = connectErrorCode(err);
	if (code) (wrapped as NodeJS.ErrnoException).code = code;
	return wrapped;
}

export const OUR_DISPATCHER_MARK = "__piParateraConnectRetryDispatcher";

export function isOurDispatcher(dispatcher: unknown): boolean {
	return !!dispatcher && (dispatcher as Record<string, unknown>)[OUR_DISPATCHER_MARK] === true;
}

export function markDispatcher(dispatcher: object): void {
	Object.defineProperty(dispatcher, OUR_DISPATCHER_MARK, { value: true, enumerable: false });
}

export interface SelectiveDispatcherHandle extends DispatchTarget {
	close(): Promise<void>;
	destroy(): Promise<void>;
}

/**
 * Duck-typed dispatcher: retries connect errors on guarded origins, delegates
 * everything else to the previous global dispatcher unchanged. The entrypoint
 * subclasses pi's real `undici.Dispatcher` around this (see `adapt` below).
 */
export function createSelectiveDispatcher(
	fallback: DispatchTarget,
	options: DispatcherRetryOptions,
): SelectiveDispatcherHandle & Record<string, unknown> {
	return {
		[OUR_DISPATCHER_MARK]: true,
		dispatch(opts: unknown, handler: unknown): boolean {
			let origin: unknown;
			try {
				origin = (opts as { origin?: unknown } | null)?.origin;
			} catch {
				origin = undefined;
			}
			const real = (handler && typeof handler === "object" ? handler : null) as Record<string, unknown> | null;
			if (isGuardedOrigin(origin) && !transportRetryDisabled()) {
				dispatchWithConnectRetry(fallback, (opts ?? {}) as Record<string, unknown>, real, options);
				return true;
			}
			return fallback.dispatch(opts, handler);
		},
		close(): Promise<void> {
			return Promise.resolve(fallback.close?.() as Promise<void> | undefined).then(() => undefined);
		},
		destroy(): Promise<void> {
			return Promise.resolve(fallback.destroy?.() as Promise<void> | undefined).then(() => undefined);
		},
	};
}

export interface DispatcherDeps {
	getGlobalDispatcher(): unknown;
	setGlobalDispatcher(dispatcher: unknown): void;
	/** Adapt the duck wrapper into a real `undici.Dispatcher` subclass instance. */
	adapt(duck: SelectiveDispatcherHandle): unknown;
}

export interface InstallResult {
	installed: boolean;
	already: boolean;
	dispatcher?: unknown;
}

/**
 * Idempotently install the origin-scoped connect-retry dispatcher. Safe to
 * call repeatedly (e.g. before each request); if pi recreates the dispatcher
 * (/reload, settings change) a later call re-wraps the new one. Never throws:
 * any failure leaves the global dispatcher untouched (fail-open).
 */
export function ensureTransportInstalled(
	deps: DispatcherDeps,
	options: DispatcherRetryOptions,
): InstallResult {
	try {
		if (guardedOrigins.size === 0) return { installed: false, already: false };
		if (transportRetryDisabled()) return { installed: false, already: false };
		const current = deps.getGlobalDispatcher();
		if (isOurDispatcher(current)) return { installed: false, already: true, dispatcher: current };
		const duck = createSelectiveDispatcher(current as DispatchTarget, options);
		const dispatcher = deps.adapt(duck);
		deps.setGlobalDispatcher(dispatcher);
		return { installed: true, already: false, dispatcher };
	} catch {
		// fail-open: transport hardening must never break pi
		return { installed: false, already: false };
	}
}

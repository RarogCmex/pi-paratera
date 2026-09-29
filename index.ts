/**
 * PARATERA MaaS (llmapi.paratera.com) provider for the pi coding agent.
 *
 * Operator: Beijing PARATERA Tech Corp., Ltd. (北京并行科技股份有限公司) —
 * the "并行科技" MaaS / 并行智算云 platform. Endpoint: https://llmapi.paratera.com/v1
 *
 * Gateway: LiteLLM Proxy **1.89.0** behind istio-envoy (read from the public
 * /openapi.json on 2026-09-19). That single fact explains most of the
 * behavior below — this is a *proxy*, not a vendor API, so capabilities vary
 * per upstream model and errors are re-wrapped several layers deep.
 *
 * Auth:     `pi /login paratera` (key validated before saving, stored in
 *           ~/.pi/agent/auth.json) or $PARATERA_API_KEY.
 * Endpoint: the shipped DEFAULT_BASE_URL is the real public endpoint, so no
 *           configuration is needed. `/paratera url set …` or
 *           $PARATERA_BASE_URL override it for private/mirror deployments;
 *           candidates are probed before saving and models are rebound
 *           in-place (pi keeps object references, so no /reload).
 *
 * Priority API surface: OpenAI **Responses API** (`/responses`) for the 33
 * models verified to support it; the other 32 chat models are registered on
 * `openai-completions`. The route split is per-model and was measured, not
 * assumed — see the verification notes below.
 *
 * All facts below were verified against the live gateway on 2026-09-19.
 *
 * Responses route (33/65 models):
 *   - Works end-to-end through pi-ai's openai-responses adapter: streaming,
 *     `thinking` blocks, function tools (tool_calls round-trip verified on
 *     GLM-5.3-Flash, Qwen3.8-Flash, DeepSeek-V4-Flash, MiniMax-M3, Kimi-K2.6,
 *     GLM-5.2, DeepSeek-V3.2, Qwen3.5-122B-A10B, Qwen3.7-Plus,
 *     MiniMax-Text-01, DeepSeek-V3.2-Instruct) and usage accounting.
 *   - LiteLLM emits SSE `data:` lines with **no** `event:` lines — the event
 *     name lives in the JSON `type` field. pi-ai survives this because it
 *     drives /responses through the official OpenAI SDK
 *     (`client.responses.create`), not a hand-rolled parser.
 *   - `store:false` is NOT honored (the echo reports `store:true`) and
 *     `GET /responses/{id}` fails pydantic validation, so retrieval is
 *     unavailable. Stateless mode therefore cannot be relied on here; pi
 *     sends the full context every turn anyway.
 *   - `reasoning.summary` and `include:["reasoning.encrypted_content"]` are
 *     accepted by every Responses model probed (GLM-5.3-Flash, GLM-5.2,
 *     Qwen3.8-Flash, Qwen3.7-Max, DeepSeek-V4-Flash, DeepSeek-V3.2,
 *     Kimi-K2.6, MiniMax-M3, MiniMax-M2.5), so **no summary-stripping hook is
 *     needed** — the gateway accepts the fields rather than rejecting them.
 *   - developer and system roles both accepted.
 *   - NOT supported by: every GLM-4.x/4.5x/4.6/4.7 (upstream 404s on
 *     `/v4/responses`), GLM-4V and GLM-Z1 (upstream 401 身份验证失败), all four
 *     ERNIE (401 "model does not exist"), Kimi-K2.5 (400 "Agent capabilities
 *     are not enabled for the current model"), DeepSeek-R1/V3/V3.1/
 *     V3-250324 (500 当前用户未开通知识库问答功能 — the upstream requires a
 *     knowledge-base feature, so accounts without it are refused; an
 *     entitlement error, not a defect), Qwen-Long,
 *     GLM-Embedding/Rerank/ASR/CogView and the image/video models.
 *
 * Chat-completions route:
 *   - `reasoning_content` streams in `delta` and pi-ai maps it to thinking
 *     blocks (verified: 1201 chars over 401 chunks on GLM-4.5-Flash).
 *   - `stream_options.include_usage` honored; `strict:false` and
 *     `strict:true` tools both accepted; streaming tool-call deltas work.
 *   - developer role accepted (not just system).
 *   - **`max_tokens` is the only reliable cap field.** `max_completion_tokens`
 *     is silently ignored by several upstreams (measured: Qwen3.8-Flash
 *     emitted 38 tokens with `max_completion_tokens:1`, GLM-5.3-Flash emitted
 *     264), while `max_tokens` is validated and honored by every family —
 *     which is also why all the output caps below were discoverable from
 *     `max_tokens` 400-errors. Hence maxTokensField:"max_tokens" everywhere.
 *     Note this is the opposite of the common OpenAI spelling: gateways that
 *     honour `max_completion_tokens` are the norm, this one is not.
 *   - Empty `tool_calls:[]` on a replayed assistant message is REJECTED by
 *     Qwen ("Empty tool_calls") — pi-ai omits empty arrays, so no hook needed.
 *   - Assistant messages carrying `reasoning_content` are accepted on replay
 *     (Kimi-K2.6, GLM-4.6, Qwen3.6-Flash verified).
 *
 * Thinking control differs per family, so each gets its own map + format:
 *   - GLM-4.5x/4.6 (`zai` format): `thinking:{type:"disabled"}` zeroes
 *     reasoning (verified rc=0); `reasoning_effort` is accepted but IGNORED
 *     (GLM-4.5-Flash returned rc=25 identically for every level).
 *   - GLM-5.3 (Responses): `effort:"none"` is IGNORED (1297 reasoning chars),
 *     `low` ⇒ 0 chars. So `off` is unavailable; low is the floor.
 *   - GLM-5.1/5.2/5.3-Flash (Responses): `effort:"none"` ⇒ 0 chars, so `off`
 *     works normally.
 *   - Qwen (`qwen` format, `enable_thinking`): verified false ⇒ rc=0.
 *   - DeepSeek (`deepseek` format, `thinking:{type}`): verified
 *     disabled ⇒ rc=0, incl. DeepSeek-R1.
 *   - Kimi-K2.6/K3: **`max` is rejected** — allowed set is
 *     none/minimal/low/medium/high/xhigh (upstream error message). `max` is
 *     mapped out of the picker.
 *   - MiniMax M1-80k/M2/M2.5/M2.7: thinking cannot be disabled (all levels
 *     and `none` still reason), so `off` is unavailable.
 *   - MiniMax-M3: returned zero `reasoning_content` on every probe ⇒ treated
 *     as non-reasoning.
 *   - ERNIE-5.0-Thinking-Preview: `thinking:{type:"disabled"}` ⇒ rc=0;
 *     minimal/low/medium/high accepted, xhigh/max unverified ⇒ unavailable.
 *
 * Prompt caching: implicit prefix caching works and is reported in
 * `usage.prompt_tokens_details.cached_tokens` (seen on GLM-4.5-Flash,
 * Qwen3.8-Flash and GLM chat routes). `prompt_cache_retention:"24h"` plus
 * `prompt_cache_key` are ACCEPTED (200) on every route probed — chat:
 * GLM-4.5-Flash, GLM-4.6, Qwen3.8-Flash, Kimi-K2.6, MiniMax-M2.5,
 * DeepSeek-V4-Flash, ERNIE-4.5-Turbo-32K; responses: GLM-5.3-Flash,
 * Qwen3.8-Flash, DeepSeek-V4-Flash, MiniMax-M3, Kimi-K2.6 — so
 * supportsLongCacheRetention:true across the catalog.
 *
 * Context windows: the gateway ENFORCES input caps with a clean pre-inference
 * 400 ("Prompt exceeds max length"), which made them measurable without
 * spending tokens. Verified lower bounds (real prompt_tokens accepted):
 * DeepSeek-V4-Flash 233_049, GLM-5.3-Flash 174_778, Kimi-K2.6 174_776,
 * Qwen3.8-Flash 116_572, MiniMax-M2.5 116_552, GLM-4.6 116_000. Values below
 * are family defaults that never fell below a measured bound; a 292k-token
 * input was correctly rejected by GLM-4.5-Flash, confirming enforcement
 * rather than silent truncation — which matters because a gateway that
 * truncates quietly makes its published window unverifiable from the outside.
 *
 * Output caps: read from the gateway's own free 400-errors — the pre-inference
 * max_tokens=99999999 probe is rejected before any tokens are generated, and
 * the message names the cap. 49 of 65 models are capped this way, e.g. GLM
 * 限制数值范围[1,131072], Qwen3.8 "Range of max_tokens should be [1, 131072]",
 * Kimi-K2.6 [1, 262144], MiniMax "does not support max tokens > 196608",
 * MiniMax-M3 > 524288, ERNIE max_completion_tokens [1, 12288], Baichuan
 * "must be between 1 and 32000", GLM-4-Long [1,4095], GLM-4V-Flash [1,1024].
 * The other 16 ACCEPTED the absurd value and enforce no upstream cap, so they
 * carry a family default (marked † in the README table): the six DeepSeek V4
 * routes, DeepSeek-R1/V3-250324/V3.1, GLM-5.2/5.3/5.3-Flash,
 * GLM-4-9B/4-Flash/4-FlashX, Kimi-K3.
 *
 * Vision: verified with a local data-URI probe — remote image URLs 400 on
 * several upstreams ("图片输入格式/解析错误") because the gateway cannot always
 * fetch them, so pass base64 data URIs. Confirmed working: GLM-4.6V,
 * GLM-4.5V, GLM-4V, GLM-4V-Flash, GLM-4V-Plus-0111, ERNIE-4.5-Turbo-VL-32K,
 * DeepSeek-V4-Flash-Vision-Exp, Qwen3.8-Flash. DeepSeek-V4-Pro accepted an
 * image but misread it (answered "white" for a red square), so it stays
 * text-only rather than advertising unverified vision; GLM-4.5-Air/AirX reject
 * image content outright ("content.type 参数非法，取值范围 ['text']").
 *
 * Billing: **all costs are reported as zero.** GET /v1/models returns only
 * id/object/created/owned_by — no credit multiplier — and LiteLLM's admin
 * endpoints are closed to this key
 * (`/model/info` → "RBAC: access denied", `/key/info` → 404). paratera bills
 * in CNY per million tokens behind the console (ai.paratera.com), so no
 * trustworthy per-model price can be baked in. pi will show $0.00; treat
 * usage columns as token counts only.
 *
 * Catalog: dynamic. GET /v1/models lists 96 ids but omits every capability,
 * so the listing is merged over the verified static table below: known ids
 * keep their measured caps/maps/compat, unknown ids are auto-registered
 * conservatively on the chat route (and upgraded with any cap saved by
 * `/paratera models probe` — a persisted maxTokens map in paratera.json). 31 listed ids are deliberately NOT
 * registered because they are not chat-completion models (embeddings, rerank,
 * ASR, OCR, image/video generation), are dead deployments, or reject tools:
 *   - non-chat: GLM-Embedding-2/3, GLM-Rerank, GLM-ASR-2512,
 *     GLM-CogView3-Flash, DeepSeek-OCR, PaddleOCR-VL-0.9B/1.5,
 *     WanX2.1-T2I-Plus/Turbo, Doubao-Seedream-3.0/4.0/4.5/5.0-lite,
 *     Doubao-Seedance-1.0-Pro, MiniMax-Hailuo-02, MiniMax-I2V-01(+Director,
 *     +Live), MiniMax-T2V-01(+Director)
 *   - dead/broken deployments (404 or 500 on both routes): Baichuan-M2-128K,
 *     DeepSeek-R1-0528, DeepSeek-V3.1-Terminus, DeepSeek-V3.2-Exp,
 *     DeepSeek-V3.2-Thinking, GLM-5, GLM-X-F, Intern-S2-Preview
 *     (您已超过输入 tokens 配额)
 *   - no tool support (unusable for a coding agent): Baichuan-M2, Baichuan-M3
 *     — "Model `Baichuan-M2` does not support function calls"
 *
 * Key validation (zero inference): POST {} to /chat/completions returns 500
 * "Router.acompletion() missing 1 required positional argument: 'messages'"
 * for a VALID key and 401 "Invalid proxy server token passed …
 * LiteLLM_VerificationTokenTable" for an invalid one. A 403
 * "team not allowed to access model" also means the key authenticated.
 *
 * Network: the endpoint is hosted in China and drops connections transiently —
 * undici (pi-coding-agent's bundled fetch) intermittently fails with
 * UND_ERR_CONNECT_TIMEOUT / UND_ERR_SOCKET while curl to the same URL connects
 * in ~0.2–1.2s, and some inference calls stall >45s. pi-ai does NOT retry
 * these (its retryProviderRequest requires status+headers, but a connect
 * failure is a bare `TypeError: fetch failed` with a cause.code), so transport.ts
 * closes the gap at two layers: `withConnectRetry` wraps the control-plane
 * fetches below (validateGatewayKey / probeBaseUrl / fetchGatewayModels via
 * `defaultFetch`), and an origin-scoped undici dispatcher (installed in the
 * entrypoint through resolvePiUndici) retries connect errors on inference
 * streams too. Only pre-response connect/socket codes are retried — they fire
 * before any request byte is sent, so a retry can never double-execute or
 * double-bill; HTTP 429/500 stay pi-ai's business, and
 * UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT are also left un-retried
 * because they can fire after the request already reached the server.
 * Everything fails open: an
 * unresolvable undici or any throw inside the wrapper passes the request
 * through untouched, and `/paratera transport status` reports it.
 *
 * Timeouts here are therefore generous (25s key probe, 30s catalog, 25s
 * endpoint probe) and every network path degrades rather than throwing: a
 * failed catalog fetch keeps the static baseline, an unreachable key probe
 * reports "unavailable" (never "invalid"). Retrying is automatic; a persistent
 * failure surfaces as an actionable message naming the URL and error code.
 *
 * Usage:
 *   pi                        # /login paratera, then /model
 *   export PARATERA_API_KEY=… # alternative to /login
 *   /paratera status          # in-pi settings: base URL, key, cache, catalog
 *   /paratera cache on        # persist 24h prompt-cache retention
 *   /paratera keys check      # validate the resolved key (zero inference)
 *   /paratera models refresh  # force GET /v1/models catalog refresh
 *   /paratera transport status# connect-retry install state + last retried error
 */

import {
	createProvider,
	type ApiKeyCredential,
	type AuthContext,
	type Model,
	type ProviderAuthInteraction,
	type RefreshModelsContext,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyCacheRetention,
	completeArgs,
	envSetHint,
	formatCommandLine,
	loadSettings,
	normalizeBaseUrl,
	parateraCommands,
	parseCacheArg,
	saveSettings,
	settingsPath,
	type CacheRetentionMode,
	type ParateraSettings,
} from "./settings.ts";
import {
	DEFAULT_CONNECT_RETRY,
	ensureTransportInstalled,
	guardOrigin,
	markDispatcher,
	setTransportRetryEnabled,
	type DispatchTarget,
	type DispatcherDeps,
	type SelectiveDispatcherHandle,
	transportRetryDisabled,
	unguardOrigin,
	withConnectRetryFetch,
} from "./transport.ts";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

/** Default fetch for the extension's own control-plane calls (key validation,
 *  endpoint probe, catalog refresh): transparently retries the intermittent
 *  connect timeouts this China-hosted endpoint produces. Callers that inject
 *  their own fetchImpl (tests) bypass it and stay deterministic. */
const defaultFetch = withConnectRetryFetch(fetch, DEFAULT_CONNECT_RETRY);

export const PROVIDER_ID = "paratera";
/** The real public endpoint — paratera publishes one shared MaaS URL rather
 *  than per-subscription gateway ids, so this ships working and needs no
 *  configuration. Overridable for private/dedicated deployments. */
export const DEFAULT_BASE_URL = "https://llmapi.paratera.com/v1";
export const API_KEY_ENV = "PARATERA_API_KEY";
export const BASE_URL_ENV = "PARATERA_BASE_URL";

/** Timeout for the zero-inference key-validation probe. Generous on purpose:
 *  this endpoint is hosted in China and was observed to drop connections
 *  transiently (undici UND_ERR_CONNECT_TIMEOUT) even though curl connects in
 *  ~0.2–1.2s — a tight timeout would make a working key look invalid. */
const KEY_VALIDATION_TIMEOUT_MS = 25_000;
/** Timeout for the GET /models catalog fetch. */
const FETCH_TIMEOUT_MS = 30_000;

/** Human-readable reason from an unknown thrown value. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Timeout-guarded fetch signal: `setTimeout`-based abort combined with an
 *  optional caller signal. Always call `done()` in a `finally` to clear the
 *  timer — the control-plane fetches below follow that pattern. */
function connectSignals(
	timeoutMs: number,
	signal?: AbortSignal,
): { signal: AbortSignal; done: () => void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	return {
		signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
		done: () => clearTimeout(timeout),
	};
}

/**
 * Effective endpoint: $PARATERA_BASE_URL env > persisted settings override
 * (`/paratera url set`) > built-in default.
 */
export function resolveBaseUrl(
	env: NodeJS.ProcessEnv = process.env,
	settings?: { baseUrl?: string },
): string {
	const override = env[BASE_URL_ENV]?.trim() || settings?.baseUrl?.trim();
	if (override) return override.replace(/\/+$/, "");
	return DEFAULT_BASE_URL;
}

export function baseUrlSource(
	env: NodeJS.ProcessEnv = process.env,
	settings?: { baseUrl?: string },
): "env" | "settings" | "default" {
	if (env[BASE_URL_ENV]?.trim()) return "env";
	if (settings?.baseUrl?.trim()) return "settings";
	return "default";
}

type GatewayApi = "openai-responses" | "openai-completions";
type CatalogEntry = Omit<Model<GatewayApi>, "provider" | "baseUrl">;

// ---------------------------------------------------------------------------
// compat blocks
// ---------------------------------------------------------------------------

/** Verified on every Responses model: developer role OK, strict tools not
 *  needed, `prompt_cache_retention:"24h"` accepted (probe 2026-09-19).
 *  NOTE `store:false` is echoed back as `store:true` by this LiteLLM build and
 *  `GET /responses/{id}` fails validation — retrieval is unavailable, but pi
 *  is stateless-by-payload so this is cosmetic. */
const RESPONSES_COMPAT = {
	supportsDeveloperRole: true,
	supportsStore: false,
	supportsStrictMode: false,
	supportsLongCacheRetention: true,
};

/** Verified on every chat model. `maxTokensField:"max_tokens"` is load-bearing:
 *  `max_completion_tokens` is silently IGNORED by several upstreams
 *  (Qwen3.8-Flash emitted 38 tokens with max_completion_tokens:1,
 *  GLM-5.3-Flash emitted 264) while `max_tokens` is validated by all. */
const CHAT_COMPAT = {
	supportsDeveloperRole: true,
	supportsStore: false,
	supportsUsageInStreaming: true,
	supportsLongCacheRetention: true,
	supportsStrictMode: false,
	maxTokensField: "max_tokens" as const,
};

// ---------------------------------------------------------------------------
// thinking level maps (pi level -> provider value; null = level unavailable)
// ---------------------------------------------------------------------------

/** DeepSeek family (`thinking:{type}` on chat, `reasoning.effort` on
 *  Responses): none/xhigh verified accepted on both routes, none ⇒ rc=0. */
const DEEPSEEK_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "high",
} satisfies ThinkingLevelMap;

/** GLM family: `thinking:{type:"disabled"}` zeroes reasoning on chat
 *  (verified rc=0); on Responses `effort:"none"` ⇒ 0 chars for 5.1/5.2/5.3-Flash.
 *  GLM-4.5-Flash accepted every reasoning_effort value but ignored it (rc=25
 *  for all), so levels are nominal there — harmless either way. */
const GLM_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} satisfies ThinkingLevelMap;

/** GLM-5.3 specifically IGNORES `effort:"none"` (measured 1297 reasoning chars
 *  vs 0 for 5.1/5.2/5.3-Flash): it always thinks, `low` is the floor. */
const GLM53_EFFORT = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} satisfies ThinkingLevelMap;

/** Qwen family (`enable_thinking` on chat, `reasoning.effort` on Responses):
 *  none verified accepted on both routes, enable_thinking:false ⇒ rc=0. */
const QWEN_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} satisfies ThinkingLevelMap;

/** Kimi-K2.6/K3 REJECT `max`: the upstream error names the allowed set
 *  ('none','minimal','low','medium','high','xhigh'). xhigh is the ceiling;
 *  `max` is folded into it so the picker never offers a value that 400s. */
const KIMI_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "xhigh",
} satisfies ThinkingLevelMap;

/** MiniMax M1-80k/M2/M2.5/M2.7 cannot disable thinking — every level AND
 *  `none` still produced reasoning (measured 280–1463 chars), so `off` is
 *  unavailable and the picker starts at minimal. */
const MINIMAX_ALWAYS_EFFORT = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} satisfies ThinkingLevelMap;

/** ERNIE-5.0-Thinking-Preview: minimal/low/medium/high verified accepted,
 *  `thinking:{type:"disabled"}` ⇒ rc=0. xhigh/max were not probed, so they
 *  stay unavailable rather than shipping an unverified value. */
const ERNIE_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
} satisfies ThinkingLevelMap;

/**
 * Costs are reported as zero: this gateway exposes no per-model credit
 * multiplier (GET /v1/models returns only id/object/created/owned_by) and the
 * LiteLLM admin endpoints that would carry pricing are closed to this key
 * (/model/info → "RBAC: access denied"). paratera bills in CNY behind its
 * console, so any number baked in here would be invented.
 */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ---------------------------------------------------------------------------
// static catalog (verified against the live gateway on 2026-09-19)
// ---------------------------------------------------------------------------

export const CATALOG: CatalogEntry[] = [
	// ---- Responses API (33 models: verified 200 + tool-call round-trip) ----
	{
		id: "DeepSeek-V3.2",
		name: "DeepSeek-V3.2",
		api: "openai-responses",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 128_000,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "DeepSeek-V3.2-Instruct",
		name: "DeepSeek-V3.2-Instruct",
		api: "openai-responses",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 128_000,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "DeepSeek-V4-Flash",
		name: "DeepSeek-V4-Flash",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...DEEPSEEK_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "DeepSeek-V4-Flash-0731",
		name: "DeepSeek-V4-Flash-0731",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...DEEPSEEK_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "DeepSeek-V4-Flash-Vision-Exp",
		name: "DeepSeek-V4-Flash-Vision-Exp",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...DEEPSEEK_EFFORT },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "DeepSeek-V4-Pro",
		name: "DeepSeek-V4-Pro",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...DEEPSEEK_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "DeepSeek-V4-Pro-0813",
		name: "DeepSeek-V4-Pro-0813",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...DEEPSEEK_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "DeepSeek-V4.1-Flash",
		name: "DeepSeek-V4.1-Flash",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...DEEPSEEK_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "GLM-5.1",
		name: "GLM-5.1",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 196_608,
		maxTokens: 131_072,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "GLM-5.2",
		name: "GLM-5.2",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 196_608,
		maxTokens: 131_072,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "GLM-5.3",
		name: "GLM-5.3",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...GLM53_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 196_608,
		maxTokens: 131_072,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "GLM-5.3-Flash",
		name: "GLM-5.3-Flash",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 196_608,
		maxTokens: 131_072,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Kimi-K2.6",
		name: "Kimi-K2.6",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...KIMI_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 262_144,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Kimi-K3",
		name: "Kimi-K3",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...KIMI_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 128_000,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "MiniMax-M1-80k",
		name: "MiniMax-M1-80k",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...MINIMAX_ALWAYS_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 196_608,
		maxTokens: 196_608,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "MiniMax-M2",
		name: "MiniMax-M2",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...MINIMAX_ALWAYS_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 196_608,
		maxTokens: 196_608,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "MiniMax-M2.5",
		name: "MiniMax-M2.5",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...MINIMAX_ALWAYS_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 196_608,
		maxTokens: 196_608,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "MiniMax-M2.7",
		name: "MiniMax-M2.7",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...MINIMAX_ALWAYS_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 196_608,
		maxTokens: 196_608,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "MiniMax-M3",
		name: "MiniMax-M3",
		api: "openai-responses",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 524_288,
		maxTokens: 524_288,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "MiniMax-Text-01",
		name: "MiniMax-Text-01",
		api: "openai-responses",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 196_608,
		maxTokens: 40_000,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.5-122B-A10B",
		name: "Qwen3.5-122B-A10B",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.5-27B",
		name: "Qwen3.5-27B",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.5-35B-A3B",
		name: "Qwen3.5-35B-A3B",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.5-397B-A17B",
		name: "Qwen3.5-397B-A17B",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.5-Plus",
		name: "Qwen3.5-Plus",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.6-27B",
		name: "Qwen3.6-27B",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.6-Flash",
		name: "Qwen3.6-Flash",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.6-Plus",
		name: "Qwen3.6-Plus",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 65_536,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.7-Max",
		name: "Qwen3.7-Max",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.7-Plus",
		name: "Qwen3.7-Plus",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.8-27B",
		name: "Qwen3.8-27B",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.8-Flash",
		name: "Qwen3.8-Flash",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...RESPONSES_COMPAT },
	},
	{
		id: "Qwen3.8-Max",
		name: "Qwen3.8-Max",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { ...QWEN_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...RESPONSES_COMPAT },
	},
	// ---- Chat completions (32 models: no Responses route upstream) ----
	{
		id: "DeepSeek-R1",
		name: "DeepSeek-R1",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...DEEPSEEK_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 128_000,
		maxTokens: 65_536,
		compat: { ...CHAT_COMPAT, thinkingFormat: "deepseek" },
	},
	{
		id: "DeepSeek-V3-250324",
		name: "DeepSeek-V3-250324",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 128_000,
		maxTokens: 65_536,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "DeepSeek-V3.1",
		name: "DeepSeek-V3.1",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 128_000,
		maxTokens: 65_536,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "ERNIE-4.5-Turbo-128K",
		name: "ERNIE-4.5-Turbo-128K",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		// NOT MEASURED, and it contradicts the id's own name. All four ERNIE ids
		// answer 401 "model does not exist" on the Responses route, so no probe ever
		// produced a cap for this family; 32_768 / 12_288 is the -32K sibling's pair
		// copied across. The honest reading of AGENTS.md ("no unverified limit") is
		// that this row is a placeholder, not a fact — so it is labelled here and in
		// the README's Models legend. Consequence if the real window is 128K: pi
		// compacts roughly 4x earlier than it needs to. That is the safe direction
		// (an early compaction is recoverable, an over-context request is billed),
		// which is why it ships rather than being dropped. Probing it needs a key
		// whose account is entitled to ERNIE at all.
		contextWindow: 32_768,
		maxTokens: 12_288,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "ERNIE-4.5-Turbo-32K",
		name: "ERNIE-4.5-Turbo-32K",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 32_768,
		maxTokens: 12_288,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "ERNIE-4.5-Turbo-VL-32K",
		name: "ERNIE-4.5-Turbo-VL-32K",
		api: "openai-completions",
		reasoning: false,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 32_768,
		maxTokens: 12_288,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "ERNIE-5.0-Thinking-Preview",
		name: "ERNIE-5.0-Thinking-Preview",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...ERNIE_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 65_536,
		compat: { ...CHAT_COMPAT, thinkingFormat: "deepseek" },
	},
	{
		id: "GLM-4-9B",
		name: "GLM-4-9B",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-4-Air",
		name: "GLM-4-Air",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 98_304,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-4-AirX",
		name: "GLM-4-AirX",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 98_304,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-4-Flash",
		name: "GLM-4-Flash",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-4-FlashX",
		name: "GLM-4-FlashX",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-4-Long",
		name: "GLM-4-Long",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 4_095,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-4-Plus",
		name: "GLM-4-Plus",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 98_304,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-4.5",
		name: "GLM-4.5",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-4.5-Air",
		name: "GLM-4.5-Air",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 98_304,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-4.5-AirX",
		name: "GLM-4.5-AirX",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 98_304,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-4.5-Flash",
		name: "GLM-4.5-Flash",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 98_304,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-4.5-X",
		name: "GLM-4.5-X",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-4.5V",
		name: "GLM-4.5V",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 16_384,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-4.6",
		name: "GLM-4.6",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-4.6V",
		name: "GLM-4.6V",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 32_768,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-4.7",
		name: "GLM-4.7",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-4V",
		name: "GLM-4V",
		api: "openai-completions",
		reasoning: false,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 2_048,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-4V-Flash",
		name: "GLM-4V-Flash",
		api: "openai-completions",
		reasoning: false,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 1_024,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-4V-Plus-0111",
		name: "GLM-4V-Plus-0111",
		api: "openai-completions",
		reasoning: false,
		input: ["text", "image"], // vision verified (correctly identified a red square)
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 8_192,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-5-Turbo",
		name: "GLM-5-Turbo",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: { ...GLM_EFFORT },
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 196_608,
		maxTokens: 131_072,
		compat: { ...CHAT_COMPAT, thinkingFormat: "zai" },
	},
	{
		id: "GLM-Z1-Air",
		name: "GLM-Z1-Air",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 98_304,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-Z1-AirX",
		name: "GLM-Z1-AirX",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 98_304,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "GLM-Z1-Flash",
		name: "GLM-Z1-Flash",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 32_768,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "Kimi-K2.5",
		name: "Kimi-K2.5",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 98_304,
		compat: { ...CHAT_COMPAT },
	},
	{
		id: "Qwen-Long",
		name: "Qwen-Long",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 131_072,
		maxTokens: 32_768,
		compat: { ...CHAT_COMPAT },
	},
];

export function buildModels(baseUrl: string): Model<GatewayApi>[] {
	return CATALOG.map((entry) => ({ ...entry, provider: PROVIDER_ID, baseUrl }));
}

/** ids listed by GET /v1/models that must never be registered as chat models:
 *  not chat-completion models, dead deployments, or no tool support. */
export const SKIP_MODEL_IDS = new Set<string>([
	// embeddings / rerank / ASR / OCR — different API surface
	"GLM-Embedding-2",
	"GLM-Embedding-3",
	"GLM-Rerank",
	"GLM-ASR-2512",
	"GLM-CogView3-Flash",
	"DeepSeek-OCR",
	"PaddleOCR-VL-0.9B",
	"PaddleOCR-VL-1.5",
	// image / video generation — different API surface
	"WanX2.1-T2I-Plus",
	"WanX2.1-T2I-Turbo",
	"Doubao-Seedream-3.0-T2I",
	"Doubao-Seedream-4.0",
	"Doubao-Seedream-4.5",
	"Doubao-Seedream-5.0-lite",
	"Doubao-Seedance-1.0-Pro",
	"MiniMax-Hailuo-02",
	"MiniMax-I2V-01",
	"MiniMax-I2V-01-Director",
	"MiniMax-I2V-01-Live",
	"MiniMax-T2V-01",
	"MiniMax-T2V-01-Director",
	// dead/broken deployments (404 or 500 on both routes, probe 2026-09-19)
	"Baichuan-M2-128K",
	"DeepSeek-R1-0528",
	"DeepSeek-V3.1-Terminus",
	"DeepSeek-V3.2-Exp",
	"DeepSeek-V3.2-Thinking",
	"GLM-5",
	"GLM-X-F",
	"Intern-S2-Preview",
	// no function-calling support — unusable for a coding agent
	"Baichuan-M2",
	"Baichuan-M3",
	// gateway routing pseudo-entry
	"auto",
]);

// ---------------------------------------------------------------------------
// dynamic catalog (GET /v1/models) merged over the static capability table
// ---------------------------------------------------------------------------

export interface GatewayModelEntry {
	id?: unknown;
	name?: unknown;
	credit?: unknown;
}

/** Guess an API route for a listing id this build has never seen. Responses is
 *  the priority surface, but it is per-upstream: the GLM-4.x/4.5x/4.6/4.7,
 *  GLM-4V/Z1 and ERNIE families 404/401 on /responses, so new ids fall back to
 *  chat unless they clearly belong to a Responses-verified family. */
export function guessApi(id: string): GatewayApi {
	const lower = id.toLowerCase();
	// Non-chat surfaces (embeddings/rerank/ASR/OCR, image+video generation) have
	// no /responses upstream and are normally skipped; if one slips through,
	// never put it on the Responses route.
	if (/(embedding|rerank|asr|ocr|t2i|i2v|t2v|seedream|seedance|hailuo|cogview|wanx)/.test(lower)) {
		return "openai-completions";
	}
	// Families with NO /responses upstream, verified by probe:
	//   GLM-4.x / GLM-4V / GLM-Z1 → 404 on /v4/responses or 401 身份验证失败
	//   GLM-5-Turbo → 404 (while GLM-5.1/5.2/5.3 → 200)
	//   ERNIE (all four) → 401 "model does not exist"
	//   Kimi-K2.5 → 400 "Agent capabilities are not enabled for the current model"
	//   Qwen-Long → 400
	if (/^glm-(4|z1|5-turbo)/i.test(id)) return "openai-completions";
	if (/^ernie/i.test(id)) return "openai-completions";
	if (/^kimi-k2\.5/i.test(id)) return "openai-completions";
	if (/^qwen-long/i.test(id)) return "openai-completions";
	// Families with a verified /responses upstream. Written to also cover
	// plausible future point releases (GLM-5.4, Qwen4, MiniMax-M4…).
	if (/^(deepseek-v4|glm-5\.|qwen(?:3\.[5-9]|[4-9])|kimi-k(?:2\.[6-9]|3)|minimax-(m|text))/i.test(id)) {
		return "openai-responses";
	}
	// conservative default: chat works for every gateway model
	return "openai-completions";
}

/** Guess a thinking-control map for an unlisted/unprobed id, by family. */
function guessEffort(id: string): ThinkingLevelMap | undefined {
	if (/^minimax-m[12]/i.test(id)) return { ...MINIMAX_ALWAYS_EFFORT };
	if (/^kimi-k/i.test(id)) return { ...KIMI_EFFORT };
	if (/^glm-5\.3$/i.test(id)) return { ...GLM53_EFFORT };
	if (/^glm-/i.test(id)) return { ...GLM_EFFORT };
	if (/^qwen/i.test(id)) return { ...QWEN_EFFORT };
	if (/^deepseek/i.test(id)) return { ...DEEPSEEK_EFFORT };
	if (/^ernie-5/i.test(id)) return { ...ERNIE_EFFORT };
	return undefined;
}

/** Guess the full compat block (maxTokensField, thinkingFormat, …) for an
 *  unlisted/unprobed id, by API route and family. */
function guessCompat(api: GatewayApi, id: string): CatalogEntry["compat"] {
	if (api === "openai-responses") return { ...RESPONSES_COMPAT };
	if (/^qwen/i.test(id)) return { ...CHAT_COMPAT, thinkingFormat: "qwen" as const };
	if (/^glm-/i.test(id)) return { ...CHAT_COMPAT, thinkingFormat: "zai" as const };
	if (/^(deepseek|minimax|kimi|baichuan|intern)/i.test(id)) {
		return { ...CHAT_COMPAT, thinkingFormat: "deepseek" as const };
	}
	return { ...CHAT_COMPAT };
}

/** Conservative registration for gateway models this build has never seen. */
export function unknownModelConfig(id: string, baseUrl: string, name?: string): Model<GatewayApi> {
	const api = guessApi(id);
	const effort = guessEffort(id);
	return {
		id,
		name: name?.trim() || id,
		api,
		provider: PROVIDER_ID,
		baseUrl,
		// Unknown capability ⇒ claim reasoning only when the family is a known
		// reasoner, so pi does not send thinking params to models that 400 on them.
		reasoning: effort !== undefined,
		...(effort ? { thinkingLevelMap: effort } : {}),
		input: /(-vl|vision|-4v|4\.5v|4\.6v)/i.test(id) ? (["text", "image"] as const) : (["text"] as const),
		cost: ZERO_COST,
		contextWindow: 128_000,
		maxTokens: 8_192,
		compat: guessCompat(api, id) as Model<GatewayApi>["compat"],
	};
}

/**
 * Merge the live GET /v1/models listing over the static catalog:
 * - known ids keep their verified caps/maps/compat, gain a fresh name
 * - unknown ids are auto-registered conservatively (family-guessed route),
 *   then upgraded with measured output caps when one was probed and saved
 * - skipped ids (non-chat, dead, tool-less) never register
 * - an empty/invalid listing falls back to the static catalog
 */
export function mergeGatewayCatalog(
	raw: GatewayModelEntry[],
	baseUrl: string,
	measuredMaxTokens: Record<string, number> = {},
): Model<GatewayApi>[] {
	const known = new Map(CATALOG.map((entry) => [entry.id, entry]));
	const merged: Model<GatewayApi>[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (!id || SKIP_MODEL_IDS.has(id) || seen.has(id)) continue;
		seen.add(id);
		const name = typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
		const base = known.get(id);
		if (base) {
			merged.push({ ...base, name: name ?? base.name, provider: PROVIDER_ID, baseUrl });
		} else {
			const config = unknownModelConfig(id, baseUrl, name);
			const measured = measuredMaxTokens[id];
			merged.push(measured !== undefined ? { ...config, maxTokens: measured } : config);
		}
	}
	if (merged.length === 0) return buildModels(baseUrl);
	return merged;
}

/**
 * fetchModels for createProvider: pi restores/persists the returned overlay
 * transactionally (models store), so offline starts reuse the last fetched
 * catalog. Any failure degrades to the static baseline.
 */
export async function fetchGatewayModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch = defaultFetch,
	measuredMaxTokens: Record<string, number> = {},
): Promise<Model<GatewayApi>[]> {
	const fallback = buildModels(baseUrl);
	const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!key) return fallback;
	try {
		const response = await fetchImpl(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.any([context.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
		});
		if (!response.ok) return fallback;
		const data = (await response.json()) as { data?: GatewayModelEntry[] };
		if (!Array.isArray(data?.data) || data.data.length === 0) return fallback;
		return mergeGatewayCatalog(data.data, baseUrl, measuredMaxTokens);
	} catch {
		return fallback;
	}
}

// ---------------------------------------------------------------------------
// key validation + login flow
// ---------------------------------------------------------------------------

export interface KeyValidationResult {
	status: "valid" | "invalid" | "unavailable";
	reason?: string;
}

export interface ValidateKeyOptions {
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

/**
 * Zero-inference key check: POST {} to /chat/completions.
 * A VALID key gets past LiteLLM auth and fails later with 500
 * ("Router.acompletion() missing 1 required positional argument: 'messages'");
 * an INVALID key gets 401 ("Invalid proxy server token passed …").
 * Never logs or returns the key.
 */
export async function validateGatewayKey(
	key: string,
	options: ValidateKeyOptions = {},
): Promise<KeyValidationResult> {
	const baseUrl = options.baseUrl ?? resolveBaseUrl();
	const { signal, done } = connectSignals(KEY_VALIDATION_TIMEOUT_MS, options.signal);
	try {
		const response = await (options.fetchImpl ?? defaultFetch)(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: "{}",
			signal,
		});
		if (response.status === 401 || response.status === 403) return { status: "invalid" };
		// 500 = authenticated, tripped on the empty body; 400 = same.
		if (response.ok || response.status === 400 || response.status === 500) return { status: "valid" };
		return { status: "unavailable", reason: `HTTP ${response.status}` };
	} catch (error) {
		return { status: "unavailable", reason: errorMessage(error) };
	} finally {
		done();
	}
}

// ---------------------------------------------------------------------------
// per-model limit probe (free: rejected before inference starts)
// ---------------------------------------------------------------------------

const MODEL_PROBE_TIMEOUT_MS = 25_000;

/** A one-message chat completion with `max_tokens: 99_999_999`.
 *  A capped upstream rejects it in a pre-inference 400 whose message names
 *  the real cap, without generating any tokens — that path is free.
 *  An uncapped upstream ACCEPTS it and generates a real completion, which is
 *  billed: `max_tokens` here is an upper bound, not a limit on what comes back,
 *  and for always-on reasoners the reasoning tokens are billed too. Nothing in
 *  this body bounds generation (no `stop`, no early abort), so the probe is
 *  free only when the gateway rejects it. */
const MODEL_PROBE_BODY = JSON.stringify({
	model: "MODEL_ID", // replaced by probeModelLimits
	messages: [{ role: "user", content: "hi" }],
	max_tokens: 99_999_999,
	stream: false,
});

export type ModelLimitsProbe =
	| { status: "capped"; maxTokens?: number; message: string }
	| { status: "uncapped" }
	| { status: "invalid-key" }
	| { status: "unknown-model" }
	| { status: "error"; reason: string };

/** Parse a cap out of a gateway rejection message. Verified formats
 *  (2026-09-19): GLM `限制数值范围[1,131072]`, Qwen `Range of max_tokens should
 *  be [1, 131072]`, MiniMax `does not support max tokens > 196608`, ERNIE
 *  `max_completion_tokens [1, 12288]`, Baichuan `must be between 1 and 32000`.
 *  Returns undefined when the message names no cap. */
export function parseMaxTokensCap(message: string): number | undefined {
	const patterns = [/[\[（(]\s*1\s*,\s*(\d{4,})\s*[\]）)]/, /(?:>|超过|between\s+1\s+and)\s*(\d{4,})/i];
	for (const re of patterns) {
		const m = message.match(re);
		if (m) {
			const value = Number(m[1]);
			if (Number.isSafeInteger(value) && value >= 1024) return value;
		}
	}
	return undefined;
}

/**
 * Zero- (or at most one-) token probe of a model's output cap: send
 * `max_tokens: 99_999_999` with a single "hi" message and classify the reply:
 * - 400 with a cap in the message ⇒ the enforced limit (free: rejected
 *   before inference)
 * - 200 ⇒ the upstream enforces no cap (at most 1 output token is billed)
 * - 401/403 ⇒ the key was rejected, not the probe
 * - 404/400 "does not exist" ⇒ the model is unknown to the gateway
 * Never throws; never logs the key.
 */
export async function probeModelLimits(
	id: string,
	options: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number },
): Promise<ModelLimitsProbe> {
	const baseUrl = options.baseUrl ?? resolveBaseUrl();
	const body = MODEL_PROBE_BODY.replace("MODEL_ID", JSON.stringify(id).slice(1, -1));
	const { signal, done } = connectSignals(options.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS, options.signal);
	try {
		const response = await (options.fetchImpl ?? defaultFetch)(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
			body,
			signal,
		});
		if (response.status === 401 || response.status === 403) return { status: "invalid-key" };
		if (response.status === 404) return { status: "unknown-model" };
		if (response.ok) return { status: "uncapped" };
		// The gateway returns JSON error bodies, but tolerate plain text too.
		const text = await response
			.json()
			.then((data) => JSON.stringify(data))
			.catch(async () => {
				try {
					return await response.text();
				} catch {
					return "";
				}
			});
		if (/model.*(not exist|does not exist|未找到|不存在)/i.test(text)) return { status: "unknown-model" };
		const cap = parseMaxTokensCap(text);
		return cap !== undefined
			? { status: "capped", maxTokens: cap, message: text.slice(0, 400) }
			: { status: "capped", message: text.slice(0, 400) };
	} catch (error) {
		return { status: "error", reason: errorMessage(error) };
	} finally {
		done();
	}
}

// ---------------------------------------------------------------------------
// endpoint detection (probe before switching)
// ---------------------------------------------------------------------------

const ENDPOINT_PROBE_TIMEOUT_MS = 25_000;

export type EndpointProbe =
	| { status: "ok"; models: number }
	/** Alive, but demanded auth and no key was supplied. */
	| { status: "reachable" }
	/** Alive, but rejected the supplied key (401/403). */
	| { status: "auth" }
	/** Answered, but not like a gateway /v1/models listing. */
	| { status: "unexpected"; reason: string }
	| { status: "unreachable"; reason?: string };

/**
 * Cheap GET proving a candidate endpoint resolves and serves the key —
 * `GET {url}/models`. 200 + `{data:[…]}` ⇒ ok; 401/403 ⇒ alive but the key is
 * not accepted there (or missing); anything else is classified, never thrown.
 * Does not log the key.
 */
export async function probeBaseUrl(
	url: string,
	options: { apiKey?: string; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EndpointProbe> {
	const { signal, done } = connectSignals(options.timeoutMs ?? ENDPOINT_PROBE_TIMEOUT_MS, options.signal);
	try {
		const headers: Record<string, string> = {};
		if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
		const response = await (options.fetchImpl ?? defaultFetch)(`${url}/models`, { headers, signal });
		if (response.status === 401 || response.status === 403) {
			return options.apiKey ? { status: "auth" } : { status: "reachable" };
		}
		if (!response.ok) return { status: "unexpected", reason: `HTTP ${response.status}` };
		const data = (await response.json().catch(() => null)) as { data?: unknown } | null;
		if (!data || !Array.isArray(data.data)) {
			return { status: "unexpected", reason: "response is not a /v1/models listing" };
		}
		return { status: "ok", models: data.data.length };
	} catch (error) {
		return { status: "unreachable", reason: errorMessage(error) };
	} finally {
		done();
	}
}

export function describeProbe(
	probe: EndpointProbe,
	url: string,
): { message: string; type: "info" | "warning" | "error" } {
	switch (probe.status) {
		case "ok":
			return {
				message: `${url} is LIVE — GET /models returned ${probe.models} models with the current key.`,
				type: "info",
			};
		case "reachable":
			return {
				message: `${url} is reachable but demands a key (401 before auth). No key resolved — set one to verify fully.`,
				type: "warning",
			};
		case "auth":
			return { message: `${url} is reachable but REJECTED the current key (401/403).`, type: "error" };
		case "unexpected":
			return { message: `${url} responded unexpectedly: ${probe.reason}.`, type: "warning" };
		case "unreachable":
			return { message: `${url} did not respond: ${probe.reason ?? "network error"}.`, type: "error" };
	}
}

export interface CustomEndpointOptions {
	fetchImpl?: typeof fetch;
	/** Persist + in-place rebind once the user accepts a candidate. */
	onPersist: (url: string) => void;
}

/**
 * Login-flow endpoint switcher. Prompts for a URL, probes it with the candidate
 * key, and only persists + rebinds after the probe passes or the user accepts
 * the verdict. Returns the new URL, or undefined to keep the current one.
 */
export async function promptCustomEndpoint(
	interaction: ProviderAuthInteraction,
	currentUrl: string,
	apiKey: string | undefined,
	options: CustomEndpointOptions,
): Promise<string | undefined> {
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	urlLoop: while (true) {
		const raw = (
			await interaction.prompt({
				type: "text",
				message: "Endpoint URL (default https://llmapi.paratera.com/v1) — empty to keep current",
				placeholder: currentUrl,
			})
		).trim();
		if (!raw) return undefined;
		const normalized = normalizeBaseUrl(raw);
		if (!normalized) {
			interaction.notify({ type: "info", message: `"${raw}" is not a valid http(s) URL — try again.` });
			continue urlLoop;
		}
		if (normalized === currentUrl) return undefined;
		interaction.notify({ type: "progress", message: `Probing ${normalized} …` });
		const probe = await probeBaseUrl(normalized, { apiKey, fetchImpl, signal: interaction.signal });
		if (probe.status === "ok") {
			options.onPersist(normalized);
			interaction.notify({
				type: "info",
				message: `Endpoint verified: GET /models → 200 (${probe.models} models).`,
			});
			return normalized;
		}
		const described = describeProbe(probe, normalized);
		interaction.notify({ type: "info", message: described.message });
		const choice = await interaction.prompt({
			type: "select",
			message: "This endpoint is not verified. What next?",
			options: [
				{ id: "use", label: "Use it anyway", description: "Save and continue with this endpoint" },
				{ id: "another", label: "Enter a different URL…" },
				{ id: "keep", label: "Keep the current endpoint", description: currentUrl },
			],
		});
		if (choice === "use") {
			options.onPersist(normalized);
			return normalized;
		}
		if (choice === "keep") return undefined;
		// another → loop
	}
}

async function resolveKey(ctx: AuthContext, credential?: ApiKeyCredential) {
	const stored = credential?.key?.trim();
	if (stored) return { key: stored, source: "stored credential (Pi auth.json)" };
	const fromEnv = (await ctx.env(API_KEY_ENV))?.trim();
	if (fromEnv) return { key: fromEnv, source: `$${API_KEY_ENV}` };
	return undefined;
}

// ---------------------------------------------------------------------------
// transport hardening for inference streams (undici dispatcher)
// ---------------------------------------------------------------------------

interface PiUndici {
	Dispatcher: new () => unknown;
	getGlobalDispatcher(): unknown;
	setGlobalDispatcher(dispatcher: unknown): void;
}

/**
 * Resolve pi's OWN undici copy. This extension has its own node_modules, so
 * importing "undici" here would get a different instance whose
 * `setGlobalDispatcher` does not affect pi's fetch. We load it from pi's entry
 * point instead, so the dispatcher we install is the one pi's fetch consults.
 */
export function resolvePiUndici(): { undici?: PiUndici; error?: string } {
	const candidates: string[] = [];
	if (process.argv[1]) {
		candidates.push(process.argv[1]);
		try {
			candidates.push(realpathSync(process.argv[1]));
		} catch {
			// no real path — try argv[1] as-is
		}
	}
	const main = (process as unknown as { mainModule?: { filename?: string } }).mainModule;
	if (main?.filename) candidates.push(main.filename);
	for (const base of candidates) {
		try {
			const undici = createRequire(base)("undici") as PiUndici | undefined;
			if (undici?.Dispatcher && typeof undici.setGlobalDispatcher === "function") return { undici };
		} catch {
			// try the next base
		}
	}
	return { error: `undici not resolvable from: ${candidates.join(", ") || "(no entrypoint)"}` };
}

/**
 * Install (idempotently) the connect-retry dispatcher scoped to a gateway
 * origin. Returns a status string for diagnostics; never throws. Safe to call
 * on every request — `ensureTransportInstalled` no-ops once installed.
 */
function installTransportForOrigin(baseUrl: string): { installed: boolean; already?: boolean; error?: string } {
	if (transportRetryDisabled()) return { installed: false };
	try {
		guardOrigin(baseUrl);
		const { undici, error } = resolvePiUndici();
		if (!undici) return { installed: false, error };
		const DispatcherBase = undici.Dispatcher;
		const deps: DispatcherDeps = {
			getGlobalDispatcher: () => undici.getGlobalDispatcher(),
			setGlobalDispatcher: (d) => undici.setGlobalDispatcher(d),
			adapt: (duck: SelectiveDispatcherHandle) => {
				class ParateraDispatcher extends (DispatcherBase as unknown as new () => DispatchTarget) {
					dispatch(opts: unknown, handler: unknown): boolean {
						return duck.dispatch(opts, handler);
					}
					close(): Promise<void> {
						return duck.close();
					}
					destroy(): Promise<void> {
						return duck.destroy();
					}
				}
				const instance = new ParateraDispatcher();
				markDispatcher(instance);
				return instance;
			},
		};
		const result = ensureTransportInstalled(deps, {
			config: DEFAULT_CONNECT_RETRY,
			onRetry: ({ attempt, code, delayMs }) => {
				lastTransportRetry = { attempt, code, delayMs, at: Date.now() };
			},
		});
		return { installed: result.installed, already: result.already };
	} catch (err) {
		return { installed: false, error: errorMessage(err) };
	}
}

/** Last transparent connect-retry, surfaced by `/paratera transport status`. */
let lastTransportRetry: { attempt: number; code: string; delayMs: number; at: number } | undefined;
export function getLastTransportRetry(): typeof lastTransportRetry {
	return lastTransportRetry;
}

// ---------------------------------------------------------------------------
// provider factory
// ---------------------------------------------------------------------------

export interface ParateraGatewayOptions {
	/** Static initial URL (tests); when omitted the factory resolves
	 *  env > settingsFile > default dynamically at every use. */
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	/** Settings file so the login flow can persist an endpoint switch. */
	settingsFile?: string;
	/** Called after the provider persists settings (endpoint switch, probed
	 *  caps) — the entrypoint syncs its own settings copy. */
	onSettingsSaved?: (settings: ParateraSettings) => void;
}

export function createParateraGatewayProvider(options: ParateraGatewayOptions = {}) {
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const settingsFile = options.settingsFile;
	let savedSettings: ParateraSettings | undefined = settingsFile ? loadSettings(settingsFile) : undefined;
	/** Endpoint chosen during this process (login switch / url command) —
	 *  wins until restart, where env > settings > default applies again. */
	let sessionOverride: string | undefined;

	const currentBaseUrl = (): string =>
		sessionOverride ?? options.baseUrl ?? resolveBaseUrl(process.env, savedSettings);

	/** True when the endpoint URL changed since the caller captured one. */
	const baseUrlChanged = (captured: string): boolean => currentBaseUrl() !== captured;

	const provider = createProvider<GatewayApi>({
		id: PROVIDER_ID,
		name: "PARATERA MaaS",
		baseUrl: currentBaseUrl(),
		auth: {
			apiKey: {
				name: "PARATERA MaaS API key",
				async login(interaction) {
					const url = currentBaseUrl();
					interaction.notify({
						type: "info",
						message: `Gateway endpoint: ${url} — use the sk-… key from your paratera MaaS console (ai.paratera.com). Wrong endpoint? You can switch it below if the key is rejected.`,
					});
					const changeEndpoint = async (key: string): Promise<boolean> => {
						const next = await promptCustomEndpoint(interaction, url, key, {
							fetchImpl,
							onPersist: persistEndpoint,
						});
						if (!next) return false;
						if (process.env[BASE_URL_ENV]?.trim()) {
							interaction.notify({
								type: "info",
								message: `Note: $${BASE_URL_ENV} wins again on next start; the saved endpoint applies when the env is unset. This session already uses the new one.`,
							});
						}
						return true;
					};
					keyPrompt: while (true) {
						const key = (
							await interaction.prompt({
								type: "secret",
								message: "PARATERA MaaS API key (sk-… from ai.paratera.com)",
							})
						).trim();
						if (!key) continue keyPrompt;
						validateLoop: while (true) {
							// The endpoint may have just been switched by `changeEndpoint`
							// (the provider is already re-bound to it), so never validate
							// against a stale captured URL — resolve the effective base URL
							// on every pass.
							const effectiveUrl = baseUrlChanged(url) ? currentBaseUrl() : url;
							interaction.notify({ type: "progress", message: `Validating key against ${effectiveUrl} …` });
							const result = await validateGatewayKey(key, {
								baseUrl: effectiveUrl,
								fetchImpl,
								signal: interaction.signal,
							});
							if (result.status === "valid") {
								interaction.notify({ type: "info", message: "API key validated." });
								return { type: "api_key", key };
							}
							if (result.status === "invalid") {
								const choice = await interaction.prompt({
									type: "select",
									message:
										"The gateway rejected this key (401/403). What next?",
									options: [
										{ id: "rekey", label: "Re-enter the API key", description: url },
										{
											id: "reurl",
											label: "Change the endpoint URL…",
											description: "Probed before saving; the key is then re-validated against it",
										},
									],
								});
								if (choice === "reurl" && (await changeEndpoint(key))) continue validateLoop;
								continue keyPrompt;
							}
							const choice = await interaction.prompt({
								type: "select",
								message: `Gateway unreachable (${result.reason ?? "network error"}). What would you like to do?`,
								options: [
									{ id: "retry", label: "Retry validation" },
									{
										id: "reurl",
										label: "Change the endpoint URL…",
										description: "Maybe the default endpoint is not yours",
									},
									{ id: "save", label: "Save without validating" },
								],
							});
							if (choice === "save") return { type: "api_key", key };
							if (choice === "reurl" && (await changeEndpoint(key))) continue validateLoop;
							// retry: validate the same key against the same URL again
						}
					}
				},
				async check({ ctx, credential }) {
					const resolved = await resolveKey(ctx, credential);
					return resolved ? { type: "api_key", source: resolved.source } : undefined;
				},
				async resolve({ ctx, credential }) {
					const resolved = await resolveKey(ctx, credential);
					if (!resolved) return undefined;
					return { auth: { apiKey: resolved.key }, source: resolved.source };
				},
			},
		},
		models: buildModels(currentBaseUrl()),
		fetchModels: (context) =>
			fetchGatewayModels(context, currentBaseUrl(), fetchImpl, savedSettings?.maxTokens ?? {}),
		api: {
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});

	/**
	 * In-place rebind: pi's Models keeps the very object references returned by
	 * getModels() (no cloning/freezing), so mutating baseUrl redirects
	 * subsequent requests without a /reload the login interaction cannot trigger.
	 */
	function rebindBaseUrl(url: string): void {
		sessionOverride = url;
		(provider as { baseUrl?: string }).baseUrl = url;
		for (const model of provider.getModels()) (model as { baseUrl: string }).baseUrl = url;
	}

	/** Persist to the settings store, rebind live models, sync the entrypoint. */
	function persistEndpoint(url: string): void {
		rebindBaseUrl(url);
		if (settingsFile) {
			savedSettings = saveSettings({ baseUrl: url }, settingsFile);
			options.onSettingsSaved?.(savedSettings);
		}
	}

	/** Persist a measured output cap so future catalog merges apply it over
	 *  the family default, and upgrade the live model entry right away. */
	function persistMeasuredCap(id: string, maxTokens: number): void {
		if (settingsFile) {
			savedSettings = saveSettings({ maxTokens: { [id]: maxTokens } }, settingsFile);
			options.onSettingsSaved?.(savedSettings);
		}
		for (const model of provider.getModels()) {
			if (model.id === id) (model as { maxTokens: number }).maxTokens = maxTokens;
		}
	}

	return Object.assign(provider, { rebindBaseUrl, persistEndpoint, persistMeasuredCap });
}

// ---------------------------------------------------------------------------
// context-overflow normalization (message_end)
// ---------------------------------------------------------------------------

const CONTEXT_OVERFLOW_RE =
	/context_length_exceeded|Prompt exceeds max length|exceed max message tokens|Total tokens of image and text exceed|Input tokens exceed|输入 tokens 配额|exceed(?:s|ed)?[^.\n]{0,60}context|Range of (?:input|prompt) length|max_tokens参数非法|超出限制|超过.*长度/i;
const RATE_LIMIT_RE =
	/rate.?limit|too many requests|requests per (?:second|minute)|all candidate slots are busy|TPM\/RPM limit|\bquota\b|\b429\b/i;

/**
 * Maps gateway overflow errors onto pi's `context_length_exceeded` marker so
 * auto-compaction kicks in. Returns the rewritten message text, or null when
 * the error is not an overflow (rate limits must never trigger compaction —
 * this gateway emits both "all candidate slots are busy" and
 * "Deployment over defined TPM/RPM limit", which are transient, not overflows).
 */
export function normalizeOverflowError(errorMessage: string): string | null {
	if (!errorMessage) return null;
	if (errorMessage.startsWith("context_length_exceeded")) return null; // idempotent
	if (RATE_LIMIT_RE.test(errorMessage)) return null;
	if (!CONTEXT_OVERFLOW_RE.test(errorMessage)) return null;
	return `context_length_exceeded: ${errorMessage}`;
}

// ---------------------------------------------------------------------------
// extension entry point (provider + hooks + /paratera settings command)
// ---------------------------------------------------------------------------

/** Routes that accepted `prompt_cache_retention:"24h"` (probe 2026-09-19):
 *  every catalog entry, verified per family on both APIs. */
export const RETENTION_MODELS: ReadonlySet<string> = new Set(CATALOG.map((m) => m.id));

const STATUS_KEY = "paratera";

/** Structural subset of pi's ExtensionContext/ExtensionCommandContext — keeps
 *  this module testable with plain fakes. */
export interface ParateraCtx {
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		select(title: string, options: string[]): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
	};
	model: { id: string; provider: string; api?: string } | undefined;
	signal: AbortSignal | undefined;
	modelRegistry: {
		getAll(): readonly { id: string; provider: string }[];
		getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string };
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
		refresh(options?: {
			allowNetwork?: boolean;
			providers?: readonly string[];
			force?: boolean;
			signal?: AbortSignal;
		}): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
	};
	sessionManager?: { getSessionId(): string };
}

export interface ParateraExtensionOptions {
	/** Settings file override (tests); default <agentDir>/paratera.json. */
	settingsFile?: string;
	/** fetch override (tests) used by the key-check command. */
	fetchImpl?: typeof fetch;
	/** Install the undici connect-retry dispatcher for inference streams.
	 *  Defaults to true in pi; tests pass false so the global dispatcher of the
	 *  test process is never mutated. */
	installTransport?: boolean;
}

export default function paratera(pi: ExtensionAPI, options: ParateraExtensionOptions = {}): void {
	const settingsFile = options.settingsFile ?? settingsPath();
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	let settings: ParateraSettings = loadSettings(settingsFile);

	function effectiveCacheRetention(): { mode: CacheRetentionMode; source: "env" | "settings" } {
		// PI_CACHE_RETENTION=long (pi-wide env) wins; the setting covers the
		// gateway models even when the env is not set.
		if (process.env.PI_CACHE_RETENTION?.trim().toLowerCase() === "long") return { mode: "long", source: "env" };
		return { mode: settings.cacheRetention, source: "settings" };
	}

	function endpoint(): { url: string; source: "env" | "settings" | "default" } {
		return { url: resolveBaseUrl(process.env, settings), source: baseUrlSource(process.env, settings) };
	}

	function updateStatusWidget(ctx: ParateraCtx): void {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		if (!model || model.provider !== PROVIDER_ID) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const { mode } = effectiveCacheRetention();
		// Append the last transparent connect-retry when one happened recently
		// (within 10 minutes) — the status line is the only glanceable surface
		// for transport activity short of /paratera transport status.
		const last = getLastTransportRetry();
		const recent = last && Date.now() - last.at < 10 * 60_000;
		const retryNote = recent ? ` ·retry:${last.code}` : "";
		ctx.ui.setStatus(STATUS_KEY, `para:cache-${mode}${retryNote}`);
	}

	// Declared before the provider factory so the onEndpointSaved closure below
	// never reads them in the temporal dead zone.
	const transportEnabled = options.installTransport !== false;
	let transportStatus: { installed: boolean; already?: boolean; error?: string } = { installed: false };

	const provider = createParateraGatewayProvider({
		fetchImpl,
		settingsFile,
		onSettingsSaved: (s) => {
			settings = s; // keep the entrypoint copy (status/widget/endpoint) in sync
			// A new endpoint means a new origin: guard it so inference streams to
			// it also get transparent connect retries (the old origin stays
			// guarded, which is harmless — it is simply no longer dialed).
			if (transportEnabled) {
				// installTransportForOrigin guards the new origin itself
				// (before any fail-open early return) and is idempotent.
				transportStatus = installTransportForOrigin(endpoint().url);
			}
		},
	});
	// Install the undici connect-retry dispatcher scoped to the effective
	// endpoint before the first request. Fail-open: any error is recorded for
	// `/paratera transport status` and never blocks provider registration.
	// Governed by options.installTransport so tests never mutate the process-
	// global dispatcher.
	if (transportEnabled) {
		// installTransportForOrigin guards the effective origin itself
		// (before any fail-open early return) and is idempotent.
		transportStatus = installTransportForOrigin(endpoint().url);
	}
	pi.registerProvider(provider);

	pi.on("before_provider_request", (event, ctx) => {
		const payload = applyCacheRetention(event.payload, {
			enabled: effectiveCacheRetention().mode === "long",
			supportedModels: RETENTION_MODELS,
			sessionId: (ctx as ParateraCtx)?.sessionManager?.getSessionId?.(),
		});
		return payload === undefined ? undefined : (payload as typeof event.payload);
	});

	pi.on("cache_warming_decision", (_event, ctx) => {
		// Only override for our own models: warming a 24h prefix cache is
		// near-free here (gateway reports $0, retention verified on all 65
		// models), so pi's default cost-based "stop" would be too conservative.
		// When retention is not long we return undefined and keep pi's decision.
		if ((ctx as ParateraCtx)?.model?.provider !== PROVIDER_ID) return;
		if (effectiveCacheRetention().mode === "long") return { action: "warm" as const };
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (!message || message.role !== "assistant" || message.stopReason !== "error") return;
		// Provider is taken from the MESSAGE; ctx.model is only a fallback for
		// legacy messages that omit it. Treating ctx.model as an OR-condition
		// would let us rewrite another provider's error whenever paratera
		// happens to be the selected model.
		if ((message.provider ?? ctx?.model?.provider) !== PROVIDER_ID) return;
		const rewritten = normalizeOverflowError(message.errorMessage ?? "");
		if (rewritten === null) return;
		return { message: { ...message, errorMessage: rewritten } };
	});

	pi.on("session_start", (_event, ctx) => updateStatusWidget(ctx as ParateraCtx));
	pi.on("model_select", (_event, ctx) => updateStatusWidget(ctx as ParateraCtx));
	pi.on("thinking_level_select", (_event, ctx) => updateStatusWidget(ctx as ParateraCtx));

	// ── /paratera subcommands ─────────────────────────────────────────────

	const cmdStatus = async (_args: string, ctx: ParateraCtx): Promise<void> => {
		const auth = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
		const all = ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER_ID);
		const { mode, source } = effectiveCacheRetention();
		const current = ctx.model
			? ctx.model.provider === PROVIDER_ID
				? `${ctx.model.id} (${ctx.model.api})`
				: `${ctx.model.provider}/${ctx.model.id} (other provider)`
			: "none";
		const responses = provider.getModels().filter((m) => m.api === "openai-responses").length;
		ctx.ui.notify(
			[
				"paratera (PARATERA MaaS · LiteLLM gateway)",
				`base URL: ${endpoint().url} (${endpoint().source})`,
				auth.configured
					? `key: configured (${auth.source ?? "unknown source"})`
					: `key: MISSING — /login paratera or $${API_KEY_ENV}`,
				`cache retention: ${mode} (${source === "env" ? "PI_CACHE_RETENTION=long" : settingsFile})`,
				`models: ${all.length} registered (${responses} on the Responses API)`,
				`current: ${current}`,
				"cost: reported as $0 — this gateway exposes no per-model price",
			].join("\n"),
			"info",
		);
	};

	const cmdCache = async (args: string, ctx: ParateraCtx): Promise<void> => {
		const parsed = parseCacheArg(args);
		if (parsed === undefined) {
			ctx.ui.notify(`Unknown cache mode "${args.trim()}" — use: cache [on|off|status]`, "warning");
			return;
		}
		if (parsed === "status") {
			const { mode, source } = effectiveCacheRetention();
			ctx.ui.notify(
				[
					`cache retention: ${mode} (${source === "env" ? "PI_CACHE_RETENTION=long env" : `settings: ${settingsFile}`})`,
					`supported routes (${RETENTION_MODELS.size}): every catalog model accepted prompt_cache_retention:"24h"`,
				].join("\n"),
				"info",
			);
			return;
		}
		settings = saveSettings({ cacheRetention: parsed }, settingsFile);
		const envLong = process.env.PI_CACHE_RETENTION?.trim().toLowerCase() === "long";
		const note = parsed === "short" && envLong ? " — note: PI_CACHE_RETENTION=long env still forces 24h" : "";
		ctx.ui.notify(
			`${parsed === "long" ? "24h cache retention enabled" : "Cache retention back to pi defaults"} (saved to ${settingsFile})${note}`,
			"info",
		);
		updateStatusWidget(ctx);
	};

	const cmdKeys = async (args: string, ctx: ParateraCtx): Promise<void> => {
		const sub = args.trim().toLowerCase();
		if (sub !== "check") {
			ctx.ui.notify(
				sub ? `Unknown keys subcommand "${sub}" — use: keys check` : "Usage: keys check — validate the resolved gateway key",
				"warning",
			);
			return;
		}
		const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
		if (!key) {
			ctx.ui.notify(`No API key resolved — run /login paratera or set $${API_KEY_ENV}`, "warning");
			return;
		}
		ctx.ui.notify("Checking key against the gateway (zero-inference probe)…", "info");
		const result = await validateGatewayKey(key, { baseUrl: endpoint().url, fetchImpl, signal: ctx.signal });
		if (result.status === "valid") {
			ctx.ui.notify("Gateway key is VALID (authenticated; empty-body probe).", "info");
		} else if (result.status === "invalid") {
			ctx.ui.notify("Gateway REJECTED the key (401/403) — re-run /login paratera.", "error");
		} else {
			ctx.ui.notify(`Gateway unreachable (${result.reason ?? "network error"}) — key validity unknown.`, "warning");
		}
	};

	const cmdModels = async (args: string, ctx: ParateraCtx): Promise<void> => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const sub = (parts[0] ?? "").toLowerCase();
		if (sub === "probe") {
			const id = parts.slice(1).join(" ");
			if (!id) {
				ctx.ui.notify("Usage: models probe <id> — output-cap probe of one model (free only when the gateway rejects it pre-inference)", "warning");
				return;
			}
			const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			if (!key) {
				ctx.ui.notify(`No API key resolved — run /login paratera or set $${API_KEY_ENV}`, "warning");
				return;
			}
			ctx.ui.notify(`Probing ${id} (max_tokens:99999999 — free if the gateway rejects pre-inference; an uncapped model generates a billed completion)…`, "info");
			const probe = await probeModelLimits(id, { apiKey: key, baseUrl: endpoint().url, fetchImpl, signal: ctx.signal });
			if (probe.status === "capped" && probe.maxTokens !== undefined) {
				provider.persistMeasuredCap(id, probe.maxTokens);
				ctx.ui.notify(
					`${id}: enforced max output is ${probe.maxTokens.toLocaleString("en-US")} tokens (gateway: "${probe.message.trim()}") — saved; future catalog merges apply it over the family default.`,
					"info",
				);
			} else if (probe.status === "capped") {
				ctx.ui.notify(
					`${id}: rejected with a cap the parser could not read — see the raw message: "${probe.message.trim()}"`,
					"warning",
				);
			} else if (probe.status === "uncapped") {
				ctx.ui.notify(
					`${id}: accepted max_tokens:99999999 — no upstream cap. A real completion was generated and billed for this probe.`,
					"info",
				);
			} else if (probe.status === "invalid-key") {
				ctx.ui.notify(`${id}: the gateway rejected the key (401/403) — re-run /login paratera.`, "error");
			} else if (probe.status === "unknown-model") {
				ctx.ui.notify(`${id}: the gateway does not know this model (404 / does not exist).`, "warning");
			} else {
				ctx.ui.notify(`${id}: probe failed (${probe.reason}) — endpoint unreachable?`, "warning");
			}
			return;
		}
		if (sub !== "refresh") {
			ctx.ui.notify(
				sub
					? `Unknown models subcommand "${sub}" — use: models refresh | models probe <id>`
					: "Usage: models refresh | models probe <id>",
				"warning",
			);
			return;
		}
		ctx.ui.notify("Refreshing catalog from GET /v1/models…", "info");
		const result = await ctx.modelRegistry.refresh({
			allowNetwork: true,
			providers: [PROVIDER_ID],
			force: true,
			signal: ctx.signal,
		});
		const error = result.errors.get(PROVIDER_ID);
		const count = ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER_ID).length;
		if (error) {
			ctx.ui.notify(`Catalog refresh failed (${error.message}) — kept previous catalog (${count} models).`, "warning");
		} else {
			ctx.ui.notify(`Catalog refreshed: ${count} models registered for ${PROVIDER_ID}.`, "info");
		}
	};

	const cmdUrl = async (args: string, ctx: ParateraCtx): Promise<void> => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const sub = (parts[0] ?? "status").toLowerCase();
		const value = parts.slice(1).join(" ");

		if (sub === "status") {
			const ep = endpoint();
			ctx.ui.notify(
				[
					`endpoint: ${ep.url}`,
					`source: ${ep.source}${ep.source === "env" ? ` ($${BASE_URL_ENV})` : ep.source === "settings" ? ` (${settingsFile})` : " (built-in default)"}`,
					settings.baseUrl && ep.source === "env" ? `saved override (shadowed by env): ${settings.baseUrl}` : "",
					"probe with: /paratera url check [https://…]",
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
			return;
		}

		if (sub === "reset") {
			if (!settings.baseUrl) {
				ctx.ui.notify(`No saved endpoint override — already using ${endpoint().url} (${endpoint().source}).`, "info");
				return;
			}
			const previous = settings.baseUrl;
			settings = saveSettings({ baseUrl: null }, settingsFile);
			provider.rebindBaseUrl(endpoint().url);
			if (transportEnabled && previous) unguardOrigin(previous); // stop retry-guarding the abandoned origin
			const ep = endpoint();
			ctx.ui.notify(`Override cleared — now using ${ep.url} (${ep.source}), bound in-place.`, "info");
			return;
		}

		if (sub !== "set" && sub !== "check") {
			ctx.ui.notify(
				sub === "url" || !sub
					? "Usage: url [status|set <https://…>|check <https://…>|reset]"
					: `Unknown url subcommand "${sub}" — use: status, set, check, reset`,
				"warning",
			);
			return;
		}

		let candidate = value;
		if (!candidate) {
			if (sub === "check") {
				candidate = endpoint().url; // bare `url check` probes the effective endpoint
			} else if (!ctx.hasUI) {
				ctx.ui.notify("Usage: url set <https://…> (interactive prompt needs the TUI)", "warning");
				return;
			} else {
				candidate = (await ctx.ui.input("PARATERA gateway base URL:", endpoint().url)) ?? "";
			}
		}
		const normalized = normalizeBaseUrl(candidate);
		if (!normalized) {
			ctx.ui.notify(
				`Invalid endpoint URL ${JSON.stringify(candidate.trim())} — expected https://… (default ${DEFAULT_BASE_URL})`,
				"warning",
			);
			return;
		}
		if (sub === "set" && normalized === endpoint().url && endpoint().source !== "settings") {
			ctx.ui.notify(`${normalized} is already the effective endpoint (${endpoint().source}) — nothing to save.`, "info");
			return;
		}

		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
		ctx.ui.notify(`Probing ${normalized} …`, "info");
		const probe = await probeBaseUrl(normalized, { apiKey, fetchImpl, signal: ctx.signal });

		if (sub === "check") {
			const described = describeProbe(probe, normalized);
			ctx.ui.notify(described.message, described.type);
			return;
		}

		if (probe.status === "ok") {
			provider.persistEndpoint(normalized);
			ctx.ui.notify(
				`Endpoint verified (GET /models → 200, ${probe.models} models), saved to ${settingsFile} and bound in-place.`,
				"info",
			);
			noteEnvShadow(ctx);
			return;
		}

		const described = describeProbe(probe, normalized);
		const question = `${described.message} Save it anyway?`;
		if (!ctx.hasUI) {
			ctx.ui.notify(`${question} (answer in the TUI, or ${envSetHint(BASE_URL_ENV, normalized)})`, described.type);
			return;
		}
		const save = await ctx.ui.confirm("Unverified endpoint", question);
		if (!save) {
			ctx.ui.notify("Endpoint NOT saved — keeping " + endpoint().url, "info");
			return;
		}
		provider.persistEndpoint(normalized);
		ctx.ui.notify(`Saved WITHOUT verification and bound in-place.`, "warning");
		noteEnvShadow(ctx);
	};

	function noteEnvShadow(ctx: ParateraCtx): void {
		if (process.env[BASE_URL_ENV]?.trim()) {
			ctx.ui.notify(
				`Note: $${BASE_URL_ENV} env override wins again on next start; the saved endpoint applies when the env is unset. This session already uses the saved one.`,
				"warning",
			);
		}
	}

	const cmdTransport = async (args: string, ctx: ParateraCtx): Promise<void> => {
		const sub = args.trim().toLowerCase();
		if (sub === "off") {
			setTransportRetryEnabled(false);
			ctx.ui.notify(
				"Connect retries disabled for this session. To keep them off across restarts, set PARATERA_TRANSPORT_RETRY=off.",
				"info",
			);
			return;
		}
		if (sub === "on") {
			setTransportRetryEnabled(true);
			if (!transportEnabled) {
				ctx.ui.notify("Connect retries re-enabled (dispatcher install is disabled in this host).", "info");
				return;
			}
			const res = installTransportForOrigin(endpoint().url);
			transportStatus = res;
			ctx.ui.notify(
				res.error
					? `Connect retries re-enabled, but the dispatcher could not be installed (${res.error}). Control-plane fetches still retry.`
					: `Connect retries re-enabled${res.installed ? " and dispatcher installed" : res.already ? " (dispatcher already installed)" : ""}.`,
				res.error ? "warning" : "info",
			);
			return;
		}
		if (sub && sub !== "status") {
			ctx.ui.notify(
				`Unknown transport subcommand "${sub}" — use: transport [status|on|off]`,
				"warning",
			);
			return;
		}
		const disabled = transportRetryDisabled();
		const last = getLastTransportRetry();
		ctx.ui.notify(
			[
				"transport: transparent connect-retry for the flaky China-hosted endpoint",
				`retries: ${disabled ? "DISABLED" : "enabled"}${disabled ? (transportRetryDisabled() && !process.env.PARATERA_TRANSPORT_RETRY ? " (session override)" : " (PARATERA_TRANSPORT_RETRY)") : ""}`,
				`dispatcher: ${transportStatus.installed ? "installed" : transportStatus.already ? "already installed" : `not installed${transportStatus.error ? ` — ${transportStatus.error}` : ""}`}`,
				`control-plane fetch: ${disabled ? "no retry" : "retries connect errors"} (validateKey / probe / models refresh)`,
				`inference streams: ${disabled || (!transportStatus.installed && !transportStatus.already) ? "no retry (dispatcher not active)" : "retries connect errors"}`,
				last
					? `last retry: attempt ${last.attempt} on ${last.code}, waited ${Math.round(last.delayMs)}ms (${new Date(last.at).toISOString()})`
					: "last retry: none this session",
				`backoff: up to ${DEFAULT_CONNECT_RETRY.maxRetries} retries, ${DEFAULT_CONNECT_RETRY.minDelayMs}–${DEFAULT_CONNECT_RETRY.maxDelayMs}ms`,
			].join("\n"),
			"info",
		);
	};

	const runners: Record<string, (args: string, ctx: ParateraCtx) => Promise<void>> = {
		status: cmdStatus,
		cache: cmdCache,
		url: cmdUrl,
		keys: cmdKeys,
		models: cmdModels,
		transport: cmdTransport,
	};

	pi.registerCommand("paratera", {
		description: "PARATERA MaaS settings: status, cache retention, endpoint URL, key check, catalog refresh, transport retry",
		getArgumentCompletions: (prefix: string) => completeArgs(prefix, parateraCommands()),
		handler: async (args: string, ctx: ParateraCtx) => {
			const trimmed = (args ?? "").trim();
			const [sub, ...rest] = trimmed.split(/\s+/).filter(Boolean);
			const run = sub ? runners[sub] : undefined;
			if (!run) {
				const list = parateraCommands().map(formatCommandLine).join("\n");
				ctx.ui.notify(sub ? `Unknown command "${sub}".\n/paratera:\n${list}` : `/paratera:\n${list}`, "info");
				return;
			}
			await run(rest.join(" "), ctx);
		},
	});
}

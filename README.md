# pi-paratera

Pi provider extension for the **PARATERA MaaS** gateway — 北京并行科技股份有限公司 / Beijing PARATERA Tech Corp., Ltd.

- **Endpoint:** `https://llmapi.paratera.com/v1` (shipped as the default; no configuration needed)
- **Gateway:** LiteLLM Proxy `1.89.0` behind istio-envoy (read from the public `/openapi.json`)
- **Console / keys:** `ai.paratera.com` → `sk-…`
- **Models:** 65 registered (33 on the OpenAI **Responses API**, 32 on **chat completions**)
- **Node:** ≥ 22.19, ESM, strict TypeScript, no build step — pi executes the `.ts` directly

## Install

```bash
pi install npm:pi-paratera     # or: git clone … && pi install ./pi-paratera
pi                             # then /login paratera and /model
```

Or set the key in the environment instead of `/login`:

```bash
export PARATERA_API_KEY=sk-…
```

## Commands

| Command | What it does |
|---|---|
| `/paratera status` | Base URL + source, key state, cache mode, catalog size, current model |
| `/paratera cache` `on` / `off` / `status` | Persist 24h prompt-cache retention (`prompt_cache_retention:"24h"`) |
| `/paratera url` `status` / `set` / `check` / `reset` | Probe and persist a custom endpoint (private/mirror deployments) |
| `/paratera keys check` | Validate the resolved key against the gateway, zero inference spent |
| `/paratera models refresh` | Force `GET /v1/models` and persist the overlay |

`/paratera url set` probes a candidate with `GET /models` **before** saving and rebinds live
models in place (pi keeps the same object references, so no `/reload` is needed).

Environment overrides: `PARATERA_API_KEY`, `PARATERA_BASE_URL`. The env base URL wins over the
persisted setting on every start; `PI_CACHE_RETENTION=long` forces 24h retention globally.

## Cost reporting

**Every model reports `$0.00`.** This gateway exposes no per-model price: `GET /v1/models`
returns only `id`/`object`/`created`/`owned_by` (no credit multiplier), and LiteLLM's admin
endpoints are closed to a normal key (`/model/info` → `RBAC: access denied`, `/key/info` → 404).
paratera bills in CNY per million tokens behind its console, so any number baked into this
extension would be invented. Token counts are accurate; money columns are not — check the
console for real spend.

## Models

Route legend: **Responses** = OpenAI Responses API (`/responses`), **Chat** = chat completions.
"always on" = thinking cannot be disabled (pi's `off` level is unavailable).
† = the gateway enforces no cap upstream, so this is a family default rather than a measured value.
Context/max-output come from the gateway's own enforced caps where it declares one — see
*Verified facts* below. 49 models have a **measured** cap (read from the gateway's free
pre-inference 400-errors); 16 accepted an absurd `max_tokens` and enforce no cap upstream, so
they carry a family default marked † below.

**DeepSeek**

| Model | Route | Thinking | Vision | Context | Max output |
|---|---|---|---|---:|---:|
| `DeepSeek-R1` | Chat | yes | — | 128,000 | 65,536 † |
| `DeepSeek-V3-250324` | Chat | — | — | 128,000 | 65,536 † |
| `DeepSeek-V3.1` | Chat | — | — | 128,000 | 65,536 † |
| `DeepSeek-V3.2` | Responses | — | — | 128,000 | 65,536 |
| `DeepSeek-V3.2-Instruct` | Responses | — | — | 128,000 | 65,536 |
| `DeepSeek-V4-Flash` | Responses | yes | — | 262,144 | 65,536 † |
| `DeepSeek-V4-Flash-0731` | Responses | yes | — | 262,144 | 65,536 † |
| `DeepSeek-V4-Flash-Vision-Exp` | Responses | yes | yes | 262,144 | 65,536 † |
| `DeepSeek-V4-Pro` | Responses | yes | — | 262,144 | 65,536 † |
| `DeepSeek-V4-Pro-0813` | Responses | yes | — | 262,144 | 65,536 † |
| `DeepSeek-V4.1-Flash` | Responses | yes | — | 262,144 | 65,536 † |

**GLM**

| Model | Route | Thinking | Vision | Context | Max output |
|---|---|---|---|---:|---:|
| `GLM-4-9B` | Chat | — | — | 131,072 | 131,072 † |
| `GLM-4-Air` | Chat | — | — | 131,072 | 98,304 |
| `GLM-4-AirX` | Chat | — | — | 131,072 | 98,304 |
| `GLM-4-Flash` | Chat | — | — | 131,072 | 131,072 † |
| `GLM-4-FlashX` | Chat | — | — | 131,072 | 131,072 † |
| `GLM-4-Long` | Chat | yes | — | 131,072 | 4,095 |
| `GLM-4-Plus` | Chat | — | — | 131,072 | 98,304 |
| `GLM-4.5` | Chat | yes | — | 131,072 | 131,072 |
| `GLM-4.5-Air` | Chat | yes | — | 131,072 | 98,304 |
| `GLM-4.5-AirX` | Chat | yes | — | 131,072 | 98,304 |
| `GLM-4.5-Flash` | Chat | yes | — | 131,072 | 98,304 |
| `GLM-4.5-X` | Chat | yes | — | 131,072 | 131,072 |
| `GLM-4.5V` | Chat | yes | yes | 131,072 | 16,384 |
| `GLM-4.6` | Chat | yes | — | 131,072 | 131,072 |
| `GLM-4.6V` | Chat | yes | yes | 131,072 | 32,768 |
| `GLM-4.7` | Chat | yes | — | 131,072 | 131,072 |
| `GLM-4V` | Chat | — | yes | 131,072 | 2,048 |
| `GLM-4V-Flash` | Chat | — | yes | 131,072 | 1,024 |
| `GLM-4V-Plus-0111` | Chat | — | yes | 131,072 | 8,192 |
| `GLM-5-Turbo` | Chat | yes | — | 196,608 | 131,072 |
| `GLM-5.1` | Responses | yes | — | 196,608 | 131,072 |
| `GLM-5.2` | Responses | yes | — | 196,608 | 131,072 † |
| `GLM-5.3` | Responses | always on | — | 196,608 | 131,072 † |
| `GLM-5.3-Flash` | Responses | yes | — | 196,608 | 131,072 † |
| `GLM-Z1-Air` | Chat | — | — | 131,072 | 98,304 |
| `GLM-Z1-AirX` | Chat | — | — | 131,072 | 98,304 |
| `GLM-Z1-Flash` | Chat | — | — | 131,072 | 32,768 |

**Qwen**

| Model | Route | Thinking | Vision | Context | Max output |
|---|---|---|---|---:|---:|
| `Qwen-Long` | Chat | — | — | 131,072 | 32,768 |
| `Qwen3.5-122B-A10B` | Responses | yes | — | 131,072 | 65,536 |
| `Qwen3.5-27B` | Responses | yes | — | 131,072 | 65,536 |
| `Qwen3.5-35B-A3B` | Responses | yes | — | 131,072 | 65,536 |
| `Qwen3.5-397B-A17B` | Responses | yes | — | 131,072 | 65,536 |
| `Qwen3.5-Plus` | Responses | yes | — | 131,072 | 65,536 |
| `Qwen3.6-27B` | Responses | yes | — | 131,072 | 65,536 |
| `Qwen3.6-Flash` | Responses | yes | — | 131,072 | 65,536 |
| `Qwen3.6-Plus` | Responses | yes | — | 131,072 | 65,536 |
| `Qwen3.7-Max` | Responses | yes | — | 131,072 | 131,072 |
| `Qwen3.7-Plus` | Responses | yes | — | 131,072 | 131,072 |
| `Qwen3.8-27B` | Responses | yes | — | 131,072 | 131,072 |
| `Qwen3.8-Flash` | Responses | yes | yes | 131,072 | 131,072 |
| `Qwen3.8-Max` | Responses | yes | — | 131,072 | 131,072 |

**Kimi**

| Model | Route | Thinking | Vision | Context | Max output |
|---|---|---|---|---:|---:|
| `Kimi-K2.5` | Chat | — | — | 262,144 | 98,304 |
| `Kimi-K2.6` | Responses | yes | — | 262,144 | 262,144 |
| `Kimi-K3` | Responses | yes | — | 262,144 | 128,000 † |

**MiniMax**

| Model | Route | Thinking | Vision | Context | Max output |
|---|---|---|---|---:|---:|
| `MiniMax-M1-80k` | Responses | always on | — | 196,608 | 196,608 |
| `MiniMax-M2` | Responses | always on | — | 196,608 | 196,608 |
| `MiniMax-M2.5` | Responses | always on | — | 196,608 | 196,608 |
| `MiniMax-M2.7` | Responses | always on | — | 196,608 | 196,608 |
| `MiniMax-M3` | Responses | — | — | 524,288 | 524,288 |
| `MiniMax-Text-01` | Responses | — | — | 196,608 | 40,000 |

**ERNIE**

| Model | Route | Thinking | Vision | Context | Max output |
|---|---|---|---|---:|---:|
| `ERNIE-4.5-Turbo-128K` | Chat | — | — | 32,768 | 12,288 |
| `ERNIE-4.5-Turbo-32K` | Chat | — | — | 32,768 | 12,288 |
| `ERNIE-4.5-Turbo-VL-32K` | Chat | — | yes | 32,768 | 12,288 |
| `ERNIE-5.0-Thinking-Preview` | Chat | yes | — | 131,072 | 65,536 |

### Not registered (31 of the 96 listed ids)

`GET /v1/models` lists 96 ids, but these are deliberately excluded and also blocked from
auto-registration when the catalog refreshes:

- **Not chat models** — embeddings/rerank/ASR/OCR: `GLM-Embedding-2`, `GLM-Embedding-3`,
  `GLM-Rerank`, `GLM-ASR-2512`, `GLM-CogView3-Flash`, `DeepSeek-OCR`, `PaddleOCR-VL-0.9B`,
  `PaddleOCR-VL-1.5`. Image/video generation: `WanX2.1-T2I-Plus|Turbo`,
  `Doubao-Seedream-3.0-T2I|4.0|4.5|5.0-lite`, `Doubao-Seedance-1.0-Pro`, `MiniMax-Hailuo-02`,
  `MiniMax-I2V-01`(+`-Director`,`-Live`), `MiniMax-T2V-01`(+`-Director`).
  These live on other routes (`/embeddings`, `/rerank`, `/images/generations`, `/videos`) that
  pi does not speak for chat models.
- **Dead deployments** (404/500 on both routes): `Baichuan-M2-128K`, `DeepSeek-R1-0528`,
  `DeepSeek-V3.1-Terminus`, `DeepSeek-V3.2-Exp`, `DeepSeek-V3.2-Thinking`, `GLM-5`, `GLM-X-F`,
  `Intern-S2-Preview` (您已超过输入 tokens 配额).
- **No function calling** — unusable for a coding agent: `Baichuan-M2`, `Baichuan-M3`
  ("Model `Baichuan-M2` does not support function calls").

## Verified facts about this gateway

All of the following were measured against the live endpoint on **2026-09-19**. They are also
recorded in the header comment of `index.ts`, which is the authoritative copy.

**Responses API is per-model, not per-gateway.** 33 of 65 models serve `/responses`; the rest
404 on `/v4/responses` (GLM-4.x line), 401 (GLM-4V/GLM-Z1, all four ERNIE), or 400 with
"Agent capabilities are not enabled" (Kimi-K2.5). DeepSeek-R1/V3/V3.1/V3-250324 return
500 `当前用户未开通知识库问答功能` — the Volcengine upstream wants a knowledge-base feature this
account lacks. Verified working end-to-end through pi-ai (streaming, thinking blocks, tool-call
round-trips): GLM-5.3-Flash, Qwen3.8-Flash, DeepSeek-V4-Flash, MiniMax-M3, Kimi-K2.6, GLM-5.2,
DeepSeek-V3.2, Qwen3.5-122B-A10B, Qwen3.7-Plus, MiniMax-Text-01, DeepSeek-V3.2-Instruct.

**`max_tokens` is the only reliable output cap.** `max_completion_tokens` is silently *ignored*
by several upstreams — measured: Qwen3.8-Flash emitted 38 tokens with
`max_completion_tokens:1`, GLM-5.3-Flash emitted 264 — while `max_tokens` is validated and
honored by every family. This is the opposite of the Volcengine extension, which pins
`max_completion_tokens`. All chat models here set `maxTokensField:"max_tokens"`.

**The gateway enforces input caps** with a clean pre-inference 400
(`OpenAIException - Prompt exceeds max length`), rather than silently truncating. A ~292k-token
input to GLM-4.5-Flash was rejected in ~10s. This is what made context windows measurable:
verified accepted `prompt_tokens` lower bounds are DeepSeek-V4-Flash 233,049, GLM-5.3-Flash
174,778, Kimi-K2.6 174,776, Qwen3.8-Flash 116,572, MiniMax-M2.5 116,552, GLM-4.6 ~116,000.
Values in the table are family defaults that never fell below a measured bound.

**Thinking control differs per family**, so each gets its own level map and format:

| Family | Chat-route control | Verified behavior |
|---|---|---|
| GLM-4.5x/4.6 (`zai`) | `thinking:{type:"disabled"}` | ⇒ `reasoning_content` length 0. `reasoning_effort` is accepted but *ignored* (rc=25 identically for every level) |
| GLM-5.1/5.2/5.3-Flash | `reasoning:{effort:"none"}` | ⇒ 0 reasoning chars |
| GLM-5.3 | `reasoning:{effort:"none"}` | **ignored** (1297 chars); `low` ⇒ 0, so `off` is unavailable |
| Qwen (`qwen`) | `enable_thinking:false` | ⇒ rc=0 |
| DeepSeek (`deepseek`) | `thinking:{type:"disabled"}` | ⇒ rc=0, incl. DeepSeek-R1 |
| Kimi-K2.6/K3 | `reasoning_effort` | **`max` is rejected** — allowed set is `none/minimal/low/medium/high/xhigh`, so `max` folds to `xhigh` |
| MiniMax M1-80k/M2/M2.5/M2.7 | — | cannot disable thinking: every level *and* `none` still reason (280–1463 chars), so `off` is unavailable |
| MiniMax-M3 | — | returned zero `reasoning_content` on every probe ⇒ treated as non-reasoning |
| ERNIE-5.0-Thinking-Preview | `thinking:{type:"disabled"}` | ⇒ rc=0; `xhigh`/`max` left unavailable because they were not probed |

**Prompt caching works and is reportable.** `usage.prompt_tokens_details.cached_tokens` is
populated (seen on GLM and Qwen chat routes). `prompt_cache_retention:"24h"` plus
`prompt_cache_key` were accepted (200) on every route probed — chat: GLM-4.5-Flash, GLM-4.6,
Qwen3.8-Flash, Kimi-K2.6, MiniMax-M2.5, DeepSeek-V4-Flash, ERNIE-4.5-Turbo-32K; responses:
GLM-5.3-Flash, Qwen3.8-Flash, DeepSeek-V4-Flash, MiniMax-M3, Kimi-K2.6 — so
`supportsLongCacheRetention:true` across the whole catalog.

**`store:false` is not honored.** The response echoes `"store":true` and
`GET /responses/{id}` fails pydantic validation, so retrieval is unavailable. Harmless for pi,
which is stateless-by-payload and sends the full context every turn.

**SSE has no `event:` lines.** LiteLLM emits `data:` frames only, with the event name inside the
JSON `type` field. pi-ai survives this because it drives `/responses` through the official
OpenAI SDK (`client.responses.create`), not a hand-rolled parser.

**`reasoning.summary` and `include:["reasoning.encrypted_content"]` are accepted** by every
Responses model probed — so, unlike the Volcengine extension, no summary-stripping payload hook
is needed.

**Rate limits are transient, not overflow.** Two distinct live strings must never trigger
auto-compaction: `all candidate slots are busy` and `Deployment over defined TPM/RPM limit`.
The `message_end` hook normalizes only genuine overflow (`Prompt exceeds max length`,
`max_tokens参数非法`, `您已超过输入 tokens 配额`) onto pi's `context_length_exceeded` marker.

**Network to this endpoint is flaky.** undici (pi-coding-agent's bundled fetch) intermittently
fails with `UND_ERR_CONNECT_TIMEOUT` while curl to the same URL connects in ~0.2–1.2s, and some
inference calls stall past 45s. Timeouts are therefore generous (25s key probe, 30s catalog,
25s endpoint probe) and every network path degrades instead of throwing: a failed catalog fetch
keeps the static baseline, an unreachable key probe reports `unavailable` (never `invalid`).
Retrying is the correct response.

**Key validation costs nothing.** `POST {}` to `/chat/completions` returns 500
(`Router.acompletion() missing 1 required positional argument: 'messages'`) for a valid key and
401 (`Invalid proxy server token passed … LiteLLM_VerificationTokenTable`) for an invalid one.

## Development

```bash
npm install
npm run check      # typecheck + offline tests — must be green before committing
```

Tests are **strictly offline** (`node:test` via tsx). Live requests spend real credits and this
endpoint rate-limits, so E2E runs only on explicit request:

```bash
set -a && . ./secret.env && set +a && export PARATERA_API_KEY="$KEY"
npx tsx -e 'import("./index.ts").then(async m=>{
  const p=m.createParateraGatewayProvider({});
  const {createModels}=await import("@earendil-works/pi-ai");
  const models=createModels({}); models.setProvider(p);
  const mm=models.getModel("paratera","GLM-5.3-Flash");
  const s=models.streamSimple(mm,{messages:[{role:"user",content:"Reply with exactly: PONG"}]},{apiKey:process.env.PARATERA_API_KEY});
  for await(const _ of s){}
  const r=await s.result();
  console.log(r.stopReason, JSON.stringify(r.content));
})'
```

Rules for changing the catalog (see `AGENTS.md`): update `index.ts`'s header comment and this
README together, and never introduce an unverified limit or effort value — probe it first.

## Structure

| File | Role |
|---|---|
| `index.ts` | The extension: verified catalog, `createParateraGatewayProvider`, hooks, `/paratera` command. Header comment holds all gateway facts. |
| `settings.ts` | JSON store (`<agentDir>/paratera.json`), `/paratera` command catalog + autocomplete, pure payload helpers |
| `test/` | Offline tests (`provider.test.ts`, `settings.test.ts`) |

Settings resolve to `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. A missing, corrupt, or
foreign-version settings file degrades to defaults so pi startup can never break.

## License

MIT — see [LICENSE](LICENSE).

# pi-paratera

A provider extension for [pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent` — the coding agent this plugs into) targeting the
**PARATERA MaaS** gateway: 北京并行科技股份有限公司 / Beijing PARATERA Tech Corp.,
Ltd. npm name: `@rarogcmex/pi-paratera`.

- **Endpoint:** `https://llmapi.paratera.com/v1` (shipped as the default; no configuration needed)
- **Gateway:** LiteLLM Proxy `1.89.0` behind istio-envoy (read from the public `/openapi.json`)
- **Console / keys:** `ai.paratera.com` → `sk-…`. The account must be provisioned
  for the models you intend to use: this gateway is a *proxy*, so entitlement and
  capability are decided per upstream model, not per gateway.
- **Models:** 65 registered (33 on the OpenAI **Responses API**, 32 on **chat completions**)
- **Cost:** reported as `$0.00` for every model. The gateway publishes no rate —
  `GET /v1/models` returns only `id`/`object`/`created`/`owned_by`, and no body
  discloses a credit multiplier. Your PARATERA balance is still debited per
  request; pi simply cannot show you how much.
- **Requirements:** Node ≥ 22.19, ESM, strict TypeScript, no build step — pi
  executes the `.ts` directly. Tested against pi **0.87.0** (pinned in
  `devDependencies`) and, out of tree, pi **0.99.1** — 2026-09-30, a scratch clone
  with the two pi packages swapped for a global 0.99.1: typecheck plus 157/157
  green (the pin in this tree stays 0.87.0); `peerDependencies` stays `*`, and the
  extension uses
  version-sensitive host APIs (`cache_warming_decision`,
  `modelRegistry.refresh({force})`, `getAgentDir`), so an older pi may load it and
  silently degrade rather than refuse.

## Install

```bash
pi install git:github.com/RarogCmex/pi-paratera@main
```

or from a checkout:

```bash
git clone https://github.com/RarogCmex/pi-paratera.git
pi install ./pi-paratera
```

Then start `pi` and run `/login paratera` (pi's own slash command, typed inside
pi) and pick a model with `/model`. Or set the key in the environment instead of
`/login`:

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
| `/paratera models probe <id>` | Output-cap probe of one model. Capped upstreams reject `max_tokens:99999999` pre-inference and name their cap — that path costs nothing. **Uncapped upstreams accept it and generate a real, billed completion** (reasoning tokens included for always-on reasoners). A parsed cap is saved and applied over the family default in future catalog merges |
| `/paratera transport` `status` / `on` / `off` | Inspect or toggle the transparent connect-retry layer |

`/paratera url set` probes a candidate with `GET /models` **before** saving and rebinds live
models in place (pi keeps the same object references, so no `/reload` is needed).

Environment overrides: `PARATERA_API_KEY`, `PARATERA_BASE_URL`, `PARATERA_TRANSPORT_RETRY=off`.
The env base URL wins over the persisted setting on every start;
`PI_CACHE_RETENTION=long` forces 24h retention globally.
Settings (`<agentDir>/paratera.json`) also carry measured output caps from
`models probe` (a `maxTokens` map keyed by model id); a re-probe updates them,
and the store drops junk values (<1024) on load.

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

**Vision (`Vision: yes`) means base64 data URIs.** Remote image URLs 400 on
several upstreams (`图片输入格式/解析错误`) because the gateway cannot always fetch
them, so an image has to be inlined as a data URI. Pasting a URL gets you an
opaque Chinese 400. Verified with a local data-URI probe on 2026-09-19 for
every id marked `yes`; `GLM-4.5-Air`/`-AirX` reject image content outright
(`content.type 参数非法，取值范围 ['text']`) and are text-only here.

**Two caveats on the `Thinking: yes` rows.** The `zai` thinking format
(`thinking:{type:"disabled"}`) was verified live only on **GLM-4.5x/4.6**.
`GLM-4-Long`, `GLM-4.7` and `GLM-5-Turbo` carry the same format as a *family
extrapolation*, not a measurement — if an upstream rejects
`thinking:{type:"disabled"}` the request 400s rather than degrading. And
`GLM-5-Turbo` has no `/responses` route at all, so it is chat-only. `ERNIE-4.5-Turbo-128K`
is published with a **32 768** context window despite its name: that is the value
the `-32K` sibling carries, no measurement covers ERNIE, and the practical
consequence is that pi starts compacting roughly 4× earlier than the name
suggests.

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

### Not registered (32 of the 96 listed ids)

`GET /v1/models` lists 96 ids, but these are deliberately excluded and also blocked from
auto-registration when the catalog refreshes (`SKIP_MODEL_IDS`, 32 entries — the 31 below
plus `auto`, the gateway's routing pseudo-entry, which is not a model):

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

## Limitations

Everything here was measured against the live endpoint on **2026-09-19**. The
measurement record — per-family thinking formats, the probe transcript numbers,
the exact error strings — lives in the header comment of `index.ts`, which is the
authoritative copy; this section is only what a user has to know.

**Cost is reported as zero, and that is not a promise of free.** The gateway
publishes no rate and no response body discloses one, so every model carries
`$0.00`. Requests are billed against your PARATERA account normally.

**Thinking cannot be disabled on some families.** MiniMax M1-80k / M2 / M2.5 /
M2.7 reason at every level *including* `none`, and GLM-5.3 ignores
`reasoning:{effort:"none"}` (though it honours `low`). For those, pi's `off`
level is deliberately not offered — offering it would promise a switch the
gateway does not have.

**Vision needs base64 data URIs.** Remote image URLs 400 on several upstreams
because the gateway cannot always fetch them. See the note under § Models.

**`max_tokens`, never `max_completion_tokens`.** Several upstreams silently
*ignore* `max_completion_tokens` (measured: Qwen3.8-Flash emitted 38 tokens with
the cap set to 1; GLM-5.3-Flash emitted 264), while `max_tokens` is validated and
honoured by every family. Every chat model here pins `maxTokensField:"max_tokens"`.
An ignored cap looks exactly like a working request, which is why this is not
negotiable.

**The Responses API is per-model, not per-gateway.** 33 of 65 models serve
`/responses`; the rest fail per family — 404 on `/v4/responses` (the GLM-4.x
line), 401 (GLM-4V, GLM-Z1, all four ERNIE), 400 `Agent capabilities are not
enabled` (Kimi-K2.5), or 500 `当前用户未开通知识库问答功能` for DeepSeek-R1 /
V3 / V3.1 / V3-250324 — the last one means the upstream requires a
knowledge-base feature that accounts without it do not have, so it is an
entitlement error, not a bug.

**Context windows are lower bounds, not exact sizes.** The gateway enforces input
caps with a clean pre-inference 400 (`OpenAIException - Prompt exceeds max
length`) instead of truncating, which makes windows measurable from rejections.
The published values are family defaults that never fell below a measured bound;
the measured bounds themselves (e.g. DeepSeek-V4-Flash accepted 233 049 prompt
tokens) are in the `index.ts` header.

**`store:false` is not honoured.** The response echoes `"store":true` and
`GET /responses/{id}` fails validation, so response retrieval is unavailable.
Harmless here: pi is stateless-by-payload and resends the full context each turn.

**Rate limits must not trigger compaction.** Two live strings are capacity
messages, not overflow — `all candidate slots are busy` and `Deployment over
defined TPM/RPM limit`. The `message_end` hook normalizes only genuine overflow
(`Prompt exceeds max length`, `max_tokens参数非法`, `您已超过输入 tokens 配额`)
onto pi's `context_length_exceeded` marker, so a busy gateway can never be
laundered into a compaction loop.

**Network to this endpoint is flaky, and the extension absorbs it.** undici
(pi's bundled fetch) intermittently fails with `UND_ERR_CONNECT_TIMEOUT` /
`UND_ERR_SOCKET` while `curl` to the same URL connects in ~0.2–1.2 s, and some
inference calls stall past 45 s. pi-ai does not retry these: its retry layer
requires `status` + `headers`, and a connect failure is a bare
`TypeError: fetch failed`, so the whole turn would fail. `transport.ts` closes
that gap at two layers — `withConnectRetry` around every control-plane fetch (key
validation, endpoint probe, catalog refresh), and an origin-scoped undici
dispatcher for inference streams, which reach the network through the OpenAI SDK
and cannot be wrapped any other way. Traffic to any other origin delegates to
pi's previous dispatcher untouched.

Retries are safe by construction: every retried code is a connect/socket failure
that fires *before* a request byte reaches the server, so a retry cannot
double-execute or double-bill. `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT`
are deliberately **excluded** even though undici classifies them as connect-phase
errors — they can fire after the server already received the request, so retrying
could re-execute paid inference. HTTP 429/500 are likewise not retried here; the
server saw those, and pi-ai owns that policy. The dispatcher stops retrying the
moment a response has started. Policy: up to 2 retries, 400–5000 ms exponential
backoff with jitter.

Everything fails open. If pi's undici cannot be resolved, or anything throws
inside the wrapper, requests pass through unchanged and only `/paratera transport
status` reports it. Timeouts are generous (25 s key probe, 30 s catalog, 25 s
endpoint probe), a failed catalog fetch keeps the static baseline, and an
unreachable key probe reports `unavailable` — never `invalid`. When retries are
exhausted the final error is rewritten into an actionable message (URL + code +
"usually transient") with `.code` and `.cause` preserved, so Node prints the cause
chain instead of a bare `fetch failed`.

`/paratera transport status` shows the install state and the last retried error;
`transport off` disables retries for the session (persist across restarts with
`PARATERA_TRANSPORT_RETRY=off`).

**Key validation costs nothing.** `POST {}` to `/chat/completions` returns 500
(`Router.acompletion() missing 1 required positional argument: 'messages'`) for a
valid key and 401 for an invalid one — a pre-inference rejection, so `/login` and
`/paratera keys check` are free. This is the *only* operation in the plugin that
is unconditionally free; `/paratera models probe <id>` is not (see § Commands).


## Development

```bash
npm install
npm run check      # typecheck + offline tests — must be green before committing
```

Prerequisites are ordinary: `npm install` resolves everything, because
`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@types/node`, `tsx`
and `typescript` are real `devDependencies` here (pinned to the 0.87.0 line the
extension was tested against) and `package-lock.json` is committed. Node ≥ 22.19.

Tests are **strictly offline** (`node:test` via tsx). Live requests spend real credits and this
endpoint rate-limits, so E2E runs only on explicit request:

```bash
export PARATERA_API_KEY=sk-…      # your own key; nothing in the repo supplies one
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
| `transport.ts` | Transparent connect-retry: `withConnectRetry` for control-plane fetches, origin-scoped undici dispatcher for inference streams. Pure — undici is injected by the entrypoint |
| `test/` | Offline tests (`provider.test.ts`, `settings.test.ts`, `transport.test.ts`) |

Settings resolve to `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. A missing, corrupt, or
foreign-version settings file degrades to defaults so pi startup can never break.

## License

MIT — see [LICENSE](LICENSE).

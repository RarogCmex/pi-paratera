# AGENTS.md

Provider extension for the PARATERA MaaS gateway (`llmapi.paratera.com`) for the
pi coding agent. Protocol details, the model tables and user documentation are in
[README.md](README.md); the verified gateway facts are in the header comment of
`index.ts`. Read both before changing the catalog or the hooks.

This file is in English to match the README, which sends contributors here for
the catalog-change rules.

## Structure

- `index.ts` — the whole extension: the model catalog (65 entries),
  `createParateraGatewayProvider`, the `before_provider_request` / `message_end`
  hooks, and the `/paratera` command. Its header comment is the authoritative
  record of what was measured and when.
- `settings.ts` — the JSON settings store (`<agentDir>/paratera.json`, where
  `agentDir` is the host's `getAgentDir()`: `$PI_CODING_AGENT_DIR`, else
  `~/.pi/agent`).
- `transport.ts` — transparent retry of connect errors (`UND_ERR_CONNECT_TIMEOUT`
  and friends): `withConnectRetry` for control-plane fetches, plus an
  origin-scoped undici dispatcher for inference streams. The module is pure —
  the entrypoint injects undici (`resolvePiUndici`).
- `test/` — offline tests (`node:test` via tsx).

There is no key file in this repository. Live runs take the key from
`PARATERA_API_KEY` or from the credential `/login paratera` stored in
`~/.pi/agent/auth.json`. Never commit a key and never paste one into code, docs
or tests.

## Verification

```bash
npm install      # devDependencies are real and pinned; package-lock.json is committed
npm run check    # typecheck + offline tests — must be green before committing
```

## Rules

- **Tests are strictly offline.** Live requests spend real PARATERA credit and hit
  TPM/RPM limits, so E2E runs only on explicit request, using the recipe in the
  README's Development section.
- **Gateway facts are measured and dated (2026-09-19).** When you change the
  catalog, update the `index.ts` header comment **and** the README together, and
  never introduce an unverified limit or effort value — probe it first.
- **How to probe a limit.** Output caps and context windows come from
  pre-inference 400s (`max_tokens=99999999`). That path is free **only when the
  upstream rejects the request**: an uncapped model accepts it and generates a
  real, billed completion — for always-on reasoners that includes reasoning
  tokens. Key validation via `POST {}` never runs inference and is the one
  unconditionally free operation. Use these instead of paid runs. This is what
  `/paratera models probe <id>` (`probeModelLimits`) exposes to the user: a parsed
  cap is persisted to settings (the `maxTokens` map) and applied over the family
  default on every catalog merge.
- **`max_tokens`, not `max_completion_tokens`.** The latter is silently ignored by
  several upstreams (Qwen emitted 38 tokens with the cap set to 1). Any change to
  `maxTokensField` is a regression.
- **The Responses route is chosen per model, not per gateway.** GLM-4.x 404s on
  `/v4/responses`; ERNIE returns 401. For a new model: probe first, then catalog.
- **Prices are deliberately zero.** The gateway returns no per-model price
  (`/model/info` → `RBAC: access denied`). Do not substitute "estimated" figures —
  those would be invented numbers in a cost report.
- **The network to this endpoint is unstable** (undici `UND_ERR_CONNECT_TIMEOUT`
  while curl to the same URL connects). pi-ai does **not** retry those errors —
  `retryProviderRequest` requires `status` + `headers`, and a connect failure is a
  bare `TypeError: fetch failed` carrying `cause.code` — which is why `transport.ts`
  exists. Only connect/socket codes that fire **before the response starts** may be
  retried: they mean the server never saw the request, so a retry cannot
  double-execute or double-bill. `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT`
  are deliberately **not** retried (they can fire after the request was delivered).
  HTTP 429/500 are deliberately not retried here either — that policy belongs to
  pi-ai — and the dispatcher stops retrying the moment a response has started.
- **Transport must degrade, never throw.** A failed `resolvePiUndici`, or any error
  inside the wrapper, means the request passes through unchanged (fail-open);
  `fetchModels` falls back to the static baseline; an unreachable key probe reports
  `unavailable`, never `invalid`. Tests pass `installTransport: false` so they do
  not touch the process's global dispatcher.
- **Timeouts are deliberately generous** (25 s key probe, 30 s catalog, 25 s
  endpoint probe).
- Node ≥ 22, ESM, strict TS with no emit. There is no build step — pi executes the
  `.ts` directly.
- **Never write `*/` inside a block comment in `index.ts`** (e.g. `GLM-4V*/GLM-Z1*`):
  it closes the header comment and breaks the whole file.

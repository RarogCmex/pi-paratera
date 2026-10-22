# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-10-22

Host re-verification only: no catalog, protocol or command behavior changed.

### Changed

- **Host pin raised to pi 1.4.0** (`@earendil-works/pi-ai` and
  `@earendil-works/pi-coding-agent` in `devDependencies`, `package-lock.json`
  regenerated, 2026-10-22; the pin was 1.0.4 since 2026-10-06). Typecheck (the
  repo's pinned tsc 5.9.3) and 157/157 offline tests are green on 1.4.0, and
  loading was re-checked in an isolated `PI_CODING_AGENT_DIR`
  (`pi -ne -e <repo> --offline --list-models paratera` → the same 65 models).
  `peerDependencies` stays `*`, so this pin is the tested configuration, not an
  install constraint.
- Reviewed the 1.0.4→1.4.0 host changelog against this extension's surface: every
  breaking item in it misses this repo, which is why the diff is documentation
  plus the pin.
  - 1.2.0 made `before_agent_start` a union over `messageType` (`"user"` vs
    `"custom"`) and made `pi.sendUserMessage()` require `deliverAs` while a run is
    starting — this extension registers no `before_agent_start` handler and calls
    neither `sendUserMessage()` nor `sendMessage()` (its hooks are
    `session_start`, `model_select`, `thinking_level_select`,
    `before_provider_request`, `cache_warming_decision`, `message_end`).
  - 1.2.0 removed the experimental server/client/plugin stack and with it the
    `@earendil-works/chord` dependency — never imported here; regenerating the
    lockfile removed that whole subtree (all 28 entries this bump dropped).
  - 1.2.0 published JSON schemas for pi's own config files (`$schema` on
    `settings.json`, `models.json`, keybindings, themes) — this extension writes
    only its own `<agentDir>/paratera.json` and reads no pi config file.
  - 1.4.0 moved provider attribution headers ahead of `before_provider_headers`
    (OpenRouter/NVIDIA/OpenCode) — no such handler here, and the one request hook
    this extension has (`applyCacheRetention` behind `before_provider_request`)
    edits the request *payload*, never headers.
  - 1.4.0's provider `compat` on classifier models and 1.3.0's kimi-coding
    `/v1` base-URL rule concern pi's built-in catalogs and providers, not the
    `paratera` provider or its 65 catalog entries; `samplingParamsByThinkingLevel`
    (1.0.2) stays unused because this gateway's thinking control is per-family and
    already expressed through `compat.thinkingFormat` + the level maps.

## [0.1.1] - 2026-10-06

Carries the changes that were on `main` after v0.1.0 (the former `[Unreleased]`
block) plus the host re-pin to pi 1.0.4. The supported install path for this
extension remains `pi install git:github.com/RarogCmex/pi-paratera@main`.

### Fixed

- **Login flow validated the key against a stale endpoint URL after a switch**
  (`reurl` in the interactive login): the base URL was captured once at login
  start, so re-validation after an endpoint change hit the old endpoint and a
  key that only works on the new one could never pass. The effective URL is
  now resolved on every validation pass.
- **`UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` are no longer
  retried** by the transparent transport layer. They can fire after the
  request already reached the server (it never finished responding), so a
  retry could re-execute paid inference. A regression test now pins the
  exclusion.
- `/paratera url reset` now un-guards the abandoned endpoint origin from the
  connect-retry dispatcher (previously it stayed guarded forever).

### Changed

- **Host pin raised to pi 1.0.4** (`devDependencies` + regenerated
  `package-lock.json`, 2026-10-06; the pin was 1.0.0 since 2026-10-03).
  Typecheck (the repo's pinned tsc 5.9.3) + 157/157 offline tests green, and
  loading re-checked in an isolated `PI_CODING_AGENT_DIR` (`pi -ne -e <repo>
  --offline --list-models paratera` → the same 65 models). The 1.0.0→1.0.4
  host delta is additive for this extension's surface (`registerToolRenderer`,
  `samplingParamsByThinkingLevel`, `getPromptGuidelines`); the only drift that
  bit the family was pi's bundled `@types/node` (22.19.19 → 26.6.4), which this
  repo does not hit.
- **Host pin raised to pi 1.0.0** (`@earendil-works/pi-ai` and
  `@earendil-works/pi-coding-agent` in `devDependencies`, `package-lock.json`
  regenerated). The extension was developed and first tested against the 0.87.0
  line; 157/157 tests and the typecheck are green on 1.0.0 (measured 2026-10-03,
  first out of tree, then in-tree with this pin), and loading was checked in an
  isolated `PI_CODING_AGENT_DIR` (`pi -ne -e <repo> --offline --list-models
  paratera` → the same 65 models). `peerDependencies` stays `*` per pi's packaging
  guidance, so this pin is the tested configuration, not an install constraint. The
  reason 1.0.0 mattered at all is host-side: `ProviderModelConfig` became a
  discriminated union and `ModelsStoreEntry.models` became `readonly AnyModel[]`,
  which broke two sibling provider extensions that read chat fields off those
  types — this repo reads neither, so nothing here had to change.
- `guessThinkingFormat` renamed to `guessCompat` (it returns the full compat
  block, not just a thinking format); duplicated
  `AbortController + setTimeout + AbortSignal.any` and
  `error instanceof Error ? … : String` shapes extracted into
  `connectSignals` / `errorMessage` helpers; unused `now?: () => number`
  removed from `ConnectRetryConfig`.

### Added

- **`/paratera models probe <id>`** — output-cap probe for a single
  model: sends `max_tokens: 99999999`, which capped upstreams reject in a
  pre-inference 400 that names the enforced cap (no tokens generated, free);
  uncapped upstreams accept it and generate a real, billed completion.
  A parsed cap is persisted to `<agentDir>/paratera.json` (`maxTokens` map,
  junk values filtered) and applied over the family default in every future
  catalog merge, so probed caps survive refreshes and restarts. Exposed as
  the pure `probeModelLimits()` + `parseMaxTokensCap()`.
- **Login-flow regression tests** (validateLoop / rekey / reurl / save /
  retry) covering the interactive state machine end to end, including the
  stale-endpoint-URL fix above.
- The status widget now surfaces a recent transparent connect-retry
  (`para:cache-long ·retry:UND_ERR_CONNECT_TIMEOUT`) within 10 minutes of
  the retry.

## [0.1.0] — 2026-09-19

Initial release: PARATERA MaaS provider (65 verified models, 33 on the
Responses API), transparent connect-retry transport for the flaky
China-hosted endpoint, `/paratera` settings command
(status / cache / url / keys / models / transport), offline test suites.

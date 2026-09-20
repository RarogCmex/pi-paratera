# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

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

- `guessThinkingFormat` renamed to `guessCompat` (it returns the full compat
  block, not just a thinking format); duplicated
  `AbortController + setTimeout + AbortSignal.any` and
  `error instanceof Error ? … : String` shapes extracted into
  `connectSignals` / `errorMessage` helpers; unused `now?: () => number`
  removed from `ConnectRetryConfig`.

### Added

- **`/paratera models probe <id>`** — free output-cap probe for a single
  model: sends `max_tokens: 99999999`, which capped upstreams reject in a
  pre-inference 400 that names the enforced cap (no tokens generated);
  uncapped upstreams accept it (at most 1 output token is billed).
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

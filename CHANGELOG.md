# Changelog

All notable changes to **vouch** (`@mikkeljuhl/vouch`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0 note:** while the version is `0.x`, the public API may change in a
> minor release. Breaking changes are called out under **Changed**/**Removed**.

## [Unreleased]

_Nothing yet._

## [0.1.0] - 2026-06-05

First tagged release — a Bun-first, engine-agnostic API testing framework with a
fluent builder, distributed as a library, Docker image, CLI, and GitHub Action.

### Added

- **Client factory** — `createClient({ baseUrl, headers, timeoutMs, retry, cookies, beforeRequest, debug, redact })`. Header values may be sync/async callables resolved per request (auth is just a header).
- **Fluent builder** — `get/post/put/patch/delete`, `.query()`, `.headers()`, `.json()`, `.form()`, `.multipart()`, `.file()`, `.body()`, `.timeout()`, `.retry()`; awaitable, resolving to `{ status, headers, body, text, raw, durationMs }`. First-class chaining via plain `await`.
- **Assertions** (engine-agnostic, fail-fast, throwing `AssertionError`): `expectStatus`, `expectHeader` (string/RegExp), `expectJson` (subset) and `expectJsonStrict` (deep) with **structured path-level diffs**, `expectText`/`expectBody`, `expectSchema` (Standard Schema — zod/valibot/arktype — or a predicate), `expectUnder` (latency).
- **Retry** — opt-in `.retry({ times, when, delayMs, backoff })`; default retries 5xx + 429 + transport errors (never other 4xx); honors `Retry-After`; per-attempt timeout. Default request timeout of 30s (`timeoutMs: 0` disables).
- **Sessions & signing** — opt-in cookie jar (`cookies: true`) and a `beforeRequest(req)` hook (request signing, correlation IDs).
- **File uploads** — multipart/form/raw bodies and a `fixture(import.meta.url, path)` helper.
- **Diagnostics & redaction** — `debug` dumps (`'onFailure'`/`'always'`/`.debug()`/`VOUCH_DEBUG`) and `redact` (sensitive headers + `bodyKeys`) that mask secrets in dumps **and** assertion diffs (and therefore in CI reporting).
- **Runtimes & distribution** — runs under Bun (default), Vitest, or `node --test`; ships TypeScript source plus generated `.d.ts`. Docker runner image, `vouch` CLI (`--junit`, `--typecheck`/`--typecheck-only`, `--version`), and a composite GitHub Action.
- **Reporting** — JUnit via Bun, enriched with failure messages (Bun's JUnit omits them) by `scripts/ci-summary.mjs`, which also emits inline annotations + a job-summary table.

[Unreleased]: https://github.com/mikkeljuhl/vouch/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mikkeljuhl/vouch/releases/tag/v0.1.0

---

## Releasing

1. Move everything under **[Unreleased]** into a new `## [X.Y.Z] - YYYY-MM-DD` section (keep an empty Unreleased).
2. Bump `version` in `package.json` (it's the single source of truth — `VERSION` and `vouch --version` read it).
3. Update the compare/tag links at the bottom.
4. Commit, then tag: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
5. Pin docs/consumers to the tag (`uses: mikkeljuhl/vouch@vX.Y.Z`).

# Changelog

All notable changes to **vouch** (`@mikkeljuhl/vouch`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0 note:** while the version is `0.x`, the public API may change in a
> minor release. Breaking changes are called out under **Changed**/**Removed**.

## [Unreleased]

_Nothing yet._

## [0.3.2] - 2026-06-07

### Fixed
- Importing `@mikkeljuhl/vouch` is now safe on any runtime. `src/index.ts` read `VERSION` via top-level-await `Bun.file(...).json()` (a Bun-only API), which crashed the import outside Bun — undercutting the runner-agnostic core. `VERSION` is now a generated static constant (`scripts/gen-version.mjs` -> `src/version.ts`, run in `prepare`), the debug dump uses `console.error`, and `VOUCH_DEBUG` is read via `globalThis.process?.env?` (no assumed `process` global).
- Dockerfile copies `scripts/` before `bun install` so the new `prepare` (gen-version) succeeds during the image build.

## [0.3.1] - 2026-06-06

### Added
- `vouch init [dir]` scaffolds `tests/`, an example test, and a `tsconfig.json` (`--no-install` skips `bun add`).

### Fixed
- `bin` path dropped the leading `./` (`cli/vouch.ts`) — npm was stripping the `vouch` bin on publish, which would break `bunx @mikkeljuhl/vouch`.
- The GHCR image is now built **multi-arch** (`linux/amd64` + `linux/arm64`), so it pulls on Apple Silicon.

### Changed
- Docs lead with the Bun local loop (`bunx @mikkeljuhl/vouch init` + `bun test --watch`) as the dev path for any backend; Docker is positioned for CI and zero-install one-offs (with a `host.docker.internal` note for hitting a local service).

## [0.3.0] - 2026-06-06

### Added
- MIT license; the package is published to npm as `@mikkeljuhl/vouch` (public).

### Changed
- The GitHub Action is now a Docker container action (`image: Dockerfile`) running the same runner image as `docker run` — one path. Inputs trimmed to `paths` + `junit-file`; Linux runners only; type-checking moves to a separate native step.

## [0.2.0] - 2026-06-06

### Added
- `proxy` option on `createClient` and a per-request `.proxy(url)`, forwarded to Bun's `fetch` (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` already route fetch on Bun).
- Runner image published to GitHub Container Registry on each version tag: `docker run --rm -v "$PWD/tests:/app/tests" ghcr.io/mikkeljuhl/vouch:0.2.0`.
- `docs/USAGE.md` usage guide.

### Changed
- Bun is now the only supported runtime; the Node/Vitest fallback is dropped. `engines` requires `bun >= 1.2.0`; the package ships TypeScript source (no `@types/node`, no `node:` imports).

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

[Unreleased]: https://github.com/mikkeljuhl/vouch/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/mikkeljuhl/vouch/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/mikkeljuhl/vouch/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mikkeljuhl/vouch/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mikkeljuhl/vouch/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mikkeljuhl/vouch/releases/tag/v0.1.0

---

## Releasing

1. Move everything under **[Unreleased]** into a new `## [X.Y.Z] - YYYY-MM-DD` section (keep an empty Unreleased).
2. Bump `version` in `package.json` (the single source of truth), then run `bun run gen:version` to regenerate `src/version.ts` (also runs in `prepare`). `VERSION` and `vouch --version` come from it.
3. Update the compare/tag links at the bottom.
4. Commit, then tag: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
5. Pin docs/consumers to the tag (`uses: mikkeljuhl/vouch@vX.Y.Z`).

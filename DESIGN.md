# API Testing Framework — Design

A reusable TypeScript framework for **code-authored**, E2E-style API testing
against **already-deployed** servers. You create a **client** with a base URL and
headers, then make fluent, awaitable requests and assert on responses.

The framework has an **engine-agnostic core** (no dependency on any test runner)
and runs by default under **Bun** — chosen so that getting started costs as
little as possible. It is distributed as a **Docker image** and a **CLI** so even
teams without a JavaScript toolchain can run tests with one command.

This repo holds both the framework and a dogfooding example suite that runs
against a public sample API so CI continuously self-tests the framework.

---

## 1. Adoption thesis (why these choices)

The audience is **polyglot backend engineers** (Node *and* Java/Go/etc. services)
who must be able to write tests **without much hassle**. Three goals drive
everything: (1) a nice API, (2) minimal CI setup, (3) minimal local setup.

- **Code, not declarative.** Tests need real logic — loops, branching, reuse,
  chaining. A fluent code API expresses this directly; a declarative format would
  need an ever-growing expression sublanguage. Authoring stays in code.
- **One shared language, not per-language SDKs.** A single tool means one CI
  pattern, one set of docs, one thing to maintain. The cost ("it's TS, not
  Java") is a one-time shrug *once setup is near-zero* and the API is intuitive.
  Native per-language SDKs are explicitly **out of scope** (revisit only if a
  non-JS org genuinely refuses to touch JS).
- **Bun to kill setup friction.** Bun runs TS natively (no `tsconfig`/build to
  run), with a built-in test runner, `expect`, and `fetch`. Local is `bun test`;
  CI is `setup-bun` + `bun test`. This is the biggest lever for goals 2 & 3.
- **Engine-agnostic core for safety.** The core never imports a test library;
  assertions throw a plain error (which fails the test under *any* runner). Bun
  is the default, but the framework still runs under Vitest or `node --test` —
  a near-free hedge that preserves a Node escape hatch.
- **Docker + CLI distribution.** Non-Node teams shouldn't install a JS toolchain:
  a Docker image (`oven/bun` base) and a CLI cover laptops and CI alike.

---

## 2. Goals & non-goals

### Goals
- Define API test cases as readable, code-authored TypeScript (fluent builder).
- Run them like UI E2E tests: against a real, already-running server.
- Make assertions on responses (status, headers, JSON body).
- Support request **chaining** — use one response's output as the next's input.
- Minimal setup locally and in CI; usable by non-Node teams via Docker/CLI.
- Emit JUnit so any CI can report results.

### Non-goals (for now — see [§9 Deferred](#9-deferred))
- A from-scratch test runner (we use the host runner — Bun by default).
- Booting/managing the target server (we hit a deployed URL).
- Any config file, environments map, or `TEST_ENV` selection.
- A dedicated auth concept (auth is just a header — see [§4](#4-the-client-factory)).
- **Native per-language SDKs** (one shared language only).
- JSON-schema and latency/SLA assertions.
- A declarative format or named-variable template store.

---

## 3. Core decisions

| Area | Decision |
|---|---|
| **Approach** | Custom fluent DSL with an **engine-agnostic** core (no test-lib dependency) |
| **Default runner** | **Bun** (`bun test`); also runs under Vitest / `node --test` |
| **Language** | TypeScript (run natively by Bun; no build step to run) |
| **Authoring** | Code — TS test files using a fluent chain builder |
| **Target** | Already-running deployed env (base URL + headers) |
| **Client** | `createClient({ baseUrl, headers, ...defaults })` factory; instance exposes the builder |
| **Client lifecycle** | Created by the user in `beforeAll` (or similar), held in a file-scoped variable |
| **Config** | None — the factory call is the config; users read their own env vars and pass them in |
| **HTTP client** | Native `fetch`, generic body typing: `client.get<User>('/u/1')` |
| **Headers** | `Record<string, string \| (() => string \| Promise<string>)>`; callables awaited **per request** |
| **Auth** | No dedicated concept — auth is a header whose value is a callable |
| **Assertions** | Status, headers, JSON body (deep & partial) — MVP |
| **Assert impl** | **Built-in, engine-agnostic** — throws a clear `AssertionError` (expected/actual); a thrown error fails any runner. Fail-fast. |
| **Chaining** | First-class; state shared via `await`-resolved response objects (plain JS vars) |
| **Concurrency** | Test files run in parallel; chains stay serial (plain `await`); runner-level retry for flake |
| **Per-request retry** | Factory default + per-call override via predicate: `.retry({ times, when })`, opt-in |
| **Per-request timeout** | Factory default + per-call override via `.timeout(ms)` |
| **Reporting** | JUnit (Bun's built-in `--reporter=junit`) + a first-party job-summary script that parses the JUnit XML |
| **Distribution** | (a) library consumed as TS via `bun add`; (b) **Docker image** (`oven/bun`); (c) **CLI** |
| **Example suite** | Runs against a public sample API (jsonplaceholder / httpbin) |

---

## 4. The client factory

```ts
type HeaderValue = string | (() => string | Promise<string>)

interface ClientOptions {
  baseUrl: string
  headers?: Record<string, HeaderValue>
  timeoutMs?: number              // default applied to every request
  retry?: { times: number; when?: (res: Response) => boolean }  // default
}

function createClient(opts: ClientOptions): Client
```

- **Headers** merge precedence: per-request `.headers()` > factory `headers`.
- **Header callables** (sync or async) are resolved **per request** and awaited.
  This is the whole auth story: a token-bearing header is just a callable; the
  user caches inside the callable if they don't want per-request cost.
- **Defaults** (`timeoutMs`, `retry`) are overridable per request.

### Authoring example

```ts
import { describe, test, beforeAll } from 'bun:test'   // or 'vitest'
import { createClient, type Client } from '@your-org/apitest'

describe('users', () => {
  let client: Client

  beforeAll(() => {
    client = createClient({
      baseUrl: process.env.API_BASE_URL!,    // see env-var note below
      headers: {
        Authorization: () => `Bearer ${process.env.API_TOKEN}`, // per-request
        'X-Test-Run': crypto.randomUUID(),                      // static
      },
      timeoutMs: 10_000,
    })
  })

  test('create user, then fetch it', async () => {
    const created = await client
      .post('/users')
      .json({ name: 'Ada' })
      .expectStatus(201)

    const id = created.body.id

    await client
      .get<{ id: string; name: string }>(`/users/${id}`)
      .retry({ times: 2, when: (r) => r.status >= 500 })
      .expectStatus(200)
      .expectJson({ name: 'Ada' })   // partial / subset match
  })
})
```

> **Env var name — `API_BASE_URL`, not `BASE_URL`.** Vite/Vitest reserves
> `BASE_URL`. We keep `API_BASE_URL` as a convention so the example suite runs
> identically under Bun or Vitest. Consumers may name their own vars anything.

### Client / builder surface

```ts
client.get<T>(path) / .post / .put / .patch / .delete
  .query(record)
  .headers(record)            // values may also be callables
  .json(body)                 // JSON body + content-type: application/json
  .body(raw)                  // raw BodyInit escape hatch; no content-type set
  .form(fields)               // URLSearchParams; fetch sets urlencoded type
  .multipart(fields?)         // start/extend a multipart FormData (string fields)
  .file(name, blob, filename?)// append a file part to the multipart FormData
  .timeout(ms)
  .retry({ times, when })
  .expectStatus(code)
  .expectHeader(name, value | RegExp)
  .expectJson(partial)        // subset match
  .expectJsonStrict(value)    // deep-equal
  .expectSchema(schema)       // Standard Schema (zod/valibot/…) or (body)=>boolean
  .expectUnder(ms)            // latency: response.durationMs <= ms
  // → await resolves to { status, headers, body, raw, durationMs }
```

The lifecycle (`test`/`describe`/`beforeAll`) comes from the **host runner**
(`bun:test` by default, or `vitest`). The framework provides only `createClient`,
the builder, and the assertions.

### File uploads & fixtures

The body methods cover the common upload shapes on top of native `fetch`:

- `.json(body)` serializes JSON and sets `content-type: application/json`.
- `.form(fields)` sends a `URLSearchParams` (fetch sets
  `application/x-www-form-urlencoded`).
- `.multipart(fields?)` / `.file(name, blob, filename?)` build a single shared
  `FormData` — `.multipart()` then one or more `.file()` calls accumulate into
  the same form — and let fetch set `multipart/form-data` with the correct
  boundary. `.file()` auto-creates the form if `.multipart()` was not called.
- `.body(raw)` is the raw escape hatch for any `BodyInit`
  (string/Blob/FormData/URLSearchParams/ArrayBuffer/ReadableStream); it sets no
  content-type, so the caller supplies one via `.headers()` if needed.

**Content-type handling.** The framework tracks an *auto* content-type separately
from user `.headers()`. `.json()` sets it; `.form()/.multipart()/.file()/.body()`
clear it so a stale `application/json` can never leak onto a multipart body and
break its boundary. At request time the auto value is merged *under* user headers
(user `.headers()` wins). Body setters are last-writer-wins: `.json()` after
`.multipart()` overwrites the form (and clears the shared `FormData`).

**Fixtures.** `fixture(import.meta.url, './fixtures/sample.zip', type?)` reads a
file relative to the calling test and returns a `Blob`, using runtime builtins
(`node:fs`/`node:url`) so it works under Bun and Node alike. Resolving relative to
`import.meta.url` (not cwd) makes fixtures resolve identically locally and inside
the Docker image — **keep fixtures under `tests/`** so they travel into the image
(the `tests/` dir is copied/mounted; `.dockerignore` must not exclude
`tests/fixtures`).

**ReadableStream + retry caveat.** A `ReadableStream` body is consumed by the
first fetch and cannot be replayed. If retry is enabled (`times > 0`) with a
stream body, the builder throws early with a clear message; use a `Blob`/`Buffer`
(re-serialized per attempt) or set `.retry({ times: 0 })`.

---

## 5. Engine-agnostic assertions

The core imports **no** test library. Each `expect*` method evaluates against the
settled response and, on mismatch, throws an `AssertionError` with a clear
message (method, URL, expected, actual). Because every runner treats a thrown
error as a failing test, the same suite runs under Bun, Vitest, or `node --test`.

- **Fail-fast:** the first failing expectation throws; later ones don't run.
- **Trade-off vs. wrapping a runner's `expect`:** we forgo library-native diffs,
  so we craft explicit expected/actual messages ourselves. A future option is an
  injectable matcher hook for richer diffs, but the default stays dependency-free.

---

## 6. Architecture

```
RequestBuilder ──builds──▶ fetch ──response──▶ built-in assertions (throw on fail)
      ▲                                                  │
      │ from                                             ▼
   Client (baseUrl, headers[callables per req], defaults)   fail-fast throw
      ▲
      │ created by user in beforeAll
   createClient(opts)

host runner (bun test | vitest) ──▶ JUnit reporter ──▶ job-summary script ──▶ CI
```

---

## 7. Package & repo layout

```
src/
  client.ts        # createClient(opts) → fetch wrapper: base url, header resolution, defaults
  builder.ts       # fluent RequestBuilder: methods, query, headers, retry, timeout, expect*
  assert.ts        # engine-agnostic AssertionError + matchers (status/header/json)
  index.ts         # public exports (createClient, types)
cli/
  apitest.ts       # CLI entry: discover + run *.test.ts (Bun)
tests/             # dogfood suite vs public sample API (uses bun:test)
Dockerfile         # oven/bun base + framework; `docker run -v ./tests ...`
scripts/
  ci-summary.mjs   # parse JUnit XML → $GITHUB_STEP_SUMMARY table
tsconfig.json      # typecheck only (`tsc --noEmit`); no emit/build
```

The library ships **TypeScript source** and is consumed **as TypeScript** (Bun
and Vitest both run TS directly), so **no build step** exists — the package
`exports` map points `.` at `./src/index.ts`. There is intentionally **no**
`tsup.config.ts` (no bundle) and **no** `vitest.config.ts` (Bun is the default
runner; Vitest is only a documented fallback). A bundled build is only needed if
we ever publish for non-TS-aware consumers (deferred, §10).

---

## 8. Reporting

- **JUnit** via Bun's built-in `--reporter=junit` (the canonical machine output;
  any CI can parse it).
- **Job summary** via `scripts/ci-summary.mjs`, a dependency-free script that
  parses the JUnit XML into a `$GITHUB_STEP_SUMMARY` Markdown table (totals,
  per-file breakdown, collapsed failure details). Repo-local, not shipped.
- A packaged reusable action stays deferred (§9); CI wires the steps directly.

---

## 9. Design notes & tensions

- **Auth is not special.** Any scheme is a per-request header callable; async
  support covers network token minting.
- **Fail-fast + per-request retry coexist cleanly.** Retry handles transient
  transport/5xx *before* assertions evaluate; fail-fast governs evaluation after
  the response settles. Retry is **opt-in** so a real 4xx is never masked.
- **Engine-agnostic core, Bun default.** Bun minimizes setup; the dependency-free
  assertion layer preserves a Node/Vitest fallback at near-zero cost.
- **One language is a deliberate adoption bet.** We minimize friction via setup
  (Bun/Docker/CLI) and scaffolding rather than N native SDKs.
- **Standalone-binary risk.** A Docker image is a reliable zero-install artifact.
  A single compiled binary (`bun build --compile`) is appealing but must run the
  *user's* TS files — Bun's `bun test` runner isn't an embeddable programmatic
  API, so a true install-nothing binary needs a small homegrown collector. Hence
  **Docker first, standalone binary as a fast-follow** (see migration M5).

---

## 10. Deferred

Out of scope now, designed not to be precluded:

- **Native per-language SDKs** (Java/Go/etc.) — only if an org forces it.
- **Standalone compiled binary** (`bun build --compile`) — Docker covers the
  zero-install need; a true install-nothing binary needs a homegrown collector.
- **Bundled build for non-TS-aware consumers** (currently shipped as TS source).
- **Injectable matcher hook** for runner-native diffs.
- **Named variable store** / declarative format.
- **Registry publishing** — once the API stabilizes.

---

## 11. Implementation status & migration

### Already implemented (on Node + Vitest)
The full framework exists and is green: `createClient` + fluent builder
(query/headers/json/timeout/retry), assertions, opt-in retry (5xx-only default,
transport always, caller predicate), a live dogfood suite, JUnit + a job-summary
script, and PR CI on a Node 22/24 matrix. The pivot below changes the **runner,
assertion impl, distribution, and CI** — **not** the public API.

### Migration phases (Node+Vitest → Bun, engine-agnostic)

**Status: M0–M6 complete.** The framework now runs Bun-first with an
engine-agnostic core, ships TS source (no build), distributes via a Docker runner
image + `apitest` CLI, and reports JUnit + a repo-local job summary. The public
API and runtime semantics are unchanged from the Node+Vitest implementation.

**M0 — Bun toolchain.** ✅ Done. Added Bun; `bun test` discovers the suite (no
`bunfig.toml` needed). *Exit:* `bun test` runs.

**M1 — Engine-agnostic assertions.** ✅ Done. Added `src/assert.ts` (AssertionError
+ matchers); removed the `vitest` `expect` import from `src/builder.ts`. *Exit:*
`src` has zero test-lib imports; unit behavior preserved.

**M2 — Port tests to `bun:test`.** ✅ Done. Switched test imports `vitest` →
`bun:test`; kept mocked + live coverage. *Exit:* `bun test` green (61 cases).

**M3 — Bun CI + reporting.** ✅ Done. Workflow uses `oven-sh/setup-bun` +
`bun test --reporter=junit`; `ci-summary.mjs` parses JUnit XML. *Exit:* PR CI
green, annotations + summary render.

**M4 — Docker image.** ✅ Done. `Dockerfile` on `oven/bun`; `docker run -v ./tests …`
runs the suite and emits JUnit. *Exit:* image runs the dogfood suite.

**M5 — CLI / standalone binary.** ✅ Done. `cli/apitest.ts` is a thin wrapper over
`bun test` (registered as the `apitest` bin); a standalone compiled binary is
deferred (§10) — Bun's test runner isn't an embeddable API. *Exit:* `apitest`
runs a tests dir; binary path decision recorded.

**M6 — Cleanup & docs.** ✅ Done. Removed Vitest/tsup/Node-matrix leftovers
(`vitest.config.ts`, `tsup.config.ts`, `package-lock.json`, build/prepare scripts,
the `vitest` peer dep, and the `dist/` build); package now ships TS source via
`exports → ./src/index.ts`. README rewritten Bun-first; Vitest/`node --test`
documented as an optional fallback. *Exit:* docs match the shipped Bun-first
reality; Node fallback documented.

# API Testing Framework — Design

A reusable TypeScript package providing a fluent request/assertion builder over
**Vitest**, for E2E-style testing against **already-deployed** servers.

The framework is a thin, explicit library: you create a **client** with a base
URL and headers, then make requests and assert on responses. No config files, no
environment magic — the client factory *is* the configuration.

This repo holds both the framework package and a dogfooding example suite that
runs against a public sample API so CI continuously self-tests the framework.

---

## 1. Goals & non-goals

### Goals
- Define API test cases as readable TypeScript using a fluent chain builder.
- Run them like UI E2E tests: against a real, already-running server.
- Make assertions on responses (status, headers, JSON body).
- Support request **chaining** — use one response's output as the next's input.
- Be reusable across repos as an importable module.
- Emit JUnit so an external CI/GHA can report results.

### Non-goals (for now — see [§9 Deferred](#9-deferred))
- A from-scratch test runner (we build on Vitest).
- Booting/managing the target server (we hit a deployed URL).
- Any config file, environments map, or `TEST_ENV` selection.
- A dedicated auth concept (auth is just a header — see [§4](#4-the-client-factory)).
- A packaged GitHub Action / reusable workflow.
- A custom/packaged reporter (rely on Vitest's JUnit + an external GHA).
- Docker runner / cross-CI portability.
- JSON-schema and latency/SLA assertions.
- Form/multipart/binary request bodies.
- A declarative YAML format or named-variable template store.

---

## 2. Core decisions

| Area | Decision |
|---|---|
| **Approach** | Custom fluent DSL over an existing engine (not a from-scratch runner) |
| **Engine** | Vitest |
| **Language** | TypeScript / Node 22+ (tested on 22 & 24 LTS) |
| **Authoring** | Code — TS test files using a fluent chain builder |
| **Target** | Already-running deployed env (base URL + headers) |
| **Client** | `createClient({ baseUrl, headers, ...defaults })` factory; instance exposes the builder |
| **Client lifecycle** | Created by the user in `beforeAll` (or similar), held in a file-scoped variable |
| **Config** | None — the factory call is the config; users read their own env vars and pass them in |
| **HTTP client** | Native `fetch`, generic body typing: `client.get<User>('/u/1')` |
| **Headers** | `Record<string, string \| (() => string \| Promise<string>)>`; callables are awaited **per request** |
| **Auth** | No dedicated concept — auth is a header whose value is a callable (e.g. `Authorization: () => ...`) |
| **Assertions** | Status, headers, JSON body (deep & partial) — MVP |
| **Assert semantics** | Fail-fast, delegating to Vitest's `expect` (rich diffs, native reporter integration) |
| **Chaining** | First-class; state shared via `await`-resolved response objects (plain JS vars, no template store) |
| **Concurrency** | Files parallel, chains serial, test-level retries — configurable in the example's vitest.config |
| **Per-request retry** | Factory default + per-call override via predicate: `.retry({ times, when })`, opt-in |
| **Per-request timeout** | Factory default + per-call override via `.timeout(ms)` |
| **Reporting** | JUnit output only (Vitest built-in), consumed by an external GHA the team already has |
| **Example suite** | Runs against a public sample API (jsonplaceholder / httpbin) |
| **Build/dist** | `tsup` (ESM+CJS+d.ts); `vitest` is an **external/peer** dep (not bundled); consumed via git/workspace for now (no registry yet) |

---

## 3. Authoring experience

```ts
import { describe, test, beforeAll } from 'vitest'
import { createClient, type Client } from '@your-org/apitest'

describe('users', () => {
  let client: Client

  beforeAll(() => {
    client = createClient({
      baseUrl: process.env.API_BASE_URL!,       // user reads their own env (see note)
      headers: {
        Authorization: () => `Bearer ${process.env.API_TOKEN}`, // callable, per-request
        'X-Test-Run': crypto.randomUUID(),                      // static
      },
      timeoutMs: 10_000,
      retry: { times: 0 },                       // default; opt-in per call
    })
  })

  test('create user, then fetch it', async () => {
    const created = await client
      .post('/users')
      .json({ name: 'Ada', email: `ada+${crypto.randomUUID()}@ex.com` })
      .expectStatus(201)
      .expectHeader('content-type', /json/)

    const id = created.body.id

    await client
      .get<{ id: string; name: string }>(`/users/${id}`)
      .query({ expand: 'profile' })
      .retry({ times: 2, when: (r) => r.status >= 500 })
      .expectStatus(200)
      .expectJson({ name: 'Ada' })   // partial / subset match
  })
})
```

> **Env var name — `API_BASE_URL`, not `BASE_URL`.** Vite/Vitest reserves
> `BASE_URL` (it injects its own `base`, default `"/"`, into the worker's
> `process.env`), which would silently override a consumer's value. The example
> suite and all docs therefore read `API_BASE_URL`. Consumers are free to name
> their own env vars anything — this is only a convention to avoid the collision.

Key properties:
- The **client factory is the configuration** — no config file, no env selection.
- A builder is **awaitable**; awaiting performs the request, runs assertions
  fail-fast, and resolves to a typed response (`{ status, headers, body, raw }`).
- Chaining is plain TypeScript — no template interpolation or magic store.
- The client is created in `beforeAll` and shared via a file-scoped variable.
- Multiple clients can coexist in a file (different base URLs / headers).

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
  user caches inside the callable if they don't want per-request cost. A login
  step minted in `beforeAll` is captured by the closure.
- **Defaults** (`timeoutMs`, `retry`) are overridable per request via
  `.timeout()` / `.retry()`.

### Client / builder surface

```ts
client.get<T>(path) / .post / .put / .patch / .delete
  .query(record)
  .headers(record)            // values may also be callables
  .json(body)
  .timeout(ms)
  .retry({ times, when })
  .expectStatus(code)
  .expectHeader(name, value | RegExp)
  .expectJson(partial)        // subset match
  .expectJsonStrict(value)    // deep-equal
  // → await resolves to { status, headers, body, raw }
```

---

## 5. Architecture

```
RequestBuilder ──builds──▶ fetch ──response──▶ assertions (Vitest expect)
      ▲                                                  │
      │ from                                             ▼
   Client (baseUrl, headers[callables resolved per req], defaults)
      ▲                                            fail-fast throw
      │ created by user in beforeAll
   createClient(opts)

Vitest run ──▶ junit reporter (built-in) ──▶ external GHA reports
```

---

## 6. Package layout

```
src/
  client.ts        # createClient(opts) → fetch wrapper: base url, header resolution, defaults
  builder.ts       # fluent RequestBuilder: methods, query, headers, retry, timeout, expect*
  index.ts         # public exports (createClient, types)
tests/             # dogfood suite vs public sample API
vitest.config.ts   # example wiring: junit reporter, parallel files, retries
tsup.config.ts
```

---

## 7. Reporting

MVP emits **JUnit XML** via Vitest's built-in `junit` reporter (wired in the
example repo's `vitest.config.ts`). The team's existing (unpackaged) GitHub
Action consumes that output. The framework ships no custom reporter and no
packaged action; packaging reporting is a later step.

---

## 8. Design notes & tensions

- **Auth is not special.** Folding auth into header callables removes an entire
  concept: any scheme (Bearer, custom headers, rotating tokens) is expressed as a
  per-request callable. Async support covers network token minting.
- **Fail-fast + per-request retry coexist cleanly.** Retry handles transient
  transport/5xx *before* assertions evaluate; fail-fast governs assertion
  evaluation after a response settles. Retry is **opt-in (off by default)** so a
  real 4xx is never masked.
- **Wrapping Vitest `expect`** gives rich diffs and native reporter integration
  for free, and is naturally consistent with fail-fast (expect throws on first
  failure).
- **No config file / no env selection.** The factory call carries everything;
  env-var reading is the consumer's responsibility. Fewer abstractions, fully
  explicit, trivially supports multiple clients per file.
- **Cleanup is the consumer's job.** Use Vitest's `beforeAll`/`afterEach`/
  `afterAll`; the framework imposes no data-lifecycle policy.

---

## 9. Deferred

Out of MVP scope, designed not to be precluded:

- **Packaged GitHub Action / reusable workflow** — wrap setup/run/report.
- **Packaged reporter** — custom markdown job summary (`$GITHUB_STEP_SUMMARY`),
  GHA annotations beyond raw JUnit.
- **Docker runner / portability** — a base runner image for non-GHA CI.
- **JSON-schema & latency assertions** — `.expectSchema(...)`, `.expectUnder(ms)`.
- **Form/multipart/raw bodies** — file uploads, urlencoded, binary.
- **Named variable store** — declarative `extract`/`{{interpolation}}` for a
  future YAML-style format.
- **Registry publishing** — GitHub Packages / npm once the API stabilizes.

---

## 10. Implementation phases

### Phase 0 — Project scaffold
- `git init`; `package.json`, `tsconfig.json`, `tsup.config.ts`, `.gitignore`.
- Add Vitest + tsup dev deps; Node 22+ engines field.
- **Exit:** `npm run build` and `npm test` (no tests yet) run clean.

### Phase 1 — Client factory
- `createClient(opts)`: base URL join, default headers, defaults (timeout/retry).
- Header resolution: static strings + sync/async callables awaited per request,
  with per-request override precedence.
- **Exit:** a unit test constructs a client and a request carries resolved headers.

### Phase 2 — Fluent builder (core)
- `RequestBuilder` with methods, `.query()`, `.headers()`, `.json()`,
  `.timeout()`; awaitable → typed `{ status, headers, body, raw }`.
- Assertions wrapping Vitest `expect`: `.expectStatus`, `.expectHeader`,
  `.expectJson` (partial) + `.expectJsonStrict` (deep). Fail-fast.
- Generic body typing (`client.get<T>`).
- **Exit:** a chained create→fetch test passes against a public API.

### Phase 3 — Per-request retry
- `.retry({ times, when })`, opt-in, factory default + per-call override, applied
  before assertions.
- **Exit:** retry triggers on a forced/simulated 5xx and not on 4xx.

### Phase 4 — Example / dogfood suite + JUnit
- `tests/` against a public sample API (jsonplaceholder / httpbin) exercising
  chaining, query/headers (incl. a callable header), retry, all assertions.
- `vitest.config.ts` enables the junit reporter; parallel files, test retries.
- **Exit:** the suite runs green locally and emits JUnit XML.

### Phase 5 — Packaging & docs
- `tsup` build (ESM+CJS+d.ts), conditional `exports` map (`import`/`require`/
  `types`) + `main`/`module`/`types` for older resolvers, `files: ["dist"]`,
  `sideEffects: false`.
- `vitest` is a **peer dependency** and is marked **external** in tsup so its
  matcher machinery (~560KB) is not bundled — the output keeps a bare
  `import { expect } from 'vitest'` resolved against the consumer's Vitest. (It
  also stays a devDep so this repo's own tests run.)
- A `prepare` script runs the build so a `npm install <git-url>` consumer gets
  built `dist/` without a manual build step.
- Consumed via git/workspace (`private: true`, no registry yet); registry
  publishing is the documented future path (§9).
- README with quickstart + API reference, accurate to the shipped surface.
- **Exit:** another repo can import `createClient` and run a minimal suite
  (verified via `npm pack` + install into a separate consumer dir).

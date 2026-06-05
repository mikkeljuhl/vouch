# @your-org/apitest

A reusable TypeScript framework for writing **E2E-style API tests** with a
fluent request/assertion builder over [Vitest](https://vitest.dev). You create a
**client** with a base URL and headers, then make requests and assert on
responses against an **already-deployed** server. There is no config file and no
environment magic — the `createClient` factory call *is* the configuration. It
hits real HTTP endpoints with the native `fetch`, supports request **chaining**
(use one response as the next request's input), and delegates assertions to
Vitest's `expect` so you get rich diffs and native reporter integration for free.

See [`DESIGN.md`](./DESIGN.md) for the full design and rationale.

---

## Requirements

- **Node 20+** (uses native `fetch`, `AbortSignal.timeout`, `crypto.randomUUID`).
- **Vitest** as a **peer dependency** — the consumer must have `vitest` installed.
  The framework imports `expect` from `vitest` and runs inside your Vitest test
  process, so Vitest is always present at runtime; it is intentionally *not*
  bundled. Vitest `>=2` is supported.

---

## Install

This package is `private` and **not published to a registry yet** (see
[Deferred / roadmap](#deferred--roadmap)). Consume it via git or a workspace, and
install `vitest` alongside it.

**From git:**

```sh
npm i -D vitest "git+https://github.com/your-org/apitest.git"
```

A `prepare` script builds `dist/` on install, so a git install produces ready-to-
import output with no manual build step.

**From a workspace / local path** (monorepo or sibling checkout):

```jsonc
// package.json
{
  "devDependencies": {
    "@your-org/apitest": "workspace:*", // or "file:../apitest"
    "vitest": "^4"
  }
}
```

If you install from a local path checkout, make sure `dist/` exists
(`npm run build` in the package, or rely on the `prepare` script).

---

## Quickstart

A complete minimal suite. The client is created once in `beforeAll`, held in a
file-scoped variable, and the base URL is read from an env var by the consumer.

```ts
import { beforeAll, describe, test } from 'vitest'
import { createClient, type Client } from '@your-org/apitest'

describe('users', () => {
  let client: Client

  beforeAll(() => {
    client = createClient({
      // Read your own env. Use API_BASE_URL — not BASE_URL, which Vitest reserves
      // (it injects its own `base`, default "/"). `||` guards an empty-string env.
      baseUrl: process.env.API_BASE_URL || 'https://jsonplaceholder.typicode.com',
      headers: {
        // Auth is just a header callable, resolved per request (see below).
        Authorization: () => `Bearer ${process.env.API_TOKEN ?? 'demo-token'}`,
        'X-Test-Run': 'apitest-quickstart',
      },
      timeoutMs: 10_000,
      retry: { times: 0 }, // off by default; opt in per call
    })
  })

  test('GET /users/1', async () => {
    const res = await client
      .get<{ id: number; username: string }>('/users/1')
      .expectStatus(200)
      .expectHeader('content-type', /application\/json/)
      .expectJson({ id: 1 }) // partial / subset match

    // The awaited builder resolves to a typed response.
    console.log(res.body.username)
  })
})
```

Run it:

```sh
API_BASE_URL=https://your.api npx vitest run
```

---

## API reference

### `createClient(options): Client`

```ts
type HeaderValue = string | (() => string | Promise<string>)

interface RetryOptions {
  times: number                          // additional attempts after the first
  when?: (res: Response) => boolean      // caller-authoritative retry predicate
}

interface ClientOptions {
  baseUrl: string
  headers?: Record<string, HeaderValue>  // values may be callables
  timeoutMs?: number                     // default applied to every request
  retry?: RetryOptions                   // default retry policy (opt-in)
}
```

- **`baseUrl`** — request paths are joined onto it. A leading-slash path joins
  relative to the base; an absolute URL (`https://…`) is used verbatim.
- **`headers`** — each value is either a static string or a **callable** (sync or
  async). Callables are resolved **per request** and awaited, so a rotating or
  network-minted token is picked up on every call. This is the entire auth story:

  ```ts
  createClient({
    baseUrl,
    headers: {
      // Minted/cached however you like inside the closure; awaited per request.
      Authorization: async () => `Bearer ${await getToken()}`,
    },
  })
  ```

  Per-request `.headers()` override factory headers; names are matched
  case-insensitively and the override wins on collision.
- **`timeoutMs`** — default per-request timeout via `AbortSignal.timeout`,
  overridable per call with `.timeout(ms)`.
- **`retry`** — default retry policy, overridable per call with `.retry(...)`.
  Omit it (or use `{ times: 0 }`) for no retries.

The returned `Client` exposes `get`/`post`/`put`/`patch`/`delete<T>(path)`, each
returning a fluent `RequestBuilder<T>`. (It also exposes the lower-level
`baseUrl`, `timeoutMs`, `retry`, `resolveHeaders`, `resolveUrl`, and `_request`
seams used internally.)

### The request builder

Each builder method returns `this` and chains freely. The request is **not sent**
until you `await` the builder (or call `.send()`).

| Method | Effect |
|---|---|
| `.query(record)` | Merge query params onto the URL (`null`/`undefined` skipped). |
| `.headers(record)` | Add per-request headers (values may be callables); override factory headers. |
| `.json(body)` | Set a JSON body and `content-type: application/json`. |
| `.timeout(ms)` | Override the per-request timeout. |
| `.retry({ times, when })` | Set the retry policy for this request (overrides the factory default). |
| `.expectStatus(code)` | Assert the response status equals `code`. |
| `.expectHeader(name, value)` | Assert a response header equals a string or matches a `RegExp`. |
| `.expectJson(partial)` | **Partial** match — body contains `partial` (Vitest `toMatchObject`). |
| `.expectJsonStrict(value)` | **Strict** match — body deep-equals `value` (Vitest `toEqual`). |
| `.send()` | Perform the request and resolve to the response (same as `await`). |

**Partial vs strict:** `.expectJson({ id: 1 })` passes as long as the body
*contains* `{ id: 1 }`, ignoring other fields — ideal for large/nested bodies.
`.expectJsonStrict(value)` requires an exact deep-equal of the whole body.

**Fail-fast:** assertions run in declared order against the settled response; the
first failing `expect` throws and rejects the awaited builder, so no later
assertion runs. Failures surface as Vitest assertion errors with diffs.

Awaiting a builder resolves to an `ApiResponse<T>`:

```ts
interface ApiResponse<T> {
  status: number
  headers: Headers   // native, case-insensitive
  body: T            // parsed JSON when the response is JSON, else raw text
  raw: Response      // the underlying fetch Response (already consumed)
}
```

### Chaining

Share state via plain awaited response objects — no template store or magic
interpolation:

```ts
const user = await client.get<User>('/users/1').expectStatus(200)

const posts = await client
  .get<Post[]>('/posts')
  .query({ userId: user.body.id }) // use the previous response's body
  .expectStatus(200)
  .expectJson([]) // partial: just assert it's array-shaped, contents aside
```

---

## Retry semantics

Retry is **opt-in** (off by default) and handles transient failures *before*
assertions evaluate, so a real `4xx` is never masked.

- **`times`** is the number of *additional* attempts after the first; total
  attempts = `times + 1`. Each attempt is a fresh request with its own
  timeout/abort signal (**timeout applies per attempt**). No backoff is applied.
- **Transport/network errors** (thrown fetch failures, timeouts/aborts) are
  **always retried** until attempts are exhausted, regardless of any predicate.
- **Response-based retry:**
  - With no `when` predicate, the **default policy retries `5xx` only** — never
    `2xx`/`3xx`/`4xx`.
  - With a `when` predicate, **the predicate is authoritative**: a response is
    retried iff `when(res)` returns true (no hardcoded `5xx`).
- Resolution order: per-request `.retry(...)` ▸ factory `retry` ▸ none.

```ts
await client
  .get('/flaky')
  .retry({ times: 3, when: (r) => r.status === 503 })
  .expectStatus(200)
```

---

## Reporting

The framework ships **no custom reporter**. It relies on Vitest's built-in
`junit` reporter; the emitted XML is consumed by an external GitHub Action the
team already maintains (no packaged action yet). Wire it in your `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['default', 'junit'], // keep console output readable too
    outputFile: { junit: './reports/junit.xml' },
    retry: 1, // Vitest runner-level retry; distinct from .retry() per request
  },
})
```

Note that Vitest's runner-level `retry` (re-runs a whole failing test) is
**distinct** from the framework's per-request `.retry({ times, when })` (re-issues
a single HTTP call before assertions run).

---

## Deferred / roadmap

Out of MVP scope, designed not to be precluded (see `DESIGN.md` §9):

- **Packaged GitHub Action / reusable workflow** — wrap setup/run/report.
- **Packaged reporter** — markdown job summary (`$GITHUB_STEP_SUMMARY`),
  GHA annotations beyond raw JUnit.
- **Docker runner / portability** — a base runner image for non-GHA CI.
- **JSON-schema & latency assertions** — `.expectSchema(...)`, `.expectUnder(ms)`.
- **Form/multipart/raw bodies** — file uploads, urlencoded, binary.
- **Named variable store** — declarative `extract` / `{{interpolation}}` for a
  future YAML-style format.
- **Registry publishing** — GitHub Packages / npm once the API stabilizes.

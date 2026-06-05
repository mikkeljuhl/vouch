# @your-org/apitest

A reusable TypeScript framework for **code-authored, E2E-style API tests** against
an **already-deployed** server. You create a **client** with a base URL and
headers, then make fluent, awaitable requests and assert on responses. The core
is **engine-agnostic** — it imports no test runner and assertions throw a plain
`AssertionError`, so the same suite runs under **Bun** (the default runner),
Vitest, or `node --test`. There is no config file and no environment magic: the
`createClient` factory call *is* the configuration, and it hits real HTTP
endpoints over the native `fetch`.

See [`DESIGN.md`](./DESIGN.md) for the full design and rationale.

---

## Requirements

- **[Bun](https://bun.sh) 1.x** (default runner). Install:

  ```sh
  curl -fsSL https://bun.sh/install | bash
  ```

  Bun runs TypeScript natively (no `tsconfig`/build to run a test), and provides
  the test runner (`bun:test`), `expect`, and `fetch` out of the box.
- The package ships **TypeScript source** (no build step). Bun and Vitest both
  consume TS directly.
- **Engine-agnostic fallback.** Because the core imports no test library, the same
  tests also run under **Vitest** or **`node --test`** — a near-free Node escape
  hatch. The dogfood suite in this repo targets `bun:test`, but consumer suites
  can import lifecycle helpers from whichever runner they prefer.

---

## Three ways to run

### 1. Local (Bun on PATH)

```sh
bun test                                   # discover + run *.test.ts
bun test tests/users.test.ts               # a single file

# Or via the bundled CLI (a thin wrapper over `bun test`):
apitest                                     # = bun test
apitest tests/users.test.ts
apitest --junit reports/junit.xml          # expands to Bun's JUnit reporter flags
```

Set the base URL with an env var your suite reads (see [Quickstart](#quickstart)):

```sh
API_BASE_URL=https://your.api bun test
```

### 2. Docker (no JS toolchain)

A runner image (`oven/bun` base) with the framework preinstalled, so teams
without a JavaScript toolchain run tests with one command. Your test files import
the framework by its package name `@your-org/apitest` (resolved through a
`node_modules` symlink baked into the image, which points at the shipped TS
source).

```sh
docker build -t apitest .

# Self-test: run the baked dogfood suite.
docker run --rm apitest

# Run YOUR tests by mounting them over /app/tests:
docker run --rm -v "$PWD/tests:/app/tests" apitest

# Emit JUnit to the host:
docker run --rm \
  -v "$PWD/tests:/app/tests" \
  -v "$PWD/reports:/app/reports" \
  apitest --reporter=junit --reporter-outfile=/app/reports/junit.xml
```

### 3. CI (GitHub Actions)

Use `oven-sh/setup-bun`, run `bun test` with the JUnit reporter, then feed the XML
to the repo-local summary script. This mirrors [`.github/workflows/ci.yml`](./.github/workflows/ci.yml):

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - name: Test
        run: bun test --reporter=junit --reporter-outfile=reports/junit.xml
      - name: Job summary + annotations
        if: always()
        run: bun scripts/ci-summary.mjs reports/junit.xml
```

No third-party reporting action is needed — `scripts/ci-summary.mjs` parses the
JUnit XML into inline annotations plus a `$GITHUB_STEP_SUMMARY` table (see
[Reporting](#reporting)).

---

## Quickstart

A complete minimal test. The client is created once in `beforeAll`, held in a
file-scoped variable, and the base URL is read from an env var by the consumer.

```ts
import { test, beforeAll } from 'bun:test'
import { createClient, type Client } from '@your-org/apitest'

let client: Client

beforeAll(() => {
  client = createClient({
    // Read your own env. Use API_BASE_URL — NOT BASE_URL, which Vite/Vitest
    // reserves. `||` guards an empty-string env.
    baseUrl: process.env.API_BASE_URL || 'https://jsonplaceholder.typicode.com',
    headers: {
      // Auth is just a header callable, resolved per request (see API reference).
      Authorization: () => `Bearer ${process.env.API_TOKEN ?? 'demo-token'}`,
      'X-Test-Run': 'apitest-quickstart',
    },
    timeoutMs: 10_000,
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
```

Run it:

```sh
API_BASE_URL=https://your.api bun test
```

> **Env var name — `API_BASE_URL`, not `BASE_URL`.** Vite/Vitest reserves
> `BASE_URL`. Using `API_BASE_URL` keeps a suite running identically under Bun or
> Vitest. Consumers may name their own vars anything.

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
  overridable per call with `.timeout(ms)`. No default if omitted.
- **`retry`** — default retry policy, overridable per call with `.retry(...)`.
  Omit it (or use `{ times: 0 }`) for no retries. See [Retry semantics](#retry-semantics).

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
| `.body(raw)` | Raw `BodyInit` escape hatch (string/Blob/FormData/URLSearchParams/ArrayBuffer/ReadableStream); sets no content-type. |
| `.form(fields)` | URL-encoded body (`URLSearchParams`); fetch sets `application/x-www-form-urlencoded`. |
| `.multipart(fields?)` | Start/extend a `multipart/form-data` body with string fields; fetch sets the boundary. |
| `.file(name, blob, filename?)` | Append a file part to the multipart form (auto-creates it). |
| `.timeout(ms)` | Override the per-request timeout. |
| `.retry({ times, when })` | Set the retry policy for this request (overrides the factory default). |
| `.expectStatus(code)` | Assert the response status equals `code`. |
| `.expectHeader(name, value)` | Assert a response header equals a string or matches a `RegExp`. |
| `.expectJson(partial)` | **Partial** match — body contains `partial` (deep subset). |
| `.expectJsonStrict(value)` | **Strict** match — body deep-equals `value`. |
| `.send()` | Perform the request and resolve to the response (same as `await`). |

**Partial vs strict:** `.expectJson({ id: 1 })` passes as long as the body
*contains* `{ id: 1 }`, ignoring other fields — ideal for large/nested bodies.
Arrays are matched element-wise and must be the same length. `.expectJsonStrict(value)`
requires an exact deep-equal of the whole body.

**Fail-fast:** assertions run in declared order against the settled response; the
first failing assertion throws an **`AssertionError`** and rejects the awaited
builder, so no later assertion runs. The error message names the request
(`METHOD url`), the expected, and the actual values.

> **Caveat (Bun JUnit):** Bun's `--reporter=junit` emits a `<failure>` element
> without the assertion message text — the full `AssertionError` message (expected
> vs. actual) appears in the **run log**, not the XML. The summary script surfaces
> the per-test failure; check the job log for the detailed message.

Awaiting a builder resolves to an `ApiResponse<T>`:

```ts
interface ApiResponse<T> {
  status: number
  headers: Headers   // native, case-insensitive
  body: T            // parsed JSON when the response is JSON, else raw text
  raw: Response      // the underlying fetch Response (already consumed)
}
```

### File uploads

Upload files and non-JSON bodies on top of native `fetch`. The `fixture()` helper
reads a file **relative to the test module** (via `import.meta.url`, so it works
regardless of cwd) and returns a `Blob`:

```ts
import { createClient, fixture } from '@your-org/apitest'

// multipart/form-data: string fields + one or more files share one FormData.
const zip = fixture(import.meta.url, './fixtures/sample.zip', 'application/zip')
await client
  .post('/upload')
  .multipart({ note: 'nightly' })
  .file('archive', zip, 'sample.zip') // filename defaults to the File/blob name, else the field name
  .expectStatus(200)

// application/x-www-form-urlencoded
await client.post('/login').form({ user: 'ada', pass: 'secret' }).expectStatus(200)

// raw escape hatch — you set the content-type yourself
await client
  .put('/raw')
  .body(zip)
  .headers({ 'content-type': 'application/zip' })
  .expectStatus(200)
```

Notes:

- **Content-type is handled for you.** `.json()` sets `application/json`;
  `.form()/.multipart()/.file()` let fetch set the correct type (including the
  multipart boundary); `.body()` sets none. A user `.headers()` content-type
  always wins. Switching body kinds (e.g. `.json()` then `.multipart()`) never
  leaks a stale content-type.
- **Docker / fixtures.** Keep fixture files under the `tests/` directory so they
  travel into the Docker image (it copies/mounts `tests/`); resolving via
  `import.meta.url` then works identically locally and in the container. Ensure
  `.dockerignore` does not exclude `tests/fixtures`.
- **ReadableStream + retry.** A `ReadableStream` body can't be replayed, so
  combining it with `.retry({ times > 0 })` throws early — use a `Blob`/`Buffer`
  or `.retry({ times: 0 })`.

### Chaining

Share state via plain awaited response objects — no template store or magic
interpolation. Await one response, then use its body in the next call:

```ts
const user = await client.get<User>('/users/1').expectStatus(200)

const posts = await client
  .get<Post[]>('/posts')
  .query({ userId: user.body.id }) // use the previous response's body
  .expectStatus(200)
  .expectJson([]) // partial: assert it's array-shaped, contents aside
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

The framework ships **no third-party reporter action**. It relies on Bun's
built-in `junit` reporter:

```sh
bun test --reporter=junit --reporter-outfile=reports/junit.xml
```

The emitted XML is consumed by the repo-local, dependency-free
[`scripts/ci-summary.mjs`](./scripts/ci-summary.mjs), which parses it into:

- **Inline annotations** (GitHub `::error`/`::warning` log commands), and
- a **`$GITHUB_STEP_SUMMARY`** Markdown table (totals, per-file breakdown,
  collapsed failure details).

Wire it in CI as shown in [Three ways to run → CI](#3-ci-github-actions). The
script is repo-local and not shipped in the package.

---

## Roadmap / deferred

Out of MVP scope, designed not to be precluded (see [`DESIGN.md`](./DESIGN.md) §10):

- **Packaged GitHub Action / reusable workflow** — wrap setup/run/report.
- **Standalone compiled binary** (`bun build --compile`) — a true install-nothing
  artifact; needs a small homegrown test collector (Bun's runner isn't an
  embeddable API). Docker is the install-nothing path for now.
- **Bundled build for non-TS-aware consumers** — the package currently ships TS
  source; a compiled `dist/` is only needed for non-TS publishers.
- **JSON-schema & latency/SLA assertions** — `.expectSchema(...)`, `.expectUnder(ms)`.
- **Injectable matcher hook** — for runner-native diffs.
- **Named variable store** / declarative format.
- **Native per-language SDKs** (Java/Go/etc.) — only if an org forces it.
- **Registry publishing** — once the API stabilizes.

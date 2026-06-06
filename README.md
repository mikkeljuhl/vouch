# @mikkeljuhl/vouch

A reusable TypeScript framework for **code-authored, E2E-style API tests** against
an **already-deployed** server. You create a **client** with a base URL and
headers, then make fluent, awaitable requests and assert on responses. **Bun is
the required runtime.** The core imports no test runner — assertions throw a
plain `AssertionError` (a clean-design choice that keeps the diffs and redaction
ours to control). There is no config file and no environment magic: the
`createClient` factory call *is* the configuration, and it hits real HTTP
endpoints over the native `fetch`.

See [`DESIGN.md`](./DESIGN.md) for the full design and rationale.

---

## Requirements

- **[Bun](https://bun.sh) ≥ 1.2 is required** — the framework targets Bun as its
  only runtime and uses Bun-native APIs (`Bun.file`, fetch's `proxy` option, …).
  Install:

  ```sh
  curl -fsSL https://bun.sh/install | bash
  ```

  Bun runs TypeScript natively (no `tsconfig`/build to run a test), and provides
  the test runner (`bun:test`), `expect`, and `fetch` out of the box.
- The package ships **TypeScript source** (no build step) — Bun consumes TS
  directly.
- The core imports **no test library**: assertions throw a plain `AssertionError`
  (a clean-design property, so the diffs/redaction are fully ours), and the
  dogfood suite uses `bun:test`.

---

## Three ways to run

### 1. Local (Bun on PATH)

```sh
bun test                                   # discover + run *.test.ts
bun test tests/users.test.ts               # a single file

# Or via the bundled CLI (a thin wrapper over `bun test`):
vouch                                       # = bun test
vouch tests/users.test.ts
vouch --junit reports/junit.xml            # expands to Bun's JUnit reporter flags
```

Set the base URL with an env var your suite reads (see [Quickstart](#quickstart)):

```sh
API_BASE_URL=https://your.api bun test
```

### 2. Docker (no JS toolchain)

A runner image (`oven/bun` base) with the framework preinstalled, so teams
without a JavaScript toolchain run tests with one command. Your test files import
the framework by its package name `@mikkeljuhl/vouch` (resolved through a
`node_modules` symlink baked into the image, which points at the shipped TS
source).

```sh
docker build -t vouch .

# Self-test: run the baked dogfood suite.
docker run --rm vouch

# Run YOUR tests by mounting them over /app/tests:
docker run --rm -v "$PWD/tests:/app/tests" vouch

# Emit JUnit to the host:
docker run --rm \
  -v "$PWD/tests:/app/tests" \
  -v "$PWD/reports:/app/reports" \
  vouch --reporter=junit --reporter-outfile=/app/reports/junit.xml
```

### 3. CI (GitHub Actions)

**Easiest — the packaged composite action.** It does setup-bun → install →
(optional) typecheck → `bun test` (JUnit) → inline annotations + job summary:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: mikkeljuhl/vouch@v0.1.0    # pin a release tag (or @main for latest)
        with:
          typecheck: 'true'              # optional; runs tsc --noEmit first
          # paths: tests                 # optional; default = all discovered tests
          # bun-version: latest
          # working-directory: .
          # junit-file: reports/junit.xml
```

**Or wire the steps yourself** — use `oven-sh/setup-bun`, run `bun test` with the
JUnit reporter, then feed the XML to the summary script. This mirrors
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) (which itself dogfoods
the action via `uses: ./`):

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
        # tee Bun's console to a log so its full assertion messages can be
        # merged into the JUnit (Bun's JUnit omits them). `shell: bash` runs
        # with `set -o pipefail`, so a failed `bun test` still fails the step.
        run: bun test --reporter=junit --reporter-outfile=reports/junit.xml 2>&1 | tee vouch-console.log
      - name: Job summary + annotations
        if: always()
        run: bun scripts/ci-summary.mjs reports/junit.xml vouch-console.log
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
import { createClient, type Client } from '@mikkeljuhl/vouch'

let client: Client

beforeAll(() => {
  client = createClient({
    // Read your own env. `||` guards an empty-string env.
    baseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
    headers: {
      // Auth is just a header callable, resolved per request (see API reference).
      Authorization: () => `Bearer ${process.env.API_TOKEN ?? 'demo-token'}`,
      'X-Test-Run': 'vouch-quickstart',
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

> **Env var name — `API_BASE_URL`, not `BASE_URL`.** `API_BASE_URL` is just a
> plain, unsurprising convention; consumers may name their own vars anything.

---

## Examples

The canonical, runnable usage examples live in
[`tests/example/`](./tests/example) — doc-quality, hermetic tests you can read
and run (`bun test tests/example`):

- [`users.test.ts`](./tests/example/users.test.ts) — the basics (client, headers,
  query, status/header/JSON assertions).
- [`posts.test.ts`](./tests/example/posts.test.ts) — chaining, the CRUD
  lifecycle, retry, and schema.
- [`upload.test.ts`](./tests/example/upload.test.ts) — multipart uploads + the
  `fixture()` helper.
- [`auth.test.ts`](./tests/example/auth.test.ts) — auth/sessions (cookie jar +
  the `beforeRequest` signing hook).

Reusable test helpers (the in-process mock server, mock fetch/client, shared
scenarios and assertions) live in [`tests/support/`](./tests/support).

---

## API reference

### `createClient(options): Client`

```ts
type HeaderValue = string | (() => string | Promise<string>)

interface RetryOptions {
  times: number                          // additional attempts after the first
  when?: (res: Response) => boolean      // caller-authoritative retry predicate
  delayMs?: number                       // base delay BETWEEN attempts; default 0
  backoff?: 'fixed' | 'exponential'      // default 'fixed'; exp = delayMs * 2^attemptIndex
}

interface OutgoingRequest {
  method: string
  url: string                            // fully-resolved; mutable
  headers: Record<string, string>        // fully-resolved; MUTATE to add/override
  body: RequestInit['body']              // read for signing
}

interface ClientOptions {
  baseUrl: string
  headers?: Record<string, HeaderValue>  // values may be callables
  timeoutMs?: number                     // default applied to every request
  retry?: RetryOptions                   // default retry policy (opt-in)
  cookies?: boolean                      // opt-in in-memory session jar (default false)
  beforeRequest?: (req: OutgoingRequest) => void | Promise<void>  // per-attempt hook
  proxy?: string                         // route fetch through a proxy (per-req: .proxy())
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
  overridable per call with `.timeout(ms)`. **When omitted, a default of 30s
  (`DEFAULT_TIMEOUT_MS`) applies** so requests don't hang forever. Set
  `timeoutMs: 0` (factory or per-request) to **disable** the timeout entirely.
- **`retry`** — default retry policy, overridable per call with `.retry(...)`.
  Omit it (or use `{ times: 0 }`) for no retries. See [Retry semantics](#retry-semantics).
- **`cookies`** — opt-in in-memory session jar (default `false`). See
  [Sessions & cookies](#sessions--cookies).
- **`beforeRequest`** — a per-attempt hook to mutate the outgoing request (e.g.
  request signing). See [Request signing / hooks](#request-signing--hooks).
- **`proxy`** — route every request through an HTTP/HTTPS/SOCKS proxy (forwarded
  to Bun's `fetch` as its `proxy` option), overridable per request with
  `.proxy(url)`. See [Proxy](#proxy).

The returned `Client` exposes `get`/`post`/`put`/`patch`/`delete<T>(path)`, each
returning a fluent `RequestBuilder<T>`. (It also exposes the lower-level
`baseUrl`, `timeoutMs`, `retry`, `cookies`, `resolveHeaders`, `resolveUrl`, and
`_request` seams used internally.)

### Sessions & cookies

Set `cookies: true` for an **in-memory, per-client cookie jar** so a login that
returns `Set-Cookie` is followed by authenticated calls automatically:

```ts
const client = createClient({ baseUrl, cookies: true })

// 1. Log in — the response's Set-Cookie is stored in the jar.
await client.post('/login').json({ user: 'ada', pass: 's3cret' }).expectStatus(200)

// 2. Subsequent calls on the SAME client auto-send `Cookie: …`.
await client.get('/me').expectStatus(200).expectJson({ user: 'ada' })

// Seed / inspect / clear the jar directly when needed:
client.cookies.set('locale', 'en')
client.cookies.get('session')      // → string | undefined
client.cookies.getAll()            // → Record<string, string>
client.cookies.clear()
```

This is a **simplified test-session jar**: only `name=value` is tracked
(domain/path/expiry/attributes are ignored), scoped to the one client instance.
A per-request `.headers({ cookie: '…' })` overrides the jar entirely for that
call. A `Set-Cookie` with an empty value / `Max-Age=0` / past `Expires` deletes
the cookie.

### Request signing / hooks

`beforeRequest` runs inside the client **once per attempt** — after headers are
resolved + cookies attached + the URL is built, and **before** `fetch`. Mutate
`req.headers` / `req.url` in place (it may be async; it is awaited):

```ts
import { createHmac } from 'node:crypto'

const client = createClient({
  baseUrl,
  beforeRequest: (req) => {
    const payload = `${req.method}\n${req.url}\n${req.body ?? ''}`
    req.headers['x-signature'] = createHmac('sha256', SECRET).update(payload).digest('hex')
    req.headers['x-request-id'] = crypto.randomUUID()
  },
})

await client.post('/orders').json({ sku: 'A1', qty: 2 }).expectStatus(201)
```

Because it runs last, the hook wins the precedence chain:
`factory headers < per-request .headers() < cookie jar < beforeRequest`. Running
per attempt means a retry **re-signs** correctly. The body is readable for
string/`Blob`/`URLSearchParams`/`FormData` bodies; a `ReadableStream` body is not
re-readable and so cannot be signed from its content.

### Proxy

Route requests through an HTTP/HTTPS/SOCKS proxy. Set a client default with the
`proxy` option, or override it per request with `.proxy(url)` — both are
forwarded straight to Bun's `fetch` as its `proxy` option:

```ts
// Client default — every request goes through the proxy.
const client = createClient({ baseUrl, proxy: 'http://proxy.local:8080' })

// Per-request override (resolution: per-request .proxy() ?? client proxy).
await client.get('/health').proxy('http://other-proxy:9090').expectStatus(200)
```

The proxy is **transport** — it is independent of `headers` / `beforeRequest`.

> **Env-var proxying.** On Bun, the `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
> env vars already route `fetch` automatically, so you often need nothing in
> code. The `proxy` option is the **explicit/programmatic** form for choosing a
> proxy from code:
>
> ```sh
> HTTPS_PROXY=http://proxy.local:8080 bun test
> ```

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
| `.proxy(url)` | Route this request through a proxy (overrides the client default). See [Proxy](#proxy). |
| `.retry({ times, when })` | Set the retry policy for this request (overrides the factory default). |
| `.expectStatus(code)` | Assert the response status equals `code`. |
| `.expectHeader(name, value)` | Assert a response header equals a string or matches a `RegExp`. |
| `.expectJson(partial)` | **Partial** match — body contains `partial` (deep subset). |
| `.expectJsonStrict(value)` | **Strict** match — body deep-equals `value`. |
| `.expectText(string \| RegExp)` | Raw response text **contains** the substring or **matches** the `RegExp`. |
| `.expectBody(string)` | Raw response text **exactly equals** the string (use `''` for an empty body). |
| `.expectSchema(schema)` | Validate the body against a **Standard Schema** (zod/valibot/arktype/…) or a predicate `(body) => boolean`. |
| `.expectUnder(ms)` | Assert the request completed within `ms` (checks `response.durationMs`). |
| `.send()` | Perform the request and resolve to the response (same as `await`). |

**Partial vs strict:** `.expectJson({ id: 1 })` passes as long as the body
*contains* `{ id: 1 }`, ignoring other fields — ideal for large/nested bodies.
Arrays are matched element-wise and must be the same length. `.expectJsonStrict(value)`
requires an exact deep-equal of the whole body.

**Fail-fast:** assertions run in declared order against the settled response; the
first failing assertion throws an **`AssertionError`** and rejects the awaited
builder, so no later assertion runs. The error message names the request
(`METHOD url`).

**Structured JSON diffs.** When `.expectJson` / `.expectJsonStrict` fail, the
message is a **path-level diff** (not a truncated expected/actual blob). Each
difference shows a path — dot notation for object keys, `[i]` for array indices —
and what was expected vs received. Missing keys, type mismatches, array-length
mismatches, and (in strict mode) unexpected extra keys are each reported on their
own line; the list is capped at 20 with `… and N more`:

```
GET https://api/users/1 — JSON body did not match (subset) (4 differences):
  • role  expected "admin" received "user"
  • team.id  expected 7 received 9
  • team.members[2].id  expected 3 received 99
  • profile  missing (expected key not present)
```

> **Note (Bun JUnit):** Bun's `--reporter=junit` emits a `<failure>` element
> without the assertion message text — Bun writes the full `AssertionError`
> message (the path-level diff) only to its **console** output. To recover it,
> tee the console to a log and pass it to the summary script (see
> [Reporting](#reporting)); the script merges each message back into the JUnit
> `<failure>` element (as a `message` attribute + CDATA body) and into the inline
> annotations and job summary. The enriched JUnit therefore carries the full
> diff for downstream consumers.

**Non-JSON body assertions.** The body is read **once as text** and exposed as
`response.text` (always available, even for JSON). `.expectText` / `.expectBody`
assert against that text — handy for plain text, HTML, or empty bodies:

```ts
// substring contains (text)
await client.get('/health').expectStatus(200).expectText('OK')

// RegExp match (HTML)
await client.get('/page').expectStatus(200).expectText(/<title>.*<\/title>/)

// exact body
await client.get('/version').expectStatus(200).expectBody('1.2.3')

// empty body (e.g. a 204)
await client.delete('/users/1').expectStatus(204).expectBody('')
```

A malformed JSON body served with a JSON content-type does **not** throw — `body`
falls back to the raw text (and `text` always holds it).

Awaiting a builder resolves to an `ApiResponse<T>`:

```ts
interface ApiResponse<T> {
  status: number
  headers: Headers   // native, case-insensitive
  body: T            // parsed JSON when the response is JSON, else raw text
  text: string       // raw response body read once as text (always populated)
  raw: Response      // the underlying fetch Response (already consumed)
  durationMs: number // wall-clock time of the request (all attempts if retried)
}
```

### Schema & latency assertions

`.expectSchema(schema)` validates the body against a **Standard Schema** —
anything exposing the `['~standard']` property, including **zod ≥ 3.24**, valibot,
and arktype. The framework adds **no dependency**: it only reads the standard
interface, so you bring your own schema library (if any).

```ts
import { z } from 'zod' // zod ≥ 3.24 implements Standard Schema

const User = z.object({ id: z.number(), name: z.string() })

await client.get('/users/1').expectStatus(200).expectSchema(User)
```

A plain predicate works too — handy when you don't want a schema library:

```ts
await client
  .get('/users/1')
  .expectSchema((body) => typeof (body as any)?.id === 'number')
```

On failure `.expectSchema()` throws an `AssertionError` listing the schema's issue
messages (and paths when present). A Standard Schema's `validate` may be async; the
assertion is awaited, so async validation is fully supported.

`.expectUnder(ms)` asserts the request finished within a latency budget:

```ts
const res = await client.get('/users/1').expectStatus(200).expectUnder(200)

// durationMs is also available directly on the awaited response.
console.log(res.durationMs)
```

`durationMs` is the wall-clock time around the request; with retry enabled it
covers all attempts (retry is opt-in, so by default it's the single request time).

### File uploads

Upload files and non-JSON bodies on top of native `fetch`. The `fixture()` helper
reads a file **relative to the test module** (via `import.meta.url`, so it works
regardless of cwd) and returns a `Blob`:

```ts
import { createClient, fixture } from '@mikkeljuhl/vouch'

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

## Debugging & redaction

When a request misbehaves, turn on **failure diagnostics** to print a compact
request + response block to **stderr**. It is **off by default** and never
changes behaviour.

```ts
// Per-request: force a dump for just this one (always dumps).
await client.get('/users/1').debug().expectStatus(200)

// Per-client: dump on assertion failure, or every request.
const client = createClient({ baseUrl, debug: 'onFailure' }) // or 'always' / true
```

Or enable it from the environment without touching code:

```bash
VOUCH_DEBUG=1 bun test          # 'onFailure' (dump only on a failed assertion)
VOUCH_DEBUG=always bun test     # dump every request
```

A dump reflects the **actual request sent** (final headers incl. the cookie jar
and any `beforeRequest` mutations). Sensitive headers are masked automatically:

```
── vouch ─────────────────────────────
→ GET https://api.example.com/users/1
  headers: { authorization: "***", accept: "application/json" }
  body: {"name":"Ada"}
← 404  (123ms)
  headers: { content-type: "application/json", set-cookie: "***" }
  body: {"data":1,"token":"***"}
─────────────────────────────────────────
```

### Redaction

`redact` masks secrets on **two** surfaces — debug dumps **and** assertion diffs
(which flow into the console, JUnit, and GitHub annotations):

```ts
const client = createClient({
  baseUrl,
  redact: { bodyKeys: ['password', 'token'] },  // mask these JSON field values
  // redact.headers: [...] adds to the built-in sensitive-header set
})
```

- **Header values** for a built-in default set —
  `authorization, cookie, set-cookie, proxy-authorization, x-api-key,
  x-auth-token, api-key` (case-insensitive) — are **always masked in debug
  dumps**, even with no `redact` option, so auth never leaks. `redact.headers`
  adds more.
- **`bodyKeys`** values are masked in debug bodies (JSON, best-effort) and in
  the structured diff of `.expectJson()` / `.expectJsonStrict()`. A failing
  diff for a redacted key shows `"***"` instead of the secret, while other
  fields still show their real values:

  ```
  GET https://api.example.com/session — JSON body did not match (strict) (2 differences):
    • token  expected "***" received "***"
    • role  expected "admin" received "user"
  ```

`redactHeaders(headers, names)` and `redactBodyKeys(value, keys)` are exported as
pure helpers if you need them directly.

---

## Retry semantics

Retry is **opt-in** (off by default) and handles transient failures *before*
assertions evaluate, so a real `4xx` is never masked.

- **`times`** is the number of *additional* attempts after the first; total
  attempts = `times + 1`. Each attempt is a fresh request with its own
  timeout/abort signal (**timeout applies per attempt**).
- **Transport/network errors** (thrown fetch failures, timeouts/aborts) are
  **always retried** until attempts are exhausted, regardless of any predicate.
- **Response-based retry:**
  - With no `when` predicate, the **default policy retries `5xx` and `429`**
    (Too Many Requests) — never other `2xx`/`3xx`/`4xx`. An exhausted `429`
    still surfaces to your assertions.
  - With a `when` predicate, **the predicate is authoritative**: a response is
    retried iff `when(res)` returns true (no hardcoded `5xx`/`429`).
- **Delay & backoff** (between attempts, never before the first):
  - `delayMs` is the base delay; default `0` (immediate retries, original behavior).
  - `backoff: 'fixed'` (default) waits `delayMs` each time; `'exponential'` waits
    `delayMs * 2^attemptIndex`.
  - **`Retry-After`** on a retried response (delta-seconds **or** HTTP-date)
    overrides `delayMs`/`backoff` for that wait, capped at **30s**.
- Resolution order: per-request `.retry(...)` ▸ factory `retry` ▸ none.

```ts
// exponential backoff, retries 5xx + 429 by default
await client
  .get('/flaky')
  .retry({ times: 3, delayMs: 200, backoff: 'exponential' })
  .expectStatus(200)

// custom predicate stays authoritative (retry only on 503)
await client
  .get('/flaky')
  .retry({ times: 3, when: (r) => r.status === 503 })
  .expectStatus(200)
```

The delay computation is exported as a pure `computeRetryDelay(attemptIndex,
opts, response?)` for direct unit testing.

---

## Reporting

The framework ships **no third-party reporter action**. It relies on Bun's
built-in `junit` reporter, with the console teed to a log so the full assertion
messages can be recovered (Bun's JUnit omits them):

```sh
bun test --reporter=junit --reporter-outfile=reports/junit.xml 2>&1 | tee vouch-console.log
bun scripts/ci-summary.mjs reports/junit.xml vouch-console.log
```

The emitted XML (and the optional console log) are consumed by the repo-local,
dependency-free [`scripts/ci-summary.mjs`](./scripts/ci-summary.mjs), which:

- merges each failure's full message — parsed from the console log — back into
  the JUnit `<failure>` elements (as a `message` attribute + CDATA body), so the
  enriched JUnit is downstream-consumable;
- prints **inline annotations** (GitHub `::error` log commands) carrying the real
  diff; and
- appends a **`$GITHUB_STEP_SUMMARY`** Markdown table (totals, per-file
  breakdown, collapsed failure details).

The console-log argument is optional: omit it and the script falls back to the
JUnit-only behaviour (failures shown by error type). Wire it in CI as shown in
[Three ways to run → CI](#3-ci-github-actions). The script is repo-local and not
shipped in the package.

---

## Versioning

Semantic Versioning. The version in `package.json` is the single source of truth —
the `VERSION` export and `vouch --version` both read it. While on `0.x` the public
API may change in a minor release; changes are recorded in
[`CHANGELOG.md`](./CHANGELOG.md). Pin the action/package to a release tag
(`@v0.1.0`) for stability, or track `@main` for the latest.

---

## Roadmap / deferred

Out of MVP scope, designed not to be precluded (see [`DESIGN.md`](./DESIGN.md) §10):

- **Standalone compiled binary** (`bun build --compile`) — a true install-nothing
  artifact; needs a small homegrown test collector (Bun's runner isn't an
  embeddable API). Docker is the install-nothing path for now.
- **Bundled build for non-TS-aware consumers** — the package currently ships TS
  source; a compiled `dist/` is only needed for non-TS publishers.
- **Named variable store** / declarative format.
- **Native per-language SDKs** (Java/Go/etc.) — only if an org forces it.
- **Registry publishing** — once the API stabilizes.

# @mikkeljuhl/vouch usage

A code-authored API test framework for Bun. You write tests in TypeScript with a fluent builder; it sends real HTTP requests to a deployed server and asserts on the response. There is no DSL or YAML: a test is plain Bun test code.

## Requirements and install

Bun >= 1.2.0 is the only runtime; the package ships TypeScript source, run via Bun's export condition. Add it as a dependency:

```sh
bun add -d @mikkeljuhl/vouch
```

Tests run under `bun test` and import the framework by name:

```ts
import { createClient } from '@mikkeljuhl/vouch'
```

## Quickstart

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type Client } from '@mikkeljuhl/vouch'

describe('users', () => {
  let client: Client
  beforeAll(() => {
    client = createClient({ baseUrl: process.env.API_BASE_URL ?? 'http://localhost:3000' })
  })

  test('GET /users/1', async () => {
    const res = await client
      .get<{ id: number; email: string }>('/users/1')
      .expectStatus(200)
      .expectHeader('content-type', /json/)
      .expectJson({ id: 1 })

    expect(res.body.email).toContain('@')
  })
})
```

Point the suite at a server with `API_BASE_URL=https://your.api bun test`. `API_BASE_URL` is only a convention here; name your own vars anything.

## The client

`createClient(opts)` returns a `Client` with `get`/`post`/`put`/`patch`/`delete` plus the carried defaults. Options:

```ts
const client = createClient({
  baseUrl: process.env.API_BASE_URL!,        // required; paths join onto this
  headers: {
    Authorization: () => `Bearer ${process.env.API_TOKEN}`, // callable, resolved per request
    'X-Test-Run': 'ci',                       // static string
  },
  timeoutMs: 15_000,                          // default per request; 0 disables the timeout
  retry: { times: 0 },                        // default retry policy (off); opt in per request
  cookies: true,                              // opt-in in-memory cookie jar (login -> session)
  beforeRequest: (req) => { /* sign / stamp */ }, // runs last, may mutate req.headers/req.url
  proxy: 'http://proxy:8080',                 // route fetch through a proxy
  debug: 'onFailure',                         // diagnostics to stderr (see below)
  redact: { headers: ['x-secret'], bodyKeys: ['password'] },
})
```

A header value is `string | (() => string | Promise<string>)`. Callables re-evaluate on every request, so a rotating token stays fresh. The default timeout is 30s. `cookies` tracks only `name=value` in a client-scoped jar; `client.cookies` exposes `get`/`getAll`/`set`/`clear`.

## The request builder and assertions

A builder is awaitable: configure it, then `await` it to send once, run the queued assertions in order (fail-fast), and resolve to `ApiResponse<T>` (`status`, `headers`, `body`, `text`, `raw`, `durationMs`). Pass the body type as `.get<T>(path)`.

Configuration methods (each returns `this`, so they chain): `.query(record)`, `.headers(record)`, `.json(body)`, `.form(fields)`, `.multipart(fields?)`, `.file(name, blob, filename?)`, `.body(raw)`, `.timeout(ms)`, `.retry(opts)`, `.proxy(url)`, `.debug()`. Per-request `.headers()` win over factory headers; `.json()` sets `content-type: application/json`, while `.form()`/`.multipart()` let fetch set the content-type (and multipart boundary). `.body()` is a raw escape hatch and sets no content-type.

Assertions: `.expectStatus(code)`, `.expectHeader(name, value | RegExp)`, `.expectJson(partial)` (subset match), `.expectJsonStrict(value)` (deep-equal, no extra keys), `.expectText(string | RegExp)` (contains/matches the raw text), `.expectBody(string)` (exact text), `.expectSchema(schema)`, `.expectUnder(ms)`.

```ts
// write + read, sharing state through the plain response object
const created = await client
  .post<Post>('/posts')
  .json({ title: 'hi', userId: 1 })
  .expectStatus(201)
  .expectJson({ title: 'hi', userId: 1 })

await client.get<Post>(`/posts/${created.body.id}`).expectStatus(200)
```

## Examples

Chaining. There is no template store; feed one call's `body` into the next:

```ts
const user = await client.get<User>('/users/1').expectStatus(200)
const posts = await client.get<Post[]>('/posts').query({ userId: user.body.id }).expectStatus(200)
```

Retry (opt-in). `times` is additional attempts after the first. With no `when`, the default policy retries 5xx and 429 only, never other 4xx. A response's `Retry-After` header overrides `delayMs`/`backoff`.

```ts
await client
  .get('/flaky')
  .retry({ times: 3, when: (r) => r.status >= 500 }) // or delayMs/backoff: 'exponential'
  .expectStatus(200)
```

Sessions. With `cookies: true`, a `Set-Cookie` is stored and re-attached on later requests:

```ts
const client = createClient({ baseUrl, cookies: true })
await client.post('/login').expectStatus(200)
await client.get('/me').expectStatus(200) // Cookie header auto-attached
```

Signing. `beforeRequest` runs last (after headers, cookies, URL build) and mutates in place:

```ts
import type { OutgoingRequest } from '@mikkeljuhl/vouch'
const sign = (req: OutgoingRequest) => { req.headers['x-signature'] = hmac(req.method, req.url, req.body) }
const client = createClient({ baseUrl, beforeRequest: sign })
```

File upload. `fixture(metaUrl, relativePath, type?)` reads a file relative to the test module:

```ts
import { fixture } from '@mikkeljuhl/vouch'
const zip = fixture(import.meta.url, '../fixtures/sample.zip', 'application/zip')
await client.post('/upload').multipart({ note: 'hello' }).file('archive', zip, 'sample.zip').expectStatus(200)
```

Schema. `.expectSchema()` takes a predicate or a Standard Schema (zod/valibot/arktype, anything exposing `['~standard']`):

```ts
await client.get<User>('/users/1').expectSchema(
  (b): boolean => typeof b === 'object' && b !== null && typeof (b as User).id === 'number',
)
```

Debug and redaction. `debug: 'onFailure'` dumps request and response to stderr only when an assertion throws; `'always'` dumps every request; `.debug()` forces a dump for one request. `VOUCH_DEBUG` enables it via env (`always` for that mode, any other truthy value for `'onFailure'`). Sensitive headers (authorization, cookie, x-api-key, and similar) are always masked in dumps; `redact.bodyKeys` masks named JSON fields in dumps and in assertion diffs, so JUnit and annotations are masked too.

## Running

Local:

```sh
API_BASE_URL=https://your.api bun test
```

The `vouch` CLI wraps `bun test` with two conveniences:

```sh
vouch tests/users.test.ts          # run specific files
vouch --junit reports/junit.xml    # expands to Bun's JUnit reporter flags
vouch --typecheck                  # tsc --noEmit (baseline config), then run
```

Docker (Bun + the framework preinstalled; mount your tests over `/app/tests`):

```sh
docker run --rm -v "$PWD/tests:/app/tests" ghcr.io/mikkeljuhl/vouch:0.3.0 --reporter=junit --reporter-outfile=/app/reports/junit.xml
```

CI. The action runs the runner image (same `Dockerfile` as `docker run`), runs the tests, then emits annotations and a summary. Linux runners only; type-checking is a separate native step.

```yaml
- uses: actions/checkout@v5
- uses: mikkeljuhl/vouch@v0.3.0
  with:
    junit-file: reports/junit.xml   # optional; paths: defaults to all tests
```

## Reporting

The action writes a JUnit XML report and merges Bun's console output (the structured assertion diff) into its `<failure>` elements, since Bun's JUnit alone carries only the error type. From that report it renders inline PR annotations and a Markdown job summary.

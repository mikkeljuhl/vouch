/**
 * Fluent `RequestBuilder` — the authoring surface of the framework (DESIGN.md
 * §3/§4). A builder is constructed by the client's `get`/`post`/etc. methods,
 * configured via chainable methods, and is itself **awaitable**: awaiting it
 * performs the request once, then runs the queued assertions fail-fast and
 * resolves to a typed `ApiResponse<T>`.
 *
 * Assertions delegate to the engine-agnostic matchers in `./assert`, which throw
 * a clear `AssertionError` on mismatch (DESIGN.md §5). Because a matcher throws
 * on the first failure and assertions run in declared order, fail-fast falls out
 * for free — the first failing assertion's throw rejects the awaited builder and
 * no later assertion runs. The core imports no test library.
 */

import {
  assertBody,
  assertHeader,
  assertJson,
  assertJsonStrict,
  assertSchema,
  assertStatus,
  assertText,
  assertUnder,
  type AssertContext,
  type SchemaInput,
} from './assert'
import type { Client, HeaderValue, HttpMethod, RetryOptions, RequestOptions } from './client'

/** The typed response object an awaited builder resolves to (DESIGN.md §3). */
export interface ApiResponse<T> {
  /** HTTP status code. */
  status: number
  /** Response headers (the native, case-insensitive `Headers` instance). */
  headers: Headers
  /** Parsed body — JSON when the response is JSON, else the raw text. */
  body: T
  /**
   * The raw response body read once as text. Always populated (even for JSON
   * responses), so `.expectText()`/`.expectBody()` and ad-hoc assertions can read
   * the unparsed payload.
   */
  text: string
  /** The underlying fetch `Response` (already consumed). */
  raw: Response
  /**
   * Wall-clock time of the request in milliseconds, measured around `execute()`.
   * With retry enabled this covers **all** attempts; since retry is opt-in and
   * off by default, in the common (single-attempt) case it is the time of the
   * one request. Surfaced so callers can read it directly (and `.expectUnder()`
   * asserts against it).
   */
  durationMs: number
}

/**
 * A queued assertion: runs against the resolved response and a context carrying
 * the request `{ method, url }` for error messages; throws on failure. May be
 * async (a Standard Schema `validate` can return a Promise), so the runner
 * awaits each assertion in declared order.
 */
type Assertion<T> = (res: ApiResponse<T>, ctx: AssertContext) => void | Promise<void>

/**
 * A fluent, awaitable request builder. Configuration methods and assertion
 * methods both return `this` so they chain freely; the request is not performed
 * until the builder is awaited (or `.send()` is called).
 */
export interface RequestBuilder<T = unknown> extends PromiseLike<ApiResponse<T>> {
  /** Merge additional query params onto the request URL. */
  query(record: RequestOptions['query']): this
  /** Add per-request headers (values may be callables); override factory headers. */
  headers(record: Record<string, HeaderValue>): this
  /** Set a JSON body and `content-type: application/json`. */
  json(body: unknown): this
  /**
   * Raw body escape hatch: set the request body to any fetch `BodyInit`
   * (string/Blob/FormData/URLSearchParams/ArrayBuffer/ReadableStream). Does NOT
   * set a content-type — set one via `.headers()` if the endpoint needs it.
   */
  body(raw: NonNullable<RequestInit['body']>): this
  /**
   * Send a URL-encoded form body. Sets the body to a `URLSearchParams(fields)`;
   * fetch auto-sets `content-type: application/x-www-form-urlencoded`.
   */
  form(fields: Record<string, string>): this
  /**
   * Start (or extend) a `multipart/form-data` body, appending the given string
   * fields. fetch sets the `multipart/form-data; boundary=…` content-type itself.
   * Call `.file()` to add file parts to the same form.
   */
  multipart(fields?: Record<string, string>): this
  /**
   * Append a file part to the multipart form (auto-creating it if `.multipart()`
   * was not called first). `filename` defaults to the `Blob`'s `name` (when it is
   * a `File`) else `name`.
   */
  file(name: string, file: Blob, filename?: string): this
  /** Override the per-request timeout (ms). */
  timeout(ms: number): this
  /** Store a retry policy for this request (execution wired in Phase 3). */
  retry(options: RetryOptions): this
  /** Assert the response status equals `code`. */
  expectStatus(code: number): this
  /** Assert a response header matches `value` (exact string) or `RegExp`. */
  expectHeader(name: string, value: string | RegExp): this
  /** Assert the body contains `partial` (deep subset match). */
  expectJson(partial: unknown): this
  /** Assert the body deep-equals `value`. */
  expectJsonStrict(value: unknown): this
  /**
   * Assert the raw response text **contains** `match` (when a string) or
   * **matches** it (when a `RegExp`). Reads `response.text`, so it works on any
   * content-type (plain text, HTML, etc.).
   */
  expectText(match: string | RegExp): this
  /**
   * Assert the raw response text **exactly equals** `expected`. Use
   * `.expectBody('')` to assert an empty body.
   */
  expectBody(expected: string): this
  /**
   * Assert the body validates against `schema`: either a Standard Schema
   * (zod/valibot/arktype/… — anything exposing `['~standard']`) or a plain
   * predicate `(body) => boolean`. Standard Schema `validate` may be async.
   */
  expectSchema(schema: SchemaInput): this
  /**
   * Assert the request completed within `ms` milliseconds (wall-clock around the
   * request; all attempts when retry is enabled). Reads `response.durationMs`.
   */
  expectUnder(ms: number): this
  /** Perform the request, run assertions, and resolve to the response. */
  send(): Promise<ApiResponse<T>>
}

/**
 * Read a response body **once as text**, then derive the parsed `body`:
 * - JSON content-type → `JSON.parse(text)`; on parse failure fall back to the
 *   raw text (never throws — a malformed JSON body is surfaced, not crashed on).
 * - otherwise → the raw text.
 *
 * `raw.text()`/`.json()` each consume the stream, so we read text once and parse
 * from the string rather than touching the stream twice.
 */
async function parseBody<T>(res: Response): Promise<{ body: T; text: string }> {
  const text = await res.text()
  const contentType = res.headers.get('content-type') ?? ''
  if (/\bjson\b/i.test(contentType)) {
    try {
      return { body: JSON.parse(text) as T, text }
    } catch {
      // Malformed JSON despite a JSON content-type: fall back to text, don't throw.
      return { body: text as unknown as T, text }
    }
  }
  return { body: text as unknown as T, text }
}

/**
 * Decide whether a settled `Response` should be retried.
 *
 * - With a caller-provided `when` predicate, the predicate is authoritative: the
 *   response is retried iff `when(res)` returns true (no 5xx/429 hardcoding).
 * - Without a predicate, the default policy retries **5xx and 429** (Too Many
 *   Requests) responses only, never other 2xx/3xx/4xx — so a real 4xx is never
 *   masked (DESIGN.md §8). Retry is opt-in (`times > 0`), and an exhausted 429
 *   still surfaces to assertions.
 */
function shouldRetryResponse(res: Response, when?: (res: Response) => boolean): boolean {
  if (when) return when(res)
  return res.status >= 500 || res.status === 429
}

/** Cap for a `Retry-After`-derived delay (ms) so a hostile/large value can't hang a test. */
const RETRY_AFTER_MAX_MS = 30_000

/**
 * Parse a `Retry-After` header value into a delay in milliseconds, or `null` if
 * absent/unparseable. Supports both forms (RFC 9110):
 * - **delta-seconds** (e.g. `"2"`) → `2000` ms.
 * - **HTTP-date** (e.g. `"Wed, 21 Oct 2026 07:28:00 GMT"`) → the difference from
 *   `now` (clamped to ≥ 0), where `now` is injectable for testability.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  // delta-seconds: a bare non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000
  }
  // HTTP-date.
  const when = Date.parse(trimmed)
  if (Number.isNaN(when)) return null
  return Math.max(0, when - now)
}

/**
 * Pure, unit-testable computation of the delay (ms) to wait **before** a retry.
 *
 * - `attemptIndex` is 0 for the wait before the 1st retry (i.e. after the 1st
 *   failed attempt), 1 before the 2nd retry, etc.
 * - When `response` carries a parseable `Retry-After` header, that value wins —
 *   overriding `delayMs`/`backoff` — capped at {@link RETRY_AFTER_MAX_MS}.
 * - Otherwise: `'fixed'` (default) returns `delayMs`; `'exponential'` returns
 *   `delayMs * 2^attemptIndex`. `delayMs` defaults to `0` (immediate retry).
 * - For a transport error (no `response`), only `delayMs`/`backoff` apply.
 *
 * `now` is injectable so HTTP-date `Retry-After` parsing is deterministic in tests.
 */
export function computeRetryDelay(
  attemptIndex: number,
  opts: Pick<RetryOptions, 'delayMs' | 'backoff'>,
  response?: Response,
  now: number = Date.now(),
): number {
  if (response) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'), now)
    if (retryAfter !== null) {
      return Math.min(retryAfter, RETRY_AFTER_MAX_MS)
    }
  }
  const base = opts.delayMs ?? 0
  if (opts.backoff === 'exponential') {
    return base * 2 ** attemptIndex
  }
  return base
}

/** Resolve after `ms` milliseconds (no-op for `ms <= 0`). */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Construct a fluent builder bound to `client`. Configuration accumulates in
 * closure state; `send()` (also reachable via `then`) performs the request and
 * runs the queued assertions in order.
 */
export function createRequestBuilder<T>(
  client: Client,
  method: HttpMethod,
  path: string,
): RequestBuilder<T> {
  let query: Record<string, string | number | boolean | null | undefined> | undefined
  let headers: Record<string, HeaderValue> | undefined
  let body: RequestInit['body'] | undefined
  // Content-type the framework auto-injects for the chosen body (e.g. `.json()`).
  // Kept separate from user `.headers()` so switching body kinds (json →
  // multipart/form/raw) never leaks a stale content-type that would break a
  // multipart boundary. Merged at request time, with user headers winning.
  let autoContentType: string | undefined
  // The shared multipart FormData so `.multipart()` then `.file()` (and repeated
  // `.file()`) accumulate into the SAME instance.
  let form: FormData | undefined
  let timeoutMs: number | undefined
  // Stored for Phase 3; intentionally unused in execution for now.
  let retryOptions: RetryOptions | undefined
  const assertions: Assertion<T>[] = []

  let pending: Promise<ApiResponse<T>> | undefined

  const builder: RequestBuilder<T> = {
    query(record) {
      query = { ...query, ...record }
      return this
    },

    headers(record) {
      headers = { ...headers, ...record }
      return this
    },

    json(value) {
      body = JSON.stringify(value)
      autoContentType = 'application/json'
      // Switching to a JSON body invalidates any in-progress multipart form
      // (last-body-setter-wins). Drop it so a later `.file()` starts fresh.
      form = undefined
      return this
    },

    body(raw) {
      body = raw
      // Raw escape hatch: the caller owns the content-type (via `.headers()`).
      autoContentType = undefined
      form = undefined
      return this
    },

    form(fields) {
      body = new URLSearchParams(fields)
      // fetch auto-sets application/x-www-form-urlencoded for URLSearchParams.
      autoContentType = undefined
      form = undefined
      return this
    },

    multipart(fields) {
      // Extend an existing form (e.g. after `.file()`), else start one.
      form ??= new FormData()
      if (fields) {
        for (const [key, value] of Object.entries(fields)) {
          form.append(key, value)
        }
      }
      body = form
      // fetch sets multipart/form-data with the correct boundary itself.
      autoContentType = undefined
      return this
    },

    file(name, file, filename) {
      form ??= new FormData()
      const effectiveName = filename ?? (file as File).name ?? name
      form.append(name, file, effectiveName)
      body = form
      autoContentType = undefined
      return this
    },

    timeout(ms) {
      timeoutMs = ms
      return this
    },

    retry(options) {
      // Phase 3: stored here and consumed by `run()`'s retry loop. A per-request
      // policy overrides the factory default (see effective-retry resolution in
      // `run()`).
      retryOptions = options
      return this
    },

    expectStatus(code) {
      assertions.push((res, ctx) => {
        assertStatus(ctx, code, res.status)
      })
      return this
    },

    expectHeader(name, value) {
      assertions.push((res, ctx) => {
        // Header lookup stays case-insensitive via the native `Headers.get`.
        assertHeader(ctx, name, value, res.headers.get(name))
      })
      return this
    },

    expectJson(partial) {
      assertions.push((res, ctx) => {
        assertJson(ctx, partial, res.body)
      })
      return this
    },

    expectJsonStrict(value) {
      assertions.push((res, ctx) => {
        assertJsonStrict(ctx, value, res.body)
      })
      return this
    },

    expectText(match) {
      assertions.push((res, ctx) => {
        assertText(ctx, match, res.text)
      })
      return this
    },

    expectBody(expected) {
      assertions.push((res, ctx) => {
        assertBody(ctx, expected, res.text)
      })
      return this
    },

    expectSchema(schema) {
      // assertSchema may return a Promise (async Standard Schema `validate`); the
      // run loop awaits it, so returning it here preserves fail-fast ordering.
      assertions.push((res, ctx) => assertSchema(ctx, schema, res.body))
      return this
    },

    expectUnder(ms) {
      assertions.push((res, ctx) => {
        assertUnder(ctx, ms, res.durationMs)
      })
      return this
    },

    send() {
      if (!pending) pending = run()
      return pending
    },

    then(onfulfilled, onrejected) {
      return this.send().then(onfulfilled, onrejected)
    },
  }

  /**
   * Execute the request with the effective retry policy, returning the response
   * to evaluate assertions against.
   *
   * Effective-retry resolution: the per-request `.retry(...)` policy if set,
   * otherwise the factory default (`client.retry`), otherwise no retry
   * (`times: 0`). `times` is the number of *additional* attempts after the
   * first, so total attempts = `times + 1`.
   *
   * Retry decision:
   * - **Transport/network errors** (a thrown `_request`, e.g. fetch failure or
   *   timeout/abort) are always retryable, regardless of any `when` predicate.
   *   If every attempt throws, the last error is rethrown.
   * - **Response-based retry** is governed by `when(res)` when provided — the
   *   predicate fully controls which responses are retried (the framework does
   *   not hardcode 5xx when a predicate is given). When no `when` is provided
   *   and `times > 0`, the default policy retries on 5xx responses only and
   *   never on 2xx/3xx/4xx — so retry can never mask a real 4xx.
   *
   * Each attempt is a fresh `_request` call and therefore gets its own
   * timeout/abort signal (timeout applies per attempt). The request body is a
   * pre-serialized string (set via `.json()`), so it is safely resent verbatim
   * on every attempt.
   *
   * Between attempts (never before the first) we sleep `computeRetryDelay(...)`
   * ms — `delayMs`/`backoff` from the policy, overridden by a response's
   * `Retry-After` header when present (capped). Default `delayMs: 0` keeps the
   * original immediate-retry behavior.
   */
  async function execute(): Promise<Response> {
    const effective = retryOptions ?? client.retry
    const times = effective?.times ?? 0
    const when = effective?.when
    const delayOpts = { delayMs: effective?.delayMs, backoff: effective?.backoff }

    // A ReadableStream body is consumed by the first fetch and cannot be replayed
    // on a subsequent attempt. Blob/FormData/URLSearchParams/string are
    // re-serialized by fetch per attempt, so only streams are unsafe to retry.
    if (times > 0 && body instanceof ReadableStream) {
      throw new Error(
        'apitest: a ReadableStream body cannot be retried; set .retry({times:0}) or use a Blob/Buffer',
      )
    }

    // Merge the framework's auto content-type under the user's `.headers()` so a
    // user-supplied content-type always wins; omit it entirely for body kinds
    // (form/multipart) where fetch must set the boundary itself.
    const mergedHeaders = autoContentType
      ? { 'content-type': autoContentType, ...headers }
      : headers

    let lastError: unknown
    let lastResponse: Response | undefined

    for (let attempt = 0; attempt <= times; attempt++) {
      const isLastAttempt = attempt === times
      try {
        const res = await client._request(method, path, {
          query,
          headers: mergedHeaders,
          body,
          timeoutMs,
        })
        lastResponse = res
        // No more attempts left, or this response doesn't warrant a retry.
        if (isLastAttempt || !shouldRetryResponse(res, when)) {
          return res
        }
        // Wait before the next attempt; Retry-After (if any) wins over delay/backoff.
        await sleep(computeRetryDelay(attempt, delayOpts, res))
      } catch (error) {
        // Transport/network errors are always retryable until exhausted.
        lastError = error
        if (isLastAttempt) throw error
        // No response → delayMs/backoff only.
        await sleep(computeRetryDelay(attempt, delayOpts))
      }
    }

    // Loop only exits via the returns/throws above when an attempt produced a
    // response; this is reachable only if every attempt threw (handled above)
    // — kept for type-safety/exhaustiveness.
    if (lastResponse) return lastResponse
    throw lastError
  }

  async function run(): Promise<ApiResponse<T>> {
    // Measure the wall-clock time of the request. With retry enabled this spans
    // ALL attempts (the whole `execute()` loop); since retry is opt-in and off by
    // default, in the common single-attempt case this is the one request's time.
    const start = performance.now()
    const raw = await execute()
    const durationMs = performance.now() - start
    const { body, text } = await parseBody<T>(raw)
    const response: ApiResponse<T> = {
      status: raw.status,
      headers: raw.headers,
      body,
      text,
      raw,
      durationMs,
    }
    // Context for assertion messages: the same URL fetch was sent to.
    const ctx: AssertContext = { method, url: client.resolveUrl(path, query) }
    // Fail-fast: await in declared order so an async assertion (e.g. a Standard
    // Schema with an async `validate`) is fully settled before the next runs; the
    // first rejection/throw stops the rest.
    for (const assertion of assertions) {
      await assertion(response, ctx)
    }
    return response
  }

  return builder
}

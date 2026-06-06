/**
 * Test helper: install/uninstall a mocked `globalThis.fetch` with auto-restore.
 *
 * The unit suites all do the same dance by hand — save the real `fetch` in a
 * module-scope const, replace it in `beforeEach`, build `new Response(...)`
 * factories, and restore in `afterEach` so the stub never leaks into the live
 * (mock-server) suites. This module collapses that into ~1-2 lines:
 *
 *   const fetch = installMockFetch()      // top of describe; auto-restores
 *   fetch.json({ ok: true })             // set the single response
 *   ...
 *   fetch.calls[0].url                   // inspect what was sent
 *
 * `installMockFetch()` wires its own `beforeEach`/`afterEach` (via bun:test) so a
 * test body never touches `globalThis.fetch` directly. For tests that prefer
 * manual control there is the lower-level {@link mockFetch}.
 *
 * Dependency-free beyond `bun:test` (for the lifecycle hooks) and the `Response`
 * web global. Imports no production code.
 */

import { afterEach, beforeEach } from 'bun:test'

/** Bun's fetch init carries an extra `proxy` field beyond the DOM RequestInit. */
export type FetchInit = RequestInit & { proxy?: string }

/** One recorded fetch invocation, normalized for ergonomic assertions. */
export interface FetchCall {
  /** The URL the request went to (first fetch arg, coerced to string). */
  url: string
  /** The raw fetch init (second arg), or undefined if none was passed. */
  init: FetchInit | undefined
  /** Convenience: `init.headers` as a plain record (the framework sends one). */
  headers: Record<string, string>
  /** Convenience: `init.method`, defaulting to 'GET'. */
  method: string
  /** Convenience: `init.body` (raw BodyInit), or undefined. */
  body: RequestInit['body'] | undefined
  /** Convenience: `init.proxy` (Bun extension), or undefined. */
  proxy: string | undefined
  /** The original positional args, untouched, for exotic assertions. */
  args: [string, FetchInit | undefined]
}

/** A factory producing the next `Response` to return, given the recorded call. */
export type ResponseFactory = (call: FetchCall) => Response | Promise<Response>

/** Init bag for the {@link jsonResponse} / {@link textResponse} builders. */
export interface ResponseInit2 {
  status?: number
  headers?: Record<string, string>
}

/** A live mock-fetch handle: program responses, then read what was sent. */
export interface MockFetch {
  /** Every recorded call, in order. */
  readonly calls: FetchCall[]
  /** Number of times the mock was invoked (alias for `calls.length`). */
  readonly callCount: number
  /** The most recent recorded call, or undefined if never called. */
  readonly lastCall: FetchCall | undefined
  /**
   * Set the SINGLE response returned for every call (replaces any sequence).
   * Accepts a `Response`, or a factory `(call) => Response` for dynamic bodies.
   */
  respond(response: Response | ResponseFactory): this
  /** Sugar: respond with a JSON body (content-type set unless overridden). */
  json(body: unknown, init?: ResponseInit2): this
  /** Sugar: respond with a text/plain body. */
  text(text: string, init?: ResponseInit2): this
  /**
   * Queue a SEQUENCE of responses, one consumed per call in order (for retry
   * tests: e.g. `[503, 200]`). After the sequence is exhausted the LAST entry is
   * reused (so an exhausted-retry test keeps getting the failing response).
   * Each entry may be a `Response` or a `(call) => Response` factory.
   */
  sequence(...responses: (Response | ResponseFactory)[]): this
  /** Push one more response onto the end of the current sequence. */
  enqueue(response: Response | ResponseFactory): this
  /** Reset recorded calls + queued responses (rarely needed; auto on restore). */
  reset(): void
  /** Manually restore the real fetch (installMockFetch does this for you). */
  restore(): void
}

/** Read `init.headers` (Headers | array | record) into a plain record. */
function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const out: Record<string, string> = {}
    headers.forEach((v, k) => (out[k] = v))
    return out
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...(headers as Record<string, string>) }
}

function toCall(args: unknown[]): FetchCall {
  const url = String(args[0])
  const init = args[1] as FetchInit | undefined
  return {
    url,
    init,
    headers: headersToRecord(init?.headers),
    method: init?.method ?? 'GET',
    body: init?.body ?? undefined,
    proxy: init?.proxy,
    args: [url, init],
  }
}

/**
 * Low-level: replace `globalThis.fetch` with a recording mock NOW and return a
 * handle. Does NOT wire any lifecycle hooks — you must call `.restore()`
 * yourself (or use {@link installMockFetch}, which auto-restores). Defaults to a
 * `200 OK` empty response until you program one.
 */
export function mockFetch(): MockFetch {
  const realFetch = globalThis.fetch
  const calls: FetchCall[] = []
  let queue: (Response | ResponseFactory)[] = []
  let single: Response | ResponseFactory | undefined

  const resolve = async (call: FetchCall): Promise<Response> => {
    let pick: Response | ResponseFactory
    if (queue.length > 0) {
      // Consume one; when only the last remains, keep reusing it.
      pick = queue.length === 1 ? queue[0]! : queue.shift()!
    } else if (single !== undefined) {
      pick = single
    } else {
      return new Response('', { status: 200 })
    }
    return typeof pick === 'function' ? pick(call) : pick
  }

  const impl = async (...args: unknown[]): Promise<Response> => {
    const call = toCall(args)
    calls.push(call)
    return resolve(call)
  }
  globalThis.fetch = impl as unknown as typeof fetch

  const handle: MockFetch = {
    get calls() {
      return calls
    },
    get callCount() {
      return calls.length
    },
    get lastCall() {
      return calls[calls.length - 1]
    },
    respond(response) {
      single = response
      queue = []
      return handle
    },
    json(body, init) {
      return handle.respond(jsonResponse(body, init))
    },
    text(text, init) {
      return handle.respond(textResponse(text, init))
    },
    sequence(...responses) {
      queue = [...responses]
      single = undefined
      return handle
    },
    enqueue(response) {
      queue.push(response)
      return handle
    },
    reset() {
      calls.length = 0
      queue = []
      single = undefined
    },
    restore() {
      globalThis.fetch = realFetch
    },
  }
  return handle
}

/**
 * Recommended entry point: install a recording fetch mock and auto-restore it.
 * Re-installs fresh before EACH test and restores after, so the stub can never
 * leak into the live suites. Returns a stable handle (its accessors read the
 * current per-test mock), so call it once at the top of a `describe`:
 *
 *   const fetch = installMockFetch()
 *   test('...', async () => { fetch.json({ ok: true }); ... fetch.lastCall })
 */
export function installMockFetch(): MockFetch {
  let active: MockFetch | undefined

  beforeEach(() => {
    active = mockFetch()
  })
  afterEach(() => {
    active?.restore()
    active = undefined
  })

  const guard = (): MockFetch => {
    if (!active) throw new Error('mock fetch accessed outside a test (use inside test/beforeEach)')
    return active
  }

  // A thin proxy delegating to the current per-test mock.
  return {
    get calls() {
      return guard().calls
    },
    get callCount() {
      return guard().callCount
    },
    get lastCall() {
      return guard().lastCall
    },
    respond(r) {
      guard().respond(r)
      return this
    },
    json(b, i) {
      guard().json(b, i)
      return this
    },
    text(t, i) {
      guard().text(t, i)
      return this
    },
    sequence(...r) {
      guard().sequence(...r)
      return this
    },
    enqueue(r) {
      guard().enqueue(r)
      return this
    },
    reset() {
      guard().reset()
    },
    restore() {
      guard().restore()
    },
  }
}

// ─── Response builders ──────────────────────────────────────────────────────

/** Build a JSON `Response` (sets `content-type: application/json` unless given). */
export function jsonResponse(body: unknown, init: ResponseInit2 = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/** Build a `text/plain` `Response` (override content-type via `init.headers`). */
export function textResponse(text: string, init: ResponseInit2 = {}): Response {
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/plain', ...init.headers },
  })
}

/**
 * Build a `Response` carrying one or more `Set-Cookie` lines (each preserved as a
 * distinct header so `Headers.getSetCookie()` sees them all). Pass cookie lines
 * like `'sid=abc; Path=/'` or `'x=; Max-Age=0'`.
 */
export function cookieResponse(
  setCookies: string | string[],
  init: ResponseInit2 & { body?: string } = {},
): Response {
  const lines = Array.isArray(setCookies) ? setCookies : [setCookies]
  const headers: [string, string][] = lines.map((line) => ['set-cookie', line])
  for (const [k, v] of Object.entries(init.headers ?? {})) headers.push([k, v])
  return new Response(init.body ?? '', { status: init.status ?? 200, headers })
}

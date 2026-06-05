/**
 * Client factory: base-URL joining, per-request header resolution, and carried
 * defaults (timeout/retry). This is the configuration surface of the framework —
 * see DESIGN.md §4.
 *
 * Phase 2 builds the fluent `RequestBuilder` on top of the low-level `_request`
 * seam exposed here; this module intentionally stays thin.
 */

import { createRequestBuilder, type RequestBuilder } from './builder'

/** A header value is either a static string or a (sync or async) callable. */
export type HeaderValue = string | (() => string | Promise<string>)

export interface RetryOptions {
  times: number
  when?: (res: Response) => boolean
}

/**
 * The fully-resolved request handed to a {@link ClientOptions.beforeRequest}
 * hook, immediately before `fetch`. The hook may **mutate** `headers` (and
 * `url`) in place; the client then uses the mutated values for the actual fetch.
 *
 * `body` is provided for read-only inspection (e.g. computing a signature). For
 * stream bodies the body is not re-readable; signing works with string/Blob/
 * URLSearchParams/FormData bodies set via `.json()`/`.body()`/`.form()` etc.
 */
export interface OutgoingRequest {
  method: string
  /** Fully-resolved URL (base + path + query). May be mutated in place. */
  url: string
  /**
   * Fully-resolved headers (factory + per-request callables applied + cookie jar
   * attached). MUTATE this record to add/override headers; the mutations win
   * (the hook runs last in the precedence chain).
   */
  headers: Record<string, string>
  /** The request body as set by `.json()`/`.body()`/`.form()`/etc. (read for signing). */
  body: RequestInit['body']
}

/** Read/write accessor over a client's in-memory cookie jar. */
export interface CookieJar {
  /** Get the value of a stored cookie by name, or `undefined`. */
  get(name: string): string | undefined
  /** Snapshot of all stored cookies as a plain `name → value` record. */
  getAll(): Record<string, string>
  /** Seed/overwrite a cookie (last write wins). */
  set(name: string, value: string): void
  /** Remove all stored cookies. */
  clear(): void
}

export interface ClientOptions {
  baseUrl: string
  headers?: Record<string, HeaderValue>
  /** Default applied to every request (carried for Phase 2/3). */
  timeoutMs?: number
  /** Default retry policy (carried for Phase 3; not executed in Phase 1). */
  retry?: RetryOptions
  /**
   * Opt-in (default **false**) in-memory, per-client cookie jar. When `true`,
   * `Set-Cookie` from each response is parsed and stored, and a `Cookie` header
   * is attached to subsequent requests — enabling login → session flows on the
   * same client. This is a **simplified test-session jar**: only `name=value` is
   * tracked (domain/path/expiry/attributes are ignored), scoped to the client,
   * not a spec-compliant browser jar.
   */
  cookies?: boolean
  /**
   * Hook invoked inside `_request` **once per attempt**, AFTER headers are
   * resolved + cookies attached + the URL is built, and BEFORE `fetch`. May
   * mutate `req.headers`/`req.url` in place (and may be async — it is awaited).
   * Use for request signing (HMAC/SigV4), correlation IDs, etc.
   */
  beforeRequest?: (req: OutgoingRequest) => void | Promise<void>
}

/** Options for a single low-level request. */
export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>
  /** Per-request headers; values may be callables and override factory headers. */
  headers?: Record<string, HeaderValue>
  body?: RequestInit['body']
  /** Per-request timeout override (defaults to the client's `timeoutMs`). */
  timeoutMs?: number
  signal?: AbortSignal
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export interface Client {
  /** The normalized base URL the client was constructed with. */
  readonly baseUrl: string
  /** Carried default timeout (ms), or undefined if none configured. */
  readonly timeoutMs: number | undefined
  /** Carried default retry policy, or undefined if none configured. */
  readonly retry: RetryOptions | undefined
  /**
   * Read/write accessor over the in-memory cookie jar. Only meaningful when the
   * client was created with `cookies: true`; otherwise it is a no-op empty jar.
   */
  readonly cookies: CookieJar
  /** Begin a GET request to `path`; returns a fluent, awaitable builder. */
  get<T = unknown>(path: string): RequestBuilder<T>
  /** Begin a POST request to `path`; returns a fluent, awaitable builder. */
  post<T = unknown>(path: string): RequestBuilder<T>
  /** Begin a PUT request to `path`; returns a fluent, awaitable builder. */
  put<T = unknown>(path: string): RequestBuilder<T>
  /** Begin a PATCH request to `path`; returns a fluent, awaitable builder. */
  patch<T = unknown>(path: string): RequestBuilder<T>
  /** Begin a DELETE request to `path`; returns a fluent, awaitable builder. */
  delete<T = unknown>(path: string): RequestBuilder<T>
  /**
   * Resolve the effective header set for a request: factory headers merged with
   * `overrides`, with all callables invoked and awaited. Case-insensitive on
   * header names — overrides win on collision.
   */
  resolveHeaders(overrides?: Record<string, HeaderValue>): Promise<Record<string, string>>
  /** Join a request path onto the client's base URL, applying query params. */
  resolveUrl(path: string, query?: RequestOptions['query']): string
  /**
   * Low-level request seam. Phase 2's fluent builder is implemented in terms of
   * this. Returns the raw fetch `Response`.
   */
  _request(method: HttpMethod, path: string, opts?: RequestOptions): Promise<Response>
}

/** Resolve a single header value, awaiting callables. */
async function resolveValue(value: HeaderValue): Promise<string> {
  return typeof value === 'function' ? value() : value
}

/**
 * Merge factory + override headers (override wins) using case-insensitive header
 * names, then resolve every value (awaiting callables). Resolution happens once
 * per call, so callables are re-evaluated on each request.
 *
 * Collisions are keyed by lowercased name but the *last writer's* original
 * casing is preserved for the emitted key.
 */
export async function resolveHeaders(
  factory: Record<string, HeaderValue> | undefined,
  overrides?: Record<string, HeaderValue>,
): Promise<Record<string, string>> {
  // lowercased name -> { name (display casing), value }
  const merged = new Map<string, { name: string; value: HeaderValue }>()

  for (const [name, value] of Object.entries(factory ?? {})) {
    merged.set(name.toLowerCase(), { name, value })
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    merged.set(name.toLowerCase(), { name, value })
  }

  const entries = await Promise.all(
    [...merged.values()].map(async ({ name, value }) => [name, await resolveValue(value)] as const),
  )
  return Object.fromEntries(entries)
}

/**
 * Join a base URL and a request path without dropping or doubling segments.
 * A leading-slash path joins relative to the base URL's origin+path; an absolute
 * URL path is returned as-is.
 */
export function joinUrl(baseUrl: string, path: string): string {
  // Absolute request URL: use verbatim.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path

  const base = baseUrl.replace(/\/+$/, '')
  const rel = path.replace(/^\/+/, '')
  return rel ? `${base}/${rel}` : base
}

/** Apply query params to a URL string, skipping null/undefined values. */
function applyQuery(url: string, query?: RequestOptions['query']): string {
  if (!query) return url
  const u = new URL(url)
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue
    u.searchParams.set(key, String(value))
  }
  return u.toString()
}

/**
 * Decide whether a `Set-Cookie` value signals deletion of its cookie. We honor
 * the common deletion cases of a simplified test-session jar: an empty value
 * (`name=`), `Max-Age=0` (or negative), or an `Expires` in the past. Full
 * attribute/domain/path matching is out of scope (see `cookies` on ClientOptions).
 */
function isCookieDeletion(value: string, attributes: string[]): boolean {
  if (value === '') return true
  for (const attr of attributes) {
    const eq = attr.indexOf('=')
    const key = (eq === -1 ? attr : attr.slice(0, eq)).trim().toLowerCase()
    const val = eq === -1 ? '' : attr.slice(eq + 1).trim()
    if (key === 'max-age') {
      const n = Number(val)
      if (!Number.isNaN(n) && n <= 0) return true
    } else if (key === 'expires') {
      const t = Date.parse(val)
      if (!Number.isNaN(t) && t <= Date.now()) return true
    }
  }
  return false
}

/**
 * Apply a single `Set-Cookie` header line to the jar. Only the substring before
 * the first `;` (`name=value`) is stored; attributes are parsed only to detect
 * deletion (empty value / Max-Age<=0 / past Expires). Last write wins.
 */
function applySetCookie(jar: Map<string, string>, setCookie: string): void {
  const semi = setCookie.indexOf(';')
  const pair = (semi === -1 ? setCookie : setCookie.slice(0, semi)).trim()
  const attributes = semi === -1 ? [] : setCookie.slice(semi + 1).split(';')
  const eq = pair.indexOf('=')
  if (eq === -1) return // malformed: no name
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  if (!name) return
  if (isCookieDeletion(value, attributes)) {
    jar.delete(name)
    return
  }
  jar.set(name, value)
}

/** Read `Set-Cookie` lines off a response (Bun + Node 18.14+) into the jar. */
function storeSetCookies(jar: Map<string, string>, res: Response): void {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const lines = typeof getSetCookie === 'function' ? getSetCookie.call(res.headers) : []
  for (const line of lines) applySetCookie(jar, line)
}

/** Serialize the jar into a `Cookie` header value (`a=1; b=2`), or undefined if empty. */
function serializeCookieHeader(jar: Map<string, string>): string | undefined {
  if (jar.size === 0) return undefined
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

export function createClient(opts: ClientOptions): Client {
  const baseUrl = opts.baseUrl
  const factoryHeaders = opts.headers
  const defaultTimeoutMs = opts.timeoutMs
  const defaultRetry = opts.retry
  const cookiesEnabled = opts.cookies ?? false
  const beforeRequest = opts.beforeRequest

  // In-memory, per-client cookie jar (only used when `cookies: true`).
  const jar = new Map<string, string>()
  const cookieJar: CookieJar = {
    get: (name) => jar.get(name),
    getAll: () => Object.fromEntries(jar),
    set: (name, value) => {
      jar.set(name, value)
    },
    clear: () => {
      jar.clear()
    },
  }

  const client: Client = {
    baseUrl,
    timeoutMs: defaultTimeoutMs,
    retry: defaultRetry,
    cookies: cookieJar,

    get(path) {
      return createRequestBuilder(client, 'GET', path)
    },
    post(path) {
      return createRequestBuilder(client, 'POST', path)
    },
    put(path) {
      return createRequestBuilder(client, 'PUT', path)
    },
    patch(path) {
      return createRequestBuilder(client, 'PATCH', path)
    },
    delete(path) {
      return createRequestBuilder(client, 'DELETE', path)
    },

    resolveHeaders(overrides) {
      return resolveHeaders(factoryHeaders, overrides)
    },

    resolveUrl(path, query) {
      return applyQuery(joinUrl(baseUrl, path), query)
    },

    async _request(method, path, requestOpts = {}) {
      const url = client.resolveUrl(path, requestOpts.query)
      const headers = await client.resolveHeaders(requestOpts.headers)

      // Attach the cookie jar under the user's headers: a per-request
      // `.headers({ cookie })` (resolved above) overrides the jar entirely.
      if (cookiesEnabled) {
        const hasUserCookie = Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')
        if (!hasUserCookie) {
          const cookieHeader = serializeCookieHeader(jar)
          if (cookieHeader !== undefined) headers.cookie = cookieHeader
        }
      }

      // The hook runs LAST (after cookies) and may mutate headers/url in place;
      // its mutations therefore win the precedence chain. Re-run per attempt.
      if (beforeRequest) {
        const outgoing: OutgoingRequest = {
          method,
          url,
          headers,
          body: requestOpts.body ?? null,
        }
        await beforeRequest(outgoing)
        // Allow the hook to redirect the request by reassigning `url`.
        const finalUrl = outgoing.url

        const timeoutMs = requestOpts.timeoutMs ?? defaultTimeoutMs
        const signal =
          requestOpts.signal ??
          (timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined)

        const res = await fetch(finalUrl, {
          method,
          headers: outgoing.headers,
          body: requestOpts.body ?? null,
          signal,
        })
        if (cookiesEnabled) storeSetCookies(jar, res)
        return res
      }

      const timeoutMs = requestOpts.timeoutMs ?? defaultTimeoutMs
      const signal =
        requestOpts.signal ??
        (timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined)

      const res = await fetch(url, {
        method,
        headers,
        body: requestOpts.body ?? null,
        signal,
      })
      if (cookiesEnabled) storeSetCookies(jar, res)
      return res
    },
  }

  return client
}

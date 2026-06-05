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

export interface ClientOptions {
  baseUrl: string
  headers?: Record<string, HeaderValue>
  /** Default applied to every request (carried for Phase 2/3). */
  timeoutMs?: number
  /** Default retry policy (carried for Phase 3; not executed in Phase 1). */
  retry?: RetryOptions
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

export function createClient(opts: ClientOptions): Client {
  const baseUrl = opts.baseUrl
  const factoryHeaders = opts.headers
  const defaultTimeoutMs = opts.timeoutMs
  const defaultRetry = opts.retry

  const client: Client = {
    baseUrl,
    timeoutMs: defaultTimeoutMs,
    retry: defaultRetry,

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

      const timeoutMs = requestOpts.timeoutMs ?? defaultTimeoutMs
      const signal =
        requestOpts.signal ??
        (timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined)

      return fetch(url, {
        method,
        headers,
        body: requestOpts.body ?? null,
        signal,
      })
    },
  }

  return client
}

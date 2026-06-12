/**
 * First-class Server-Sent Events support: `client.sse(path)` returns a fluent,
 * awaitable `SseBuilder` that opens a `text/event-stream` request, collects
 * parsed events until a condition is met (default: the first event), then
 * aborts the stream and resolves to an `SseCapture`.
 *
 * Same design rules as the request builder: the core imports no test library
 * (failures throw a plain `AssertionError`), web-standard APIs only
 * (`fetch` + `ReadableStream` + `TextDecoder`, identical on Bun and Node), and
 * the builder reuses the client's `_request` seam, so factory headers,
 * callable header values, cookies, and `beforeRequest` signing all apply to
 * the stream request like any other.
 *
 * Streams never "complete" the way request/response bodies do, so the
 * lifecycle differs from `RequestBuilder` in three deliberate ways:
 * - `.until(predicate)` (or its `.take(n)` sugar) decides when the capture is
 *   done; vouch then cancels the stream — the consumer never hangs on an
 *   open connection.
 * - `.timeout(ms)` bounds the WAIT for that condition (default 10s, distinct
 *   from the client's request timeout, which would kill a healthy stream).
 *   An unmet condition at the deadline is an assertion failure, not a hang.
 * - `.onOpen(fn)` runs after the response headers arrive and before reading,
 *   so a test can trigger the server-side event it is waiting for without
 *   racing the subscription.
 */

import { AssertionError, assertHeader, assertStatus, type AssertContext } from './assert.js'
import type { Client, HeaderValue, RequestOptions } from './client.js'

/** One parsed SSE event (a dispatched `data:`-carrying block). */
export interface SseEvent {
  /**
   * The block's `id:` field, or `undefined` when it carried none. Reported
   * per block — vouch does not apply the spec's last-event-id stickiness, so
   * assertions read exactly what the server sent.
   */
  id?: string
  /** The block's `event:` field; the SSE default type is `'message'`. */
  event: string
  /** All `data:` lines of the block, joined with `\n` (per the SSE spec). */
  data: string
}

/** What an awaited `SseBuilder` resolves to. */
export interface SseCapture {
  /** HTTP status of the stream response. */
  status: number
  /** Response headers (the native, case-insensitive `Headers` instance). */
  headers: Headers
  /** Events collected until the `until` condition was met. */
  events: SseEvent[]
  /** Wall-clock time from request start until the capture settled (ms). */
  durationMs: number
}

/**
 * Default wait budget for the `until` condition (ms). Deliberately shorter
 * than `DEFAULT_TIMEOUT_MS`: an SSE assertion that has not been satisfied
 * after 10s is a failing test, and a tight default keeps a red suite fast.
 */
export const DEFAULT_SSE_TIMEOUT_MS = 10_000

/** A queued open-time assertion (status/headers — they exist before events). */
type SseAssertion = (capture: SseCapture, ctx: AssertContext) => void

/**
 * A fluent, awaitable SSE builder. Configuration methods return `this` and
 * chain; the stream is not opened until the builder is awaited (or `.send()`
 * is called).
 */
export interface SseBuilder extends PromiseLike<SseCapture> {
  /** Merge additional query params onto the stream URL. */
  query(record: RequestOptions['query']): this
  /** Add per-request headers (values may be callables); override factory headers. */
  headers(record: Record<string, HeaderValue>): this
  /** Set the `Last-Event-ID` header — the SSE resume/catch-up cursor. */
  lastEventId(id: string): this
  /**
   * Bound the wait for the `until` condition (default
   * {@link DEFAULT_SSE_TIMEOUT_MS}). When the deadline passes with the
   * condition unmet, the awaited builder rejects with an `AssertionError`
   * naming how many events arrived. `0` disables the deadline (the stream
   * then settles only via `until` or server close).
   */
  timeout(ms: number): this
  /**
   * Run `fn` once the stream is OPEN (status + headers received, open-time
   * assertions passed) and before any event is read. Use it to fire the
   * request that produces the event the capture is waiting for — subscribing
   * first, acting second, with no race.
   */
  onOpen(fn: () => void | Promise<void>): this
  /**
   * Collect events until `predicate(events)` returns true, then cancel the
   * stream and resolve. Replaces the default condition (first event).
   */
  until(predicate: (events: readonly SseEvent[]) => boolean): this
  /** Sugar for `.until((events) => events.length >= n)`. */
  take(n: number): this
  /** Assert the stream response status equals `code` (runs at open). */
  expectStatus(code: number): this
  /** Assert a stream response header matches (exact string or RegExp; at open). */
  expectHeader(name: string, value: string | RegExp): this
  /** Open the stream, capture until done, and resolve to the capture. */
  send(): Promise<SseCapture>
}

/**
 * Incremental `text/event-stream` parser. Feed decoded chunks in any
 * fragmentation; complete blocks come back as events. Field handling per the
 * spec: `data:` lines accumulate and join with `\n`, `event:` sets the type
 * (default `message`), `id:` is reported on the block, comment lines (`:`)
 * and `retry:`/unknown fields are ignored, and a block whose data buffer is
 * empty dispatches nothing (so heartbeat comments never surface as events).
 */
export function createSseParser(): { feed(chunk: string): SseEvent[] } {
  let buffer = ''
  let dataLines: string[] = []
  let eventType = ''
  let id: string | undefined

  function flushBlock(out: SseEvent[]): void {
    if (dataLines.length > 0) {
      const event: SseEvent = { event: eventType || 'message', data: dataLines.join('\n') }
      if (id !== undefined) event.id = id
      out.push(event)
    }
    dataLines = []
    eventType = ''
    id = undefined
  }

  function processLine(line: string, out: SseEvent[]): void {
    if (line === '') {
      flushBlock(out)
      return
    }
    if (line.startsWith(':')) return // comment (heartbeats)
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') eventType = value
    else if (field === 'id') id = value
    // 'retry' and unknown fields: ignored.
  }

  return {
    feed(chunk: string): SseEvent[] {
      buffer += chunk
      const out: SseEvent[] = []
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        // Tolerate \r\n line endings (the spec allows CR, LF, or CRLF).
        const line = buffer[nl - 1] === '\r' ? buffer.slice(0, nl - 1) : buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        processLine(line, out)
        nl = buffer.indexOf('\n')
      }
      return out
    },
  }
}

/** Identical formatting to the assert module's request prefix. */
function prefix(ctx: AssertContext): string {
  return `${ctx.method} ${ctx.url} — `
}

/**
 * Construct an SSE builder bound to `client`. Configuration accumulates in
 * closure state; `send()` (also reachable via `then`) opens the stream once.
 */
export function createSseBuilder(client: Client, path: string): SseBuilder {
  let query: RequestOptions['query']
  let headers: Record<string, HeaderValue> | undefined
  let timeoutMs = DEFAULT_SSE_TIMEOUT_MS
  let onOpenFn: (() => void | Promise<void>) | undefined
  let predicate: (events: readonly SseEvent[]) => boolean = (events) => events.length >= 1
  const assertions: SseAssertion[] = []

  let pending: Promise<SseCapture> | undefined

  const builder: SseBuilder = {
    query(record) {
      query = { ...query, ...record }
      return this
    },

    headers(record) {
      headers = { ...headers, ...record }
      return this
    },

    lastEventId(id) {
      headers = { ...headers, 'last-event-id': id }
      return this
    },

    timeout(ms) {
      timeoutMs = ms
      return this
    },

    onOpen(fn) {
      onOpenFn = fn
      return this
    },

    until(p) {
      predicate = p
      return this
    },

    take(n) {
      predicate = (events) => events.length >= n
      return this
    },

    expectStatus(code) {
      assertions.push((capture, ctx) => {
        assertStatus(ctx, code, capture.status)
      })
      return this
    },

    expectHeader(name, value) {
      assertions.push((capture, ctx) => {
        assertHeader(ctx, name, value, capture.headers.get(name))
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

  async function run(): Promise<SseCapture> {
    const url = client.resolveUrl(path, query)
    const ctx: AssertContext = { method: 'GET', url }
    const controller = new AbortController()
    const started = Date.now()
    const events: SseEvent[] = []

    // The client's request timeout would abort a healthy long-lived stream,
    // so it is disabled (`timeoutMs: 0`) — the wait budget below is the SSE
    // builder's own `.timeout(ms)`, enforced around the read loop.
    const res = await client._request('GET', path, {
      query,
      headers: { accept: 'text/event-stream', ...headers },
      timeoutMs: 0,
      signal: controller.signal,
    })

    const capture: SseCapture = { status: res.status, headers: res.headers, events, durationMs: 0 }
    const contentType = res.headers.get('content-type') ?? ''
    const isStream = contentType.includes('text/event-stream')

    if (!res.ok || !isStream) {
      // Not a stream. With queued assertions the caller owns the expectation
      // (e.g. `.expectStatus(401)` on an auth check); with none, failing
      // loudly beats resolving with zero events and letting a dead endpoint
      // pass silently.
      await res.body?.cancel()
      capture.durationMs = Date.now() - started
      if (assertions.length === 0) {
        throw new AssertionError(
          `${prefix(ctx)}expected an event stream but got status ${capture.status} ` +
            `with content-type ${JSON.stringify(contentType)}`,
        )
      }
      for (const assertion of assertions) assertion(capture, ctx)
      return capture
    }

    // Open-time assertions run before any waiting, so a wrong status or
    // header fails fast instead of burning the timeout.
    for (const assertion of assertions) assertion(capture, ctx)
    await onOpenFn?.()

    const reader = res.body?.getReader()
    if (!reader) throw new Error('vouch: SSE response has no readable body')
    const decoder = new TextDecoder()
    const parser = createSseParser()
    let timedOut = false
    let closed = false
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeoutMs)
        : undefined

    try {
      while (!predicate(events)) {
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try {
          chunk = await reader.read()
        } catch (err) {
          if (timedOut) break // our own deadline abort, not a transport error
          throw err
        }
        if (chunk.done) {
          closed = true
          break
        }
        events.push(...parser.feed(decoder.decode(chunk.value, { stream: true })))
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      controller.abort() // always release the connection
    }

    capture.durationMs = Date.now() - started
    if (!predicate(events)) {
      const cause = closed ? 'the stream closed' : `not met within ${timeoutMs}ms`
      throw new AssertionError(
        `${prefix(ctx)}SSE condition ${cause} (${events.length} event(s) received)`,
      )
    }
    return capture
  }

  return builder
}

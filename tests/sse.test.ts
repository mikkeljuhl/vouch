/**
 * Dogfood suite for `client.sse(path)` — the SSE builder — against the
 * mock server's /sse/* event-stream routes (real HTTP, hermetic).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AssertionError, createClient, createSseParser, type Client } from '../src/index'
import { startMockServer } from './support/mock-server'

let server: { url: string; stop(): void }
let client: Client

beforeAll(() => {
  server = startMockServer()
  client = createClient({ baseUrl: server.url })
})

afterAll(() => {
  server.stop()
})

describe('createSseParser', () => {
  test('parses fields, joins multi-line data, defaults the event type', () => {
    const parser = createSseParser()
    const events = parser.feed('id: 1\nevent: tick\ndata: a\ndata: b\n\ndata: solo\n\n')
    expect(events).toEqual([
      { id: '1', event: 'tick', data: 'a\nb' },
      { event: 'message', data: 'solo' },
    ])
  })

  test('handles chunk fragmentation at arbitrary boundaries', () => {
    const parser = createSseParser()
    const events = [
      ...parser.feed('da'),
      ...parser.feed('ta: hel'),
      ...parser.feed('lo\n'),
      ...parser.feed('\n'),
    ]
    expect(events).toEqual([{ event: 'message', data: 'hello' }])
  })

  test('ignores comments, retry fields, and dataless blocks; tolerates CRLF', () => {
    const parser = createSseParser()
    const events = parser.feed(': heartbeat\n\nretry: 1000\nevent: ghost\n\ndata: real\r\n\r\n')
    expect(events).toEqual([{ event: 'message', data: 'real' }])
  })
})

describe('client.sse', () => {
  test('collects events until take(n), then cancels the stream', async () => {
    const capture = await client
      .sse('/sse/ticks')
      .query({ count: 5 })
      .expectStatus(200)
      .expectHeader('content-type', /event-stream/)
      .take(2)

    expect(capture.events).toEqual([
      { id: '1', event: 'tick', data: '{"i":1}' },
      { id: '2', event: 'tick', data: '{"i":2}' },
    ])
    expect(capture.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('defaults to resolving on the first event', async () => {
    const capture = await client.sse('/sse/ticks')
    expect(capture.events).toHaveLength(1)
    expect(capture.events[0]?.event).toBe('tick')
  })

  test('until() sees every collected event', async () => {
    const capture = await client
      .sse('/sse/ticks')
      .query({ count: 5 })
      .until((events) => events.some((e) => e.data.includes('"i":3')))

    expect(capture.events).toHaveLength(3)
  })

  test('lastEventId() sends the Last-Event-ID header', async () => {
    const capture = await client.sse('/sse/echo-last-event-id').lastEventId('42')
    expect(capture.events[0]).toEqual({ event: 'resume', data: '42' })
  })

  test('joins multi-line data and reports the block id', async () => {
    const capture = await client.sse('/sse/multiline')
    expect(capture.events[0]).toEqual({ id: '9', event: 'message', data: 'line one\nline two' })
  })

  test('onOpen() runs after the stream is open, before events are awaited', async () => {
    let opened = false
    const capture = await client
      .sse('/sse/ticks')
      .onOpen(() => {
        opened = true
      })
      .take(1)
    expect(opened).toBe(true)
    expect(capture.events).toHaveLength(1)
  })

  test('an unmet condition fails with an AssertionError at the timeout', async () => {
    const promise = client.sse('/sse/silent').timeout(150).take(1).send()
    await expect(promise).rejects.toBeInstanceOf(AssertionError)
    await expect(promise).rejects.toThrow(/not met within 150ms \(0 event\(s\) received\)/)
  })

  test('a stream that closes before the condition fails and says so', async () => {
    const promise = client.sse('/sse/multiline').take(2).send()
    await expect(promise).rejects.toBeInstanceOf(AssertionError)
    await expect(promise).rejects.toThrow(/stream closed \(1 event\(s\) received\)/)
  })

  test('a non-stream response fails loudly when no expectation is queued', async () => {
    const promise = client.sse('/status/401').send()
    await expect(promise).rejects.toBeInstanceOf(AssertionError)
    await expect(promise).rejects.toThrow(/expected an event stream but got status 401/)
  })

  test('a non-stream response passes when the caller expected it', async () => {
    const capture = await client.sse('/status/401').expectStatus(401)
    expect(capture.status).toBe(401)
    expect(capture.events).toEqual([])
  })

  test('open-time assertions fail fast without burning the timeout', async () => {
    const started = Date.now()
    const promise = client.sse('/sse/silent').timeout(5000).expectStatus(500).send()
    await expect(promise).rejects.toBeInstanceOf(AssertionError)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('factory headers apply to the stream request', async () => {
    const authed = createClient({
      baseUrl: server.url,
      headers: { authorization: 'Bearer stream-token' },
    })
    // /auth 401s without an Authorization header; expectStatus(200) proves
    // the factory header rode along on the SSE request.
    const capture = await authed.sse('/auth').expectStatus(200)
    expect(capture.events).toEqual([])
  })
})

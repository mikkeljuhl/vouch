import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createClient } from '../src/client'
import { captureAssertion } from './support/assert'
import { installMockFetch, jsonResponse as jsonRes } from './support/mock-fetch'
import { startMockServer } from './support/mock-server'

/** Build a JSON Response with the given body/status/headers (status-positional sugar). */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return jsonRes(body, { status, headers })
}

describe('RequestBuilder (mocked fetch)', () => {
  // installMockFetch installs a fresh recording fetch before each test and
  // auto-restores after, so the stub never leaks into the live suites.
  const fetchMock = installMockFetch()

  const client = () => createClient({ baseUrl: 'https://api.example.com' })

  test('await returns a typed { status, headers, body, raw }', async () => {
    fetchMock.json({ id: 1, name: 'Ada' }, { status: 200 })
    const res = await client().get<{ id: number; name: string }>('/users/1')

    expect(res.status).toBe(200)
    expect(res.headers).toBeInstanceOf(Headers)
    expect(res.headers.get('content-type')).toMatch(/json/)
    expect(res.body).toEqual({ id: 1, name: 'Ada' })
    expect(res.raw).toBeInstanceOf(Response)
  })

  test('non-JSON responses fall back to text body', async () => {
    fetchMock.respond(new Response('plain text', { status: 200 }))
    const res = await client().get('/text')
    expect(res.body).toBe('plain text')
  })

  test('.send() and await produce the same single request', async () => {
    const builder = client().get('/x')
    const a = await builder
    const b = await builder.send()
    expect(a).toBe(b)
    expect(fetchMock.callCount).toBe(1)
  })

  describe('expectStatus', () => {
    test('passes on match', async () => {
      fetchMock.json({}, { status: 201 })
      await expect(client().post('/x').expectStatus(201).send()).resolves.toBeDefined()
    })

    test('throws on mismatch', async () => {
      fetchMock.json({}, { status: 200 })
      await captureAssertion(client().get('/x').expectStatus(404).send())
    })
  })

  describe('expectHeader', () => {
    test('string match passes and fails', async () => {
      fetchMock.respond(() => jsonResponse({}, 200, { 'x-flavor': 'vanilla' }))
      await expect(client().get('/x').expectHeader('x-flavor', 'vanilla').send()).resolves.toBeDefined()
      await captureAssertion(client().get('/x').expectHeader('x-flavor', 'chocolate').send())
    })

    test('RegExp match passes and fails (case-insensitive lookup)', async () => {
      fetchMock.respond(() => jsonResponse({}, 200, { 'Content-Type': 'application/json; charset=utf-8' }))
      // lookup by differing case proves Headers is case-insensitive
      await expect(client().get('/x').expectHeader('content-type', /json/).send()).resolves.toBeDefined()
      await captureAssertion(client().get('/x').expectHeader('content-type', /xml/).send())
    })
  })

  describe('expectJson (partial / subset)', () => {
    test('passes on a subset; extra keys in body allowed', async () => {
      fetchMock.json({ id: 1, name: 'Ada', email: 'a@ex.com' })
      await expect(client().get('/u').expectJson({ name: 'Ada' }).send()).resolves.toBeDefined()
    })

    test('throws on a missing key', async () => {
      fetchMock.json({ id: 1 })
      await captureAssertion(client().get('/u').expectJson({ name: 'Ada' }).send())
    })

    test('throws on a wrong value', async () => {
      fetchMock.json({ name: 'Bob' })
      await captureAssertion(client().get('/u').expectJson({ name: 'Ada' }).send())
    })
  })

  describe('expectJsonStrict (deep equal)', () => {
    test('passes on exact match', async () => {
      fetchMock.json({ id: 1, name: 'Ada' })
      await expect(client().get('/u').expectJsonStrict({ id: 1, name: 'Ada' }).send()).resolves.toBeDefined()
    })

    test('throws when the body has extra keys', async () => {
      fetchMock.json({ id: 1, name: 'Ada', extra: true })
      await captureAssertion(client().get('/u').expectJsonStrict({ id: 1, name: 'Ada' }).send())
    })
  })

  test('fail-fast: the first failing assertion throws and later ones never run', async () => {
    fetchMock.json({ name: 'Ada' }, { status: 500 })

    // A RegExp whose .test is spied: if the later expectHeader ran, the spy fires.
    const laterPattern = /json/
    const testSpy = spyOn(laterPattern, 'test')

    const builder = client()
      .get('/u')
      .expectStatus(200) // fails first
      .expectHeader('content-type', laterPattern) // would pass, must NOT run

    await captureAssertion(builder.send())
    expect(testSpy).not.toHaveBeenCalled()
  })

  test('fail-fast: declared order is respected (status error surfaces, not json)', async () => {
    // status mismatch AND json mismatch both present; the status error message wins.
    fetchMock.json({ name: 'Bob' }, { status: 500 })
    const err = await captureAssertion(
      client().get('/u').expectStatus(200).expectJson({ name: 'Ada' }).send(),
    )
    expect(err.message).toMatch(/200/)
  })

  test('.json() sets content-type and serializes the body', async () => {
    await client().post('/users').json({ name: 'Ada', age: 36 })

    const call = fetchMock.calls[0]!
    expect(call.method).toBe('POST')
    expect(call.body).toBe(JSON.stringify({ name: 'Ada', age: 36 }))
    expect(call.headers['content-type']).toBe('application/json')
  })

  test('.json() lets an explicit content-type header override the default', async () => {
    await client().post('/users').headers({ 'content-type': 'application/vnd.api+json' }).json({ a: 1 })
    expect(fetchMock.calls[0]!.headers['content-type']).toBe('application/vnd.api+json')
  })

  test('.query() and .headers() flow through to fetch', async () => {
    await client()
      .get('/users/1')
      .query({ expand: 'profile', page: 2 })
      .headers({ 'X-Trace': 'abc', Authorization: () => 'Bearer t' })

    const call = fetchMock.calls[0]!
    expect(call.url).toBe('https://api.example.com/users/1?expand=profile&page=2')
    expect(call.headers['X-Trace']).toBe('abc')
    expect(call.headers.Authorization).toBe('Bearer t')
  })

  test('.timeout() applies a per-request AbortSignal', async () => {
    await client().get('/x').timeout(1234)
    expect(fetchMock.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test('.retry() is chainable and now actually executes (Phase 3 changed this)', async () => {
    // Phase 2 stored retry config as a no-op and this test asserted ONE call for
    // `retry({ times: 3 })` on a 500. Phase 3 wired the real loop, so a 5xx with
    // a 5xx-matching predicate now retries: 1 initial + 3 retries = 4 calls.
    fetchMock.json({}, { status: 500 })
    await client()
      .get('/x')
      .retry({ times: 3, when: (r) => r.status >= 500 })
    expect(fetchMock.callCount).toBe(4)
  })

  test('chaining: create → read using the awaited response body', async () => {
    fetchMock.sequence(jsonResponse({ id: 42, name: 'Ada' }, 201), jsonResponse({ id: 42, name: 'Ada' }, 200))

    const created = await client()
      .post<{ id: number; name: string }>('/users')
      .json({ name: 'Ada' })
      .expectStatus(201)

    const id = created.body.id
    expect(id).toBe(42)

    const fetched = await client()
      .get<{ id: number; name: string }>(`/users/${id}`)
      .expectStatus(200)
      .expectJson({ name: 'Ada' })

    expect(fetched.body.id).toBe(42)
    expect(fetchMock.calls[1]!.url).toBe('https://api.example.com/users/42')
  })
})

/**
 * Phase 3 — per-request retry (mocked fetch). Proves effective-retry resolution,
 * the no-predicate default policy (5xx only, never 4xx), predicate override,
 * transport-error retry/rethrow, exhaustion semantics, factory default + per-call
 * override, and that a serialized body is resent verbatim on each attempt.
 */
describe('RequestBuilder retry (mocked fetch)', () => {
  const fetchMock = installMockFetch()

  const client = () => createClient({ baseUrl: 'https://api.example.com' })

  test('5xx retried by default (no when): 503,503,200 → 3 calls, final 200 passes', async () => {
    fetchMock.sequence(jsonResponse({}, 503), jsonResponse({}, 503), jsonResponse({ ok: true }, 200))

    const res = await client().get('/x').retry({ times: 2 }).expectStatus(200)
    expect(fetchMock.callCount).toBe(3)
    expect(res.status).toBe(200)
  })

  test('4xx NOT retried by default: 400 → exactly 1 call, 400 flows to assertions', async () => {
    fetchMock.json({}, { status: 400 })

    const res = await client().get('/x').retry({ times: 3 })
    expect(fetchMock.callCount).toBe(1)
    expect(res.status).toBe(400)
  })

  test('when predicate overrides default: retries 429 but not 500', async () => {
    // 429 matches the predicate → retried.
    fetchMock.sequence(jsonResponse({}, 429), jsonResponse({}, 200))
    const a = await client()
      .get('/x')
      .retry({ times: 2, when: (r) => r.status === 429 })
    expect(fetchMock.callCount).toBe(2)
    expect(a.status).toBe(200)

    // 500 does NOT match the predicate → not retried, even though it is 5xx.
    fetchMock.reset()
    fetchMock.json({}, { status: 500 })
    const b = await client()
      .get('/x')
      .retry({ times: 2, when: (r) => r.status === 429 })
    expect(fetchMock.callCount).toBe(1)
    expect(b.status).toBe(500)
  })

  test('transport error retried then succeeds: reject,reject,200 → 3 calls', async () => {
    const boom = (): never => {
      throw new Error('ECONNRESET')
    }
    fetchMock.sequence(boom, boom, jsonResponse({ ok: true }, 200))

    const res = await client().get('/x').retry({ times: 2 })
    expect(fetchMock.callCount).toBe(3)
    expect(res.status).toBe(200)
  })

  test('transport error exhausted rethrows: always reject, times:1 → 2 calls, rejects', async () => {
    fetchMock.respond(() => {
      throw new Error('network down')
    })

    await expect(client().get('/x').retry({ times: 1 }).send()).rejects.toThrow('network down')
    expect(fetchMock.callCount).toBe(2)
  })

  test('exhausted 5xx: always 500, times:2 → 3 calls, expectStatus(200) fails', async () => {
    fetchMock.json({}, { status: 500 })

    const err = await captureAssertion(client().get('/x').retry({ times: 2 }).expectStatus(200).send())
    expect(err.message).toMatch(/200/)
    expect(fetchMock.callCount).toBe(3)
  })

  test('factory default retry applies even without .retry() on the builder', async () => {
    const c = createClient({ baseUrl: 'https://api.example.com', retry: { times: 1 } })
    fetchMock.sequence(jsonResponse({}, 500), jsonResponse({ ok: true }, 200))

    const res = await c.get('/x').expectStatus(200)
    expect(fetchMock.callCount).toBe(2)
    expect(res.status).toBe(200)
  })

  test('per-request .retry() overrides the factory default', async () => {
    // Factory says times:5, but the per-request override says times:0 → no retry.
    const c = createClient({ baseUrl: 'https://api.example.com', retry: { times: 5 } })
    fetchMock.json({}, { status: 500 })

    const res = await c.get('/x').retry({ times: 0 })
    expect(fetchMock.callCount).toBe(1)
    expect(res.status).toBe(500)
  })

  test('no retry config = exactly one attempt', async () => {
    fetchMock.json({}, { status: 500 })
    const res = await client().get('/x')
    expect(fetchMock.callCount).toBe(1)
    expect(res.status).toBe(500)
  })

  test('body is resent verbatim on retry (POST .json that 503s then 200s)', async () => {
    fetchMock.sequence(jsonResponse({}, 503), jsonResponse({ ok: true }, 200))

    await client().post('/users').json({ name: 'Ada', age: 36 }).retry({ times: 1 }).expectStatus(200)

    expect(fetchMock.callCount).toBe(2)
    const expected = JSON.stringify({ name: 'Ada', age: 36 })
    expect(fetchMock.calls[0]!.body).toBe(expected)
    expect(fetchMock.calls[1]!.body).toBe(expected)
  })
})

/**
 * Real-HTTP integration tests against the in-process `Bun.serve` mock (hermetic;
 * no external dependency). These exercise the full framework over a real socket
 * — request building, fetch, parsing, assertions — while staying deterministic
 * and runnable offline. The mock is started in beforeAll and stopped in afterAll.
 */
describe('RequestBuilder (mock server)', () => {
  let live: ReturnType<typeof createClient>
  let server: { url: string; stop(): void }

  beforeAll(() => {
    server = startMockServer()
    live = createClient({ baseUrl: server.url, timeoutMs: 15_000 })
  })

  afterAll(() => server.stop())

  test('GET /todos/1 → 200 + partial JSON', async () => {
    const res = await live
      .get<{ id: number; userId: number; title: string; completed: boolean }>('/todos/1')
      .expectStatus(200)
      .expectHeader('content-type', /json/)
      .expectJson({ id: 1, userId: 1 })

    expect(typeof res.body.title).toBe('string')
  })

  test('POST /posts → 201 with echoed body', async () => {
    const res = await live
      .post<{ id: number; title: string; body: string; userId: number }>('/posts')
      .json({ title: 'hello', body: 'world', userId: 1 })
      .expectStatus(201)
      .expectJson({ title: 'hello', body: 'world', userId: 1 })

    expect(typeof res.body.id).toBe('number')
  })

  test('chained: GET a user, then GET their posts using the response body', async () => {
    const user = await live
      .get<{ id: number; username: string }>('/users/1')
      .expectStatus(200)

    const posts = await live
      .get<Array<{ userId: number; id: number }>>('/posts')
      .query({ userId: user.body.id })
      .expectStatus(200)

    expect(Array.isArray(posts.body)).toBe(true)
    expect(posts.body.length).toBeGreaterThan(0)
    expect(posts.body.every((p) => p.userId === user.body.id)).toBe(true)
  })
})

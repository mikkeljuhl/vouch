import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { createClient } from '../src/client'

/** Build a JSON Response with the given body/status/headers. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('RequestBuilder (mocked fetch)', () => {
  // Save the real fetch once; restore after each test so the stubbed fetch never
  // leaks into the live `tests/example` suite (restoration is essential).
  const realFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof mock>

  beforeEach(() => {
    fetchMock = mock(async () => jsonResponse({ ok: true }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const client = () => createClient({ baseUrl: 'https://api.example.com' })

  test('await returns a typed { status, headers, body, raw }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, name: 'Ada' }, 200))
    const res = await client().get<{ id: number; name: string }>('/users/1')

    expect(res.status).toBe(200)
    expect(res.headers).toBeInstanceOf(Headers)
    expect(res.headers.get('content-type')).toMatch(/json/)
    expect(res.body).toEqual({ id: 1, name: 'Ada' })
    expect(res.raw).toBeInstanceOf(Response)
  })

  test('non-JSON responses fall back to text body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('plain text', { status: 200 }))
    const res = await client().get('/text')
    expect(res.body).toBe('plain text')
  })

  test('.send() and await produce the same single request', async () => {
    const builder = client().get('/x')
    const a = await builder
    const b = await builder.send()
    expect(a).toBe(b)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  describe('expectStatus', () => {
    test('passes on match', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 201))
      await expect(client().post('/x').expectStatus(201).send()).resolves.toBeDefined()
    })

    test('throws on mismatch', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 200))
      await expect(client().get('/x').expectStatus(404).send()).rejects.toThrow()
    })
  })

  describe('expectHeader', () => {
    test('string match passes and fails', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 200, { 'x-flavor': 'vanilla' }))
      await expect(client().get('/x').expectHeader('x-flavor', 'vanilla').send()).resolves.toBeDefined()
      await expect(client().get('/x').expectHeader('x-flavor', 'chocolate').send()).rejects.toThrow()
    })

    test('RegExp match passes and fails (case-insensitive lookup)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 200, { 'Content-Type': 'application/json; charset=utf-8' }))
      // lookup by differing case proves Headers is case-insensitive
      await expect(client().get('/x').expectHeader('content-type', /json/).send()).resolves.toBeDefined()
      await expect(client().get('/x').expectHeader('content-type', /xml/).send()).rejects.toThrow()
    })
  })

  describe('expectJson (partial / subset)', () => {
    test('passes on a subset; extra keys in body allowed', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, name: 'Ada', email: 'a@ex.com' }))
      await expect(client().get('/u').expectJson({ name: 'Ada' }).send()).resolves.toBeDefined()
    })

    test('throws on a missing key', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }))
      await expect(client().get('/u').expectJson({ name: 'Ada' }).send()).rejects.toThrow()
    })

    test('throws on a wrong value', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'Bob' }))
      await expect(client().get('/u').expectJson({ name: 'Ada' }).send()).rejects.toThrow()
    })
  })

  describe('expectJsonStrict (deep equal)', () => {
    test('passes on exact match', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, name: 'Ada' }))
      await expect(client().get('/u').expectJsonStrict({ id: 1, name: 'Ada' }).send()).resolves.toBeDefined()
    })

    test('throws when the body has extra keys', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, name: 'Ada', extra: true }))
      await expect(client().get('/u').expectJsonStrict({ id: 1, name: 'Ada' }).send()).rejects.toThrow()
    })
  })

  test('fail-fast: the first failing assertion throws and later ones never run', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'Ada' }, 500))

    // A RegExp whose .test is spied: if the later expectHeader ran, the spy fires.
    const laterPattern = /json/
    const testSpy = spyOn(laterPattern, 'test')

    const builder = client()
      .get('/u')
      .expectStatus(200) // fails first
      .expectHeader('content-type', laterPattern) // would pass, must NOT run

    await expect(builder.send()).rejects.toThrow()
    expect(testSpy).not.toHaveBeenCalled()
  })

  test('fail-fast: declared order is respected (status error surfaces, not json)', async () => {
    // status mismatch AND json mismatch both present; the status error message wins.
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'Bob' }, 500))
    await expect(
      client().get('/u').expectStatus(200).expectJson({ name: 'Ada' }).send(),
    ).rejects.toThrow(/200/)
  })

  test('.json() sets content-type and serializes the body', async () => {
    await client().post('/users').json({ name: 'Ada', age: 36 })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ name: 'Ada', age: 36 }))
    expect(init.headers['content-type']).toBe('application/json')
  })

  test('.json() lets an explicit content-type header override the default', async () => {
    await client().post('/users').headers({ 'content-type': 'application/vnd.api+json' }).json({ a: 1 })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['content-type']).toBe('application/vnd.api+json')
  })

  test('.query() and .headers() flow through to fetch', async () => {
    await client()
      .get('/users/1')
      .query({ expand: 'profile', page: 2 })
      .headers({ 'X-Trace': 'abc', Authorization: () => 'Bearer t' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/users/1?expand=profile&page=2')
    expect(init.headers['X-Trace']).toBe('abc')
    expect(init.headers.Authorization).toBe('Bearer t')
  })

  test('.timeout() applies a per-request AbortSignal', async () => {
    await client().get('/x').timeout(1234)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test('.retry() is chainable and now actually executes (Phase 3 changed this)', async () => {
    // Phase 2 stored retry config as a no-op and this test asserted ONE call for
    // `retry({ times: 3 })` on a 500. Phase 3 wired the real loop, so a 5xx with
    // a 5xx-matching predicate now retries: 1 initial + 3 retries = 4 calls.
    fetchMock.mockResolvedValue(jsonResponse({}, 500))
    await client()
      .get('/x')
      .retry({ times: 3, when: (r) => r.status >= 500 })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  test('chaining: create → read using the awaited response body', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 42, name: 'Ada' }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: 42, name: 'Ada' }, 200))

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
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/users/42')
  })
})

/**
 * Phase 3 — per-request retry (mocked fetch). Proves effective-retry resolution,
 * the no-predicate default policy (5xx only, never 4xx), predicate override,
 * transport-error retry/rethrow, exhaustion semantics, factory default + per-call
 * override, and that a serialized body is resent verbatim on each attempt.
 */
describe('RequestBuilder retry (mocked fetch)', () => {
  const realFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof mock>

  beforeEach(() => {
    fetchMock = mock(async () => jsonResponse({ ok: true }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const client = () => createClient({ baseUrl: 'https://api.example.com' })

  test('5xx retried by default (no when): 503,503,200 → 3 calls, final 200 passes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200))

    const res = await client().get('/x').retry({ times: 2 }).expectStatus(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(res.status).toBe(200)
  })

  test('4xx NOT retried by default: 400 → exactly 1 call, 400 flows to assertions', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 400))

    const res = await client().get('/x').retry({ times: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(400)
  })

  test('when predicate overrides default: retries 429 but not 500', async () => {
    // 429 matches the predicate → retried.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({}, 200))
    const a = await client()
      .get('/x')
      .retry({ times: 2, when: (r) => r.status === 429 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(a.status).toBe(200)

    // 500 does NOT match the predicate → not retried, even though it is 5xx.
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(jsonResponse({}, 500))
    const b = await client()
      .get('/x')
      .retry({ times: 2, when: (r) => r.status === 429 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(b.status).toBe(500)
  })

  test('transport error retried then succeeds: reject,reject,200 → 3 calls', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200))

    const res = await client().get('/x').retry({ times: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(res.status).toBe(200)
  })

  test('transport error exhausted rethrows: always reject, times:1 → 2 calls, rejects', async () => {
    const err = new Error('network down')
    fetchMock.mockRejectedValue(err)

    await expect(client().get('/x').retry({ times: 1 }).send()).rejects.toThrow('network down')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('exhausted 5xx: always 500, times:2 → 3 calls, expectStatus(200) fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500))

    await expect(client().get('/x').retry({ times: 2 }).expectStatus(200).send()).rejects.toThrow(/200/)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('factory default retry applies even without .retry() on the builder', async () => {
    const c = createClient({ baseUrl: 'https://api.example.com', retry: { times: 1 } })
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200))

    const res = await c.get('/x').expectStatus(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
  })

  test('per-request .retry() overrides the factory default', async () => {
    // Factory says times:5, but the per-request override says times:0 → no retry.
    const c = createClient({ baseUrl: 'https://api.example.com', retry: { times: 5 } })
    fetchMock.mockResolvedValue(jsonResponse({}, 500))

    const res = await c.get('/x').retry({ times: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(500)
  })

  test('no retry config = exactly one attempt', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500))
    const res = await client().get('/x')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(500)
  })

  test('body is resent verbatim on retry (POST .json that 503s then 200s)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200))

    await client().post('/users').json({ name: 'Ada', age: 36 }).retry({ times: 1 }).expectStatus(200)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const expected = JSON.stringify({ name: 'Ada', age: 36 })
    expect(fetchMock.mock.calls[0][1].body).toBe(expected)
    expect(fetchMock.mock.calls[1][1].body).toBe(expected)
  })
})

/**
 * Live integration tests against a public API (jsonplaceholder). These run by
 * default; if the network is unavailable they fail loudly rather than silently
 * passing. Run `vitest --exclude '**\/*.integration*'`-style filtering offline.
 */
describe('RequestBuilder (live: jsonplaceholder)', () => {
  const live = createClient({ baseUrl: 'https://jsonplaceholder.typicode.com', timeoutMs: 15_000 })

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

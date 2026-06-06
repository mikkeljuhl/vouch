/**
 * Integration suite for the vouch framework's resilience pathways — retry,
 * timeout, cookies, and the beforeRequest hook — exercised end-to-end against
 * the in-process Bun mock (real HTTP, hermetic, deterministic).
 *
 * Each test file gets its own mock instance, so the per-key /flaky and
 * /retry-after counters start fresh; we still use a unique key per test so the
 * intent is self-documenting and order-independent.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createClient, AssertionError, type Client } from '../../src/index'
import { startMockServer } from '../support/mock-server'

let server: { url: string; stop(): void }
let baseUrl: string

beforeAll(() => {
  server = startMockServer()
  baseUrl = server.url
})

afterAll(() => {
  server.stop()
})

describe('retry', () => {
  test('retries on 5xx until it succeeds', async () => {
    const client = createClient({ baseUrl })
    // First 2 attempts → 503, 3rd → 200. With 3 extra attempts allowed, succeeds.
    const res = await client
      .get<{ ok: boolean }>('/flaky/retry-5xx')
      .query({ fails: 2 })
      .retry({ times: 3 })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    // The success landed on the 3rd attempt — proves it actually retried twice.
    expect(res.headers.get('x-attempt')).toBe('3')
  })

  test('does NOT retry a 4xx by default', async () => {
    const client = createClient({ baseUrl })
    // status=400 is a hard client error: the default policy must surface it
    // immediately, never burning the retry budget.
    const res = await client
      .get('/flaky/no-retry-4xx')
      .query({ fails: 5, status: 400 })
      .retry({ times: 3 })

    expect(res.status).toBe(400)
    // Exactly one attempt was made (no retry on 4xx).
    expect(res.headers.get('x-attempt')).toBe('1')
  })

  test('retries on 429 (default policy)', async () => {
    const client = createClient({ baseUrl })
    // First attempt → 429 with Retry-After: 0 (no wait), then 200. Proves 429 is
    // retried by the default policy. (Honoring the *delay* is a separate test.)
    const res = await client
      .get<{ ok: boolean }>('/retry-after/retry-429')
      .query({ fails: 1, seconds: 0 })
      .retry({ times: 2 })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    // Success on the 2nd attempt confirms the 429 was retried.
    expect(res.headers.get('x-attempt')).toBe('2')
  })

  test('honors the Retry-After delay before retrying a 429', async () => {
    const client = createClient({ baseUrl })
    // First attempt → 429 with Retry-After: 1 (second), then 200. The framework
    // must WAIT that ~1s before the retry; with seconds:0 it would be immediate,
    // so measuring the elapsed time is what actually exercises the honoring path.
    const start = performance.now()
    const res = await client
      .get<{ ok: boolean }>('/retry-after/honor-delay')
      .query({ fails: 1, seconds: 1 })
      .retry({ times: 2 })
    const elapsed = performance.now() - start

    expect(res.status).toBe(200)
    expect(res.headers.get('x-attempt')).toBe('2')
    // Must have waited roughly the 1s Retry-After. Wide lower bound (>=900ms vs
    // the 1000ms target) absorbs timer slack while still proving a real wait
    // happened — an immediate retry would land near 0ms and fail this.
    expect(elapsed).toBeGreaterThanOrEqual(900)
  })

  test('surfaces the final failing response when the retry budget is exhausted', async () => {
    const client = createClient({ baseUrl })
    // Every attempt 5xx (fails: 5) but only 2 retries allowed → 3 total attempts,
    // all 503. The budget is BOUNDED: the request resolves (does not throw) and
    // the last failing response is surfaced for assertions to inspect.
    const res = await client
      .get('/flaky/exhausted')
      .query({ fails: 5, status: 503 })
      .retry({ times: 2 })

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'flaky', attempt: 3 })
    // Exactly times+1 attempts were made — proves the loop stopped at the budget.
    expect(res.headers.get('x-attempt')).toBe('3')
  })

  test('a custom `when` predicate controls which responses retry', async () => {
    const client = createClient({ baseUrl })
    // 418 is NOT in the default retry set (5xx/429), so by default it would not
    // retry. A `when` predicate targeting 418 makes it retry — proving the
    // predicate is authoritative over the default policy.
    const res = await client
      .get<{ ok: boolean }>('/flaky/custom-when')
      .query({ fails: 1, status: 418 })
      .retry({ times: 2, when: (r) => r.status === 418 })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(res.headers.get('x-attempt')).toBe('2')
  })

  test('an assertion on the exhausted-retry response throws a descriptive AssertionError', async () => {
    const client = createClient({ baseUrl })
    // After the retry budget is exhausted the surfaced 503 still flows through
    // the assertion pipeline. An `.expectStatus(200)` must therefore FAIL with a
    // real AssertionError whose message names the mismatch — not silently pass.
    let error: unknown
    try {
      await client
        .get('/flaky/assert-after-retry')
        .query({ fails: 5, status: 503 })
        .retry({ times: 1 })
        .expectStatus(200)
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(AssertionError)
    const message = (error as AssertionError).message
    // The message must surface both the expected and actual status so the
    // failure is diagnosable — not a generic "assertion failed".
    expect(message).toContain('200')
    expect(message).toContain('503')
  })

  test('a `when` predicate that excludes 5xx surfaces it without retrying', async () => {
    const client = createClient({ baseUrl })
    // Default policy would retry a 503, but a predicate that never returns true
    // overrides it: the 503 is surfaced immediately on the first attempt.
    const res = await client
      .get('/flaky/when-no-retry')
      .query({ fails: 5, status: 503 })
      .retry({ times: 3, when: () => false })

    expect(res.status).toBe(503)
    // No retry happened despite times: 3 — the predicate suppressed it.
    expect(res.headers.get('x-attempt')).toBe('1')
  })

  test('rejects when the transport fails on every attempt', async () => {
    // Port 1 is privileged/closed: fetch raises a transport error. A transport
    // error is always retried, but with the budget exhausted the await rejects.
    // (This is the one allowed non-mock target — a deliberate dead port.)
    const deadClient = createClient({ baseUrl: 'http://127.0.0.1:1' })
    // `.send()` returns a real Promise (the builder itself is only a thenable).
    let error: unknown
    try {
      await deadClient.get('/auth').retry({ times: 1 }).send()
    } catch (e) {
      error = e
    }

    // Must reject (not resolve to a response) and the rejection must be the
    // surfaced transport error, not an AssertionError or anything else.
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(AssertionError)
  })
})

describe('timeout', () => {
  test('aborts a request that exceeds the timeout', async () => {
    const client = createClient({ baseUrl })
    // The server sleeps 500ms; a 50ms timeout aborts it. Generous gap (10x).
    const start = performance.now()
    let error: unknown
    try {
      await client.get('/delay/500').timeout(50).send()
    } catch (e) {
      error = e
    }
    const elapsed = performance.now() - start

    // It must actually have thrown — and thrown the *abort/timeout* error, not
    // some unrelated failure. `AbortSignal.timeout` raises a DOMException named
    // 'TimeoutError'; assert on that so a non-timeout rejection wouldn't pass.
    expect(error).toBeDefined()
    expect((error as Error).name).toBe('TimeoutError')
    // And it must have aborted promptly, NOT waited out the full 500ms server
    // sleep — proving the timeout fired rather than the request completing.
    // 50ms budget + scheduling slack; comfortably below the 500ms server delay.
    expect(elapsed).toBeLessThan(400)
  })
})

describe('cookies', () => {
  test('a cookie-enabled client carries the session from /login to /me', async () => {
    const client = createClient({ baseUrl, cookies: true })

    const login = await client.post<{ ok: boolean }>('/login')
    expect(login.status).toBe(200)
    expect(login.body).toEqual({ ok: true })

    // The Set-Cookie from /login is auto-attached on the next request.
    const me = await client.get<{ user: string }>('/me')
    expect(me.status).toBe(200)
    expect(me.body).toEqual({ user: 'ada' })
  })

  test('a client without the cookie jar is unauthorized at /me', async () => {
    // No cookies: even after a login on a *different* client, this one has no
    // session, so /me must reject as unauthorized.
    const client = createClient({ baseUrl })
    const me = await client.get('/me')

    expect(me.status).toBe(401)
    expect(me.body).toEqual({ error: 'unauthorized' })
  })
})

describe('beforeRequest', () => {
  test('a signing hook authenticates the request', async () => {
    const client: Client = createClient({
      baseUrl,
      beforeRequest: (req) => {
        req.headers['x-signature'] = 'sig'
      },
    })

    const res = await client.get<{ authed: boolean }>('/auth')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ authed: true })
  })

  test('without the hook the request is unauthorized', async () => {
    const client = createClient({ baseUrl })
    const res = await client.get('/auth')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })
})

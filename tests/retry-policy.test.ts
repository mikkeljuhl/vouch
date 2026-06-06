import { describe, expect, test } from 'bun:test'
import { createClient } from '../src/client'
import { computeRetryDelay, parseRetryAfter } from '../src/builder'
import { installMockFetch } from './support/mock-fetch'

/** Build a plain Response with the given text body/status. */
function res(body: string, status: number): Response {
  return new Response(body, { status })
}

describe('computeRetryDelay (pure)', () => {
  test('fixed backoff returns a constant delayMs', () => {
    const opts = { delayMs: 100, backoff: 'fixed' as const }
    expect(computeRetryDelay(0, opts)).toBe(100)
    expect(computeRetryDelay(1, opts)).toBe(100)
    expect(computeRetryDelay(5, opts)).toBe(100)
  })

  test('default (no backoff) behaves as fixed, default delayMs 0', () => {
    expect(computeRetryDelay(0, {})).toBe(0)
    expect(computeRetryDelay(3, { delayMs: 50 })).toBe(50)
  })

  test('exponential backoff is delayMs * 2^attemptIndex', () => {
    const opts = { delayMs: 100, backoff: 'exponential' as const }
    expect(computeRetryDelay(0, opts)).toBe(100)
    expect(computeRetryDelay(1, opts)).toBe(200)
    expect(computeRetryDelay(2, opts)).toBe(400)
  })

  test('Retry-After in seconds overrides delay/backoff', () => {
    const res = new Response('', { status: 429, headers: { 'retry-after': '2' } })
    expect(computeRetryDelay(0, { delayMs: 100, backoff: 'exponential' }, res)).toBe(2000)
  })

  test('Retry-After as an HTTP-date is computed against a fixed now', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')
    const future = 'Wed, 21 Oct 2026 07:28:05 GMT' // +5s
    const res = new Response('', { status: 503, headers: { 'retry-after': future } })
    expect(computeRetryDelay(0, { delayMs: 100 }, res, now)).toBe(5000)
  })

  test('Retry-After is capped at the max (30000ms)', () => {
    const res = new Response('', { status: 429, headers: { 'retry-after': '99999' } })
    expect(computeRetryDelay(0, {}, res)).toBe(30000)
  })

  test('transport error (no response) uses delay/backoff', () => {
    expect(computeRetryDelay(2, { delayMs: 10, backoff: 'exponential' })).toBe(40)
  })
})

describe('parseRetryAfter', () => {
  test('returns null for absent/empty/garbage', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('not-a-date')).toBeNull()
  })

  test('parses delta-seconds', () => {
    expect(parseRetryAfter('3')).toBe(3000)
  })

  test('parses HTTP-date relative to now, clamped at >= 0', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', now)).toBe(10000)
    // A past date clamps to 0.
    expect(parseRetryAfter('Wed, 21 Oct 2020 07:28:00 GMT', now)).toBe(0)
  })
})

describe('retry policy loop (mocked fetch)', () => {
  const fetch = installMockFetch()

  const client = () => createClient({ baseUrl: 'https://api.example.com' })

  test('default policy retries 429: 429 → 200 with times:1 makes 2 calls, resolves 200', async () => {
    fetch.sequence(res('rate', 429), res('ok', 200))
    const result = await client().get('/x').retry({ times: 1 }).expectStatus(200)
    expect(fetch.callCount).toBe(2)
    expect(result.status).toBe(200)
  })

  test('a `when` predicate overrides the default: retries 503 but not 429', async () => {
    // 429 first; predicate only retries 503, so no retry → one call, surfaces 429.
    fetch.sequence(res('rate', 429), res('ok', 200))
    const result = await client()
      .get('/x')
      .retry({ times: 2, when: (r) => r.status === 503 })
    expect(fetch.callCount).toBe(1)
    expect(result.status).toBe(429)
  })

  test('a `when` predicate retries 503', async () => {
    fetch.sequence(res('boom', 503), res('ok', 200))
    const result = await client()
      .get('/x')
      .retry({ times: 1, when: (r) => r.status === 503 })
      .expectStatus(200)
    expect(fetch.callCount).toBe(2)
    expect(result.status).toBe(200)
  })

  test('exhausted 429 still surfaces to assertions', async () => {
    fetch.respond(res('rate', 429))
    await expect(
      client().get('/x').retry({ times: 1 }).expectStatus(200).send(),
    ).rejects.toThrow(/200/)
    expect(fetch.callCount).toBe(2)
  })
})

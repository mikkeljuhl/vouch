import { describe, expect, test } from 'bun:test'
import { createClient, joinUrl, resolveHeaders } from '../src/client'
import { installMockFetch, textResponse } from './support/mock-fetch'

describe('joinUrl', () => {
  test.each([
    ['https://api.example.com', '/users/1', 'https://api.example.com/users/1'],
    ['https://api.example.com/', '/users/1', 'https://api.example.com/users/1'],
    ['https://api.example.com', 'users/1', 'https://api.example.com/users/1'],
    ['https://api.example.com/', 'users/1', 'https://api.example.com/users/1'],
    ['https://api.example.com/v1', '/users/1', 'https://api.example.com/v1/users/1'],
    ['https://api.example.com/v1/', '/users/1', 'https://api.example.com/v1/users/1'],
    ['https://api.example.com///', '///users/1', 'https://api.example.com/users/1'],
    ['https://api.example.com', '', 'https://api.example.com'],
  ])('joins %s + %s', (base, path, expected) => {
    expect(joinUrl(base, path)).toBe(expected)
  })

  test('passes absolute request URLs through verbatim', () => {
    expect(joinUrl('https://api.example.com', 'https://other.com/x')).toBe('https://other.com/x')
  })
})

describe('resolveHeaders', () => {
  test('resolves static, sync-callable and async-callable values', async () => {
    const headers = await resolveHeaders({
      'X-Static': 'static',
      'X-Sync': () => 'sync',
      'X-Async': async () => 'async',
    })
    expect(headers).toEqual({ 'X-Static': 'static', 'X-Sync': 'sync', 'X-Async': 'async' })
  })

  test('per-request headers override factory headers (case-insensitive)', async () => {
    const headers = await resolveHeaders(
      { Authorization: 'factory', 'X-Keep': 'keep' },
      { authorization: 'override' },
    )
    // Only one Authorization key, override casing/value wins.
    expect(headers).toEqual({ authorization: 'override', 'X-Keep': 'keep' })
  })

  test('override values may also be callables', async () => {
    const headers = await resolveHeaders({ Authorization: 'factory' }, { Authorization: async () => 'minted' })
    expect(headers).toEqual({ Authorization: 'minted' })
  })

  test('callables are re-evaluated on each resolution', async () => {
    let n = 0
    const factory = { 'X-Count': () => String(++n) }
    const first = await resolveHeaders(factory)
    const second = await resolveHeaders(factory)
    expect(first['X-Count']).toBe('1')
    expect(second['X-Count']).toBe('2')
  })
})

describe('createClient', () => {
  test('exposes carried defaults', () => {
    const retry = { times: 3, when: (r: Response) => r.status >= 500 }
    const client = createClient({
      baseUrl: 'https://api.example.com/',
      timeoutMs: 5000,
      retry,
    })
    expect(client.baseUrl).toBe('https://api.example.com/')
    expect(client.timeoutMs).toBe(5000)
    expect(client.retry).toBe(retry)
  })

  test('resolveUrl joins path and applies query (skipping null/undefined)', () => {
    const client = createClient({ baseUrl: 'https://api.example.com/v1' })
    const url = client.resolveUrl('/users/1', { expand: 'profile', page: 2, skip: null, drop: undefined })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://api.example.com/v1/users/1')
    expect(parsed.searchParams.get('expand')).toBe('profile')
    expect(parsed.searchParams.get('page')).toBe('2')
    expect(parsed.searchParams.has('skip')).toBe(false)
    expect(parsed.searchParams.has('drop')).toBe(false)
  })

  describe('_request (with mocked fetch)', () => {
    // installMockFetch installs a fresh recording fetch per test and auto-restores,
    // so a stubbed fetch can never leak into the live suites. A fresh text body is
    // produced per call so multi-request tests don't reuse a consumed stream.
    const fetchMock = installMockFetch()
    const respondOk = () => fetchMock.respond(() => textResponse('ok'))

    test('sends resolved headers and joined URL', async () => {
      respondOk()
      let calls = 0
      const client = createClient({
        baseUrl: 'https://api.example.com',
        headers: {
          'X-Static': 'static',
          Authorization: async () => `Bearer ${++calls}`,
        },
      })

      await client._request('GET', '/users/1', {
        query: { expand: 'profile' },
        headers: { 'X-Per-Request': () => 'per-req' },
      })

      expect(fetchMock.callCount).toBe(1)
      const call = fetchMock.calls[0]!
      expect(call.url).toBe('https://api.example.com/users/1?expand=profile')
      expect(call.method).toBe('GET')
      expect(call.headers).toEqual({
        'X-Static': 'static',
        Authorization: 'Bearer 1',
        'X-Per-Request': 'per-req',
      })

      // Callable re-evaluated on next request.
      await client._request('GET', '/users/2')
      expect(fetchMock.calls[1]!.headers.Authorization).toBe('Bearer 2')
    })

    test('per-request headers override factory headers on the wire', async () => {
      respondOk()
      const client = createClient({
        baseUrl: 'https://api.example.com',
        headers: { Authorization: 'factory' },
      })

      await client._request('POST', '/login', { headers: { authorization: 'override' } })

      expect(fetchMock.calls[0]!.headers).toEqual({ authorization: 'override' })
    })

    test('applies AbortSignal.timeout when timeoutMs is set', async () => {
      respondOk()
      const client = createClient({ baseUrl: 'https://api.example.com', timeoutMs: 1000 })
      await client._request('GET', '/x')
      expect(fetchMock.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
    })

    test('applies the default timeout signal when none is configured', async () => {
      respondOk()
      const client = createClient({ baseUrl: 'https://api.example.com' })
      await client._request('GET', '/x')
      // A default 30s timeout now applies instead of hanging forever.
      expect(fetchMock.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
    })

    test('timeoutMs: 0 disables the signal (escape hatch)', async () => {
      respondOk()
      const client = createClient({ baseUrl: 'https://api.example.com', timeoutMs: 0 })
      await client._request('GET', '/x')
      expect(fetchMock.calls[0]!.init?.signal).toBeUndefined()
    })
  })
})

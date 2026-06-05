import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createClient, type OutgoingRequest } from '../src/client'

/**
 * `beforeRequest` hook behaviour. Stubs `globalThis.fetch` and restores it in
 * `afterEach`. The hook runs inside `_request`, once per attempt, after cookies
 * and header resolution and before fetch — so it wins the precedence chain.
 */
describe('beforeRequest hook', () => {
  const realFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof mock>

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function headersOf(callIndex: number): Record<string, string> {
    return fetchMock.mock.calls[callIndex][1].headers as Record<string, string>
  }

  test('adds a signature header derived from the body, seen by fetch', async () => {
    fetchMock = mock(async () => new Response('ok', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const sign = (s: string) => `sig-${s.length}`
    const client = createClient({
      baseUrl: 'https://api.example.com',
      beforeRequest: (req: OutgoingRequest) => {
        req.headers['x-signature'] = sign(String(req.body ?? ''))
      },
    })

    await client._request('POST', '/sign', { body: '{"a":1}' })
    expect(headersOf(0)['x-signature']).toBe('sig-7')
  })

  test('runs once per attempt (5xx → retry via builder)', async () => {
    let n = 0
    // First attempt 500, second 200, so a retry of 1 produces two attempts.
    fetchMock = mock(async () => new Response('', { status: ++n === 1 ? 500 : 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    let hookCalls = 0
    const client = createClient({
      baseUrl: 'https://api.example.com',
      beforeRequest: () => {
        hookCalls++
      },
    })

    await client.get('/flaky').retry({ times: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(hookCalls).toBe(2)
  })

  test('async beforeRequest is awaited before fetch', async () => {
    fetchMock = mock(async () => new Response(''))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createClient({
      baseUrl: 'https://api.example.com',
      beforeRequest: async (req) => {
        await Promise.resolve()
        req.headers['x-async'] = 'done'
      },
    })

    await client._request('GET', '/x')
    expect(headersOf(0)['x-async']).toBe('done')
  })

  test('hook runs last and can override a cookie / auth header', async () => {
    fetchMock = mock(async () => new Response(''))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createClient({
      baseUrl: 'https://api.example.com',
      headers: { authorization: 'Bearer factory' },
      cookies: true,
      beforeRequest: (req) => {
        req.headers.authorization = 'Bearer hook-wins'
        req.headers.cookie = 'hook=1'
      },
    })
    client.cookies.set('jar', 'value')

    await client._request('GET', '/me')
    const headers = headersOf(0)
    expect(headers.authorization).toBe('Bearer hook-wins')
    // Hook overrode the jar-derived cookie too.
    expect(headers.cookie).toBe('hook=1')
  })
})

import { describe, expect, test } from 'bun:test'
import { createClient, type OutgoingRequest } from '../src/client'
import { installMockFetch, textResponse } from './support/mock-fetch'

/**
 * `beforeRequest` hook behaviour. Stubs `globalThis.fetch` via installMockFetch
 * (fresh per test, auto-restored). The hook runs inside `_request`, once per
 * attempt, after cookies and header resolution and before fetch — so it wins the
 * precedence chain.
 */
describe('beforeRequest hook', () => {
  const fetchMock = installMockFetch()

  function headersOf(callIndex: number): Record<string, string> {
    return fetchMock.calls[callIndex]!.headers
  }

  test('adds a signature header derived from the body, seen by fetch', async () => {
    fetchMock.respond(() => textResponse('ok'))

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
    // First attempt 500, second 200, so a retry of 1 produces two attempts.
    fetchMock.sequence(new Response('', { status: 500 }), new Response('', { status: 200 }))

    let hookCalls = 0
    const client = createClient({
      baseUrl: 'https://api.example.com',
      beforeRequest: () => {
        hookCalls++
      },
    })

    await client.get('/flaky').retry({ times: 1 })
    expect(fetchMock.callCount).toBe(2)
    expect(hookCalls).toBe(2)
  })

  test('async beforeRequest is awaited before fetch', async () => {
    fetchMock.respond(() => new Response(''))

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
    fetchMock.respond(() => new Response(''))

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

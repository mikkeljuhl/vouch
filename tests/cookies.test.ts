import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createClient } from '../src/client'

/**
 * Cookie-jar behaviour. The jar is a simplified, in-memory, per-client
 * test-session jar (name=value only; opt-in via `cookies: true`).
 *
 * All tests stub `globalThis.fetch` and restore the real one in `afterEach` so a
 * mock can never leak into the live example suite.
 */
describe('cookie jar', () => {
  const realFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof mock>

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** Install a fetch mock that returns `response` and records each call. */
  function stubFetch(makeResponse: () => Response) {
    fetchMock = mock(async () => makeResponse())
    globalThis.fetch = fetchMock as unknown as typeof fetch
  }

  /** Read the `cookie` header (case-insensitively) off a recorded fetch init. */
  function cookieHeaderOf(callIndex: number): string | undefined {
    const init = fetchMock.mock.calls[callIndex][1]
    const headers = init.headers as Record<string, string>
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie')
    return key ? headers[key] : undefined
  }

  test('cookies:true stores Set-Cookie and sends them on the next request', async () => {
    stubFetch(
      () =>
        new Response('', {
          headers: [
            ['set-cookie', 'a=1'],
            ['set-cookie', 'b=2'],
          ],
        }),
    )
    const client = createClient({ baseUrl: 'https://api.example.com', cookies: true })

    // First request: no cookie sent yet, but response stores a=1; b=2.
    await client._request('POST', '/login')
    expect(cookieHeaderOf(0)).toBeUndefined()

    // Next request auto-sends the jar.
    await client._request('GET', '/me')
    expect(cookieHeaderOf(1)).toBe('a=1; b=2')
  })

  test('cookies:false (default) never sends a Cookie header even if Set-Cookie returned', async () => {
    stubFetch(() => new Response('', { headers: [['set-cookie', 'a=1']] }))
    const client = createClient({ baseUrl: 'https://api.example.com' })

    await client._request('POST', '/login')
    await client._request('GET', '/me')

    expect(cookieHeaderOf(0)).toBeUndefined()
    expect(cookieHeaderOf(1)).toBeUndefined()
    // The jar accessor is a no-op when disabled.
    expect(client.cookies.getAll()).toEqual({})
  })

  test('cookie deletion via Max-Age=0 removes it from the jar', async () => {
    let responses = [
      new Response('', { headers: [['set-cookie', 'sid=abc']] }),
      new Response('', { headers: [['set-cookie', 'sid=; Max-Age=0']] }),
    ]
    let i = 0
    fetchMock = mock(async () => responses[i++] ?? new Response(''))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createClient({ baseUrl: 'https://api.example.com', cookies: true })

    await client._request('POST', '/login') // sets sid=abc
    expect(client.cookies.get('sid')).toBe('abc')

    await client._request('POST', '/logout') // Max-Age=0 deletes it
    expect(client.cookies.get('sid')).toBeUndefined()
    expect(client.cookies.getAll()).toEqual({})
  })

  test('cookie deletion via empty value removes it', () => {
    const client = createClient({ baseUrl: 'https://api.example.com', cookies: true })
    client.cookies.set('x', '1')
    expect(client.cookies.get('x')).toBe('1')
    // Simulate a Set-Cookie with empty value through a request response.
    fetchMock = mock(async () => new Response('', { headers: [['set-cookie', 'x=']] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return client._request('GET', '/clear').then(() => {
      expect(client.cookies.get('x')).toBeUndefined()
    })
  })

  test('cookies accessor set/get/getAll/clear and seeding before a request', async () => {
    stubFetch(() => new Response(''))
    const client = createClient({ baseUrl: 'https://api.example.com', cookies: true })

    client.cookies.set('seeded', 'yes')
    client.cookies.set('k', 'v')
    expect(client.cookies.get('seeded')).toBe('yes')
    expect(client.cookies.getAll()).toEqual({ seeded: 'yes', k: 'v' })

    await client._request('GET', '/me')
    expect(cookieHeaderOf(0)).toBe('seeded=yes; k=v')

    client.cookies.clear()
    expect(client.cookies.getAll()).toEqual({})
  })

  test('per-request cookie header overrides the jar entirely', async () => {
    stubFetch(() => new Response(''))
    const client = createClient({ baseUrl: 'https://api.example.com', cookies: true })
    client.cookies.set('jar', 'value')

    await client._request('GET', '/me', { headers: { cookie: 'override=1' } })
    // User's per-request cookie wins; the jar is not merged in.
    expect(cookieHeaderOf(0)).toBe('override=1')
  })
})

/**
 * Proxy forwarding (DESIGN.md §4). The `proxy` client option and the per-request
 * `.proxy()` builder method are forwarded to Bun's `fetch` as its `proxy` init
 * field. fetch is stubbed and restored after each test so nothing leaks into the
 * live suite.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createClient } from '../src/client'

/** Bun's fetch init carries an extra `proxy` field beyond the DOM RequestInit. */
type FetchInit = RequestInit & { proxy?: string }

describe('proxy forwarding (mocked fetch)', () => {
  const realFetch = globalThis.fetch
  let calls: { url: string; init: FetchInit }[]

  beforeEach(() => {
    calls = []
    const fetchMock = mock(async (url: string, init: FetchInit) => {
      calls.push({ url, init })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('client-level proxy is forwarded to fetch', async () => {
    const client = createClient({
      baseUrl: 'https://api.example.com',
      proxy: 'http://proxy.local:8080',
    })
    await client.get('/x')
    expect(calls[0].init.proxy).toBe('http://proxy.local:8080')
  })

  test('client-level proxy is exposed on the client', () => {
    const client = createClient({ baseUrl: 'https://api.example.com', proxy: 'http://p:1' })
    expect(client.proxy).toBe('http://p:1')
  })

  test('per-request .proxy() overrides the client default', async () => {
    const client = createClient({
      baseUrl: 'https://api.example.com',
      proxy: 'http://default-proxy:8080',
    })
    await client.get('/x').proxy('http://override-proxy:9090')
    expect(calls[0].init.proxy).toBe('http://override-proxy:9090')
  })

  test('per-request .proxy() works with no client default', async () => {
    const client = createClient({ baseUrl: 'https://api.example.com' })
    await client.post('/y').json({ a: 1 }).proxy('http://only-here:7070')
    expect(calls[0].init.proxy).toBe('http://only-here:7070')
  })

  test('no proxy configured ⇒ no proxy is sent', async () => {
    const client = createClient({ baseUrl: 'https://api.example.com' })
    await client.get('/x')
    expect(calls[0].init.proxy).toBeUndefined()
  })

  test('proxy is forwarded even with a beforeRequest hook (independent of headers)', async () => {
    const client = createClient({
      baseUrl: 'https://api.example.com',
      proxy: 'http://hooked-proxy:8080',
      beforeRequest: (req) => {
        req.headers['x-signed'] = 'yes'
      },
    })
    await client.get('/x')
    expect(calls[0].init.proxy).toBe('http://hooked-proxy:8080')
    const h = calls[0].init.headers as Record<string, string>
    expect(h['x-signed']).toBe('yes')
  })
})

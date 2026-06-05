import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createClient, DEFAULT_TIMEOUT_MS } from '../src/client'

describe('default timeout (mocked fetch)', () => {
  const realFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof mock>

  beforeEach(() => {
    fetchMock = mock(async () => new Response('ok', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('DEFAULT_TIMEOUT_MS is 30s', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
  })

  test('no timeoutMs configured → a default AbortSignal is applied', async () => {
    const client = createClient({ baseUrl: 'https://api.example.com' })
    await client._request('GET', '/x')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test('timeoutMs: 0 → no signal (escape hatch)', async () => {
    const client = createClient({ baseUrl: 'https://api.example.com', timeoutMs: 0 })
    await client._request('GET', '/x')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBeUndefined()
  })

  test('per-request timeoutMs: 0 disables a factory default', async () => {
    const client = createClient({ baseUrl: 'https://api.example.com', timeoutMs: 5000 })
    await client._request('GET', '/x', { timeoutMs: 0 })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBeUndefined()
  })

  test('factory timeoutMs still applies a signal', async () => {
    const client = createClient({ baseUrl: 'https://api.example.com', timeoutMs: 1000 })
    await client._request('GET', '/x')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

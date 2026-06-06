import { describe, expect, test } from 'bun:test'
import { createClient, DEFAULT_TIMEOUT_MS } from '../src/client'
import { installMockFetch } from './support/mock-fetch'

describe('default timeout (mocked fetch)', () => {
  const fetch = installMockFetch()

  test('DEFAULT_TIMEOUT_MS is 30s', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
  })

  test('no timeoutMs configured → a default AbortSignal is applied', async () => {
    const client = createClient({ baseUrl: 'https://api.example.com' })
    await client._request('GET', '/x')
    expect(fetch.lastCall!.init!.signal).toBeInstanceOf(AbortSignal)
  })

  test('timeoutMs: 0 → no signal (escape hatch)', async () => {
    const client = createClient({ baseUrl: 'https://api.example.com', timeoutMs: 0 })
    await client._request('GET', '/x')
    expect(fetch.lastCall!.init!.signal).toBeUndefined()
  })

  test('per-request timeoutMs: 0 disables a factory default', async () => {
    const client = createClient({ baseUrl: 'https://api.example.com', timeoutMs: 5000 })
    await client._request('GET', '/x', { timeoutMs: 0 })
    expect(fetch.lastCall!.init!.signal).toBeUndefined()
  })

  test('factory timeoutMs still applies a signal', async () => {
    const client = createClient({ baseUrl: 'https://api.example.com', timeoutMs: 1000 })
    await client._request('GET', '/x')
    expect(fetch.lastCall!.init!.signal).toBeInstanceOf(AbortSignal)
  })
})

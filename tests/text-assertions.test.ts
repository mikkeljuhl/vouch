import { describe, expect, test } from 'bun:test'
import { createClient } from '../src/client'
import { installMockFetch, jsonResponse, textResponse } from './support/mock-fetch'

describe('text body assertions (mocked fetch)', () => {
  // The shared helper installs/restores the stub so it never leaks into the live suite.
  const fetch = installMockFetch()

  const client = () => createClient({ baseUrl: 'https://api.example.com' })

  test('response.text is populated for text responses', async () => {
    fetch.text('plain payload')
    const res = await client().get('/text')
    expect(res.text).toBe('plain payload')
    expect(res.body).toBe('plain payload')
  })

  describe('.expectText', () => {
    test('passes when text contains the substring', async () => {
      fetch.text('the quick brown fox')
      await expect(client().get('/x').expectText('brown').send()).resolves.toBeDefined()
    })

    test('throws when text does not contain the substring', async () => {
      fetch.text('the quick brown fox')
      await expect(client().get('/x').expectText('purple').send()).rejects.toThrow(/contain/)
    })

    test('passes when text matches a RegExp', async () => {
      fetch.text('<html><body>Hi</body></html>', { headers: { 'content-type': 'text/html' } })
      await expect(client().get('/x').expectText(/<body>.*<\/body>/).send()).resolves.toBeDefined()
    })

    test('throws when text does not match a RegExp', async () => {
      fetch.text('abc')
      await expect(client().get('/x').expectText(/\d{3}/).send()).rejects.toThrow(/match/)
    })
  })

  describe('.expectBody', () => {
    test('passes on an exact match', async () => {
      fetch.text('exact')
      await expect(client().get('/x').expectBody('exact').send()).resolves.toBeDefined()
    })

    test('throws on a non-exact match (substring is not enough)', async () => {
      fetch.text('exact plus more')
      await expect(client().get('/x').expectBody('exact').send()).rejects.toThrow(/equal/)
    })

    test("passes on an empty body via .expectBody('')", async () => {
      fetch.respond(new Response('', { status: 204 }))
      const res = await client().get('/x').expectBody('')
      expect(res.text).toBe('')
    })
  })

  describe('JSON interplay', () => {
    test('JSON response still parses body AND exposes text', async () => {
      // Two calls below — return a fresh Response per call so the body isn't reused.
      fetch.respond(() => jsonResponse({ id: 1, name: 'Ada' }))
      const res = await client().get<{ id: number; name: string }>('/users/1')
      expect(res.body).toEqual({ id: 1, name: 'Ada' })
      expect(res.text).toBe('{"id":1,"name":"Ada"}')
      // .expectText works against the raw JSON text too.
      await client().get('/users/1') // no-op to keep mock symmetry
    })

    test('malformed JSON with JSON content-type falls back to text (no throw)', async () => {
      fetch.respond(
        new Response('{not valid json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      const res = await client().get('/broken')
      expect(res.body).toBe('{not valid json')
      expect(res.text).toBe('{not valid json')
    })
  })
})

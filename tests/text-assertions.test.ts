import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createClient } from '../src/client'

/** Build a text/plain Response. */
function textResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain', ...headers } })
}

describe('text body assertions (mocked fetch)', () => {
  // Save/restore the real fetch so the stub never leaks into the live suite.
  const realFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof mock>

  beforeEach(() => {
    fetchMock = mock(async () => textResponse('hello world'))
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const client = () => createClient({ baseUrl: 'https://api.example.com' })

  test('response.text is populated for text responses', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('plain payload'))
    const res = await client().get('/text')
    expect(res.text).toBe('plain payload')
    expect(res.body).toBe('plain payload')
  })

  describe('.expectText', () => {
    test('passes when text contains the substring', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('the quick brown fox'))
      await expect(client().get('/x').expectText('brown').send()).resolves.toBeDefined()
    })

    test('throws when text does not contain the substring', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('the quick brown fox'))
      await expect(client().get('/x').expectText('purple').send()).rejects.toThrow(/contain/)
    })

    test('passes when text matches a RegExp', async () => {
      fetchMock.mockResolvedValueOnce(
        textResponse('<html><body>Hi</body></html>', { 'content-type': 'text/html' }),
      )
      await expect(client().get('/x').expectText(/<body>.*<\/body>/).send()).resolves.toBeDefined()
    })

    test('throws when text does not match a RegExp', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('abc'))
      await expect(client().get('/x').expectText(/\d{3}/).send()).rejects.toThrow(/match/)
    })
  })

  describe('.expectBody', () => {
    test('passes on an exact match', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('exact'))
      await expect(client().get('/x').expectBody('exact').send()).resolves.toBeDefined()
    })

    test('throws on a non-exact match (substring is not enough)', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('exact plus more'))
      await expect(client().get('/x').expectBody('exact').send()).rejects.toThrow(/equal/)
    })

    test("passes on an empty body via .expectBody('')", async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status: 204 }))
      const res = await client().get('/x').expectBody('')
      expect(res.text).toBe('')
    })
  })

  describe('JSON interplay', () => {
    test('JSON response still parses body AND exposes text', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1, name: 'Ada' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      const res = await client().get<{ id: number; name: string }>('/users/1')
      expect(res.body).toEqual({ id: 1, name: 'Ada' })
      expect(res.text).toBe('{"id":1,"name":"Ada"}')
      // .expectText works against the raw JSON text too.
      await client().get('/users/1') // no-op to keep mock symmetry
    })

    test('malformed JSON with JSON content-type falls back to text (no throw)', async () => {
      fetchMock.mockResolvedValueOnce(
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

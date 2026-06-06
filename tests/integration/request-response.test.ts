/**
 * Integration suite for the vouch framework's request shaping + response
 * handling, driven end-to-end against the in-process Bun mock (real HTTP, no
 * external network). Each test file gets its own mock instance (fresh state).
 *
 * Coverage:
 *  - query encoding (spaces / special chars / multiple params / falsy values)
 *  - header resolution: factory + per-request override, callable values,
 *    case-insensitive lookup, .expectHeader string + RegExp, content-type echo
 *  - request bodies: .json(), .form() (urlencoded), .multipart().file()
 *    (real fixture upload, framework-set boundary), .body() raw + explicit CT
 *  - response types: /text, /html, /empty, /malformed-json fallback, JSON
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createClient, fixture, AssertionError } from '../../src/index'
import { startMockServer } from '../support/mock-server'

let server: { url: string; stop(): void }

beforeAll(() => {
  server = startMockServer()
})

afterAll(() => {
  server.stop()
})

/** The /echo route reflects the request shape; this is its (typed) body. */
interface EchoResponse {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

describe('request shaping → /echo', () => {
  test('query params: spaces, special chars, falsy values, multiple params', async () => {
    const client = createClient({ baseUrl: server.url })

    const res = await client
      .get<EchoResponse>('/echo')
      .query({ a: 1, b: 'x y', c: true, d: 0, e: 'a/b&c' })
      .expectStatus(200)

    // The server reflects the DECODED query, so we assert decoded values arrived
    // intact — proving the framework encoded the wire form correctly.
    expect(res.body.query).toEqual({
      a: '1',
      b: 'x y',
      c: 'true',
      d: '0',
      e: 'a/b&c',
    })

    // And assert the WIRE encoding directly on the URL the request went to: the
    // space is encoded (the framework uses URLSearchParams, which renders a space
    // as `+` in the query string) and special chars are percent-escaped. A bare
    // unencoded space / `&` / `/` here would be a real regression.
    const sentUrl = res.raw.url
    expect(sentUrl).toContain('b=x+y')
    expect(sentUrl).not.toContain('b=x y')
    expect(sentUrl).toMatch(/e=a%2Fb%26c/)
    // The falsy-but-defined params must NOT be dropped (0 / false-like handling).
    expect(sentUrl).toContain('d=0')
    expect(sentUrl).toContain('c=true')
  })

  test('headers: factory + per-request override, callable, case-insensitive, expectHeader', async () => {
    let callCount = 0
    const client = createClient({
      baseUrl: server.url,
      headers: {
        'X-Factory': 'factory-value',
        'X-Overridden': 'from-factory',
        // A CALLABLE header value, re-evaluated each request.
        'X-Callable': () => `call-${++callCount}`,
      },
    })

    const res = await client
      .get<EchoResponse>('/echo')
      // Per-request override of a factory header (override must win) + a new one.
      .headers({ 'X-Overridden': 'from-request', 'X-Extra': 'extra-value' })
      // expectHeader with an exact string (response always carries this).
      .expectHeader('x-powered-by', 'vouch-mock')
      // expectHeader with a RegExp against the response content-type.
      .expectHeader('content-type', /application\/json/)
      .expectStatus(200)

    const echoed = res.body.headers // lowercased by the mock
    expect(echoed['x-factory']).toBe('factory-value')
    // Override wins over the factory value.
    expect(echoed['x-overridden']).toBe('from-request')
    expect(echoed['x-extra']).toBe('extra-value')
    // Callable was invoked exactly once for this single request.
    expect(echoed['x-callable']).toBe('call-1')
    expect(callCount).toBe(1)

    // Case-insensitive lookup on the native Headers of the response.
    expect(res.raw.headers.get('X-POWERED-BY')).toBe('vouch-mock')
    expect(res.raw.headers.get('Content-Type')).toContain('application/json')
  })

  test('json body: object reflected verbatim (nested)', async () => {
    const client = createClient({ baseUrl: server.url })
    const payload = { name: 'Ada', tags: ['x', 'y'], meta: { active: true, score: 42 } }

    const res = await client
      .post<EchoResponse>('/echo')
      .json(payload)
      .expectStatus(200)

    // The framework set application/json, so the mock parsed the body as JSON.
    expect(res.body.headers['content-type']).toContain('application/json')
    expect(res.body.body).toEqual(payload)
  })

  test('form body: urlencoded fields, content-type auto-set by fetch', async () => {
    const client = createClient({ baseUrl: server.url })

    const res = await client
      .post<EchoResponse>('/echo')
      .form({ k: 'v', other: 'a b', sym: 'x&y' })
      .expectStatus(200)

    expect(res.body.headers['content-type']).toContain('application/x-www-form-urlencoded')
    // Mock decodes urlencoded into a fields object — assert round-trip fidelity.
    expect(res.body.body).toEqual({ k: 'v', other: 'a b', sym: 'x&y' })
  })

  test('multipart + file: real fixture upload, framework-set boundary content-type', async () => {
    const client = createClient({ baseUrl: server.url })
    const zip = fixture(import.meta.url, '../fixtures/sample.zip', 'application/zip')

    const res = await client
      .post<EchoResponse>('/echo')
      .multipart({ field: 'v' })
      .file('f', zip, 'sample.zip')
      .expectStatus(200)

    // The framework must NOT override the multipart content-type: fetch sets a
    // boundary itself. Assert the boundary is present (a stale application/json
    // here would be a real regression).
    const ct = res.body.headers['content-type']
    expect(ct).toContain('multipart/form-data')
    expect(ct).toMatch(/boundary=/)

    const body = res.body.body as {
      form: Record<string, string>
      files: Record<string, { filename: string; size: number; type: string }>
    }
    expect(body.form).toEqual({ field: 'v' })
    expect(body.files.f).toBeDefined()
    expect(body.files.f.filename).toBe('sample.zip')
    expect(body.files.f.type).toBe('application/zip')
    // Real bytes flowed through: the known fixture is non-empty.
    expect(body.files.f.size).toBeGreaterThan(0)
  })

  test('raw body with explicit content-type via .body() + .headers()', async () => {
    const client = createClient({ baseUrl: server.url })
    const raw = 'just a raw string payload'

    const res = await client
      .post<EchoResponse>('/echo')
      .body(raw)
      .headers({ 'content-type': 'text/plain' })
      .expectStatus(200)

    expect(res.body.headers['content-type']).toContain('text/plain')
    // Non-JSON/non-form/non-multipart → the mock echoes the raw text verbatim.
    expect(res.body.body).toBe(raw)
  })
})

describe('response body + type permutations', () => {
  test('/text → expectText substring + regex', async () => {
    const client = createClient({ baseUrl: server.url })

    const res = await client
      .get('/text')
      .expectStatus(200)
      .expectHeader('content-type', /text\/plain/)
      .expectText('hello') // substring
      .expectText(/^hello world$/) // regex full-match

    expect(res.text).toBe('hello world')
    // Non-JSON content-type: body falls back to the raw text.
    expect(res.body).toBe('hello world')
  })

  test('/html → expectText(/<h1>/)', async () => {
    const client = createClient({ baseUrl: server.url })

    const res = await client
      .get('/html')
      .expectStatus(200)
      .expectHeader('content-type', /text\/html/)
      .expectText(/<h1>hi<\/h1>/)

    expect(res.text).toContain('<html>')
  })

  test('/empty → expectBody("") on a 204', async () => {
    const client = createClient({ baseUrl: server.url })

    const res = await client.get('/empty').expectStatus(204).expectBody('')

    expect(res.text).toBe('')
    expect(res.status).toBe(204)
  })

  test('/malformed-json → body falls back to text (no throw), text is raw', async () => {
    const client = createClient({ baseUrl: server.url })

    // The route sends application/json but an invalid body; parsing must NOT
    // throw — body falls back to the raw string and .text is that raw string.
    const res = await client
      .get('/malformed-json')
      .expectStatus(200)
      .expectHeader('content-type', /application\/json/)

    expect(res.raw.headers.get('content-type')).toContain('application/json')
    expect(res.text).toBe('{ not valid json')
    expect(res.body).toBe('{ not valid json')
  })

  test('JSON route → expectJson partial + nested', async () => {
    const client = createClient({ baseUrl: server.url })

    // /users/1 → { id, name, username, email } (frozen contract).
    const res = await client
      .get('/users/1')
      .expectStatus(200)
      // Partial subset match (would catch a wrong id / missing field).
      .expectJson({ id: 1, username: 'ada' })

    expect(res.body).toEqual({
      id: 1,
      name: 'Ada Lovelace',
      username: 'ada',
      email: 'ada@example.com',
    })

    // A nested partial via a POST echo route (frozen): { ...body, id: 101 }.
    const created = await client
      .post('/posts')
      .json({ title: 't', body: 'b', userId: 1 })
      .expectStatus(201)
      .expectJson({ id: 101, userId: 1 })

    expect((created.body as { id: number }).id).toBe(101)
  })

  test('JSON route → expectJsonStrict full equality (every key, no extras)', async () => {
    const client = createClient({ baseUrl: server.url })

    // Strict equality (deep-equal): the WHOLE object must match — a missing key,
    // an extra key, or any wrong value would fail. This exercises a distinct
    // matcher (assertJsonStrict) that the subset .expectJson() above does not.
    const res = await client
      .get('/users/1')
      .expectStatus(200)
      .expectJsonStrict({
        id: 1,
        name: 'Ada Lovelace',
        username: 'ada',
        email: 'ada@example.com',
      })

    expect((res.body as { id: number }).id).toBe(1)
  })
})

describe('assertion failure paths → AssertionError', () => {
  // These prove the matchers actually FAIL (not silently pass) and surface a
  // useful, request-identifying message. A regression that made an assertion a
  // no-op would flip every one of these from rejecting to resolving.

  test('expectStatus mismatch rejects with AssertionError naming expected/actual', async () => {
    const client = createClient({ baseUrl: server.url })

    // /text returns 200; asserting 404 must throw. `.send()` returns a real
    // Promise (the builder itself is only a thenable) so `.rejects` can assert.
    const promise = client.get('/text').expectStatus(404).send()
    await expect(promise).rejects.toThrow(AssertionError)
    await expect(promise).rejects.toThrow(/expected status 404 but got 200/)
    // The message identifies the request (method + url) so failures are locatable.
    await expect(promise).rejects.toThrow(/GET .*\/text/)
  })

  test('expectJson subset mismatch rejects with a path-level diff', async () => {
    const client = createClient({ baseUrl: server.url })

    // /users/1 has username 'ada'; assert a wrong value and a missing key.
    const promise = client
      .get('/users/1')
      .expectJson({ username: 'NOT-ada', nope: 'x' })
      .send()

    await expect(promise).rejects.toThrow(AssertionError)
    // The structured diff calls out the offending paths.
    await expect(promise).rejects.toThrow(/username/)
    await expect(promise).rejects.toThrow(/nope.*missing/)
  })

  test('expectText mismatch rejects with AssertionError showing the actual text', async () => {
    const client = createClient({ baseUrl: server.url })

    // /text is 'hello world'; a regex that cannot match must throw.
    const promise = client.get('/text').expectText(/goodbye/).send()
    await expect(promise).rejects.toThrow(AssertionError)
    await expect(promise).rejects.toThrow(/expected response text to match/)
    // The actual body is surfaced in the message.
    await expect(promise).rejects.toThrow(/hello world/)
  })

  test('expectHeader mismatch rejects and reports the actual header value', async () => {
    const client = createClient({ baseUrl: server.url })

    // x-powered-by is 'vouch-mock'; asserting a different exact value must throw.
    const promise = client.get('/text').expectHeader('x-powered-by', 'express').send()
    await expect(promise).rejects.toThrow(AssertionError)
    await expect(promise).rejects.toThrow(/x-powered-by/)
    await expect(promise).rejects.toThrow(/vouch-mock/)
  })
})

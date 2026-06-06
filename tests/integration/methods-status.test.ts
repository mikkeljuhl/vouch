/**
 * Integration suite: HTTP method matrix + status/error pathways.
 *
 * Runs the real vouch framework against the in-process Bun mock server (no
 * external network). Each file gets its own mock instance (fresh state), started
 * in beforeAll and stopped in afterAll. Assertions are meaningful: they pin the
 * echoed method, the exact status code, and the response body shape, so a real
 * regression (wrong verb sent, wrong status surfaced, body mis-parsed) would fail.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createClient, AssertionError, type Client } from '../../src/index'
import { startMockServer } from '../support/mock-server'

let server: { url: string; stop(): void }
let client: Client

beforeAll(() => {
  server = startMockServer()
  client = createClient({ baseUrl: server.url })
})

afterAll(() => {
  server.stop()
})

describe('HTTP method matrix', () => {
  // The /echo route reflects the request method verbatim, so each verb assertion
  // would catch the builder sending the wrong HTTP method.
  test('GET /echo reflects method GET', async () => {
    await client.get('/echo').expectStatus(200).expectJson({ method: 'GET', path: '/echo' })
  })

  test('POST /echo reflects method POST and JSON body', async () => {
    await client
      .post('/echo')
      .json({ hello: 'world' })
      .expectStatus(200)
      .expectJson({ method: 'POST', body: { hello: 'world' } })
  })

  test('PUT /echo reflects method PUT', async () => {
    await client.put('/echo').json({ a: 1 }).expectStatus(200).expectJson({ method: 'PUT', body: { a: 1 } })
  })

  test('PATCH /echo reflects method PATCH', async () => {
    await client
      .patch('/echo')
      .json({ b: 2 })
      .expectStatus(200)
      .expectJson({ method: 'PATCH', body: { b: 2 } })
  })

  test('DELETE /echo reflects method DELETE', async () => {
    await client.delete('/echo').expectStatus(200).expectJson({ method: 'DELETE' })
  })
})

describe('CRUD /posts routes per verb', () => {
  test('GET /posts/:id returns the seeded post', async () => {
    await client
      .get('/posts/1')
      .expectStatus(200)
      .expectJsonStrict({ id: 1, userId: 1, title: 'first post', body: 'first body' })
  })

  test('POST /posts creates with assigned id 101', async () => {
    await client
      .post('/posts')
      .json({ userId: 7, title: 't', body: 'b' })
      .expectStatus(201)
      .expectJsonStrict({ userId: 7, title: 't', body: 'b', id: 101 })
  })

  test('PUT /posts/:id echoes the body verbatim', async () => {
    await client
      .put('/posts/1')
      .json({ id: 1, userId: 1, title: 'replaced', body: 'replaced body' })
      .expectStatus(200)
      .expectJsonStrict({ id: 1, userId: 1, title: 'replaced', body: 'replaced body' })
  })

  test('PATCH /posts/:id merges over the existing resource', async () => {
    await client
      .patch('/posts/2')
      .json({ title: 'patched title' })
      .expectStatus(200)
      // Merge: existing fields preserved, only title overwritten.
      .expectJsonStrict({ id: 2, userId: 1, title: 'patched title', body: 'second body' })
  })

  test('DELETE /posts/:id returns 200 with empty object', async () => {
    await client.delete('/posts/1').expectStatus(200).expectJsonStrict({})
  })
})

describe('status code matrix', () => {
  test('200 OK', async () => {
    await client.get('/status/200').expectStatus(200).expectJson({ code: 200 })
  })

  test('201 Created', async () => {
    await client.get('/status/201').expectStatus(201).expectJson({ code: 201 })
  })

  test('204 No Content via /empty has an empty body', async () => {
    await client.get('/empty').expectStatus(204).expectBody('')
  })

  test('204 No Content via /status/204 has an empty body', async () => {
    await client.get('/status/204').expectStatus(204).expectBody('')
  })

  test('redirect resolves to a 200 (3xx followed by fetch)', async () => {
    // Bun's fetch follows redirects by default, so /redirect/1 (302) lands on
    // /redirect/0 (200). The intermediate hop is a 301-or-302 we cannot observe
    // directly; we assert the redirect chain was honored and landed at 200.
    await client.get('/redirect/1').expectStatus(200).expectJson({ landed: true })
  })

  test('400 Bad Request carries a JSON error body', async () => {
    await client.get('/status/400').expectStatus(400).expectJson({ code: 400 })
  })

  test('401 Unauthorized (real auth route) returns JSON error', async () => {
    await client.get('/auth').expectStatus(401).expectJsonStrict({ error: 'unauthorized' })
  })

  test('403 Forbidden carries a JSON error body', async () => {
    await client.get('/status/403').expectStatus(403).expectJson({ code: 403 })
  })

  test('404 Not Found carries a JSON error body', async () => {
    await client.get('/status/404').expectStatus(404).expectJson({ code: 404 })
  })

  test('409 Conflict carries a JSON error body', async () => {
    await client.get('/status/409').expectStatus(409).expectJson({ code: 409 })
  })

  test('422 Unprocessable Entity carries a JSON error body', async () => {
    await client.get('/status/422').expectStatus(422).expectJson({ code: 422 })
  })

  test('500 Internal Server Error carries a JSON error body', async () => {
    await client.get('/status/500').expectStatus(500).expectJson({ code: 500 })
  })

  test('503 Service Unavailable carries a JSON error body', async () => {
    await client.get('/status/503').expectStatus(503).expectJson({ code: 503 })
  })

  test('text error body via ?type=text', async () => {
    // The text variant proves the error pathway also surfaces a plain-text body,
    // not just JSON — would catch a content-type/body mis-handling regression.
    await client
      .get('/status/422')
      .query({ type: 'text' })
      .expectStatus(422)
      .expectBody('status 422')
  })
})

describe('redirect following', () => {
  test('/redirect/3 follows the whole chain to a 200 landing', async () => {
    await client.get('/redirect/3').expectStatus(200).expectJsonStrict({ landed: true })
  })
})

describe('missing resource (404 pathway)', () => {
  test('GET /posts/99999 → 404 not found', async () => {
    await client.get('/posts/99999').expectStatus(404).expectJsonStrict({ error: 'not found' })
  })

  test('GET unknown route → 404 not found', async () => {
    await client.get('/no-such-route').expectStatus(404).expectJsonStrict({ error: 'not found' })
  })
})

describe('chained CRUD lifecycle', () => {
  test('POST → GET → PUT → PATCH → DELETE threading ids', async () => {
    // Create — the mock assigns id 101.
    const created = await client
      .post('/posts')
      .json({ userId: 1, title: 'lifecycle', body: 'created' })
      .expectStatus(201)
      .expectJson({ id: 101, title: 'lifecycle' })
    const id = (created.body as { id: number }).id
    expect(id).toBe(101)

    // Read a seeded post (the mock only stores seeds; id 1 is readable).
    const read = await client
      .get('/posts/1')
      .expectStatus(200)
      .expectJson({ id: 1, userId: 1 })
    const readId = (read.body as { id: number }).id

    // Update (PUT) the read id — echoed verbatim, so the threaded id round-trips.
    await client
      .put(`/posts/${readId}`)
      .json({ id: readId, userId: 1, title: 'updated', body: 'updated body' })
      .expectStatus(200)
      .expectJsonStrict({ id: readId, userId: 1, title: 'updated', body: 'updated body' })

    // Partial update (PATCH) merges over the existing seeded resource.
    await client
      .patch(`/posts/${readId}`)
      .json({ body: 'patched body' })
      .expectStatus(200)
      .expectJsonStrict({ id: readId, userId: 1, title: 'first post', body: 'patched body' })

    // Delete the threaded id.
    await client.delete(`/posts/${readId}`).expectStatus(200).expectJsonStrict({})
  })
})

describe('assertion failure pathways (negative tests)', () => {
  // These prove the positive assertions above are not no-ops: when the response
  // does NOT match, the awaited builder must REJECT with an AssertionError whose
  // message pins the real status/method, so a regression would be surfaced.

  test('expectStatus mismatch rejects with a precise AssertionError', async () => {
    let err: unknown
    try {
      // The route really returns 200; asserting 404 must fail.
      await client.get('/status/200').expectStatus(404)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AssertionError)
    // Message must name both the wrong expectation and the real status.
    expect((err as Error).message).toContain('expected status 404')
    expect((err as Error).message).toContain('got 200')
    expect((err as Error).message).toContain('/status/200')
  })

  test('wrong-method expectation rejects (proves the verb is actually sent)', async () => {
    let err: unknown
    try {
      // A GET is sent; claiming the echo saw POST must fail on the method field.
      await client.get('/echo').expectJson({ method: 'POST' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AssertionError)
    const message = (err as Error).message
    expect(message).toContain('JSON body did not match')
    // The diff must point at the method field: expected POST, received the real GET.
    expect(message).toContain('method')
    expect(message).toContain('"POST"')
    expect(message).toContain('"GET"')
  })

  test('expectJsonStrict rejects on an extra key the strict matcher must catch', async () => {
    let err: unknown
    try {
      // /status/200 returns exactly { code: 200 }; a strict match against {} must
      // report the unexpected `code` key (subset would have passed — strict must not).
      await client.get('/status/200').expectJsonStrict({})
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AssertionError)
    const message = (err as Error).message
    expect(message).toContain('JSON body did not match (strict)')
    expect(message).toContain('code')
  })

  test('expectBody mismatch rejects with expected-vs-received text', async () => {
    let err: unknown
    try {
      // /empty has an empty body; asserting non-empty text must fail.
      await client.get('/empty').expectBody('not empty')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AssertionError)
    expect((err as Error).message).toContain('expected response body to equal')
  })
})

describe('transport-error pathway (dead port)', () => {
  // The one deliberate non-mock case: a request to a closed port must reject with
  // a transport error BEFORE any assertion runs (no AssertionError, since no
  // response was produced). Proves the framework surfaces network failures.
  test('connecting to a dead port rejects (no response)', async () => {
    // Port 1 is in the privileged range and not served here; the connect fails.
    const deadClient = createClient({ baseUrl: 'http://127.0.0.1:1' })
    let err: unknown
    try {
      await deadClient.get('/echo').expectStatus(200)
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    // A transport failure is NOT an assertion failure — the request never settled.
    expect(err).not.toBeInstanceOf(AssertionError)
  })
})

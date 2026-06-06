/**
 * Integration suite: HTTP method matrix + status/error pathways.
 *
 * Runs the real vouch framework against the in-process Bun mock server (no
 * external network). Setup via useMockServer(); failure paths via captureAssertion;
 * breadth via the status-table and CRUD-lifecycle scenario runners. Assertions are
 * meaningful: they pin the echoed method, the exact status code, and the response
 * body shape, so a real regression (wrong verb sent, wrong status surfaced, body
 * mis-parsed) would fail.
 */

import { describe, test, expect } from 'bun:test'
import { createClient, AssertionError } from '../../src/index'
import { useMockServer } from '../support/mock-client'
import { captureAssertion } from '../support/assert'
import { hitStatusCodes, crudLifecycle } from '../support/scenarios'

const mock = useMockServer()

describe('HTTP method matrix', () => {
  // The /echo route reflects the request method verbatim, so each verb assertion
  // would catch the builder sending the wrong HTTP method.
  test('GET /echo reflects method GET', async () => {
    await mock.client().get('/echo').expectStatus(200).expectJson({ method: 'GET', path: '/echo' })
  })

  test('POST /echo reflects method POST and JSON body', async () => {
    await mock
      .client()
      .post('/echo')
      .json({ hello: 'world' })
      .expectStatus(200)
      .expectJson({ method: 'POST', body: { hello: 'world' } })
  })

  test('PUT /echo reflects method PUT', async () => {
    await mock
      .client()
      .put('/echo')
      .json({ a: 1 })
      .expectStatus(200)
      .expectJson({ method: 'PUT', body: { a: 1 } })
  })

  test('PATCH /echo reflects method PATCH', async () => {
    await mock
      .client()
      .patch('/echo')
      .json({ b: 2 })
      .expectStatus(200)
      .expectJson({ method: 'PATCH', body: { b: 2 } })
  })

  test('DELETE /echo reflects method DELETE', async () => {
    await mock.client().delete('/echo').expectStatus(200).expectJson({ method: 'DELETE' })
  })
})

describe('CRUD /posts routes per verb', () => {
  test('GET /posts/:id returns the seeded post', async () => {
    await mock
      .client()
      .get('/posts/1')
      .expectStatus(200)
      .expectJsonStrict({ id: 1, userId: 1, title: 'first post', body: 'first body' })
  })

  test('POST /posts creates with assigned id 101', async () => {
    await mock
      .client()
      .post('/posts')
      .json({ userId: 7, title: 't', body: 'b' })
      .expectStatus(201)
      .expectJsonStrict({ userId: 7, title: 't', body: 'b', id: 101 })
  })

  test('PUT /posts/:id echoes the body verbatim', async () => {
    await mock
      .client()
      .put('/posts/1')
      .json({ id: 1, userId: 1, title: 'replaced', body: 'replaced body' })
      .expectStatus(200)
      .expectJsonStrict({ id: 1, userId: 1, title: 'replaced', body: 'replaced body' })
  })

  test('PATCH /posts/:id merges over the existing resource', async () => {
    await mock
      .client()
      .patch('/posts/2')
      .json({ title: 'patched title' })
      .expectStatus(200)
      // Merge: existing fields preserved, only title overwritten.
      .expectJsonStrict({ id: 2, userId: 1, title: 'patched title', body: 'second body' })
  })

  test('DELETE /posts/:id returns 200 with empty object', async () => {
    await mock.client().delete('/posts/1').expectStatus(200).expectJsonStrict({})
  })
})

describe('status code matrix', () => {
  // The status table reflects `{ code }` for each JSON status; one assertion per
  // code pins both the surfaced status AND the body shape (catches mis-parsed /
  // mis-surfaced status). Each code is a distinct pathway.
  const jsonCodes = [200, 201, 400, 403, 404, 409, 422, 500, 503]
  test.each(jsonCodes)('%i carries a JSON { code } body', async (code) => {
    const [r] = await hitStatusCodes(mock.client(), [code])
    expect(r.status).toBe(code)
    expect(r.body).toEqual({ code })
  })

  test('204 No Content via /empty has an empty body', async () => {
    await mock.client().get('/empty').expectStatus(204).expectBody('')
  })

  test('204 No Content via /status/204 has an empty body', async () => {
    await mock.client().get('/status/204').expectStatus(204).expectBody('')
  })

  test('redirect resolves to a 200 (3xx followed by fetch)', async () => {
    // Bun's fetch follows redirects by default, so /redirect/1 (302) lands on
    // /redirect/0 (200). The intermediate hop is a 301-or-302 we cannot observe
    // directly; we assert the redirect chain was honored and landed at 200.
    await mock.client().get('/redirect/1').expectStatus(200).expectJson({ landed: true })
  })

  test('401 Unauthorized (real auth route) returns JSON error', async () => {
    await mock.client().get('/auth').expectStatus(401).expectJsonStrict({ error: 'unauthorized' })
  })

  test('text error body via ?type=text', async () => {
    // The text variant proves the error pathway also surfaces a plain-text body,
    // not just JSON — would catch a content-type/body mis-handling regression.
    const [r] = await hitStatusCodes(mock.client(), [422], { asText: true })
    expect(r.status).toBe(422)
    expect(r.body).toBe('status 422')
  })
})

describe('redirect following', () => {
  test('/redirect/3 follows the whole chain to a 200 landing', async () => {
    await mock.client().get('/redirect/3').expectStatus(200).expectJsonStrict({ landed: true })
  })
})

describe('missing resource (404 pathway)', () => {
  test('GET /posts/99999 → 404 not found', async () => {
    await mock.client().get('/posts/99999').expectStatus(404).expectJsonStrict({ error: 'not found' })
  })

  test('GET unknown route → 404 not found', async () => {
    await mock.client().get('/no-such-route').expectStatus(404).expectJsonStrict({ error: 'not found' })
  })
})

describe('chained CRUD lifecycle', () => {
  test('POST → GET → PUT → PATCH → DELETE threading ids', async () => {
    // The lifecycle runner threads the read id through PUT/PATCH/DELETE; we pin
    // every step's status + echoed/merged body, matching the original assertions.
    const r = await crudLifecycle(mock.client(), {
      createBody: { userId: 1, title: 'lifecycle', body: 'created' },
      readId: 1,
      updateBody: { id: 1, userId: 1, title: 'updated', body: 'updated body' },
      patchBody: { body: 'patched body' },
    })

    // Create — the mock assigns id 101.
    expect(r.created.status).toBe(201)
    expect(r.created.body).toMatchObject({ id: 101, title: 'lifecycle' })
    expect(r.createdId).toBe(101)

    // Read a seeded post (the mock only stores seeds; id 1 is readable).
    expect(r.read.status).toBe(200)
    expect(r.read.body).toMatchObject({ id: 1, userId: 1 })

    // Update (PUT) the read id — echoed verbatim, so the threaded id round-trips.
    expect(r.updated.status).toBe(200)
    expect(r.updated.body).toEqual({ id: 1, userId: 1, title: 'updated', body: 'updated body' })

    // Partial update (PATCH) merges over the existing seeded resource.
    expect(r.patched.status).toBe(200)
    expect(r.patched.body).toEqual({ id: 1, userId: 1, title: 'first post', body: 'patched body' })

    // Delete the threaded id.
    expect(r.deleted.status).toBe(200)
    expect(r.deleted.body).toEqual({})
  })
})

describe('assertion failure pathways (negative tests)', () => {
  // These prove the positive assertions above are not no-ops: when the response
  // does NOT match, the awaited builder must REJECT with an AssertionError whose
  // message pins the real status/method, so a regression would be surfaced.

  test('expectStatus mismatch rejects with a precise AssertionError', async () => {
    // The route really returns 200; asserting 404 must fail.
    const err = await captureAssertion(mock.client().get('/status/200').expectStatus(404))
    // Message must name both the wrong expectation and the real status.
    expect(err.message).toContain('expected status 404')
    expect(err.message).toContain('got 200')
    expect(err.message).toContain('/status/200')
  })

  test('wrong-method expectation rejects (proves the verb is actually sent)', async () => {
    // A GET is sent; claiming the echo saw POST must fail on the method field.
    const err = await captureAssertion(mock.client().get('/echo').expectJson({ method: 'POST' }))
    expect(err.message).toContain('JSON body did not match')
    // The diff must point at the method field: expected POST, received the real GET.
    expect(err.message).toContain('method')
    expect(err.message).toContain('"POST"')
    expect(err.message).toContain('"GET"')
  })

  test('expectJsonStrict rejects on an extra key the strict matcher must catch', async () => {
    // /status/200 returns exactly { code: 200 }; a strict match against {} must
    // report the unexpected `code` key (subset would have passed — strict must not).
    const err = await captureAssertion(mock.client().get('/status/200').expectJsonStrict({}))
    expect(err.message).toContain('JSON body did not match (strict)')
    expect(err.message).toContain('code')
  })

  test('expectBody mismatch rejects with expected-vs-received text', async () => {
    // /empty has an empty body; asserting non-empty text must fail.
    const err = await captureAssertion(mock.client().get('/empty').expectBody('not empty'))
    expect(err.message).toContain('expected response body to equal')
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

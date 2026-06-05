/**
 * Dogfood example — posts (writes + chaining + retry + per-request header override).
 *
 * Same consumer-style setup as users.test.ts: a single client built in
 * `beforeAll`, held file-scoped, base URL from env with a default — here the
 * in-process `Bun.serve` mock (hermetic; no external dependency).
 *
 * Mock contract (important): the mock accepts POST/PUT/PATCH and *echoes* the
 * payload back — POST /posts returns your body plus a fresh id (101); PUT echoes
 * exactly the object you send; PATCH merges your fields onto the existing resource
 * and echoes the result. We design the chain around that: assert the POST echoes
 * our data and returns an id, then chain by reusing that id in a PATCH to the same
 * resource and assert the merged result.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type Client } from '../../src/index'
import { startMockServer } from '../support/mock-server'
import type { Post } from './types'

describe('posts (mock server)', () => {
  let client: Client
  let server: { url: string; stop(): void }

  beforeAll(() => {
    server = startMockServer()
    client = createClient({
      // Set API_BASE_URL to retarget. We avoid `BASE_URL` because Vite/Vitest
      // reserves it (injects its own `base`, default "/", into process.env), which
      // would silently override this. `||` also guards an empty-string env.
      baseUrl: process.env.API_BASE_URL || server.url,
      headers: {
        Authorization: () => `Bearer ${process.env.API_TOKEN ?? 'demo-token'}`,
        'X-Request-Id': () => crypto.randomUUID(),
      },
      timeoutMs: 15_000,
      retry: { times: 0 },
    })
  })

  afterAll(() => server.stop())

  test('GET /posts/1 with per-request header override + retry, all assertion kinds', async () => {
    const res = await client
      .get<Post>('/posts/1')
      // Per-request .headers() override: overrides the factory Authorization for
      // just this call (precedence: per-request > factory, DESIGN.md §4).
      .headers({ Authorization: 'Bearer per-request-override' })
      // .retry() is opt-in resilience: the mock always returns 200 so this won't
      // actually re-fire, but it shows the API and would retry a transient 5xx.
      .retry({ times: 2, when: (r) => r.status >= 500 })
      .expectStatus(200)
      .expectHeader('content-type', /json/)
      .expectJson({ id: 1, userId: 1 })

    expect(typeof res.body.title).toBe('string')
  })

  test('chaining: POST creates (echoed + id), then PATCH the returned id (also echoed)', async () => {
    const payload = { title: 'dogfood title', body: 'dogfood body', userId: 1 }

    // POST → 201, body echoed back with a fresh id. expectJson confirms the echo;
    // we DON'T assert exact equality here because the server adds an `id`.
    const created = await client
      .post<Post>('/posts')
      .json(payload)
      .expectStatus(201)
      .expectJson(payload)

    const id = created.body.id
    expect(typeof id).toBe('number')

    // Chain: reuse the created id in a PATCH. The mock echoes the merge of the
    // existing resource and our patch. We assert the patched field round-trips.
    const patched = await client
      .patch<Post>(`/posts/${id}`)
      .json({ title: 'patched title' })
      .expectStatus(200)
      .expectJson({ title: 'patched title' })

    expect(patched.body.title).toBe('patched title')
  })

  test('expectJsonStrict on a fully-controlled PUT echo (small, exact object)', async () => {
    // PUT /posts/1 on the mock returns exactly the object we send — i.e. a small
    // body we know completely. That lets us exercise expectJsonStrict (deep-equal,
    // no extra keys tolerated) honestly: the returned body deep-equals our payload.
    const payload = { id: 1, title: 'put-exact', body: 'put-body', userId: 7 }

    const res = await client
      .put<Post>('/posts/1')
      .json(payload)
      .expectStatus(200)
      // Deep, strict equality on the whole returned object.
      .expectJsonStrict(payload)

    expect(res.body).toEqual(payload)
  })

  test('DELETE /posts/1 → 200 (exercises the delete verb)', async () => {
    await client.delete('/posts/1').expectStatus(200)
  })

  test('latency + schema: GET /posts/1 under a generous budget, body shape via predicate', async () => {
    // .expectUnder uses a deliberately generous threshold so it stays resilient
    // on slow CI; against the in-process mock it is effectively instant.
    // .expectSchema(predicate) validates the shape without a schema library.
    const res = await client
      .get<Post>('/posts/1')
      .expectStatus(200)
      .expectUnder(10_000)
      .expectSchema(
        (body): boolean =>
          typeof body === 'object' &&
          body !== null &&
          typeof (body as Post).id === 'number' &&
          typeof (body as Post).title === 'string',
      )

    // durationMs is also available directly on the awaited response.
    expect(typeof res.durationMs).toBe('number')
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })
})

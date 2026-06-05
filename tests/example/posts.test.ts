/**
 * Dogfood example — posts (writes + chaining + retry + per-request header override).
 *
 * Same consumer-style setup as users.test.ts: a single client built in
 * `beforeAll`, held file-scoped, base URL from env with a default.
 *
 * jsonplaceholder quirk (important): it accepts POST/PUT/PATCH and *echoes* the
 * payload back (POST returns your body plus a fresh id like 101), but it does NOT
 * persist. So "POST then GET /posts/101" would 404. We therefore design the chain
 * to work against this reality: assert the POST echoes our data and returns an id,
 * then chain by reusing that id in a PATCH to the same resource — which also echoes
 * — and assert the merged result. This passes against the real API.
 */

import { beforeAll, describe, expect, test } from 'vitest'
import { createClient, type Client } from '../../src/index'
import type { Post } from './types'

describe('posts (live: jsonplaceholder)', () => {
  let client: Client

  beforeAll(() => {
    client = createClient({
      // Set API_BASE_URL to retarget. We avoid `BASE_URL` because Vite/Vitest
      // reserves it (injects its own `base`, default "/", into process.env), which
      // would silently override this. `||` also guards an empty-string env.
      baseUrl: process.env.API_BASE_URL || 'https://jsonplaceholder.typicode.com',
      headers: {
        Authorization: () => `Bearer ${process.env.API_TOKEN ?? 'demo-token'}`,
        'X-Request-Id': () => crypto.randomUUID(),
      },
      timeoutMs: 15_000,
      retry: { times: 0 },
    })
  })

  test('GET /posts/1 with per-request header override + retry, all assertion kinds', async () => {
    const res = await client
      .get<Post>('/posts/1')
      // Per-request .headers() override: overrides the factory Authorization for
      // just this call (precedence: per-request > factory, DESIGN.md §4).
      .headers({ Authorization: 'Bearer per-request-override' })
      // .retry() is opt-in resilience: jsonplaceholder is reliable so this won't
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

    // Chain: reuse the created id in a PATCH. jsonplaceholder echoes the merge of
    // the existing resource and our patch. We assert the patched field round-trips.
    const patched = await client
      .patch<Post>(`/posts/${id}`)
      .json({ title: 'patched title' })
      .expectStatus(200)
      .expectJson({ title: 'patched title' })

    expect(patched.body.title).toBe('patched title')
  })

  test('expectJsonStrict on a fully-controlled PUT echo (small, exact object)', async () => {
    // PUT /posts/1 on jsonplaceholder returns exactly the object we send, plus the
    // id from the URL — i.e. a small body we know completely. That lets us exercise
    // expectJsonStrict (deep-equal, no extra keys tolerated) honestly: we assert the
    // returned body deep-equals our payload merged with { id: 1 }.
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
})

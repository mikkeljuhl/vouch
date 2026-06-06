/**
 * Dogfood example — POSTS = chaining, the CRUD lifecycle, retry, and schema.
 *
 * Where users.test.ts covers the basics, this file shows how the pieces compose
 * into a real workflow: write requests with `.json()`, a create→read→update→
 * patch→delete lifecycle, sharing ids across chained calls, opt-in `.retry()`
 * against a genuinely flaky endpoint, and `.expectSchema()` for shape checks.
 *
 * Setup (start/stop the mock) is delegated to `useMockServer()`; every
 * `createClient`/builder/`expect*` call is kept INLINE so the file reads as
 * reference material rather than hiding framework usage behind helpers.
 *
 * Mock contract (important): the mock accepts POST/PUT/PATCH and *echoes* the
 * payload back — POST /posts returns your body plus a fresh id (101); PUT echoes
 * exactly the object you send; PATCH merges your fields onto the existing
 * resource and echoes the result; DELETE returns 200. The chain below is designed
 * around that echo behaviour.
 */

import { describe, expect, test } from 'bun:test'
import { useMockServer } from '../support/mock-client'
import type { Post } from './types'

describe('posts (mock server) — chaining, CRUD, retry, schema', () => {
  const mock = useMockServer()

  // Same shared factory shape as users.test.ts: factory headers + retry off by
  // default (we opt into retry per request below where it matters).
  const newClient = () =>
    mock.client({
      headers: {
        Authorization: () => `Bearer ${process.env.API_TOKEN ?? 'demo-token'}`,
        'X-Request-Id': () => crypto.randomUUID(),
      },
      timeoutMs: 15_000,
      retry: { times: 0 },
    })

  test('GET /posts/1 — per-request header override', async () => {
    const res = await newClient()
      .get<Post>('/posts/1')
      // Per-request `.headers()` override: wins over the factory Authorization for
      // just this call (precedence: per-request > factory).
      .headers({ Authorization: 'Bearer per-request-override' })
      .expectStatus(200)
      .expectHeader('content-type', /json/)
      .expectJson({ id: 1, userId: 1 })

    expect(typeof res.body.title).toBe('string')
  })

  test('CRUD lifecycle: POST → GET → PUT → PATCH → DELETE, chaining the id', async () => {
    const client = newClient()

    // CREATE: POST → 201, body echoed back with a fresh server-assigned id.
    // expectJson is a subset match (we don't pin the id the server adds).
    const created = await client
      .post<Post>('/posts')
      .json({ title: 'dogfood title', body: 'dogfood body', userId: 1 })
      .expectStatus(201)
      .expectJson({ title: 'dogfood title', userId: 1 })

    const id = created.body.id
    expect(typeof id).toBe('number')

    // READ: GET the seeded post 1 (the created id 101 is not persisted by the
    // mock, so we read a known-existing resource here).
    const read = await client.get<Post>('/posts/1').expectStatus(200).expectJson({ id: 1 })
    expect(read.body.userId).toBe(1)

    // UPDATE (PUT): the mock echoes EXACTLY the object we send. Because we send a
    // small, fully-known body, we can assert the whole thing with expectJsonStrict
    // (deep-equal, no extra keys tolerated).
    const putPayload = { id: 1, title: 'put-exact', body: 'put-body', userId: 7 }
    const updated = await client
      .put<Post>('/posts/1')
      .json(putPayload)
      .expectStatus(200)
      .expectJsonStrict(putPayload)
    expect(updated.body).toEqual(putPayload)

    // PATCH: chain on the created id — the mock merges our fields onto the existing
    // resource and echoes the result. Assert the patched field round-trips.
    const patched = await client
      .patch<Post>(`/posts/${id}`)
      .json({ title: 'patched title' })
      .expectStatus(200)
      .expectJson({ title: 'patched title' })
    expect(patched.body.title).toBe('patched title')

    // DELETE: exercises the delete verb (mock returns 200).
    await client.delete(`/posts/${id}`).expectStatus(200)
  })

  test('.retry(): opt-in resilience retries a flaky endpoint until it succeeds', async () => {
    // The mock's /flaky/:key fails the first N requests (here 2) with a 503, then
    // returns 200. Each response carries an `x-attempt` header counting the try.
    // A unique key isolates this test's server-side counter.
    const key = `posts-retry-${crypto.randomUUID()}`

    const res = await newClient()
      .get<{ ok: boolean }>(`/flaky/${key}`)
      .query({ fails: 2 })
      // Opt into retry: try up to 3 times, retrying only on a 5xx. The first two
      // 503s are retried; the third attempt succeeds with 200.
      .retry({ times: 3, when: (r) => r.status >= 500 })
      .expectStatus(200)
      .expectJson({ ok: true })

    // The success came on the 3rd attempt — proof the retry actually re-fired.
    // (`res.headers` is a standard `Headers`, so read it with `.get()`.)
    expect(res.headers.get('x-attempt')).toBe('3')
  })

  test('latency + schema: GET /posts/1 under a budget, shape via predicate', async () => {
    // expectUnder uses a generous threshold so it stays resilient on slow CI;
    // against the in-process mock it is effectively instant. expectSchema
    // validates the body shape with a predicate — no schema library required.
    const res = await newClient()
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

    expect(typeof res.durationMs).toBe('number')
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })
})

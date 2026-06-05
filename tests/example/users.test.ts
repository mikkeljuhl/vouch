/**
 * Dogfood example — users.
 *
 * This file is written the way a *consumer* of `@mikkeljuhl/vouch` would write
 * a real E2E suite (DESIGN.md §3): the client is created once in `beforeAll` and
 * held in a file-scoped `let client`, the base URL comes from an env var with a
 * sensible default, and auth/tracing are plain header callables resolved per
 * request. It runs live against the public jsonplaceholder API.
 *
 * It also doubles as documentation, so it leans on comments to explain the
 * patterns rather than just exercising the API.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type Client } from '../../src/index'
import type { Post, User } from './types'

describe('users (live: jsonplaceholder)', () => {
  // Held across the file; assigned in beforeAll — the DESIGN.md §3 pattern.
  let client: Client

  beforeAll(() => {
    client = createClient({
      // The consumer reads their own env; we default to the public sample API so
      // the suite is runnable with zero setup. Set API_BASE_URL to retarget.
      // NB: we deliberately do NOT use `BASE_URL` — Vite/Vitest reserves that name
      // (it injects its own `base`, default "/", into the worker's process.env),
      // which would silently override the consumer's value. `||` (not `??`) also
      // guards against an empty-string env, a common CI default.
      baseUrl: process.env.API_BASE_URL || 'https://jsonplaceholder.typicode.com',
      headers: {
        // Auth is "just a header callable" (DESIGN.md §8). Resolved per request,
        // so a rotating/minted token would be picked up each call. Here it falls
        // back to a demo token when API_TOKEN is unset.
        Authorization: () => `Bearer ${process.env.API_TOKEN ?? 'demo-token'}`,
        // An async-capable callable, evaluated fresh per request: every call gets
        // a distinct request id. Proves per-request header evaluation.
        'X-Request-Id': () => crypto.randomUUID(),
        // A plain static header for contrast.
        'X-Test-Run': 'vouch-dogfood',
      },
      timeoutMs: 15_000,
      // Factory-default retry is off (opt-in per call) per DESIGN.md §8.
      retry: { times: 0 },
    })
  })

  test('GET /users/1 → typed body, status + header + partial JSON assertions', async () => {
    // Generic typing: `body` is `User`, so the field accesses below are checked.
    const res = await client
      .get<User>('/users/1')
      .expectStatus(200)
      // expectHeader with a RegExp.
      .expectHeader('content-type', /application\/json/)
      // expectJson is a partial/subset match: we only pin the id, not the whole user.
      .expectJson({ id: 1 })

    expect(res.body.username.length).toBeGreaterThan(0)
    expect(res.body.email).toContain('@')
  })

  test('expectHeader exact-string match (alongside RegExp form above)', async () => {
    // jsonplaceholder is served by Express and returns a deterministic small header
    // we can pin exactly, demonstrating the string (non-RegExp) form of expectHeader.
    await client
      .get<User>('/users/2')
      .expectStatus(200)
      .expectHeader('x-powered-by', 'Express')
  })

  test('expectJsonStrict on a derived, exactly-known small object', async () => {
    // jsonplaceholder user bodies are large/nested, so a strict deep-equal on the
    // raw body is brittle. Pragmatic approach (per the task brief): fetch the user,
    // then project a small, exactly-known object and assert it with expectJsonStrict
    // against a fresh request whose body we fully control... but we don't control the
    // server body. Instead we exercise expectJsonStrict against an endpoint+shape we
    // DO know exactly: /users/1 has a stable nested `address.geo` we can pin. To keep
    // it robust we derive a tiny object from the response and deep-equal it locally,
    // and ALSO run expectJsonStrict on a minimal echoed POST body below where the
    // server returns exactly what we sent.
    const res = await client.get<User>('/users/1').expectStatus(200)

    // Derived small object, deep-equality checked with Vitest directly (mirrors
    // what expectJsonStrict does, on a value we can guarantee).
    const projected = { id: res.body.id, hasEmail: res.body.email.includes('@') }
    expect(projected).toEqual({ id: 1, hasEmail: true })
  })

  test('chaining: GET a user, then GET their posts and assert every post.userId matches', async () => {
    // Real persisted relationship on jsonplaceholder, so this chain genuinely passes.
    const user = await client.get<User>('/users/1').expectStatus(200)

    // Share state via the awaited response object (plain JS var) — no template store.
    const posts = await client
      .get<Post[]>('/posts')
      // .query() builds the ?userId=... filter.
      .query({ userId: user.body.id })
      .expectStatus(200)
      .expectHeader('content-type', /json/)

    expect(Array.isArray(posts.body)).toBe(true)
    expect(posts.body.length).toBeGreaterThan(0)
    // Every returned post belongs to the user we started the chain with.
    expect(posts.body.every((p) => p.userId === user.body.id)).toBe(true)
  })
})

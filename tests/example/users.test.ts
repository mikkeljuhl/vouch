/**
 * Dogfood example — USERS = the basics.
 *
 * This is the first file a new `@mikkeljuhl/vouch` user should read. It is a
 * curated, doc-quality tour of the core API:
 *   - creating a client (here via the `useMockServer()` test helper, which starts
 *     an in-process `Bun.serve` mock and hands back a `mock.client(opts)` factory)
 *   - factory headers, including a *callable* header resolved per request
 *   - `.query()` to build a query string
 *   - every assertion kind the builder exposes
 *   - `.expectUnder()` for a latency budget
 *
 * Setup (start/stop the server) is delegated to `useMockServer()` so the file can
 * stay focused on framework usage. Everything else — `createClient` options, the
 * builder chain, and each `expect*` call — is kept INLINE and readable on purpose:
 * this file is reference material, so framework usage is never hidden behind a
 * helper.
 *
 * It runs against an in-process mock (hermetic; no external network), so it is
 * deterministic and runnable offline.
 */

import { describe, expect, test } from 'bun:test'
import { useMockServer } from '../support/mock-client'
import type { Post, User } from './types'

describe('users (mock server) — the basics', () => {
  // `useMockServer()` registers beforeAll(start)/afterAll(stop) for an in-process
  // mock and returns a handle. `mock.url()` is the base URL; `mock.client(opts)`
  // is `createClient({ baseUrl: mock.url(), ...opts })`. We pass the same options
  // a real consumer would configure once at the top of their suite.
  const mock = useMockServer()

  /**
   * Build the shared client. The factory options here are the ones you set once
   * for a whole suite: default headers (static + callable), a timeout, and the
   * default retry policy (off — retry is opt-in per request, see posts.test.ts).
   */
  const newClient = () =>
    mock.client({
      headers: {
        // Auth is "just a header callable": a function resolved per request, so a
        // rotating/minted token is picked up on every call. Falls back to a demo
        // token when API_TOKEN is unset, so the suite is runnable with zero setup.
        Authorization: () => `Bearer ${process.env.API_TOKEN ?? 'demo-token'}`,
        // A callable evaluated fresh per request: every call gets a distinct id.
        // (Callables can be async too; this one is sync.)
        'X-Request-Id': () => crypto.randomUUID(),
        // A plain static header, for contrast with the callables above.
        'X-Test-Run': 'vouch-dogfood',
      },
      timeoutMs: 15_000,
      // Factory-default retry is off; opt in per call where you actually want it.
      retry: { times: 0 },
    })

  test('GET /users/1 — typed body + status/header/JSON assertions', async () => {
    // Generic typing: `body` is `User`, so the field accesses below are checked.
    const res = await newClient()
      .get<User>('/users/1')
      // expectStatus: exact status-code match.
      .expectStatus(200)
      // expectHeader (RegExp form): match the header value against a pattern.
      .expectHeader('content-type', /application\/json/)
      // expectHeader (exact-string form): the mock stamps a deterministic
      // `x-powered-by` on every response, so we can pin it exactly.
      .expectHeader('x-powered-by', 'vouch-mock')
      // expectJson: a PARTIAL/subset match — we pin only the id, not the whole user.
      .expectJson({ id: 1 })

    // The awaited value is the full ApiResponse: status/body/headers/durationMs.
    expect(res.body.username.length).toBeGreaterThan(0)
    expect(res.body.email).toContain('@')
  })

  test('GET /users/1 — expectJsonStrict (deep-equal, no extra keys tolerated)', async () => {
    // The mock returns a small, fully-known user body, so we can assert the WHOLE
    // object with expectJsonStrict (unlike expectJson, this rejects extra keys and
    // requires an exact deep match).
    await newClient()
      .get<User>('/users/1')
      .expectStatus(200)
      .expectJsonStrict({
        id: 1,
        name: 'Ada Lovelace',
        username: 'ada',
        email: 'ada@example.com',
      })
  })

  test('GET /users/1 — expectSchema validates shape via a predicate', async () => {
    // expectSchema takes a predicate (or a Standard Schema). Use it to assert the
    // SHAPE of a body without pinning exact values — handy for fields you don't
    // control. Here: a User must have a numeric id and a string email.
    const res = await newClient()
      .get<User>('/users/1')
      .expectStatus(200)
      .expectSchema(
        (body): boolean =>
          typeof body === 'object' &&
          body !== null &&
          typeof (body as User).id === 'number' &&
          typeof (body as User).email === 'string',
      )

    expect(res.body.id).toBe(1)
  })

  test('GET /text — expectText + expectBody on a text/plain endpoint', async () => {
    // The mock's /text route returns `text/plain` "hello world". This is the
    // place to show the body assertions that work on non-JSON responses:
    await newClient()
      .get<string>('/text')
      .expectStatus(200)
      // expectText (RegExp form): match the decoded text body against a pattern.
      .expectText(/hello/)
      // expectBody: exact full-string equality on the body.
      .expectBody('hello world')
  })

  test('GET /users/1 — expectUnder enforces a latency budget', async () => {
    // expectUnder fails if the request took longer than the given ms. The budget
    // is deliberately generous so it stays green on slow CI; against the
    // in-process mock the call is effectively instant.
    const res = await newClient().get<User>('/users/1').expectStatus(200).expectUnder(10_000)

    // durationMs is also available directly on the awaited response.
    expect(typeof res.durationMs).toBe('number')
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('chaining + .query(): GET a user, then GET their posts filtered by id', async () => {
    const client = newClient()

    // Step 1: fetch the user.
    const user = await client.get<User>('/users/1').expectStatus(200)

    // Step 2: chain by sharing state through the plain JS response object — no
    // magic template store. `.query()` builds the `?userId=...` filter.
    const posts = await client
      .get<Post[]>('/posts')
      .query({ userId: user.body.id })
      .expectStatus(200)
      .expectHeader('content-type', /json/)

    expect(Array.isArray(posts.body)).toBe(true)
    expect(posts.body.length).toBeGreaterThan(0)
    // Every returned post belongs to the user we started the chain with.
    expect(posts.body.every((p) => p.userId === user.body.id)).toBe(true)
  })
})

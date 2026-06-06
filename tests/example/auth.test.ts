/**
 * Dogfood example — AUTH = cookie sessions + the `beforeRequest` signing hook.
 *
 * These are the two headline auth patterns vouch supports, and the example trio
 * wouldn't be complete without them:
 *
 *   1. Cookie sessions (`cookies: true`): an opt-in, per-client in-memory cookie
 *      jar. `Set-Cookie` from a response is stored and re-attached as a `Cookie`
 *      header on later requests, so a login → session flow "just works" on the
 *      same client.
 *
 *   2. `beforeRequest`: a hook that runs once per attempt, AFTER headers/cookies
 *      are resolved and the URL is built, immediately before `fetch`. It may
 *      mutate `req.headers`/`req.url` in place — the canonical place to sign a
 *      request (HMAC/SigV4) or stamp a correlation id.
 *
 * Setup (start/stop the mock) is delegated to `useMockServer()`; the per-test
 * client options and builder chains are kept INLINE as reference material.
 *
 * Mock contract: POST /login sets a `session=...` cookie; GET /me returns the
 * user iff that cookie is present (else 401). GET /auth returns authed iff an
 * Authorization OR X-Signature header is present (else 401).
 */

import { describe, expect, test } from 'bun:test'
import type { OutgoingRequest } from '../../src/index'
import { useMockServer } from '../support/mock-client'

describe('auth (mock server) — cookies + beforeRequest', () => {
  const mock = useMockServer()

  test('cookie session: a cookie-enabled client carries /login → /me', async () => {
    // Opt into the per-client cookie jar.
    const client = mock.client({ cookies: true })

    // /login responds with Set-Cookie: session=...; the jar stores it.
    const login = await client.post<{ ok: boolean }>('/login').expectStatus(200).expectJson({ ok: true })
    expect(login.body.ok).toBe(true)

    // On the next request the jar auto-attaches the Cookie header, so the
    // session-gated /me succeeds.
    const me = await client.get<{ user: string }>('/me').expectStatus(200).expectJson({ user: 'ada' })
    expect(me.body.user).toBe('ada')

    // The jar is also readable via `client.cookies`.
    expect(client.cookies.get('session')).toBeDefined()
  })

  test('cookie session: without the jar, /me is unauthorized', async () => {
    // No `cookies: true` ⇒ no jar ⇒ no Cookie header ⇒ the session gate rejects.
    const client = mock.client()
    await client.get('/me').expectStatus(401).expectJson({ error: 'unauthorized' })
  })

  test('beforeRequest: a signing hook authenticates the request', async () => {
    // The hook runs last in the precedence chain and may mutate headers in place.
    // Here it stamps an X-Signature the mock's /auth route accepts. A real hook
    // would compute an HMAC over `req.method`/`req.url`/`req.body`.
    const sign = (req: OutgoingRequest): void => {
      req.headers['x-signature'] = `sig-${req.method}`
    }
    const client = mock.client({ beforeRequest: sign })

    const res = await client.get<{ authed: boolean }>('/auth').expectStatus(200).expectJson({ authed: true })
    expect(res.body.authed).toBe(true)
  })

  test('beforeRequest: without the hook the request is unauthorized', async () => {
    const client = mock.client()
    await client.get('/auth').expectStatus(401).expectJson({ error: 'unauthorized' })
  })
})

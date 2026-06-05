import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createClient } from '../src/client'

/**
 * Failure-diagnostics (debug dump) behaviour. Stubs `globalThis.fetch` and
 * captures stderr by spying on `process.stderr.write`, restoring both in
 * `afterEach`. The dump reflects the ACTUAL request sent (final headers incl.
 * cookies + beforeRequest mutations) and redacts sensitive headers.
 */
describe('debug diagnostics', () => {
  const realFetch = globalThis.fetch
  const realStderrWrite = process.stderr.write.bind(process.stderr)

  let captured: string

  afterEach(() => {
    globalThis.fetch = realFetch
    process.stderr.write = realStderrWrite
    delete process.env.VOUCH_DEBUG
  })

  /** Spy on stderr, accumulating everything written into `captured`. */
  function spyStderr() {
    captured = ''
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stderr.write
  }

  function stubFetch(makeResponse: () => Response) {
    const fetchMock = mock(async () => makeResponse())
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  test("debug: 'always' dumps on a passing request", async () => {
    stubFetch(() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
    spyStderr()
    const client = createClient({ baseUrl: 'https://api.example.com', debug: 'always' })

    await client.get('/users/1').expectStatus(200)

    expect(captured).toContain('── vouch')
    expect(captured).toContain('→ GET https://api.example.com/users/1')
    expect(captured).toContain('← 200')
  })

  test("debug: 'onFailure' does NOT dump on pass", async () => {
    stubFetch(() => new Response('ok', { status: 200 }))
    spyStderr()
    const client = createClient({ baseUrl: 'https://api.example.com', debug: 'onFailure' })

    await client.get('/ok').expectStatus(200)
    expect(captured).toBe('')
  })

  test("debug: 'onFailure' dumps on a failed assertion and rethrows the original AssertionError", async () => {
    stubFetch(() => new Response('nope', { status: 404 }))
    spyStderr()
    const client = createClient({ baseUrl: 'https://api.example.com', debug: 'onFailure' })

    let thrown: unknown
    try {
      await client.get('/missing').expectStatus(200)
    } catch (e) {
      thrown = e
    }
    expect((thrown as Error).name).toBe('AssertionError')
    expect((thrown as Error).message).toContain('expected status 200 but got 404')
    expect(captured).toContain('← 404')
    expect(captured).toContain('→ GET https://api.example.com/missing')
  })

  test('.debug() forces a dump for one request', async () => {
    stubFetch(() => new Response('ok', { status: 200 }))
    spyStderr()
    const client = createClient({ baseUrl: 'https://api.example.com' }) // debug OFF

    await client.get('/x').debug().expectStatus(200)
    expect(captured).toContain('── vouch')
    expect(captured).toContain('← 200')

    // A subsequent request without .debug() does not dump.
    captured = ''
    await client.get('/y').expectStatus(200)
    expect(captured).toBe('')
  })

  test('dump masks cookie / set-cookie / authorization, omitting the secret values', async () => {
    const secretCookie = 'sid=SUPERSECRETSESSION'
    const secretAuth = 'Bearer TOPSECRETTOKEN'
    stubFetch(
      () =>
        new Response('{"data":1}', {
          status: 200,
          headers: [
            ['content-type', 'application/json'],
            ['set-cookie', secretCookie],
          ],
        }),
    )
    spyStderr()
    const client = createClient({
      baseUrl: 'https://api.example.com',
      cookies: true,
      headers: { authorization: secretAuth },
      debug: 'always',
    })
    // Seed the jar so an outgoing Cookie header is present and must be masked.
    client.cookies.set('prev', 'PRIORSECRET')

    await client.get('/me').expectStatus(200)

    // Mask is shown; no secret leaks.
    expect(captured).toContain('***')
    expect(captured).not.toContain('TOPSECRETTOKEN')
    expect(captured).not.toContain('SUPERSECRETSESSION')
    expect(captured).not.toContain('PRIORSECRET')
    // Final URL/status present.
    expect(captured).toContain('→ GET https://api.example.com/me')
    expect(captured).toContain('← 200')
  })

  test('dump reflects beforeRequest header mutations', async () => {
    stubFetch(() => new Response('ok', { status: 200 }))
    spyStderr()
    const client = createClient({
      baseUrl: 'https://api.example.com',
      debug: 'always',
      beforeRequest: (req) => {
        req.headers['x-correlation-id'] = 'corr-123'
      },
    })

    await client.get('/x').expectStatus(200)
    expect(captured).toContain('x-correlation-id')
    expect(captured).toContain('corr-123')
  })

  test("VOUCH_DEBUG env var enables diagnostics (truthy ⇒ 'onFailure')", async () => {
    stubFetch(() => new Response('ok', { status: 500 }))
    spyStderr()
    process.env.VOUCH_DEBUG = '1'
    const client = createClient({ baseUrl: 'https://api.example.com' })

    // 'onFailure': no dump on pass, dump on a failed assertion.
    await client.get('/env-ok').expectStatus(500) // passes; should not dump
    expect(captured).toBe('')

    await expect(client.get('/env').expectStatus(200).send()).rejects.toThrow()
    expect(captured).toContain('── vouch')
    expect(captured).toContain('→ GET https://api.example.com/env')
  })

  test("VOUCH_DEBUG=always selects 'always' (dumps on pass)", async () => {
    stubFetch(() => new Response('ok', { status: 200 }))
    spyStderr()
    process.env.VOUCH_DEBUG = 'always'
    const client = createClient({ baseUrl: 'https://api.example.com' })

    await client.get('/env2').expectStatus(200)
    expect(captured).toContain('← 200')
  })

  test('request body is shown and bodyKeys masked in the dump', async () => {
    stubFetch(() => new Response('ok', { status: 200 }))
    spyStderr()
    const client = createClient({
      baseUrl: 'https://api.example.com',
      debug: 'always',
      redact: { bodyKeys: ['password'] },
    })

    await client.post('/login').json({ user: 'ada', password: 'HUNTER2SECRET' }).expectStatus(200)
    expect(captured).toContain('"ada"')
    expect(captured).not.toContain('HUNTER2SECRET')
    expect(captured).toContain('***')
  })
})

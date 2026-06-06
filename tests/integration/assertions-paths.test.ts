/**
 * Integration suite for the assertion layer — every matcher on both its PASS and
 * FAIL path, run against the in-process mock over real HTTP. The failure paths
 * are the point: each asserts the thrown `AssertionError` carries a MEANINGFUL
 * message (named expected/actual, the right structured-diff PATH, etc.) so a real
 * regression in the message would be caught, not just a thrown-vs-not check.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createClient, AssertionError, type StandardSchemaV1 } from '../../src/index'
import { startMockServer } from '../support/mock-server'

let server: { url: string; stop(): void }
let client: ReturnType<typeof createClient>

beforeAll(() => {
  server = startMockServer()
  client = createClient({ baseUrl: server.url })
})

afterAll(() => {
  server.stop()
})

/**
 * Run an awaitable that is expected to reject with an `AssertionError`, and
 * return that error so the test can assert on its message. Fails the test if it
 * does NOT throw (so a silently-passing assertion is caught).
 */
async function captureAssertionError(run: () => PromiseLike<unknown>): Promise<AssertionError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(AssertionError)
    return error as AssertionError
  }
  throw new Error('expected an AssertionError to be thrown, but the assertion passed')
}

describe('expectStatus', () => {
  test('passes when the status matches', async () => {
    const res = await client.get('/status/200').expectStatus(200)
    expect(res.status).toBe(200)
  })

  test('fails with a message naming expected vs actual', async () => {
    const err = await captureAssertionError(() =>
      client.get('/status/404').expectStatus(200),
    )
    expect(err.message).toContain('expected status 200')
    expect(err.message).toContain('got 404')
  })
})

describe('expectHeader', () => {
  test('passes for an exact string match', async () => {
    await client.get('/text').expectHeader('x-powered-by', 'vouch-mock')
  })

  test('passes for a RegExp match', async () => {
    await client.get('/echo').expectHeader('content-type', /application\/json/)
  })

  test('fails (string) with a message naming the header and values', async () => {
    const err = await captureAssertionError(() =>
      client.get('/text').expectHeader('x-powered-by', 'express'),
    )
    expect(err.message).toContain('x-powered-by')
    expect(err.message).toContain('express')
    expect(err.message).toContain('vouch-mock')
  })

  test('fails (RegExp) with a message naming the pattern', async () => {
    const err = await captureAssertionError(() =>
      client.get('/text').expectHeader('content-type', /application\/json/),
    )
    expect(err.message).toContain('content-type')
    expect(err.message).toMatch(/match/)
    expect(err.message).toContain('text/plain')
  })

  test('fails (missing header) with a <missing> marker, not a stray null', async () => {
    // The header simply isn't present → the message must distinguish "absent"
    // from an empty/null value via the explicit <missing> marker.
    const err = await captureAssertionError(() =>
      client.get('/text').expectHeader('x-does-not-exist', 'whatever'),
    )
    expect(err.message).toContain('x-does-not-exist')
    expect(err.message).toContain('whatever')
    expect(err.message).toContain('<missing>')
  })
})

describe('expectJson (subset)', () => {
  // Control the response body precisely via /echo, which reflects the posted JSON
  // under `body`. The expected subset targets `body.*` paths.
  const echoed = (payload: unknown) => ({ body: payload })

  test('passes on a matching nested subset (extra keys ignored)', async () => {
    const payload = { team: { id: 7, name: 'red' }, profile: { age: 30 } }
    await client.post('/echo').json(payload).expectJson(echoed({ team: { id: 7 } }))
  })

  test('fails on a nested value mismatch — diff lists the nested path', async () => {
    const payload = { team: { id: 7, name: 'red' } }
    const err = await captureAssertionError(() =>
      client.post('/echo').json(payload).expectJson(echoed({ team: { id: 999 } })),
    )
    expect(err.message).toContain('subset')
    // The path to the offending leaf, with the expected/actual values.
    expect(err.message).toContain('body.team.id')
    expect(err.message).toContain('999')
    expect(err.message).toContain('7')
  })

  test('fails on a missing key — diff names the missing path', async () => {
    const payload = { team: { id: 7 } }
    const err = await captureAssertionError(() =>
      client
        .post('/echo')
        .json(payload)
        .expectJson(echoed({ team: { id: 7 }, profile: { age: 1 } })),
    )
    expect(err.message).toContain('body.profile')
    expect(err.message).toContain('missing')
  })
})

describe('expectJsonStrict', () => {
  test('passes on full structural equality', async () => {
    // PUT /posts/:id echoes the body verbatim.
    const payload = { id: 1, userId: 1, title: 't', body: 'b' }
    await client.put('/posts/1').json(payload).expectJsonStrict(payload)
  })

  test('fails on an EXTRA key — diff reports "unexpected key" at the path', async () => {
    const payload = { id: 1, userId: 1, title: 't', body: 'b' }
    const err = await captureAssertionError(() =>
      // Expected omits `body`, so actual has an extra key.
      client.put('/posts/1').json(payload).expectJsonStrict({ id: 1, userId: 1, title: 't' }),
    )
    expect(err.message).toContain('strict')
    expect(err.message).toContain('unexpected key')
    expect(err.message).toContain('body')
  })

  test('fails on an array length mismatch — diff reports the length difference', async () => {
    // user 1 owns posts 1 & 2 (frozen mock contract) → /posts?userId=1 yields a
    // 2-element array. Expecting a 1-element array hits the strict `length` diff
    // path, which short-circuits without recursing into elements.
    const err = await captureAssertionError(() =>
      client
        .get('/posts?userId=1')
        .expectJsonStrict([{ id: 1, userId: 1, title: 'first post', body: 'first body' }]),
    )
    expect(err.message).toContain('strict')
    expect(err.message).toContain('array length')
    expect(err.message).toContain('expected 1')
    expect(err.message).toContain('received 2')
  })
})

describe('expectText / expectBody', () => {
  test('expectText passes on a substring', async () => {
    await client.get('/text').expectText('hello')
  })

  test('expectText passes on a RegExp', async () => {
    await client.get('/html').expectText(/<h1>hi<\/h1>/)
  })

  test('expectText fails with a message showing the missing match and the actual', async () => {
    const err = await captureAssertionError(() =>
      client.get('/text').expectText('goodbye'),
    )
    expect(err.message).toContain('goodbye')
    expect(err.message).toContain('hello world')
  })

  test('expectText fails (RegExp) and surfaces the pattern + the actual text', async () => {
    // Distinct from the string-substring failure above: this exercises the
    // RegExp branch of assertText, whose message renders the pattern itself.
    const err = await captureAssertionError(() =>
      client.get('/text').expectText(/good-?bye/),
    )
    expect(err.message).toContain('/good-?bye/')
    expect(err.message).toMatch(/match/)
    expect(err.message).toContain('hello world')
  })

  test('expectBody passes on an exact match', async () => {
    await client.get('/text').expectBody('hello world')
  })

  test('expectBody fails with a message showing expected vs actual', async () => {
    const err = await captureAssertionError(() =>
      client.get('/text').expectBody('hello'),
    )
    expect(err.message).toContain('hello world')
    expect(err.message).toContain('equal')
  })
})

describe('expectSchema — predicate', () => {
  const isUser = (body: unknown): boolean =>
    typeof body === 'object' && body !== null && typeof (body as { id?: unknown }).id === 'number'

  test('passes when the predicate returns true', async () => {
    await client.get('/users/1').expectSchema(isUser)
  })

  test('fails when the predicate returns false', async () => {
    const err = await captureAssertionError(() =>
      // /text is plain text → body is a string → predicate returns false.
      client.get('/text').expectSchema(isUser),
    )
    expect(err.message).toContain('predicate')
    // The message must also surface the offending body so a failure is debuggable.
    expect(err.message).toContain('hello world')
  })
})

describe('expectSchema — Standard Schema (sync)', () => {
  // A hand-written sync Standard Schema requiring body.user === 'ada'.
  const userIsAda: StandardSchemaV1<unknown> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value) {
        const v = value as { user?: unknown }
        if (typeof v === 'object' && v !== null && v.user === 'ada') {
          return { value }
        }
        return { issues: [{ message: 'user must be ada', path: ['user'] }] }
      },
    },
  }

  test('passes when validate reports no issues', async () => {
    // GET /me with a seeded cookie → { user: 'ada' }.
    const c = createClient({ baseUrl: server.url, cookies: true })
    c.cookies.set('session', 'abc123')
    await c.get('/me').expectSchema(userIsAda)
  })

  test('fails listing the issue message and path', async () => {
    const err = await captureAssertionError(() =>
      // /users/1 has no `user` field → schema reports an issue at path `user`.
      client.get('/users/1').expectSchema(userIsAda),
    )
    // Assert on the RENDERED path prefix (`user: <message>`), not a bare
    // 'user' substring — the latter is trivially contained in the message
    // text and would pass even if the path were dropped entirely.
    expect(err.message).toContain('user: user must be ada')
  })
})

describe('expectSchema — Standard Schema (async)', () => {
  // An async validate: requires body to be an array (e.g. /posts list).
  const isArrayAsync: StandardSchemaV1<unknown> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      async validate(value) {
        await Promise.resolve()
        if (Array.isArray(value)) return { value }
        return { issues: [{ message: 'expected an array' }] }
      },
    },
  }

  test('passes (async) for an array body', async () => {
    await client.get('/posts?userId=1').expectSchema(isArrayAsync)
  })

  test('fails (async) and surfaces the issue message', async () => {
    const err = await captureAssertionError(() =>
      client.get('/users/1').expectSchema(isArrayAsync),
    )
    expect(err.message).toContain('expected an array')
  })
})

describe('expectUnder', () => {
  test('passes for a fast endpoint with a generous threshold', async () => {
    const res = await client.get('/echo').expectUnder(2000)
    // durationMs is populated and consistent with the generous bound.
    expect(res.durationMs).toBeLessThanOrEqual(2000)
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('fails for a slow endpoint against a tight threshold', async () => {
    const err = await captureAssertionError(() =>
      // /delay/300 sleeps ~300ms, well over the 20ms bound.
      client.get('/delay/300').expectUnder(20),
    )
    expect(err.message).toContain('under 20ms')
    expect(err.message).toMatch(/took \d+ms/)
  })
})

describe('fail-fast ordering', () => {
  test('an earlier failing assertion stops a later one from running', async () => {
    let laterRan = false

    // A schema with a side-effecting validate so we can detect whether it ran.
    const tripwire: StandardSchemaV1<unknown> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate(value) {
          laterRan = true
          return { value }
        },
      },
    }

    const err = await captureAssertionError(() =>
      client
        .get('/status/500')
        .expectStatus(200) // fails first
        .expectSchema(tripwire), // must NOT run
    )

    expect(err.message).toContain('expected status 200')
    expect(laterRan).toBe(false)
  })
})

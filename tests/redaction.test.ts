import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createClient } from '../src/client'
import {
  redactHeaders,
  redactBodyKeys,
  redactBodyText,
  DEFAULT_SENSITIVE_HEADERS,
  REDACTION_MASK,
} from '../src/redact'

/** Pure redaction helpers + the assertion-diff propagation surface. */
describe('redactHeaders', () => {
  test('masks default sensitive header names (case-insensitive)', () => {
    const out = redactHeaders({
      Authorization: 'Bearer x',
      'Set-Cookie': 'sid=1',
      COOKIE: 'a=1',
      'X-Api-Key': 'k',
      accept: 'application/json',
    })
    expect(out.Authorization).toBe(REDACTION_MASK)
    expect(out['Set-Cookie']).toBe(REDACTION_MASK)
    expect(out.COOKIE).toBe(REDACTION_MASK)
    expect(out['X-Api-Key']).toBe(REDACTION_MASK)
    // Non-sensitive passes through.
    expect(out.accept).toBe('application/json')
  })

  test('merges custom names with the defaults (case-insensitive)', () => {
    const out = redactHeaders(
      { 'X-Custom-Secret': 'shh', authorization: 'Bearer y', other: 'ok' },
      ['x-custom-secret'],
    )
    expect(out['X-Custom-Secret']).toBe(REDACTION_MASK)
    expect(out.authorization).toBe(REDACTION_MASK)
    expect(out.other).toBe('ok')
  })

  test('default set covers the documented header names', () => {
    expect(DEFAULT_SENSITIVE_HEADERS).toEqual([
      'authorization',
      'cookie',
      'set-cookie',
      'proxy-authorization',
      'x-api-key',
      'x-auth-token',
      'api-key',
    ])
  })
})

describe('redactBodyKeys', () => {
  test('masks nested keys, leaves others, handles arrays', () => {
    const input = {
      user: 'ada',
      token: 'SECRET',
      nested: { password: 'SECRET2', keep: 1 },
      list: [{ token: 'SECRET3', id: 5 }, { id: 6 }],
    }
    const out = redactBodyKeys(input, ['token', 'password']) as typeof input
    expect(out.user).toBe('ada')
    expect(out.token).toBe(REDACTION_MASK)
    expect(out.nested.password).toBe(REDACTION_MASK)
    expect(out.nested.keep).toBe(1)
    expect(out.list[0].token).toBe(REDACTION_MASK)
    expect(out.list[0].id).toBe(5)
    expect(out.list[1].id).toBe(6)
    // Original is not mutated.
    expect(input.token).toBe('SECRET')
  })

  test('no keys → value returned unchanged', () => {
    const input = { token: 'SECRET' }
    expect(redactBodyKeys(input)).toBe(input)
  })

  test('redactBodyText masks JSON and leaves non-JSON as-is', () => {
    expect(redactBodyText('{"token":"SECRET","a":1}', ['token'])).toBe('{"token":"***","a":1}')
    expect(redactBodyText('not json', ['token'])).toBe('not json')
  })
})

describe('assertion diff redaction', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('redact.bodyKeys masks the token value in the thrown AssertionError while showing other diffs', async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ token: 'REALSECRETVALUE', role: 'user' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createClient({
      baseUrl: 'https://api.example.com',
      redact: { bodyKeys: ['token'] },
    })

    let thrown: unknown
    try {
      await client
        .get('/session')
        .expectJsonStrict({ token: 'expected-token', role: 'admin' })
    } catch (e) {
      thrown = e
    }
    const msg = (thrown as Error).message
    // The real secret never appears.
    expect(msg).not.toContain('REALSECRETVALUE')
    // The token diff line is masked.
    expect(msg).toContain('token')
    expect(msg).toContain('***')
    // A non-redacted field still shows its real diff values.
    expect(msg).toContain('user')
    expect(msg).toContain('admin')
  })
})

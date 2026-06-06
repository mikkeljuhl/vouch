/**
 * Unit coverage for the structured, path-level JSON diff (DESIGN.md §5). We call
 * `assertJson`/`assertJsonStrict` directly with a fake `AssertContext` and assert
 * on the thrown `AssertionError.message`, plus an agreement check proving the diff
 * walker's pass/fail verdict matches the existing `isSubset`/`deepEqual` booleans
 * exactly (behavior unchanged — only the message improved).
 */

import { describe, expect, test } from 'bun:test'
import {
  assertJson,
  assertJsonStrict,
  deepEqual,
  diffJson,
  isSubset,
  type AssertContext,
} from '../src/assert'
import { captureAssertion } from './support/assert'

const ctx: AssertContext = { method: 'GET', url: 'https://api/users/1' }

/** Capture the message of the AssertionError thrown by `fn`, or fail. */
function messageOf(fn: () => void): Promise<string> {
  return captureAssertion(fn).then((err) => err.message)
}

describe('message format', () => {
  test('carries the method + url prefix', async () => {
    const msg = await messageOf(() => assertJson(ctx, { role: 'admin' }, { role: 'user' }))
    expect(msg.startsWith('GET https://api/users/1 — ')).toBe(true)
  })

  test('nested value mismatch shows path + expected/received', async () => {
    const msg = await messageOf(() =>
      assertJson(ctx, { team: { id: 7 } }, { team: { id: 9 } }),
    )
    expect(msg).toContain('team.id')
    expect(msg).toContain('expected 7')
    expect(msg).toContain('received 9')
  })

  test('missing key (subset) is reported as missing', async () => {
    const msg = await messageOf(() => assertJson(ctx, { profile: { x: 1 } }, { other: true }))
    expect(msg).toContain('profile')
    expect(msg).toContain('missing')
  })

  test('extra key: strict REPORTS it, subset does NOT', async () => {
    // subset: extra key in actual is allowed → passes (no throw).
    expect(() => assertJson(ctx, { a: 1 }, { a: 1, b: 2 })).not.toThrow()
    // strict: extra key in actual is reported as unexpected.
    const msg = await messageOf(() => assertJsonStrict(ctx, { a: 1 }, { a: 1, b: 2 }))
    expect(msg).toContain('b')
    expect(msg).toContain('unexpected key')
  })

  test('array element mismatch shows indexed path', async () => {
    const msg = await messageOf(() =>
      assertJson(ctx, { items: [{ id: 1 }, { id: 2 }, { id: 3 }] }, {
        items: [{ id: 1 }, { id: 2 }, { id: 99 }],
      }),
    )
    expect(msg).toContain('items[2].id')
  })

  test('array length mismatch produces a length diff', async () => {
    const msg = await messageOf(() => assertJson(ctx, { items: [1, 2, 3] }, { items: [1, 2] }))
    expect(msg).toContain('items')
    expect(msg).toContain('array length expected 3 received 2')
  })

  test('type mismatch: expected number got string', async () => {
    const msg = await messageOf(() => assertJson(ctx, { id: 7 }, { id: '7' }))
    const diffs = diffJson({ id: 7 }, { id: '7' }, 'subset')
    expect(diffs[0]?.kind).toBe('type')
    expect(msg).toContain('id')
    expect(msg).toContain('expected 7')
    expect(msg).toContain('received "7"')
  })

  test('type mismatch: expected object got null', () => {
    const diffs = diffJson({ team: { id: 1 } }, { team: null }, 'subset')
    expect(diffs[0]?.kind).toBe('type')
    expect(diffs[0]?.path).toBe('team')
  })

  test('root-level mismatch shows (root)', async () => {
    const msg = await messageOf(() => assertJsonStrict(ctx, { a: 1 }, 'a string'))
    expect(msg).toContain('(root)')
  })

  test('values are truncated so one huge field cannot flood the line', async () => {
    const huge = 'x'.repeat(500)
    const msg = await messageOf(() => assertJson(ctx, { blob: huge }, { blob: 'small' }))
    expect(msg).toContain('truncated')
    expect(msg).not.toContain('x'.repeat(200))
  })

  test('caps the diff lines and appends "… and N more"', async () => {
    const expected: Record<string, number> = {}
    const actual: Record<string, number> = {}
    for (let i = 0; i < 30; i++) {
      expected[`k${i}`] = 1
      actual[`k${i}`] = 2
    }
    const msg = await messageOf(() => assertJson(ctx, expected, actual))
    expect(msg).toContain('(30 differences)')
    expect(msg).toContain('and 10 more')
    // Only the first 20 bullet lines are rendered.
    expect(msg.split('•').length - 1).toBe(20)
  })

  test('single difference uses singular noun', async () => {
    const msg = await messageOf(() => assertJson(ctx, { a: 1 }, { a: 2 }))
    expect(msg).toContain('(1 difference)')
  })
})

describe('agreement with isSubset / deepEqual (pass/fail unchanged)', () => {
  const pairs: Array<[unknown, unknown]> = [
    [{ a: 1 }, { a: 1, b: 2 }], // subset match, strict extra
    [{ a: 1 }, { a: 2 }], // value mismatch
    [{ a: { b: 1 } }, { a: { b: 1, c: 9 } }], // nested subset
    [[1, 2, 3], [1, 2, 3]], // equal arrays
    [[1, 2], [1, 2, 3]], // length mismatch
    [{ id: 7 }, { id: '7' }], // type mismatch
    [{ team: { id: 1 } }, { team: null }], // object vs null
    [null, null], // both null
    [5, 5], // equal primitives
    [{ a: 1, b: 2 }, { a: 1, b: 2 }], // exact match
    ['hello', 'world'], // primitive mismatch
    [{ list: [{ x: 1 }] }, { list: [{ x: 1, y: 2 }] }], // array of objects subset
  ]

  test('subset: (diffs.length === 0) === isSubset(actual, expected)', () => {
    for (const [expected, actual] of pairs) {
      const noDiffs = diffJson(expected, actual, 'subset').length === 0
      expect(noDiffs).toBe(isSubset(actual, expected))
    }
  })

  test('strict: (diffs.length === 0) === deepEqual(expected, actual)', () => {
    for (const [expected, actual] of pairs) {
      const noDiffs = diffJson(expected, actual, 'strict').length === 0
      expect(noDiffs).toBe(deepEqual(expected, actual))
    }
  })
})

describe('matchers still pass on a match', () => {
  test('assertJson passes on a subset match', () => {
    expect(() => assertJson(ctx, { name: 'Ada' }, { id: 1, name: 'Ada' })).not.toThrow()
  })

  test('assertJsonStrict passes on an exact match', () => {
    expect(() => assertJsonStrict(ctx, { id: 1, name: 'Ada' }, { id: 1, name: 'Ada' })).not.toThrow()
  })
})

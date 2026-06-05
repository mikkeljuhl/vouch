/**
 * Engine-agnostic assertion layer (DESIGN.md §5). This module imports **no** test
 * library — matchers simply throw an `AssertionError` on mismatch, and because
 * every test runner treats a thrown error as a failing test, the same suite runs
 * under Bun, Vitest, or `node --test`.
 *
 * The matchers craft explicit expected/actual messages (we forgo a runner's
 * native diff in exchange for zero dependencies). Each carries an `AssertContext`
 * (`{ method, url }`) so the message identifies which request failed.
 */

/** Error thrown by every matcher on failure. A thrown error fails any runner. */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssertionError'
  }
}

/** Identifies the request a failing assertion belongs to, for the message. */
export interface AssertContext {
  method: string
  url: string
}

/** `GET https://… — ` prefix shared by every assertion message. */
function prefix(ctx: AssertContext): string {
  return `${ctx.method} ${ctx.url} — `
}

/**
 * Compact JSON for error messages, truncated when huge so a giant body doesn't
 * flood the output. Falls back to `String(value)` for non-serializable values.
 */
function preview(value: unknown, max = 500): string {
  let str: string
  try {
    str = JSON.stringify(value)
  } catch {
    str = String(value)
  }
  if (str === undefined) str = String(value)
  if (str.length > max) return `${str.slice(0, max)}… (truncated)`
  return str
}

/**
 * Structural equality for JSON values: primitives, arrays, and plain objects
 * (with null/undefined handled). Not intended for Map/Set/Date — JSON bodies
 * don't contain those. Arrays must match length and element order; objects must
 * have the same key set with deep-equal values.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== 'object' || typeof b !== 'object') return false

  const aIsArray = Array.isArray(a)
  const bIsArray = Array.isArray(b)
  if (aIsArray !== bIsArray) return false

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }

  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false
    if (!deepEqual(aObj[key], bObj[key])) return false
  }
  return true
}

/**
 * Partial / subset match, mirroring Vitest's `toMatchObject` closely enough for
 * JSON bodies: every key present in `expected` must exist in `actual` and match
 * recursively. Extra keys in `actual` are allowed.
 *
 * Arrays: matched element-wise with the SAME length (like `toMatchObject`,
 * which requires array lengths to match), and each element is compared with
 * subset semantics when both elements are objects (so `[{a:1}]` matches
 * `[{a:1,b:2}]`), otherwise by `deepEqual`. This is the pragmatic middle ground:
 * objects nested in arrays still get subset treatment, but you can't match a
 * shorter expected array against a longer actual one — matching prior behavior.
 */
export function isSubset(actual: unknown, expected: unknown): boolean {
  if (deepEqual(actual, expected)) return true
  if (expected === null || typeof expected !== 'object') {
    // Primitive expected that wasn't `===` actual → no match.
    return false
  }
  if (actual === null || typeof actual !== 'object') return false

  const expIsArray = Array.isArray(expected)
  const actIsArray = Array.isArray(actual)
  if (expIsArray !== actIsArray) return false

  if (expIsArray && actIsArray) {
    if (expected.length !== actual.length) return false
    for (let i = 0; i < expected.length; i++) {
      if (!isSubset(actual[i], expected[i])) return false
    }
    return true
  }

  const expObj = expected as Record<string, unknown>
  const actObj = actual as Record<string, unknown>
  for (const key of Object.keys(expObj)) {
    if (!Object.prototype.hasOwnProperty.call(actObj, key)) return false
    if (!isSubset(actObj[key], expObj[key])) return false
  }
  return true
}

/** Assert the response status equals `expected`. */
export function assertStatus(ctx: AssertContext, expected: number, actual: number): void {
  if (actual !== expected) {
    throw new AssertionError(
      `${prefix(ctx)}expected status ${expected} but got ${actual}`,
    )
  }
}

/**
 * Assert a response header matches `expected`: an exact string match, or a
 * RegExp `.test`. `actualValue` is the value from `Headers.get` (case-insensitive
 * lookup happens at the call site), which is `null` when the header is absent.
 */
export function assertHeader(
  ctx: AssertContext,
  name: string,
  expected: string | RegExp,
  actualValue: string | null,
): void {
  if (expected instanceof RegExp) {
    if (actualValue === null || !expected.test(actualValue)) {
      throw new AssertionError(
        `${prefix(ctx)}expected header ${name} to match ${expected} but got ${
          actualValue === null ? '<missing>' : JSON.stringify(actualValue)
        }`,
      )
    }
    return
  }
  if (actualValue !== expected) {
    throw new AssertionError(
      `${prefix(ctx)}expected header ${name} to be ${JSON.stringify(expected)} but got ${
        actualValue === null ? '<missing>' : JSON.stringify(actualValue)
      }`,
    )
  }
}

/** Assert the body contains `partial` (subset / partial match via `isSubset`). */
export function assertJson(ctx: AssertContext, partial: unknown, body: unknown): void {
  if (!isSubset(body, partial)) {
    throw new AssertionError(
      `${prefix(ctx)}expected body to match (subset) ${preview(partial)} but got ${preview(body)}`,
    )
  }
}

/** Assert the body deep-equals `expected` (full structural equality). */
export function assertJsonStrict(ctx: AssertContext, expected: unknown, body: unknown): void {
  if (!deepEqual(body, expected)) {
    throw new AssertionError(
      `${prefix(ctx)}expected body to deep-equal ${preview(expected)} but got ${preview(body)}`,
    )
  }
}

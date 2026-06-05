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

/**
 * Minimal inline copy of the **Standard Schema v1** interface
 * (https://standardschema.dev). We intentionally do **not** add a dependency on
 * the `@standard-schema/spec` package — the spec surface is tiny, so we declare
 * just what we consume here. Any validation library that implements Standard
 * Schema (zod ≥ 3.24, valibot, arktype, …) exposes a `['~standard']` property and
 * is therefore accepted by `.expectSchema()` without the framework taking on a
 * runtime/dev dependency.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

export namespace StandardSchemaV1 {
  /** The `~standard` properties we use: the version, vendor, and validator. */
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    /** Validate (sync or async); returns a success or a failure with issues. */
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>
    /** Inferred input/output types (phantom — present only for type inference). */
    readonly types?: Types<Input, Output> | undefined
  }

  /** A validation result is either a success carrying a value or a failure. */
  export type Result<Output> = SuccessResult<Output> | FailureResult

  export interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }

  export interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined
  }

  export interface PathSegment {
    readonly key: PropertyKey
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }
}

/**
 * A schema accepted by `.expectSchema()`: either a Standard Schema object or a
 * plain predicate `(body) => boolean` (truthy = valid). The predicate path keeps
 * the simplest case dependency- and ceremony-free.
 */
export type SchemaInput = StandardSchemaV1 | ((body: unknown) => boolean)

/** Runtime check for a Standard Schema: it carries a `~standard.validate`. */
function isStandardSchema(schema: SchemaInput): schema is StandardSchemaV1 {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '~standard' in schema &&
    typeof (schema as StandardSchemaV1)['~standard']?.validate === 'function'
  )
}

/** Render a Standard Schema issue path (`a.b[0]`) for the error message. */
function formatPath(path: StandardSchemaV1.Issue['path']): string {
  if (!path || path.length === 0) return ''
  const parts = path.map((seg) => {
    const key = typeof seg === 'object' && seg !== null ? seg.key : seg
    return typeof key === 'number' ? `[${key}]` : String(key)
  })
  // Join object keys with dots; array indices already carry their own brackets.
  let out = ''
  for (const part of parts) {
    out += part.startsWith('[') || out === '' ? part : `.${part}`
  }
  return out
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

/**
 * One path-level difference between an expected and an actual JSON value.
 *
 * `kind` is the category of mismatch; `path` is a dot/bracket path to the
 * offending node (empty string = the root value). `expected`/`actual` carry the
 * relevant values for rendering (e.g. the two primitives for a `value` diff, or
 * the two lengths for a `length` diff). They are `undefined` when not applicable
 * (`missing` has no actual; `extra` has no expected).
 */
export interface Difference {
  kind: 'value' | 'type' | 'missing' | 'extra' | 'length'
  path: string
  expected?: unknown
  actual?: unknown
}

/** The diff mode: `subset` mirrors `isSubset`, `strict` mirrors `deepEqual`. */
type DiffMode = 'subset' | 'strict'

/** Append an object-key segment to a path with dot notation. */
function childKeyPath(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`
}

/** Append an array-index segment to a path with bracket notation. */
function childIndexPath(base: string, index: number): string {
  return `${base}[${index}]`
}

/** The JSON "type" of a value, distinguishing null/array/object/primitive. */
function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Walk `expected` vs `actual` and collect every path-level difference.
 *
 * This is the single source of truth for what counts as a mismatch and it is
 * defined to AGREE EXACTLY with the boolean helpers:
 *  - `mode: 'subset'`  → `diff(...).length === 0` ⟺ `isSubset(actual, expected)`
 *  - `mode: 'strict'`  → `diff(...).length === 0` ⟺ `deepEqual(expected, actual)`
 *
 * Semantics mirrored from those helpers:
 *  - Primitives (and any value where `expected` is not a non-null object) are
 *    compared with `deepEqual`; on mismatch we emit `type` when the JSON types
 *    differ, else `value`.
 *  - Arrays require EQUAL LENGTH (both modes); a mismatch emits a single
 *    `length` diff for the array and does not recurse into elements (matching
 *    the helpers, which short-circuit on length). Equal-length arrays recurse
 *    element-wise — subset elements get subset treatment, strict get strict.
 *  - Objects: keys in `expected` missing from `actual` → `missing`; common keys
 *    recurse. In `strict` mode, keys in `actual` not in `expected` → `extra`.
 *    In `subset` mode extra actual keys are allowed (not reported).
 */
export function diffJson(
  expected: unknown,
  actual: unknown,
  mode: DiffMode,
  path = '',
  out: Difference[] = [],
): Difference[] {
  // When expected is a primitive/null, the helpers reduce to `deepEqual`.
  if (expected === null || typeof expected !== 'object') {
    if (!deepEqual(expected, actual)) {
      const kind = jsonType(expected) !== jsonType(actual) ? 'type' : 'value'
      out.push({ kind, path, expected, actual })
    }
    return out
  }

  // Expected is an object or array. If actual isn't the same shape, that's a
  // type mismatch (object-vs-array, object-vs-null, object-vs-primitive).
  const expIsArray = Array.isArray(expected)
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual) !== expIsArray) {
    out.push({ kind: 'type', path, expected, actual })
    return out
  }

  if (expIsArray) {
    const expArr = expected as unknown[]
    const actArr = actual as unknown[]
    // Both helpers require equal array length and short-circuit otherwise.
    if (expArr.length !== actArr.length) {
      out.push({ kind: 'length', path, expected: expArr.length, actual: actArr.length })
      return out
    }
    for (let i = 0; i < expArr.length; i++) {
      diffJson(expArr[i], actArr[i], mode, childIndexPath(path, i), out)
    }
    return out
  }

  const expObj = expected as Record<string, unknown>
  const actObj = actual as Record<string, unknown>
  for (const key of Object.keys(expObj)) {
    const childPath = childKeyPath(path, key)
    if (!Object.prototype.hasOwnProperty.call(actObj, key)) {
      out.push({ kind: 'missing', path: childPath, expected: expObj[key] })
      continue
    }
    diffJson(expObj[key], actObj[key], mode, childPath, out)
  }
  if (mode === 'strict') {
    for (const key of Object.keys(actObj)) {
      if (!Object.prototype.hasOwnProperty.call(expObj, key)) {
        out.push({ kind: 'extra', path: childKeyPath(path, key), actual: actObj[key] })
      }
    }
  }
  return out
}

/** Max characters for a single rendered value before truncation (per line). */
const VALUE_MAX = 80
/** Max number of diff lines shown before collapsing into `… and N more`. */
const DIFF_CAP = 20

/** Compact JSON for a single diff value, truncated so one field can't flood. */
function diffValue(value: unknown): string {
  return preview(value, VALUE_MAX)
}

/** Render one difference as a `path  expected … received …` line. */
function formatDifference(diff: Difference): string {
  const label = diff.path === '' ? '(root)' : diff.path
  switch (diff.kind) {
    case 'missing':
      return `${label}  missing (expected key not present)`
    case 'extra':
      return `${label}  unexpected key (received ${diffValue(diff.actual)})`
    case 'length':
      return `${label}  array length expected ${diff.expected} received ${diff.actual}`
    case 'type':
    case 'value':
      return `${label}  expected ${diffValue(diff.expected)} received ${diffValue(diff.actual)}`
  }
}

/** Build the multi-line diff message body (cap applied) for a list of diffs. */
function formatDiffMessage(diffs: Difference[], headline: string): string {
  const lines = diffs.slice(0, DIFF_CAP).map((d) => `  • ${formatDifference(d)}`)
  if (diffs.length > DIFF_CAP) {
    lines.push(`  … and ${diffs.length - DIFF_CAP} more`)
  }
  const noun = diffs.length === 1 ? 'difference' : 'differences'
  return `${headline} (${diffs.length} ${noun}):\n${lines.join('\n')}`
}

/** Assert the body contains `partial` (subset / partial match via `isSubset`). */
export function assertJson(ctx: AssertContext, partial: unknown, body: unknown): void {
  const diffs = diffJson(partial, body, 'subset')
  if (diffs.length > 0) {
    throw new AssertionError(
      `${prefix(ctx)}${formatDiffMessage(diffs, 'JSON body did not match (subset)')}`,
    )
  }
}

/** Assert the body deep-equals `expected` (full structural equality). */
export function assertJsonStrict(ctx: AssertContext, expected: unknown, body: unknown): void {
  const diffs = diffJson(expected, body, 'strict')
  if (diffs.length > 0) {
    throw new AssertionError(
      `${prefix(ctx)}${formatDiffMessage(diffs, 'JSON body did not match (strict)')}`,
    )
  }
}

/** Truncate a string for an error message so a large body doesn't flood output. */
function previewText(text: string, max = 200): string {
  const json = JSON.stringify(text.length > max ? `${text.slice(0, max)}… (truncated)` : text)
  return json
}

/**
 * Assert the raw response text **contains** `match` (string substring) or
 * **matches** it (`RegExp.test`). The message shows the match and a truncated
 * preview of the actual text.
 */
export function assertText(
  ctx: AssertContext,
  match: string | RegExp,
  actualText: string,
): void {
  if (match instanceof RegExp) {
    if (!match.test(actualText)) {
      throw new AssertionError(
        `${prefix(ctx)}expected response text to match ${match} but got ${previewText(actualText)}`,
      )
    }
    return
  }
  if (!actualText.includes(match)) {
    throw new AssertionError(
      `${prefix(ctx)}expected response text to contain ${JSON.stringify(match)} but got ${previewText(actualText)}`,
    )
  }
}

/**
 * Assert the raw response text **exactly equals** `expected`. Covers exact-text
 * and empty-body (`expected === ''`) checks.
 */
export function assertBody(ctx: AssertContext, expected: string, actualText: string): void {
  if (actualText !== expected) {
    throw new AssertionError(
      `${prefix(ctx)}expected response body to equal ${previewText(expected)} but got ${previewText(actualText)}`,
    )
  }
}

/**
 * Assert the response wall-clock duration was at or under `maxMs`. `actualMs` is
 * the measured time for the request (a single attempt unless retry is enabled).
 */
export function assertUnder(ctx: AssertContext, maxMs: number, actualMs: number): void {
  if (actualMs > maxMs) {
    // Round the measured value so the message stays readable (sub-ms precision
    // isn't meaningful for an SLA-style threshold).
    throw new AssertionError(
      `${prefix(ctx)}expected response under ${maxMs}ms but took ${Math.round(actualMs)}ms`,
    )
  }
}

/**
 * Assert the body validates against `schema`:
 * - a **predicate** `(body) => boolean` — throws if it returns falsy;
 * - a **Standard Schema** — runs `validate` (which MAY be async, hence the
 *   `Promise<void>` return) and throws listing the issue messages (and paths
 *   when present) if the result reports `issues`.
 *
 * The success `value` from a Standard Schema is ignored: `.expectSchema()` is a
 * validation assertion, not a transform — the framework keeps the parsed body.
 */
export function assertSchema(
  ctx: AssertContext,
  schema: SchemaInput,
  body: unknown,
): void | Promise<void> {
  if (!isStandardSchema(schema)) {
    // Predicate path: truthy return means valid.
    if (!schema(body)) {
      throw new AssertionError(
        `${prefix(ctx)}expected body to satisfy the predicate but it returned false; body was ${preview(body)}`,
      )
    }
    return
  }

  const result = schema['~standard'].validate(body)
  if (result instanceof Promise) {
    return result.then((settled) => throwIfIssues(ctx, settled))
  }
  throwIfIssues(ctx, result)
}

/** Throw an `AssertionError` listing the issues if a Standard Schema failed. */
function throwIfIssues(ctx: AssertContext, result: StandardSchemaV1.Result<unknown>): void {
  if (!result.issues) return
  const lines = result.issues.map((issue) => {
    const path = formatPath(issue.path)
    return path ? `${path}: ${issue.message}` : issue.message
  })
  throw new AssertionError(
    `${prefix(ctx)}expected body to match schema but validation failed: ${lines.join('; ')}`,
  )
}

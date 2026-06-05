/**
 * Unit coverage for the CI reporting helpers in `scripts/ci-summary.mjs`
 * (DESIGN.md §8). The script captures Bun's console output (which contains the
 * full assertion message) and MERGES it into the JUnit `<failure>` elements,
 * because Bun's JUnit reporter emits only the error `type` and no message.
 *
 * The sample strings below are real Bun v1.3 console output, captured by
 * inducing failures (a JSON-diff AssertionError, a `bun:expect` failure, and a
 * nested-describe TypeError). The `(fail) …` trailer names each test exactly as
 * Bun prints it: describe ancestry outermost-first, " > "-joined, plus title.
 */

import { describe, expect, test } from 'bun:test'
import {
  parseConsoleFailures,
  enrichJUnit,
  junitFullName,
  stripAnsi,
} from '../scripts/ci-summary.mjs'

// ── Realistic captured Bun console output ──────────────────────────────────

// Single AssertionError with a multi-line structured diff.
const SINGLE_ASSERTION = `bun test v1.3.14 (0d9b296a)

tests/x.test.ts:
397 |   const diffs = ...
          ^
AssertionError: GET https://jsonplaceholder.typicode.com/todos/1 — JSON body did not match (subset) (2 differences):
  • title  expected "definitely-wrong" received "delectus aut autem"
  • completed  expected "nope" received false
      at assertJson (/Users/x/src/assert.ts:399:11)
      at <anonymous> (/Users/x/src/builder.ts:256:9)
(fail) json diff failure [75.85ms]

 0 pass
 1 fail
Ran 1 tests across 1 file. [88.00ms]
`

// Two failures in one run: a bun:expect failure then a nested-describe TypeError.
const TWO_FAILURES = `bun test v1.3.14 (0d9b296a)

tests/p.test.ts:
4 | test('top level assertion', () => {
5 |   expect(1).toBe(2)
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/private/tmp/probe/p.test.ts:5:13)
(fail) top level assertion [0.61ms]
11 |       throw new TypeError('boom from nested')
                                                 ^
TypeError: boom from nested
      at <anonymous> (/private/tmp/probe/p.test.ts:11:45)
(fail) outer > inner nested > deeply nested fail [0.03ms]

 0 pass
 2 fail
Ran 2 tests across 1 file. [88.00ms]
`

describe('parseConsoleFailures', () => {
  test('extracts a single multi-line AssertionError message', () => {
    const m = parseConsoleFailures(SINGLE_ASSERTION)
    expect(m.size).toBe(1)
    const msg = m.get('json diff failure')
    expect(msg).toBeDefined()
    expect(msg).toContain('AssertionError: GET https://jsonplaceholder.typicode.com/todos/1')
    expect(msg).toContain('• title  expected "definitely-wrong" received "delectus aut autem"')
    expect(msg).toContain('• completed  expected "nope" received false')
    // Stack frames must NOT be part of the message.
    expect(msg).not.toContain('at assertJson')
  })

  test('maps two failures to the correct names (incl. nested describe path)', () => {
    const m = parseConsoleFailures(TWO_FAILURES)
    expect(m.size).toBe(2)

    expect(m.get('top level assertion')).toContain('error: expect(received).toBe(expected)')
    expect(m.get('top level assertion')).toContain('Expected: 2')
    expect(m.get('top level assertion')).toContain('Received: 1')

    const nested = m.get('outer > inner nested > deeply nested fail')
    expect(nested).toBe('TypeError: boom from nested')
  })

  test('strips ANSI escape codes before parsing', () => {
    const ansi =
      '\x1b[2mtests/x.test.ts:\x1b[0m\n' +
      '\x1b[31mAssertionError: colours leaked\x1b[0m\n' +
      '      at foo (/x.ts:1:1)\n' +
      '\x1b[31m(fail)\x1b[0m colourful test \x1b[2m[1.00ms]\x1b[0m\n'
    const m = parseConsoleFailures(ansi)
    expect(m.get('colourful test')).toBe('AssertionError: colours leaked')
  })

  test('stripAnsi removes escape sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('plain')).toBe('plain')
  })
})

// ── JUnit reconstruction + enrichment ──────────────────────────────────────

// Real Bun JUnit shape: classname is the describe ancestry REVERSED (innermost
// first), double-escaped (`&amp;gt;`), and <failure> is self-closed with only
// `type`. Top-level testcases have an empty classname.
const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="1" failures="2" skipped="0" time="0.088">
  <testsuite name="tests/p.test.ts" file="tests/p.test.ts" tests="3" failures="2" skipped="0" time="0.075">
    <testcase name="top level assertion" classname="" time="0.0006" file="tests/p.test.ts" line="4">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="passing test" classname="" time="0.001" file="tests/p.test.ts" line="6" />
    <testsuite name="outer">
      <testsuite name="inner nested">
        <testcase name="deeply nested fail" classname="inner nested &amp;gt; outer" time="0.00003" file="tests/p.test.ts" line="10">
          <failure type="AssertionError" />
        </testcase>
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>`

describe('junitFullName', () => {
  test('reconstructs the console fullName from name + reversed classname', () => {
    expect(junitFullName({ name: 'top level assertion', classname: '' })).toBe(
      'top level assertion',
    )
    expect(
      junitFullName({ name: 'deeply nested fail', classname: 'inner nested > outer' }),
    ).toBe('outer > inner nested > deeply nested fail')
  })
})

describe('enrichJUnit', () => {
  test('merges messages into matched <failure> elements, leaves others as-is', () => {
    const m = parseConsoleFailures(TWO_FAILURES)
    const out = enrichJUnit(JUNIT, m)

    // Top-level failure: self-closed <failure/> becomes a message+CDATA element.
    expect(out).toContain(
      '<failure type="AssertionError" message="error: expect(received).toBe(expected)">',
    )
    expect(out).toContain('<![CDATA[\nerror: expect(received).toBe(expected)')
    expect(out).toContain('Received: 1\n]]></failure>')

    // Nested-describe failure: matched via reconstructed fullName.
    expect(out).toContain('<failure type="AssertionError" message="TypeError: boom from nested">')
    expect(out).toContain('<![CDATA[\nTypeError: boom from nested\n]]>')

    // The passing testcase is untouched (still self-closed, no <failure>).
    expect(out).toContain('<testcase name="passing test" classname="" time="0.001"')
    // No self-closed <failure /> should remain (both got enriched).
    expect(out).not.toContain('<failure type="AssertionError" />')
  })

  test('XML-escapes special characters in the message attribute', () => {
    const m = new Map([
      ['top level assertion', 'AssertionError: a < b && "c" > d'],
    ])
    const out = enrichJUnit(JUNIT, m)
    expect(out).toContain('message="AssertionError: a &lt; b &amp;&amp; &quot;c&quot; &gt; d"')
  })

  test('is a no-op with no console messages (backward compatible)', () => {
    expect(enrichJUnit(JUNIT, new Map())).toBe(JUNIT)
    expect(enrichJUnit(JUNIT, undefined)).toBe(JUNIT)
  })

  test('leaves a failure unmatched when no message correlates (no crash)', () => {
    const m = new Map([['some other unrelated test name', 'AssertionError: nope']])
    const out = enrichJUnit(JUNIT, m)
    // Neither failing testcase matches, and there are 2 failures so the
    // single-failure fallback does not fire → XML unchanged.
    expect(out).toBe(JUNIT)
  })
})

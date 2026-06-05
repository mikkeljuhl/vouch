// Renders CI reporting from a JUnit XML report (as emitted by `bun test
// --reporter=junit --reporter-outfile=...`). First-party, dependency-free.
//
// Two surfaces, both built-in/first-party (DESIGN.md §1/§8):
//   1. Inline annotations — prints `::error file=…,line=…::msg` workflow
//      commands for each failing test (Bun doesn't emit these itself).
//   2. Job summary — a Markdown table appended to $GITHUB_STEP_SUMMARY
//      (totals, per-file breakdown, collapsed failure details).
//
// Usage: node scripts/ci-summary.mjs [path-to-junit.xml]   (default: reports/junit.xml)
// Runs under Bun or Node (uses only node: builtins).

import { readFileSync, appendFileSync } from 'node:fs'

const reportPath = process.argv[2] ?? './reports/junit.xml'

/** Append Markdown to the job summary, or print it when running locally. */
function emitSummary(markdown) {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (target) appendFileSync(target, markdown + '\n')
  else process.stdout.write(markdown + '\n')
}

/** Decode the handful of XML entities that appear in JUnit attributes/text. */
function unescapeXml(s) {
  return s
    .replace(/&amp;gt;/g, '>') // Bun double-escapes ">" in classname → "&amp;gt;"
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

/** Encode a string for a GitHub Actions workflow command (annotations). */
function encodeCmd(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

const fmt = (sec) => {
  const ms = sec * 1000
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

let xml
try {
  xml = readFileSync(reportPath, 'utf8')
} catch (err) {
  emitSummary(`### API tests\n\n> ⚠️ No JUnit report at \`${reportPath}\` (${err.code ?? err.message}).`)
  process.exit(0)
}

const attrs = (s) => {
  const out = {}
  for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2])
  return out
}

// Overall totals from the root <testsuites …> element (Bun populates these).
const rootM = xml.match(/<testsuites\b([^>]*)>/)
const root = rootM ? attrs(rootM[1]) : {}
let total = Number(root.tests ?? 0)
let failed = Number(root.failures ?? 0)
let skipped = Number(root.skipped ?? 0)
const wallSec = Number(root.time ?? 0)

// Walk every <testcase>. Self-closed (`/>`) = passed/skipped; with a body that
// contains <failure>/<error> = failed.
const cases = []
for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const a = attrs(m[1])
  const inner = m[3] ?? ''
  const isFailed = /<(failure|error)\b/.test(inner)
  const isSkipped = /<skipped\b/.test(inner)
  let message = ''
  if (isFailed) {
    const fm =
      inner.match(/<(?:failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>/) ||
      inner.match(/<(?:failure|error)\b([^>]*)\/>/)
    if (fm) {
      const fa = attrs(fm[1])
      // Bun's JUnit <failure> carries only `type` (e.g. "AssertionError") — no
      // message/body. The full assertion message is in the run's console log.
      // Prefer an explicit message/body if a future/other runner provides one.
      message = (fa.message || (fm[2] ? unescapeXml(fm[2].trim()) : '') || fa.type || '').trim()
    }
  }
  cases.push({ ...a, isFailed, isSkipped, message })
}

// Fall back to counting from testcases if the root lacked aggregate attrs.
if (!rootM || root.tests == null) {
  total = cases.length
  failed = cases.filter((c) => c.isFailed).length
  skipped = cases.filter((c) => c.isSkipped).length
}
const passed = total - failed - skipped
const ok = failed === 0

// 1) Annotations for each failure (stdout workflow commands).
for (const c of cases.filter((c) => c.isFailed)) {
  const file = c.file || ''
  const line = c.line || ''
  const title = c.name || 'Test failed'
  const body = c.message || 'Test failed'
  process.stdout.write(
    `::error file=${file},line=${line},title=${encodeCmd(title)}::${encodeCmd(body)}\n`,
  )
}

// 2) Per-file aggregation for the summary table.
const byFile = new Map()
for (const c of cases) {
  const f = c.file || '(unknown)'
  const e = byFile.get(f) ?? { total: 0, passed: 0, failed: 0 }
  e.total++
  if (c.isFailed) e.failed++
  else if (!c.isSkipped) e.passed++
  byFile.set(f, e)
}

const lines = []
lines.push(`## API tests — ${ok ? '✅ passed' : '❌ failed'}`)
lines.push('')
lines.push('| Total | Passed | Failed | Skipped | Duration |')
lines.push('|------:|-------:|-------:|--------:|---------:|')
lines.push(`| ${total} | ${passed} | ${failed} | ${skipped} | ${fmt(wallSec)} |`)
lines.push('')
lines.push('| File | Tests | Passed | Failed |')
lines.push('|:-----|------:|-------:|-------:|')
for (const [file, e] of byFile) {
  const mark = e.failed > 0 ? '❌' : '✅'
  lines.push(`| ${mark} ${file} | ${e.total} | ${e.passed} | ${e.failed} |`)
}
lines.push('')

const failures = cases.filter((c) => c.isFailed)
if (failures.length) {
  lines.push('<details open><summary><strong>Failures</strong></summary>')
  lines.push('')
  for (const c of failures) {
    lines.push(`#### ❌ ${c.name || '(unnamed)'}`)
    lines.push(`\`${c.file || '?'}${c.line ? ':' + c.line : ''}\``)
    lines.push('')
    if (c.message) {
      lines.push('```')
      lines.push(c.message.length > 3000 ? c.message.slice(0, 3000) + '\n… (truncated)' : c.message)
      lines.push('```')
    }
    lines.push('')
  }
  lines.push('</details>')
}

emitSummary(lines.join('\n'))

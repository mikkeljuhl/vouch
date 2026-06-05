// Renders a GitHub Actions job-summary table from Vitest's JSON report.
//
// First-party, dependency-free (DESIGN.md §7: no third-party reporting actions).
// Reads the JSON written by Vitest's `json` reporter and appends a Markdown
// summary to $GITHUB_STEP_SUMMARY (falls back to stdout when run locally).
//
// Usage: node scripts/ci-summary.mjs [path-to-results.json]
//   default path: ./reports/results.json

import { readFileSync, appendFileSync } from 'node:fs'
import { relative } from 'node:path'

const reportPath = process.argv[2] ?? './reports/results.json'

/** Append Markdown to the job summary, or print it when running locally. */
function emit(markdown) {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (target) appendFileSync(target, markdown + '\n')
  else process.stdout.write(markdown + '\n')
}

let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch (err) {
  // Never fail the job over a missing/unreadable report — just note it.
  emit(`### API tests\n\n> ⚠️ No test report found at \`${reportPath}\` (${err.code ?? err.message}).`)
  process.exit(0)
}

const cwd = process.cwd()
const files = report.testResults ?? []

// Wall-clock duration: earliest file start → latest file end.
const starts = files.map((f) => f.startTime).filter(Boolean)
const ends = files.map((f) => f.endTime).filter(Boolean)
const wallMs = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`)

const total = report.numTotalTests ?? 0
const passed = report.numPassedTests ?? 0
const failed = report.numFailedTests ?? 0
const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)
const ok = report.success && failed === 0

const lines = []
lines.push(`## API tests — ${ok ? '✅ passed' : '❌ failed'}`)
lines.push('')
lines.push('| Total | Passed | Failed | Skipped | Duration |')
lines.push('|------:|-------:|-------:|--------:|---------:|')
lines.push(`| ${total} | ${passed} | ${failed} | ${skipped} | ${fmt(wallMs)} |`)
lines.push('')

// Per-file breakdown.
lines.push('| File | Tests | Passed | Failed | Duration |')
lines.push('|:-----|------:|-------:|-------:|---------:|')
for (const f of files) {
  const a = f.assertionResults ?? []
  const fPassed = a.filter((r) => r.status === 'passed').length
  const fFailed = a.filter((r) => r.status === 'failed').length
  const fDur = f.endTime && f.startTime ? f.endTime - f.startTime : 0
  const name = relative(cwd, f.name)
  const mark = fFailed > 0 ? '❌' : '✅'
  lines.push(`| ${mark} ${name} | ${a.length} | ${fPassed} | ${fFailed} | ${fmt(fDur)} |`)
}
lines.push('')

// Failure details (collapsed).
const failures = []
for (const f of files) {
  for (const r of f.assertionResults ?? []) {
    if (r.status === 'failed') failures.push({ file: relative(cwd, f.name), r })
  }
}
if (failures.length) {
  lines.push('<details open><summary><strong>Failures</strong></summary>')
  lines.push('')
  for (const { file, r } of failures) {
    lines.push(`#### ❌ ${r.fullName || r.title}`)
    lines.push(`\`${file}\``)
    lines.push('')
    const msg = (r.failureMessages ?? []).join('\n\n').trim()
    if (msg) {
      lines.push('```')
      // Keep summaries readable; truncate very long stacks.
      lines.push(msg.length > 3000 ? msg.slice(0, 3000) + '\n… (truncated)' : msg)
      lines.push('```')
    }
    lines.push('')
  }
  lines.push('</details>')
}

emit(lines.join('\n'))

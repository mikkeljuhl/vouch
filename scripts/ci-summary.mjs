// Renders CI reporting from a JUnit XML report (as emitted by `bun test
// --reporter=junit --reporter-outfile=...`). First-party, dependency-free.
//
// Two surfaces, both built-in/first-party (DESIGN.md §1/§8):
//   1. Inline annotations — prints `::error file=…,line=…::msg` workflow
//      commands for each failing test (Bun doesn't emit these itself).
//   2. Job summary — a Markdown table appended to $GITHUB_STEP_SUMMARY
//      (totals, per-file breakdown, collapsed failure details).
//
// WHY a console log too: Bun's JUnit `<failure>` carries only `type` (e.g.
// "AssertionError") and NO message/body, and Bun offers no flag/JSON reporter
// to include it. But Bun's *console* output contains the full assertion message
// (our rich structured diff). So when a console-log path is provided we parse
// the messages out of it, MERGE them into the JUnit `<failure>` elements (so the
// JUnit artifact itself becomes downstream-consumable), and use them for the
// annotations + summary. With no console arg the script behaves exactly as
// before (type-only) — fully backward-compatible.
//
// Usage: bun scripts/ci-summary.mjs <junit.xml> [console.txt]
//        (junit default: ./reports/junit.xml)
// Runs under Bun or Node (uses only node: builtins).

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'

// ──────────────────────────────────────────────────────────────────────────
// Pure, exported helpers (unit-testable; no I/O, no process state).
// ──────────────────────────────────────────────────────────────────────────

/** Strip ANSI/VT escape sequences (colours, cursor moves) defensively. */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** Decode the handful of XML entities that appear in JUnit attributes/text. */
export function unescapeXml(s) {
  return s
    .replace(/&amp;gt;/g, '>') // Bun double-escapes ">" in classname → "&amp;gt;"
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

/** Escape a string for use inside an XML attribute value (double-quoted). */
export function escapeXmlAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
}

/** Encode a string for a GitHub Actions workflow command (annotations). */
export function encodeCmd(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

// A line that starts an error block, e.g. `AssertionError:`, `TypeError:`,
// `error:`. Allow leading whitespace and any residual ANSI (stripped already).
const ERROR_LINE = /^([A-Za-z_]\w*(?:Error)?|error):(?:\s|$)/
// The trailer that ends each failing test's block and names it. Bun joins the
// describe ancestry outermost-first with " > " and appends the test title, e.g.
//   (fail) outer > inner nested > deeply nested fail [0.03ms]
const FAIL_LINE = /^\(fail\)\s+(.+?)\s+\[[\d.]+(?:ms|s)\]\s*$/
// First stack frame line, e.g. `      at assertJson (/…:399:11)`.
const STACK_LINE = /^\s+at\s/

/**
 * Parse a Bun console log and return a Map of `fullName` → assertion message.
 *
 * `fullName` is exactly what Bun prints after `(fail) ` (describe path +
 * test title, " > "-joined). The message is the error-type line plus following
 * lines up to (but not including) the first stack frame.
 *
 * @param {string} text raw console output (may contain ANSI codes)
 * @returns {Map<string,string>}
 */
export function parseConsoleFailures(text) {
  const out = new Map()
  const lines = stripAnsi(text).split('\n')

  let block = null // string[] currently-accumulating error message, or null
  let lastMessage = '' // most recently *completed* message, awaiting its (fail) line

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    const failM = line.match(FAIL_LINE)
    if (failM) {
      // The block (if still open) completes here; flush it.
      if (block) {
        lastMessage = block.join('\n').trim()
        block = null
      }
      if (lastMessage) out.set(failM[1].trim(), lastMessage)
      lastMessage = ''
      continue
    }

    if (block) {
      // We're inside a message block. A stack line ends it.
      if (STACK_LINE.test(line)) {
        lastMessage = block.join('\n').trim()
        block = null
      } else {
        block.push(line)
      }
      continue
    }

    // Not in a block: does this line start one?
    if (ERROR_LINE.test(line)) {
      block = [line]
      lastMessage = ''
    }
  }

  return out
}

/**
 * Parse JUnit XML into a flat list of testcases.
 * Each entry: { name, classname, file, line, isFailed, isSkipped, type, raw }
 * where `raw` is the exact `<testcase …>…</testcase>` (or self-closed) text so
 * enrichJUnit can do a precise string replacement.
 */
export function parseTestcases(xml) {
  const attrs = (s) => {
    const o = {}
    for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) o[m[1]] = unescapeXml(m[2])
    return o
  }
  const cases = []
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1])
    const inner = m[3] ?? ''
    const isFailed = /<(failure|error)\b/.test(inner)
    const isSkipped = /<skipped\b/.test(inner)
    let type = ''
    let bodyMessage = ''
    if (isFailed) {
      const fm =
        inner.match(/<(?:failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>/) ||
        inner.match(/<(?:failure|error)\b([^>]*)\/>/)
      if (fm) {
        const fa = attrs(fm[1])
        type = fa.type || ''
        bodyMessage = (fa.message || (fm[2] ? unescapeXml(fm[2].trim()) : '')).trim()
      }
    }
    cases.push({
      name: a.name || '',
      classname: a.classname || '',
      file: a.file || '',
      line: a.line || '',
      isFailed,
      isSkipped,
      type,
      bodyMessage,
      raw: m[0],
    })
  }
  return cases
}

/**
 * Reconstruct the console `(fail)` fullName for a JUnit testcase.
 *
 * Bun's JUnit `classname` is the describe ancestry **reversed** (innermost
 * first), " > "-joined and double-escaped; the console prints it outermost-first
 * with the test title appended. e.g. classname "inner nested > outer",
 * name "deeply nested fail" → "outer > inner nested > deeply nested fail".
 * Top-level tests have an empty classname → fullName is just the name.
 */
export function junitFullName(tc) {
  const cls = (tc.classname || '').trim()
  if (!cls) return tc.name
  const ancestors = cls
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse()
  return [...ancestors, tc.name].join(' > ')
}

/**
 * Match parsed console messages to failing testcases.
 * Returns a Map<rawTestcaseString, message> for the cases we can confidently
 * enrich. Matching strategy, in order:
 *   1. exact fullName match (reconstructed describe path + title)
 *   2. a console fullName that uniquely ends-with the testcase title
 *   3. single-failure / single-message fallback
 * Anything unmatched is left out (caller keeps it type-only — never crashes).
 *
 * @param {ReturnType<typeof parseTestcases>} cases
 * @param {Map<string,string>} messages
 * @returns {Map<string,string>} keyed by testcase.raw
 */
export function matchMessages(cases, messages) {
  const matched = new Map()
  const failed = cases.filter((c) => c.isFailed)
  const used = new Set() // console fullNames already consumed

  // 1) exact fullName.
  for (const tc of failed) {
    const full = junitFullName(tc)
    if (messages.has(full) && !used.has(full)) {
      matched.set(tc.raw, messages.get(full))
      used.add(full)
    }
  }

  // 2) unique endsWith on the test title (handles describe-path mismatches).
  for (const tc of failed) {
    if (matched.has(tc.raw)) continue
    const suffix = ` > ${tc.name}`
    const hits = [...messages.keys()].filter(
      (k) => !used.has(k) && (k === tc.name || k.endsWith(suffix)),
    )
    if (hits.length === 1) {
      matched.set(tc.raw, messages.get(hits[0]))
      used.add(hits[0])
    }
  }

  // 3) single-failure / single-message fallback.
  const remaining = failed.filter((c) => !matched.has(c.raw))
  const freeMsgs = [...messages.entries()].filter(([k]) => !used.has(k))
  if (remaining.length === 1 && freeMsgs.length === 1) {
    matched.set(remaining[0].raw, freeMsgs[0][1])
    used.add(freeMsgs[0][0])
  }

  return matched
}

/**
 * Rewrite JUnit XML, merging messages into matched `<failure>`/`<error>`
 * elements. Each enriched element becomes:
 *   <failure type="…" message="<escaped first line>"><![CDATA[\n<msg>\n]]></failure>
 * Unmatched testcases are left exactly as-is. With an empty message map this is
 * a no-op (returns the input unchanged).
 *
 * @param {string} xml
 * @param {Map<string,string>} messages  console fullName → message
 * @returns {string} enriched XML
 */
export function enrichJUnit(xml, messages) {
  if (!messages || messages.size === 0) return xml
  const cases = parseTestcases(xml)
  const matched = matchMessages(cases, messages)
  if (matched.size === 0) return xml

  let out = xml
  for (const [rawCase, message] of matched) {
    const firstLine = message.split('\n')[0].trim()
    // Replace the first <failure …/> or <failure …>…</failure> inside this case.
    const enrichedCase = rawCase.replace(
      /<(failure|error)\b([^>]*?)(?:\s*\/>|>[\s\S]*?<\/\1>)/,
      (_m, tag, rawAttrs) => {
        // Keep a `type` attr if present; drop any old message attr.
        const typeM = rawAttrs.match(/\btype="([^"]*)"/)
        const type = typeM ? unescapeXml(typeM[1]) : ''
        const typeAttr = type ? ` type="${escapeXmlAttr(type)}"` : ''
        return (
          `<${tag}${typeAttr} message="${escapeXmlAttr(firstLine)}">` +
          `<![CDATA[\n${cdataSafe(message)}\n]]></${tag}>`
        )
      },
    )
    out = out.replace(rawCase, enrichedCase)
  }
  return out
}

/** Make a string safe to embed in a CDATA section (escape the `]]>` sentinel). */
function cdataSafe(s) {
  return s.replace(/]]>/g, ']]]]><![CDATA[>')
}

// ──────────────────────────────────────────────────────────────────────────
// Top-level run (only when executed directly, not when imported by tests).
// ──────────────────────────────────────────────────────────────────────────

/** Append Markdown to the job summary, or print it when running locally. */
function emitSummary(markdown) {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (target) appendFileSync(target, markdown + '\n')
  else process.stdout.write(markdown + '\n')
}

const fmt = (sec) => {
  const ms = sec * 1000
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

function main() {
  const reportPath = process.argv[2] ?? './reports/junit.xml'
  const consolePath = process.argv[3]

  let xml
  try {
    xml = readFileSync(reportPath, 'utf8')
  } catch (err) {
    emitSummary(
      `### API tests\n\n> ⚠️ No JUnit report at \`${reportPath}\` (${err.code ?? err.message}).`,
    )
    process.exit(0)
  }

  // Merge console messages into the JUnit (and write the enriched file back).
  let messages = new Map()
  if (consolePath) {
    try {
      const consoleText = readFileSync(consolePath, 'utf8')
      messages = parseConsoleFailures(consoleText)
    } catch (err) {
      // Console log is best-effort; missing/unreadable → behave as type-only.
      process.stderr.write(
        `ci-summary: could not read console log \`${consolePath}\` (${err.code ?? err.message}); ` +
          `falling back to type-only messages.\n`,
      )
    }
    if (messages.size) {
      const enriched = enrichJUnit(xml, messages)
      if (enriched !== xml) {
        try {
          writeFileSync(reportPath, enriched)
          xml = enriched
        } catch (err) {
          process.stderr.write(
            `ci-summary: could not write enriched JUnit back to \`${reportPath}\` (${err.code ?? err.message}).\n`,
          )
        }
      }
    }
  }

  // Overall totals from the root <testsuites …> element (Bun populates these).
  const attrs = (s) => {
    const o = {}
    for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) o[m[1]] = unescapeXml(m[2])
    return o
  }
  const rootM = xml.match(/<testsuites\b([^>]*)>/)
  const root = rootM ? attrs(rootM[1]) : {}
  let total = Number(root.tests ?? 0)
  let failed = Number(root.failures ?? 0)
  let skipped = Number(root.skipped ?? 0)
  const wallSec = Number(root.time ?? 0)

  // Build per-testcase view, resolving each failure's display message:
  // enriched message (from console) > body/attr message > type.
  const parsed = parseTestcases(xml)
  const matched = messages.size ? matchMessages(parsed, messages) : new Map()
  const cases = parsed.map((c) => {
    let message = ''
    if (c.isFailed) {
      message = (matched.get(c.raw) || c.bodyMessage || c.type || '').trim()
    }
    return { ...c, message }
  })

  if (!rootM || root.tests == null) {
    total = cases.length
    failed = cases.filter((c) => c.isFailed).length
    skipped = cases.filter((c) => c.isSkipped).length
  }
  const passed = total - failed - skipped
  const ok = failed === 0

  // 1) Annotations for each failure (stdout workflow commands). Cap the body to
  // the first ~10 lines so the annotation stays readable.
  for (const c of cases.filter((c) => c.isFailed)) {
    const file = c.file || ''
    const line = c.line || ''
    const title = c.name || 'Test failed'
    const full = c.message || 'Test failed'
    const capped = full.split('\n').slice(0, 10).join('\n')
    const body = capped.length > 2000 ? capped.slice(0, 2000) + '\n… (truncated)' : capped
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
        lines.push(
          c.message.length > 3000 ? c.message.slice(0, 3000) + '\n… (truncated)' : c.message,
        )
        lines.push('```')
      }
      lines.push('')
    }
    lines.push('</details>')
  }

  emitSummary(lines.join('\n'))
}

// Guard the run-on-import so tests can import the pure helpers (Bun sets
// `import.meta.main` true only for the directly-executed entry module).
if (import.meta.main) main()

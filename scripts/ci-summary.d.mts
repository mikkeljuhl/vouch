// Type declarations for the dependency-free CI reporting script
// (`ci-summary.mjs` is authored as plain JS so it runs under bare Node/Bun with
// no build step; these ambient types let the unit tests import it type-safely).

/** Strip ANSI/VT escape sequences from a string. */
export function stripAnsi(s: string): string

/** Decode the XML entities that appear in JUnit attributes/text. */
export function unescapeXml(s: string): string

/** Escape a string for use inside a double-quoted XML attribute value. */
export function escapeXmlAttr(s: string): string

/** Encode a string for a GitHub Actions workflow command (annotations). */
export function encodeCmd(s: string): string

/** Parse a Bun console log into a map of `fullName` → assertion message. */
export function parseConsoleFailures(text: string): Map<string, string>

export interface JUnitTestcase {
  name: string
  classname: string
  file: string
  line: string
  isFailed: boolean
  isSkipped: boolean
  type: string
  bodyMessage: string
  raw: string
}

/** Parse JUnit XML into a flat list of testcases. */
export function parseTestcases(xml: string): JUnitTestcase[]

/** Reconstruct the console `(fail)` fullName for a JUnit testcase. */
export function junitFullName(tc: { name: string; classname?: string }): string

/** Match parsed console messages to failing testcases, keyed by `testcase.raw`. */
export function matchMessages(
  cases: JUnitTestcase[],
  messages: Map<string, string>,
): Map<string, string>

/** Rewrite JUnit XML, merging messages into matched `<failure>` elements. */
export function enrichJUnit(xml: string, messages?: Map<string, string>): string

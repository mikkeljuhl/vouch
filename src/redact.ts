/**
 * Secret redaction (DESIGN.md §4/§8). Two leak surfaces are protected:
 *
 *  1. **Debug dumps** (see `./builder` dump): sensitive *header* values are
 *     masked, and configured `bodyKeys` are masked in JSON request/response
 *     bodies.
 *  2. **Assertion diffs**: `bodyKeys` are threaded into the matchers so a masked
 *     value (`"***"`) is rendered for any diff path whose final key is a body
 *     key — which then propagates into the console / JUnit / GitHub annotations
 *     (all derived from the `AssertionError` message).
 *
 * Everything here is pure and unit-testable; no I/O, no process state.
 */

/** The mask substituted for any redacted value. */
export const REDACTION_MASK = '***'

/**
 * Built-in set of sensitive header names (lowercased). Always masked inside
 * debug dumps so credentials never leak, even when no `redact` option is given.
 * Merged with any user-supplied `redact.headers`.
 */
export const DEFAULT_SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'api-key',
]

/** Configuration for redaction; both lists are optional. */
export interface RedactOptions {
  /**
   * Extra header names to mask (case-insensitive), merged with
   * {@link DEFAULT_SENSITIVE_HEADERS}.
   */
  headers?: string[]
  /**
   * JSON property names whose values are masked wherever they appear (in debug
   * bodies and in assertion diffs). We cannot guess these, so by default none
   * are masked.
   */
  bodyKeys?: string[]
}

/**
 * Return a new header record with the values of any sensitive header masked.
 * `names` is merged with {@link DEFAULT_SENSITIVE_HEADERS} and matched
 * case-insensitively. Non-sensitive headers pass through unchanged.
 */
export function redactHeaders(
  headers: Record<string, string>,
  names: readonly string[] = [],
): Record<string, string> {
  const sensitive = new Set(
    [...DEFAULT_SENSITIVE_HEADERS, ...names].map((n) => n.toLowerCase()),
  )
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = sensitive.has(name.toLowerCase()) ? REDACTION_MASK : value
  }
  return out
}

/**
 * Deep-clone `value`, masking the value of any object property whose key is in
 * `keys`. Recurses through nested objects and arrays; leaves all other values
 * untouched. Matching is exact (case-sensitive) on the JSON property name.
 * Returns the input unchanged when `keys` is empty.
 */
export function redactBodyKeys(value: unknown, keys: readonly string[] = []): unknown {
  if (keys.length === 0) return value
  const keySet = new Set(keys)
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = keySet.has(k) ? REDACTION_MASK : walk(v)
      }
      return out
    }
    return node
  }
  return walk(value)
}

/**
 * Best-effort masking of `bodyKeys` inside a textual body for a debug dump: if
 * `text` parses as JSON, mask matching keys and re-stringify; otherwise return
 * the text unchanged (we don't guess at non-JSON formats).
 */
export function redactBodyText(text: string, keys: readonly string[] = []): string {
  if (keys.length === 0) return text
  try {
    const parsed = JSON.parse(text)
    return JSON.stringify(redactBodyKeys(parsed, keys))
  } catch {
    return text
  }
}

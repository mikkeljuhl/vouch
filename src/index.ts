/**
 * The package version. Re-exported from the generated `./version` module, which
 * `scripts/gen-version.mjs` writes from package.json (the single source of truth)
 * during `prepare`. This keeps `VERSION` a plain static constant — no top-level
 * `await`, no `Bun.file` read — so importing the package never crashes on a
 * non-Bun runtime, and the runner-agnostic assertion layer is importable anywhere.
 */
export { VERSION } from './version'

export { createClient, DEFAULT_TIMEOUT_MS, resolveDebugMode } from './client'
export type {
  Client,
  ClientOptions,
  HeaderValue,
  RetryOptions,
  RequestOptions,
  HttpMethod,
  OutgoingRequest,
  CookieJar,
  DebugMode,
} from './client'
export { computeRetryDelay, parseRetryAfter, formatDebugDump } from './builder'
export type { RequestBuilder, ApiResponse } from './builder'
export { AssertionError } from './assert'
export type { AssertContext, SchemaInput, StandardSchemaV1 } from './assert'
export { fixture } from './fixtures'
export {
  redactHeaders,
  redactBodyKeys,
  redactBodyText,
  DEFAULT_SENSITIVE_HEADERS,
  REDACTION_MASK,
} from './redact'
export type { RedactOptions } from './redact'

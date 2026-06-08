/**
 * The package version. Re-exported from the generated `./version` module, which
 * `scripts/gen-version.mjs` writes from package.json (the single source of truth)
 * during `prepare`. This keeps `VERSION` a plain static constant — no top-level
 * `await`, no `Bun.file` read — so importing the package never crashes on a
 * non-Bun runtime, and the runner-agnostic assertion layer is importable anywhere.
 */
export { VERSION } from './version.js'

export { createClient, DEFAULT_TIMEOUT_MS, resolveDebugMode } from './client.js'
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
} from './client.js'
export { computeRetryDelay, parseRetryAfter, formatDebugDump } from './builder.js'
export type { RequestBuilder, ApiResponse } from './builder.js'
export { AssertionError } from './assert.js'
export type { AssertContext, SchemaInput, StandardSchemaV1 } from './assert.js'
export { fixture } from './fixtures.js'
export {
  redactHeaders,
  redactBodyKeys,
  redactBodyText,
  DEFAULT_SENSITIVE_HEADERS,
  REDACTION_MASK,
} from './redact.js'
export type { RedactOptions } from './redact.js'

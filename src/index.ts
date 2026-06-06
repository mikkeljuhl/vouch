/**
 * The package version — read from package.json at import time so it is the single
 * source of truth (never drifts from the manifest). Resolved relative to this
 * module, so it works whether running from source (Bun) or as an installed dep.
 *
 * Uses a top-level `await` over `Bun.file(...).json()` (Bun-native; the framework
 * targets Bun as its only runtime). Top-level await is valid in Bun ESM and under
 * tsc with `module: ESNext`.
 */
export const VERSION: string = (
  await Bun.file(new URL('../package.json', import.meta.url)).json()
).version

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

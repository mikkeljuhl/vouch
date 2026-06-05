import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The package version — read from package.json at import time so it is the single
 * source of truth (never drifts from the manifest). Resolved relative to this
 * module, so it works whether running from source (Bun) or as an installed dep.
 */
export const VERSION: string = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
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

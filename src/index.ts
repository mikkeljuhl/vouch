export const VERSION = '0.0.0'

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

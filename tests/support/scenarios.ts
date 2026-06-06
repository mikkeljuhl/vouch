/**
 * Test helper: higher-level SCENARIO runners that DRY the breadth of the
 * integration suite. They DRIVE the framework (issue real requests via a passed
 * `Client`) and RETURN structured results, leaving the assertions to the caller —
 * so each test stays explicit about what it pins while shedding the loop/threading
 * boilerplate.
 *
 * Three families, mirroring the integration files:
 *  - {@link hitStatusCodes}  — a status-code table runner (methods-status.test.ts'
 *    status matrix): hit `/status/:code` for each code, return the responses.
 *  - {@link crudLifecycle}   — a create→read→update→patch→delete runner against
 *    `/posts` (methods-status.test.ts' "chained CRUD lifecycle"), returning every
 *    step so the caller can assert the threaded id + echoed/merged bodies.
 *  - {@link runFlaky} / {@link runRetryAfter} — wrappers around `/flaky/:key` and
 *    `/retry-after/:key` (resilience.test.ts) that issue a request with a retry
 *    policy and return the outcome (status, body, attempts via `x-attempt`).
 *
 * Composable + typed; imports only types from the framework.
 */

import type { ApiResponse, Client } from '../../src/index'

// ─── Status-code table ──────────────────────────────────────────────────────

/** One row of a status-table run: the requested code and the response it got. */
export interface StatusResult {
  /** The code requested at `/status/:code`. */
  code: number
  /** The status the framework actually surfaced (should equal `code`). */
  status: number
  /** The parsed body (the mock returns `{ code }` for JSON statuses). */
  body: unknown
  /** The full awaited response, for any extra assertions. */
  res: ApiResponse<unknown>
}

/** Options for {@link hitStatusCodes}. */
export interface StatusTableOptions {
  /** Request `?type=text` so the mock returns a `text/plain` body. */
  asText?: boolean
}

/**
 * GET `/status/:code` for each code (sequentially, so per-key server state stays
 * deterministic) and return one {@link StatusResult} per code. The caller asserts:
 *
 *   for (const r of await hitStatusCodes(client, [200, 404, 500]))
 *     expect(r.status).toBe(r.code)
 */
export async function hitStatusCodes(
  client: Client,
  codes: number[],
  options: StatusTableOptions = {},
): Promise<StatusResult[]> {
  const results: StatusResult[] = []
  for (const code of codes) {
    let b = client.get<unknown>(`/status/${code}`)
    if (options.asText) b = b.query({ type: 'text' })
    const res = await b
    results.push({ code, status: res.status, body: res.body, res })
  }
  return results
}

// ─── CRUD lifecycle ─────────────────────────────────────────────────────────

/** A single post-shaped body used across the CRUD lifecycle. */
export interface PostBody {
  id?: number
  userId?: number
  title?: string
  body?: string
}

/** The five steps of {@link crudLifecycle}, each carrying its awaited response. */
export interface CrudLifecycleResult {
  /** POST /posts → 201, body echoed with id 101. */
  created: ApiResponse<PostBody>
  /** The id assigned by the create step (101 for the mock). */
  createdId: number
  /** GET /posts/:readId (defaults to the seeded id 1). */
  read: ApiResponse<PostBody>
  /** PUT /posts/:readId — body echoed verbatim. */
  updated: ApiResponse<PostBody>
  /** PATCH /posts/:readId — fields merged over the existing resource. */
  patched: ApiResponse<PostBody>
  /** DELETE /posts/:readId → 200 {}. */
  deleted: ApiResponse<Record<string, never>>
}

/** Options for {@link crudLifecycle}. */
export interface CrudLifecycleOptions {
  /** Body for the POST create step. Default: a labeled lifecycle post. */
  createBody?: PostBody
  /**
   * Which existing (seeded) post id to read/update/patch/delete. The mock only
   * persists seeds, so the create id (101) is not itself readable — default 1.
   */
  readId?: number
  /** Fields for the PUT update step. Default: a full replacement body. */
  updateBody?: PostBody
  /** Fields for the PATCH step. Default: `{ body: 'patched body' }`. */
  patchBody?: PostBody
}

/**
 * Run a full create→read→update→patch→delete lifecycle against `/posts`,
 * threading the read id through PUT/PATCH/DELETE, and return every step's
 * response. No assertions are made here — the caller pins what matters:
 *
 *   const r = await crudLifecycle(client)
 *   expect(r.created.status).toBe(201)
 *   expect(r.patched.body.body).toBe('patched body')
 */
export async function crudLifecycle(
  client: Client,
  options: CrudLifecycleOptions = {},
): Promise<CrudLifecycleResult> {
  const createBody = options.createBody ?? { userId: 1, title: 'lifecycle', body: 'created' }
  const readId = options.readId ?? 1
  const updateBody =
    options.updateBody ?? { id: readId, userId: 1, title: 'updated', body: 'updated body' }
  const patchBody = options.patchBody ?? { body: 'patched body' }

  const created = await client.post<PostBody>('/posts').json(createBody)
  const createdId = (created.body as { id?: number }).id ?? -1

  const read = await client.get<PostBody>(`/posts/${readId}`)
  const updated = await client.put<PostBody>(`/posts/${readId}`).json(updateBody)
  const patched = await client.patch<PostBody>(`/posts/${readId}`).json(patchBody)
  const deleted = await client.delete<Record<string, never>>(`/posts/${readId}`)

  return { created, createdId, read, updated, patched, deleted }
}

// ─── Retry / flaky ──────────────────────────────────────────────────────────

/** Shared retry policy shape (subset of the framework's RetryOptions). */
export interface FlakyRetry {
  times: number
  when?: (res: Response) => boolean
}

/** Options for {@link runFlaky}. */
export interface FlakyOptions {
  /**
   * Unique per-key path segment so the server's attempt counter is isolated per
   * scenario (order-independent). Default: a random key.
   */
  key?: string
  /** How many leading attempts fail before a 200 (mock `?fails=`). Default 1. */
  fails?: number
  /** The failing status the mock returns (mock `?status=`). Default 503. */
  status?: number
  /** The retry policy passed to `.retry()`. Default `{ times: fails }`. */
  retry?: FlakyRetry
}

/** Outcome of a {@link runFlaky}/{@link runRetryAfter} run. */
export interface FlakyResult<T = unknown> {
  /** The final surfaced status. */
  status: number
  /** The final parsed body. */
  body: T
  /**
   * The attempt number the final response was produced on, read from the mock's
   * `x-attempt` header (so `attempts === fails + 1` proves it retried, and
   * `=== 1` proves it did not).
   */
  attempts: number
  /** The full awaited response. */
  res: ApiResponse<T>
}

function attemptsOf(res: ApiResponse<unknown>): number {
  return Number(res.headers.get('x-attempt') ?? '0')
}

/**
 * Drive `/flaky/:key` with a retry policy and return the outcome (status, body,
 * and the attempt count via `x-attempt`). The caller asserts whether/how it
 * retried:
 *
 *   const r = await runFlaky(client, { fails: 2, retry: { times: 3 } })
 *   expect(r.status).toBe(200); expect(r.attempts).toBe(3)
 */
export async function runFlaky<T = unknown>(
  client: Client,
  options: FlakyOptions = {},
): Promise<FlakyResult<T>> {
  const key = options.key ?? `flaky-${crypto.randomUUID()}`
  const fails = options.fails ?? 1
  const status = options.status ?? 503
  const retry = options.retry ?? { times: fails }

  const res = await client
    .get<T>(`/flaky/${key}`)
    .query({ fails, status })
    .retry(retry)

  return { status: res.status, body: res.body, attempts: attemptsOf(res), res }
}

/** Options for {@link runRetryAfter}. */
export interface RetryAfterOptions {
  /** Unique per-key path segment (isolates the counter). Default: random. */
  key?: string
  /** How many leading attempts return 429 before a 200. Default 1. */
  fails?: number
  /** The `Retry-After` seconds the mock advertises on the 429. Default 0. */
  seconds?: number
  /** The retry policy passed to `.retry()`. Default `{ times: fails }`. */
  retry?: FlakyRetry
}

/**
 * Drive `/retry-after/:key` (429 + `Retry-After`) with a retry policy and return
 * the outcome. Set `seconds > 0` to exercise the honor-the-delay path (the caller
 * can time the call); `attempts` confirms the 429 was retried.
 *
 *   const r = await runRetryAfter(client, { fails: 1, seconds: 0, retry: { times: 2 } })
 *   expect(r.status).toBe(200); expect(r.attempts).toBe(2)
 */
export async function runRetryAfter<T = unknown>(
  client: Client,
  options: RetryAfterOptions = {},
): Promise<FlakyResult<T>> {
  const key = options.key ?? `retry-after-${crypto.randomUUID()}`
  const fails = options.fails ?? 1
  const seconds = options.seconds ?? 0
  const retry = options.retry ?? { times: fails }

  const res = await client
    .get<T>(`/retry-after/${key}`)
    .query({ fails, seconds })
    .retry(retry)

  return { status: res.status, body: res.body, attempts: attemptsOf(res), res }
}

/**
 * Dogfood example — a real multipart file upload that round-trips through a live
 * echo endpoint. This proves `.multipart()/.file()` and the `fixture()` helper
 * end to end (correct multipart boundary set by fetch, the file bytes arriving
 * intact) against a real server, not just a mock.
 *
 * Endpoint: postman-echo.com/post. We chose it over httpbin.org because httbin
 * was returning 503s from the sandbox at authoring time, while postman-echo was
 * reliably 200. postman-echo echoes uploaded files under `.files` keyed by
 * FILENAME (not the field name) as a `data:` URL, and string fields under
 * `.form`. Both are accepted by the framework's default JSON parsing.
 *
 * Kept resilient: this is a live network test. If the endpoint is unreachable it
 * will fail loudly (a thrown transport error) rather than silently pass; the
 * authoritative, deterministic coverage lives in `tests/upload.test.ts`.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { createClient, fixture, type Client } from '../../src/index'

interface EchoResponse {
  files: Record<string, string>
  form: Record<string, string>
  headers: Record<string, string>
}

describe('upload (live: postman-echo)', () => {
  let client: Client

  beforeAll(() => {
    client = createClient({
      baseUrl: process.env.API_BASE_URL || 'https://postman-echo.com',
      timeoutMs: 20_000,
      retry: { times: 0 },
    })
  })

  test('multipart file upload round-trips the zip + a field', async () => {
    const zip = fixture(import.meta.url, '../fixtures/sample.zip', 'application/zip')

    const res = await client
      .post<EchoResponse>('/post')
      .multipart({ note: 'hello' })
      .file('archive', zip, 'sample.zip')
      .expectStatus(200)

    // fetch set a multipart/form-data content-type with a boundary.
    expect(res.body.headers['content-type']).toMatch(/multipart\/form-data; *boundary=/)
    // The string field round-tripped under `.form`.
    expect(res.body.form.note).toBe('hello')
    // postman-echo keys uploaded files by filename; assert ours arrived.
    expect(Object.keys(res.body.files)).toContain('sample.zip')
    expect(res.body.files['sample.zip']).toContain('base64')
  })
})

/**
 * Dogfood example — a real multipart file upload that round-trips through the
 * in-process `Bun.serve` mock's echo endpoint. This proves `.multipart()/.file()`
 * and the `fixture()` helper end to end (correct multipart boundary set by fetch,
 * the file bytes arriving intact) over real HTTP, while staying hermetic — no
 * external network, deterministic, runnable offline.
 *
 * Endpoint: POST /post on the mock. It parses `await request.formData()` and
 * returns a controlled shape:
 *   { headers: { 'content-type': ... }, form: {<text fields>}, files: { <filename>: <data: URL> } }
 * Files are keyed by FILENAME, echoed as a base64 `data:` URL so we can assert the
 * bytes arrived. String fields are echoed under `.form`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient, fixture, type Client } from '../../src/index'
import { startMockServer } from '../support/mock-server'

interface EchoResponse {
  files: Record<string, string>
  form: Record<string, string>
  headers: Record<string, string>
}

describe('upload (mock server)', () => {
  let client: Client
  let server: { url: string; stop(): void }

  beforeAll(() => {
    server = startMockServer()
    client = createClient({
      baseUrl: process.env.API_BASE_URL || server.url,
      timeoutMs: 20_000,
      retry: { times: 0 },
    })
  })

  afterAll(() => server.stop())

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
    // The mock keys uploaded files by filename; assert ours arrived.
    expect(Object.keys(res.body.files)).toContain('sample.zip')
    // The mock echoes file bytes as a base64 data: URL, declaring our content-type.
    expect(res.body.files['sample.zip']).toContain('base64')
    expect(res.body.files['sample.zip']).toContain('application/zip')
  })
})

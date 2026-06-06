/**
 * Dogfood example — UPLOAD = multipart bodies + the `fixture()` helper.
 *
 * This file shows how to send a real `multipart/form-data` request: text fields
 * via `.multipart()`, a file via `.file()`, and the bytes loaded from disk with
 * the `fixture()` helper. It round-trips through the mock's echo endpoint to prove
 * the file arrives intact over real HTTP — while staying hermetic (no external
 * network, deterministic, runnable offline).
 *
 * Setup (start/stop the mock) is delegated to `useMockServer()`; the builder chain
 * is kept INLINE so the multipart usage reads as reference material.
 *
 * Endpoint: POST /post on the mock. It parses `await request.formData()` and
 * returns a controlled shape:
 *   { headers: { 'content-type': ... }, form: {<text fields>}, files: { <filename>: <data: URL> } }
 * Files are keyed by FILENAME, echoed as a base64 `data:` URL so we can assert the
 * bytes arrived. String fields are echoed under `.form`.
 */

import { describe, expect, test } from 'bun:test'
import { fixture } from '../../src/index'
import { useMockServer } from '../support/mock-client'

interface EchoResponse {
  files: Record<string, string>
  form: Record<string, string>
  headers: Record<string, string>
}

describe('upload (mock server) — multipart + fixture()', () => {
  const mock = useMockServer()

  test('multipart file upload round-trips the zip + a text field', async () => {
    // fixture(baseUrl, relativePath, contentType) loads bytes relative to THIS
    // module and tags them with a content-type — the ergonomic way to attach a
    // file that lives next to your test.
    const zip = fixture(import.meta.url, '../fixtures/sample.zip', 'application/zip')

    const res = await mock
      .client()
      .post<EchoResponse>('/post')
      // .multipart() sets the body to form-data and seeds the text fields.
      .multipart({ note: 'hello' })
      // .file(fieldName, data, filename) attaches a file part. fetch computes the
      // multipart boundary for us; no manual content-type wrangling.
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

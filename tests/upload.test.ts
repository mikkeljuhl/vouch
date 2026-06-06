/**
 * Mocked, deterministic tests for the file/body upload surface (DESIGN.md §4):
 * `.body()`, `.form()`, `.multipart()`, `.file()`, the auto-content-type switch,
 * the ReadableStream+retry guard, and the `fixture()` helper. fetch is stubbed
 * via the shared helper (auto-restored) so nothing leaks into the live suite.
 */

import { describe, expect, test } from 'bun:test'
import { createClient } from '../src/client'
import { fixture } from '../src/fixtures'
import { installMockFetch } from './support/mock-fetch'

describe('upload / body surface (mocked fetch)', () => {
  const fetch = installMockFetch()

  const client = () => createClient({ baseUrl: 'https://api.example.com' })

  /** Lowercase header lookup over the normalized headers record of a call. */
  function header(headers: Record<string, string>, name: string): string | undefined {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? headers[key] : undefined
  }

  test('.multipart().file() sends a FormData with the field + file, no content-type from us', async () => {
    fetch.json({ ok: true })
    const blob = new Blob(['PK\x03\x04zip-bytes'], { type: 'application/zip' })
    await client().post('/upload').multipart({ a: '1' }).file('archive', blob, 'x.zip')

    const { init, headers } = fetch.lastCall!
    expect(init!.body).toBeInstanceOf(FormData)
    const fd = init!.body as FormData
    expect(fd.get('a')).toBe('1')
    const part = fd.get('archive') as File
    expect(part).toBeInstanceOf(Blob)
    expect((part as File).name).toBe('x.zip')

    // We must NOT set content-type so fetch can add the multipart boundary.
    expect(header(headers, 'content-type')).toBeUndefined()
  })

  test('.file() auto-creates the FormData without a prior .multipart()', async () => {
    fetch.json({ ok: true })
    const blob = new Blob(['data'])
    await client().post('/upload').file('f', blob, 'a.bin')
    const fd = fetch.lastCall!.init!.body as FormData
    expect(fd).toBeInstanceOf(FormData)
    expect((fd.get('f') as File).name).toBe('a.bin')
  })

  test('.file() filename defaults to the File name, else the field name', async () => {
    fetch.json({ ok: true })
    const named = new File(['x'], 'orig.txt')
    const plain = new Blob(['y'])
    await client().post('/u').file('withFile', named).file('withBlob', plain)
    const fd = fetch.lastCall!.init!.body as FormData
    expect((fd.get('withFile') as File).name).toBe('orig.txt')
    expect((fd.get('withBlob') as File).name).toBe('withBlob')
  })

  test('.form() sends URLSearchParams and sets no manual content-type', async () => {
    fetch.json({ ok: true })
    await client().post('/login').form({ u: 'ada', p: 'x' })
    const { init, headers } = fetch.lastCall!
    expect(init!.body).toBeInstanceOf(URLSearchParams)
    expect((init!.body as URLSearchParams).get('u')).toBe('ada')
    // fetch sets application/x-www-form-urlencoded itself; we set nothing.
    expect(header(headers, 'content-type')).toBeUndefined()
  })

  test('.body(blob) with a user content-type sends the blob + the user header', async () => {
    fetch.json({ ok: true })
    const blob = new Blob(['PK\x03\x04'], { type: 'application/zip' })
    await client()
      .post('/raw')
      .body(blob)
      .headers({ 'content-type': 'application/zip' })
    const { init, headers } = fetch.lastCall!
    expect(init!.body).toBe(blob)
    expect(header(headers, 'content-type')).toBe('application/zip')
  })

  test('content-type switch: .json().multipart() ends with NO content-type', async () => {
    fetch.json({ ok: true })
    await client().post('/x').json({ a: 1 }).multipart({ b: '2' })
    const { init, headers } = fetch.lastCall!
    expect(init!.body).toBeInstanceOf(FormData)
    expect(header(headers, 'content-type')).toBeUndefined()
  })

  test('.json() alone sets application/json', async () => {
    fetch.json({ ok: true })
    await client().post('/x').json({ a: 1 })
    const { init, headers } = fetch.lastCall!
    expect(header(headers, 'content-type')).toBe('application/json')
    expect(init!.body).toBe(JSON.stringify({ a: 1 }))
  })

  test('user .headers() content-type wins over the auto json content-type', async () => {
    fetch.json({ ok: true })
    await client().post('/x').json({ a: 1 }).headers({ 'content-type': 'application/vnd.custom+json' })
    expect(header(fetch.lastCall!.headers, 'content-type')).toBe('application/vnd.custom+json')
  })

  test('retry guard: a ReadableStream body with retry rejects with a clear error', async () => {
    fetch.json({ ok: true })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'))
        controller.close()
      },
    })
    await expect(
      client().post('/upload').body(stream).retry({ times: 1 }).send(),
    ).rejects.toThrow(/ReadableStream body cannot be retried/)
  })

  test('retry guard: a Blob body with retry is fine', async () => {
    fetch.json({ ok: true })
    const blob = new Blob(['ok'], { type: 'application/octet-stream' })
    await expect(
      client().post('/upload').body(blob).retry({ times: 1 }).send(),
    ).resolves.toBeDefined()
    expect(fetch.lastCall!.init!.body).toBe(blob)
  })

  test('a ReadableStream body with no retry is allowed', async () => {
    fetch.json({ ok: true })
    const stream = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })
    await expect(client().post('/upload').body(stream).send()).resolves.toBeDefined()
  })

  test('fixture() returns a Blob with the file byte length', async () => {
    const zip = fixture(import.meta.url, './fixtures/sample.zip', 'application/zip')
    expect(zip).toBeInstanceOf(Blob)
    expect(zip.type).toBe('application/zip')
    expect(zip.size).toBeGreaterThan(0)
    const bytes = new Uint8Array(await zip.arrayBuffer())
    // Local file header magic "PK\x03\x04".
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
  })
})

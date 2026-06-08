/**
 * Node + vitest portability smoke.
 *
 * Imports from the BUILT `../../dist/index.js` (not `src/*.ts`), so this
 * exercises exactly what an npm consumer would load under Node. Runs against a
 * one-off `node:http` server — the dogfood mock-server uses `Bun.serve` and
 * isn't usable here. Scope is intentionally tiny: each seam where Bun/Node
 * actually differ (file fixture loading, `globalThis.Bun` runtime detection,
 * `Set-Cookie` parsing via `getSetCookie`, multipart `FormData` upload). The
 * full assertion/diff/redaction coverage lives in the bun:test suite — we are
 * not duplicating it here.
 *
 * Filename ends `-vitest.ts` (not `.test.ts`) so `bun test`'s default
 * discovery skips it — the Docker image / GitHub Action runs `bun test` over
 * the workspace and has no `dist/` to import. `vitest.config.ts` includes
 * this pattern explicitly.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  AssertionError,
  createClient,
  fixture,
  type Client,
} from '../../dist/index.js'

interface Echo {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(payload)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  if (url.pathname === '/status/200') return send(res, 200, { ok: true })
  if (url.pathname === '/login') {
    res.setHeader('set-cookie', 'sid=abc123; Path=/')
    return send(res, 200, { ok: true })
  }
  if (url.pathname === '/me') {
    const cookie = req.headers.cookie ?? ''
    return send(res, 200, { cookie })
  }
  if (url.pathname === '/echo') {
    const echo: Echo = {
      method: req.method ?? '',
      path: url.pathname,
      headers: req.headers,
      body: await readBody(req),
    }
    return send(res, 200, echo)
  }
  send(res, 404, { error: 'not found' })
}

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res).catch((err) => {
        // Surface server-side errors as 500 so the test fails loudly with context.
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(err))
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('unexpected server address'))
        return
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

describe('vouch on Node + vitest', () => {
  let server: Server
  let baseUrl: string
  let client: Client

  beforeAll(async () => {
    const started = await startServer()
    server = started.server
    baseUrl = started.url
    client = createClient({ baseUrl })
  })

  afterAll(() => {
    server.close()
  })

  test('GET returns 200 and JSON subset matches', async () => {
    await client.get('/status/200').expectStatus(200).expectJson({ ok: true })
  })

  test('response header assertion', async () => {
    await client
      .get('/status/200')
      .expectStatus(200)
      .expectHeader('content-type', /application\/json/)
  })

  test('expectSchema predicate', async () => {
    await client
      .get('/status/200')
      .expectStatus(200)
      .expectSchema((body): boolean => typeof body === 'object' && body !== null && 'ok' in body)
  })

  test('failed assertion throws our AssertionError (no test runner coupling)', async () => {
    let caught: unknown
    try {
      await client.get('/status/200').expectStatus(404)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AssertionError)
    expect((caught as Error).message).toContain('expected status 404')
  })

  test('cookie jar carries Set-Cookie across requests', async () => {
    const jarClient = createClient({ baseUrl, cookies: true })
    await jarClient.post('/login').expectStatus(200)
    expect(jarClient.cookies.get('sid')).toBe('abc123')
    const res = await jarClient.get<{ cookie: string }>('/me').expectStatus(200)
    expect(res.body.cookie).toContain('sid=abc123')
  })

  test('fixture() reads a file as a Blob and uploads via multipart', async () => {
    const blob = fixture(import.meta.url, '../fixtures/sample.zip', 'application/zip')
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(0)
    expect(blob.type).toBe('application/zip')
    const res = await client
      .post('/echo')
      .file('archive', blob, 'sample.zip')
      .expectStatus(200)
    const echoed = res.body as Echo
    expect(echoed.headers['content-type']).toMatch(/multipart\/form-data/)
    expect(echoed.body).toContain('filename="sample.zip"')
  })
})

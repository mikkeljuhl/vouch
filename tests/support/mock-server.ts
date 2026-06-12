/**
 * In-process mock server for the dogfood example + integration suites.
 *
 * Built on Bun's native `Bun.serve` (no dependency) so the tests exercise *real*
 * HTTP + the full framework while staying hermetic: no external network,
 * deterministic responses, runnable offline. `port: 0` lets the OS assign a free
 * port, so parallel test files never collide.
 *
 * Two layers live here:
 *  1. A small, realistic REST API (users / posts / todos + a multipart echo) that
 *     the example suite asserts on. These shapes are a frozen contract — do not
 *     change them.
 *  2. An httpbin-style set of parameterized utility routes (/echo, /status/:code,
 *     /delay/:ms, /flaky/:key, /retry-after/:key, /redirect/:n, /auth, /login,
 *     /me, /text, /html, /empty, /malformed-json) so integration tests can drive
 *     many code paths (retries, redirects, auth, content-types, timeouts...)
 *     without adding bespoke routes, plus /sse/* event-stream routes for the
 *     SSE builder.
 *
 * Per-key stateful routes (/flaky, /retry-after) keep their counters in Maps that
 * are RESET on every startMockServer() call, so each test file gets fresh state.
 */

interface MockUser {
  id: number
  name: string
  username: string
  email: string
}

interface MockPost {
  id: number
  userId: number
  title: string
  body: string
}

interface MockTodo {
  id: number
  userId: number
  title: string
  completed: boolean
}

// A deterministic header stamped on every response. We use our own value rather
// than faking "Express" so the exact-header assertion pins something honest.
const POWERED_BY = 'vouch-mock'

// Seed data — enough for the chaining tests (user 1 owns posts 1 & 2).
const users: MockUser[] = [
  { id: 1, name: 'Ada Lovelace', username: 'ada', email: 'ada@example.com' },
  { id: 2, name: 'Alan Turing', username: 'alan', email: 'alan@example.com' },
]

const posts: MockPost[] = [
  { id: 1, userId: 1, title: 'first post', body: 'first body' },
  { id: 2, userId: 1, title: 'second post', body: 'second body' },
  { id: 3, userId: 2, title: 'third post', body: 'third body' },
]

const todos: MockTodo[] = [{ id: 1, userId: 1, title: 'delectus aut autem', completed: false }]

// Per-key attempt counters for the stateful utility routes. Reset per server.
const flakyState = new Map<string, number>()
const retryAfterState = new Map<string, number>()

/** JSON response with the deterministic content-type + x-powered-by header. */
function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-powered-by': POWERED_BY, ...extra },
  })
}

/** Plain-text response with the deterministic x-powered-by header. */
function text(body: string, status = 200, contentType = 'text/plain', extra?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType, 'x-powered-by': POWERED_BY, ...extra },
  })
}

/** Bodyless response (used for 204/205/304 and redirects). */
function empty(status: number, extra?: Record<string, string>): Response {
  return new Response(null, { status, headers: { 'x-powered-by': POWERED_BY, ...extra } })
}

/**
 * text/event-stream response: enqueue `frames` one by one (5ms apart), then
 * close when `close` is set, else hold the stream open until the client
 * cancels. The timer chain stops on cancel so no work leaks past a test.
 */
function sse(frames: string[], opts: { close?: boolean } = {}): Response {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let i = 0
      const push = () => {
        if (i < frames.length) {
          controller.enqueue(encoder.encode(frames[i]))
          i += 1
          timer = setTimeout(push, 5)
        } else if (opts.close) {
          controller.close()
        }
      }
      timer = setTimeout(push, 5)
    },
    cancel() {
      clearTimeout(timer)
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'x-powered-by': POWERED_BY },
  })
}

function notFound(): Response {
  return json({ error: 'not found' }, 404)
}

/** Lowercased header map, for the /echo route's deterministic shape. */
function headersToObject(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of req.headers.entries()) out[k.toLowerCase()] = v
  return out
}

/** searchParams → plain object (last value wins on repeats). */
function queryToObject(url: URL): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of url.searchParams.entries()) out[k] = v
  return out
}

/** Parse the cookie header into a name→value map. */
function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = req.headers.get('cookie')
  if (!raw) return out
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/** Body for /echo: shaped by content-type (JSON / urlencoded / multipart / raw). */
async function echoBody(req: Request): Promise<unknown> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return req.json().catch(() => null)
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(await req.text())
    return Object.fromEntries(params.entries())
  }
  if (ct.includes('multipart/form-data')) {
    const form: Record<string, string> = {}
    const files: Record<string, { filename: string; size: number; type: string }> = {}
    const fd = await req.formData()
    for (const [key, value] of fd.entries()) {
      if (value instanceof File) {
        files[key] = {
          filename: value.name,
          size: value.size,
          type: value.type || 'application/octet-stream',
        }
      } else {
        form[key] = String(value)
      }
    }
    return { form, files }
  }
  return req.text()
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method

  // ─── Existing REST API (frozen contract) ──────────────────────────────────

  // GET /users/:id → a single user.
  let m = path.match(/^\/users\/(\d+)$/)
  if (m && method === 'GET') {
    const user = users.find((u) => u.id === Number(m![1]))
    return user ? json(user) : notFound()
  }

  // GET /posts?userId=N → all posts for that user (the chaining filter).
  if (path === '/posts' && method === 'GET') {
    const userId = url.searchParams.get('userId')
    const list = userId == null ? posts : posts.filter((p) => p.userId === Number(userId))
    return json(list)
  }

  // POST /posts → 201, echo the body + an assigned id (101, like the placeholder API).
  if (path === '/posts' && method === 'POST') {
    const sent = (await req.json().catch(() => ({}))) as Record<string, unknown>
    return json({ ...sent, id: 101 }, 201)
  }

  // /posts/:id → GET / PUT / PATCH / DELETE.
  m = path.match(/^\/posts\/(\d+)$/)
  if (m) {
    const id = Number(m[1])
    if (method === 'GET') {
      const post = posts.find((p) => p.id === id)
      return post ? json(post) : notFound()
    }
    if (method === 'PUT') {
      // Echo exactly the sent object (the strict-equal test relies on this: the
      // payload already carries `id`, so we return it verbatim).
      const sent = (await req.json().catch(() => ({}))) as Record<string, unknown>
      return json(sent)
    }
    if (method === 'PATCH') {
      // Merge the existing resource with the patch; echo the merged fields.
      const existing = posts.find((p) => p.id === id) ?? { id }
      const sent = (await req.json().catch(() => ({}))) as Record<string, unknown>
      return json({ ...existing, ...sent })
    }
    if (method === 'DELETE') {
      return json({})
    }
  }

  // GET /todos/:id → a single todo (used by the builder live block).
  m = path.match(/^\/todos\/(\d+)$/)
  if (m && method === 'GET') {
    const todo = todos.find((t) => t.id === Number(m![1]))
    return todo ? json(todo) : notFound()
  }

  // POST /post → multipart echo. Returns the controlled shape:
  //   { headers: { 'content-type': ... }, form: {...text fields}, files: { <filename>: <info> } }
  // `files` is keyed by filename and the value records the content-type + a
  // base64 marker so the upload test can assert the file arrived intact.
  if (path === '/post' && method === 'POST') {
    const contentType = req.headers.get('content-type') ?? ''
    const form: Record<string, string> = {}
    const files: Record<string, string> = {}
    const fd = await req.formData()
    for (const [key, value] of fd.entries()) {
      if (value instanceof File) {
        const bytes = new Uint8Array(await value.arrayBuffer())
        const b64 = Buffer.from(bytes).toString('base64')
        files[value.name] = `data:${value.type || 'application/octet-stream'};base64,${b64}`
      } else {
        form[key] = String(value)
      }
    }
    return json({ headers: { 'content-type': contentType }, form, files })
  }

  // ─── httpbin-style utility routes ─────────────────────────────────────────

  // ANY /echo → reflect the request (method, path, query, headers, body).
  if (path === '/echo') {
    return json({
      method,
      path,
      query: queryToObject(url),
      headers: headersToObject(req),
      body: await echoBody(req),
    })
  }

  // ANY /status/:code → respond with that status. ?type=text → text/plain body.
  m = path.match(/^\/status\/(\d+)$/)
  if (m) {
    const code = Number(m[1])
    if (url.searchParams.get('type') === 'text') return text(`status ${code}`, code)
    if (code === 204 || code === 205 || code === 304) return empty(code)
    return json({ code }, code)
  }

  // GET /delay/:ms → wait (capped at 3000) then 200.
  m = path.match(/^\/delay\/(\d+)$/)
  if (m && method === 'GET') {
    const ms = Math.min(Number(m[1]), 3000)
    await Bun.sleep(ms)
    return json({ delayed: ms })
  }

  // GET /flaky/:key → first N calls fail with ?status=S, then 200. x-attempt header.
  m = path.match(/^\/flaky\/([^/]+)$/)
  if (m && method === 'GET') {
    const key = decodeURIComponent(m[1])
    const fails = Number(url.searchParams.get('fails') ?? '1')
    const status = Number(url.searchParams.get('status') ?? '503')
    const attempt = (flakyState.get(key) ?? 0) + 1
    flakyState.set(key, attempt)
    const hdr = { 'x-attempt': String(attempt) }
    return attempt <= fails ? json({ error: 'flaky', attempt }, status, hdr) : json({ ok: true }, 200, hdr)
  }

  // GET /retry-after/:key → first N calls 429 w/ Retry-After, then 200. x-attempt.
  m = path.match(/^\/retry-after\/([^/]+)$/)
  if (m && method === 'GET') {
    const key = decodeURIComponent(m[1])
    const fails = Number(url.searchParams.get('fails') ?? '1')
    const seconds = url.searchParams.get('seconds') ?? '0'
    const attempt = (retryAfterState.get(key) ?? 0) + 1
    retryAfterState.set(key, attempt)
    const hdr = { 'x-attempt': String(attempt) }
    return attempt <= fails
      ? json({ error: 'rate limited', attempt }, 429, { ...hdr, 'retry-after': seconds })
      : json({ ok: true }, 200, hdr)
  }

  // GET /redirect/:n → 302 chain down to /redirect/0 → 200 { landed: true }.
  m = path.match(/^\/redirect\/(\d+)$/)
  if (m && method === 'GET') {
    const n = Number(m[1])
    if (n > 0) return empty(302, { location: `/redirect/${n - 1}` })
    return json({ landed: true })
  }

  // GET /auth → 200 if Authorization OR X-Signature present, else 401.
  if (path === '/auth' && method === 'GET') {
    const authed = req.headers.has('authorization') || req.headers.has('x-signature')
    return authed ? json({ authed: true }) : json({ error: 'unauthorized' }, 401)
  }

  // POST /login → set a session cookie. GET /me → requires that cookie.
  if (path === '/login' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': 'session=abc123; Path=/' })
  }
  if (path === '/me' && method === 'GET') {
    return parseCookies(req).session ? json({ user: 'ada' }) : json({ error: 'unauthorized' }, 401)
  }

  // ─── SSE routes (text/event-stream) ───────────────────────────────────────

  // GET /sse/ticks?count=N[&close=1] → a comment heartbeat, then N `tick`
  // events (id: i, data: {"i":i}); holds the stream open unless close=1.
  if (path === '/sse/ticks' && method === 'GET') {
    const count = Number(url.searchParams.get('count') ?? '3')
    const frames = [': heartbeat\n\n']
    for (let i = 1; i <= count; i++) {
      frames.push(`id: ${i}\nevent: tick\ndata: {"i":${i}}\n\n`)
    }
    return sse(frames, { close: url.searchParams.get('close') === '1' })
  }

  // GET /sse/echo-last-event-id → one `resume` event whose data is the
  // received Last-Event-ID header (or "none"); holds open.
  if (path === '/sse/echo-last-event-id' && method === 'GET') {
    const lastEventId = req.headers.get('last-event-id') ?? 'none'
    return sse([`event: resume\ndata: ${lastEventId}\n\n`])
  }

  // GET /sse/multiline → one event with two data lines + an id, then CLOSE
  // (exercises spec joining and the stream-closed-before-condition path).
  if (path === '/sse/multiline' && method === 'GET') {
    return sse(['id: 9\ndata: line one\ndata: line two\n\n'], { close: true })
  }

  // GET /sse/silent → comment heartbeats only, never an event (timeout path).
  if (path === '/sse/silent' && method === 'GET') {
    return sse([': nothing to see\n\n'])
  }

  // Content-type fixtures.
  if (path === '/text' && method === 'GET') return text('hello world')
  if (path === '/html' && method === 'GET')
    return text('<html><body><h1>hi</h1></body></html>', 200, 'text/html')
  if (path === '/empty' && method === 'GET') return empty(204)
  if (path === '/malformed-json' && method === 'GET')
    return text('{ not valid json', 200, 'application/json')

  return notFound()
}

export function startMockServer(): { url: string; stop(): void } {
  // Fresh per-key state for each server instance (i.e. each test file).
  flakyState.clear()
  retryAfterState.clear()

  const server = Bun.serve({
    port: 0, // OS-assigned free port — safe under parallel test files.
    fetch: handle,
  })
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  }
}

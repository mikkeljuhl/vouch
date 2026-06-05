/**
 * In-process mock REST server for the dogfood example suite.
 *
 * Built on Bun's native `Bun.serve` (no dependency) so the example/builder-live
 * tests exercise *real* HTTP + the full framework while staying hermetic: no
 * external network, deterministic responses, runnable offline. `port: 0` lets the
 * OS assign a free port, so parallel test files never collide.
 *
 * The surface is a small, realistic REST API (users / posts / todos + a multipart
 * echo) that mirrors the shape of a public placeholder API. Because the suite owns
 * this contract, assertions can be clean and exact rather than defensive.
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

/** JSON response with the deterministic content-type + x-powered-by header. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-powered-by': POWERED_BY },
  })
}

function notFound(): Response {
  return json({ error: 'not found' }, 404)
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method

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

  return notFound()
}

export function startMockServer(): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0, // OS-assigned free port — safe under parallel test files.
    fetch: handle,
  })
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  }
}

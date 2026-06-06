/**
 * Test helper: wire the in-process Bun mock server lifecycle for an integration
 * / example suite, and hand back a factory for `vouch` clients pointed at it.
 *
 * Every integration + example file repeats the same boilerplate:
 *
 *   let server = startMockServer()  // in beforeAll
 *   server.stop()                   // in afterAll
 *   const client = createClient({ baseUrl: server.url })
 *
 * `useMockServer()` registers the `beforeAll(start)` / `afterAll(stop)` hooks for
 * you and returns a handle whose `url()` resolves the (per-suite) base URL and
 * whose `client(opts?)` mints a client against it — merging any per-test options
 * (cookies, headers, beforeRequest, proxy, retry, timeoutMs, ...):
 *
 *   const mock = useMockServer()
 *   test('...', async () => {
 *     await mock.client().get('/status/200').expectStatus(200)
 *     const authed = mock.client({ beforeRequest: signHook })
 *   })
 *
 * Imports only `createClient` + types from the framework and `startMockServer`
 * from the (untouched) mock-server module.
 */

import { afterAll, beforeAll } from 'bun:test'
import { createClient, type Client, type ClientOptions } from '../../src/index'
import { startMockServer } from './mock-server'

/** Re-export so suites can grab the raw server starter without a second import. */
export { startMockServer } from './mock-server'

/** Per-suite handle returned by {@link useMockServer}. */
export interface MockServerHandle {
  /**
   * The base URL of the running mock server. Throws if read before `beforeAll`
   * has started the server (i.e. outside a test/hook body).
   */
  url(): string
  /**
   * Mint a client against the mock server. `opts` are merged over `{ baseUrl }`
   * (you may even override `baseUrl`, e.g. to point at a dead port). Call once
   * per test so per-test options (cookies, hooks, headers) stay isolated.
   */
  client(opts?: Omit<ClientOptions, 'baseUrl'> & { baseUrl?: string }): Client
}

/**
 * Register `beforeAll`/`afterAll` hooks around a fresh mock server for the
 * current `describe`/file, and return a handle to its URL + a client factory.
 * Each call starts ONE server (fresh per-key /flaky + /retry-after state).
 */
export function useMockServer(): MockServerHandle {
  let server: { url: string; stop(): void } | undefined

  beforeAll(() => {
    server = startMockServer()
  })
  afterAll(() => {
    server?.stop()
    server = undefined
  })

  const url = (): string => {
    if (!server) throw new Error('mock server URL read before beforeAll started it')
    return server.url
  }

  return {
    url,
    client(opts) {
      return createClient({ baseUrl: url(), ...opts })
    },
  }
}

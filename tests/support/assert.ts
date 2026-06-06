/**
 * Test helper: capture the `AssertionError` thrown by a failing vouch assertion.
 *
 * ~14 integration/unit tests hand-roll the same try/catch: run an awaitable that
 * SHOULD reject with an `AssertionError`, grab it, assert its type, and inspect
 * `.message` / `.path`. If it does NOT throw they must fail loudly (a silently
 * passing assertion is the bug those tests guard against).
 *
 *   const err = await captureAssertion(client.get('/x').expectStatus(404))
 *   expect(err.message).toContain('got 200')
 *
 * Accepts either:
 *  - a thenable/builder directly (the common case — `RequestBuilder` is a
 *    PromiseLike), or
 *  - a zero-arg function returning a thenable/value (when you want to defer
 *    construction or pass a non-thenable expression).
 *
 * Engine-light by design: it uses `bun:test`'s `expect` ONLY to fail the test
 * when nothing was thrown, and imports just the `AssertionError` type/class from
 * the framework for the `instanceof` check.
 */

import { expect } from 'bun:test'
import { AssertionError } from '../../src/index'

/** A thenable or a (sync/async) function producing one — anything awaitable. */
export type Awaitableish<T> = PromiseLike<T> | (() => T | PromiseLike<T>)

/**
 * Await `subject` expecting it to throw an `AssertionError`; return that error
 * for message/path inspection. Fails the test (via `expect`) if it does NOT
 * throw, or if it throws something that is not an `AssertionError`.
 */
export async function captureAssertion(subject: Awaitableish<unknown>): Promise<AssertionError> {
  try {
    await (typeof subject === 'function' ? subject() : subject)
  } catch (error) {
    if (!(error instanceof AssertionError)) {
      // Surface the wrong-type failure with the offending error attached.
      expect(error).toBeInstanceOf(AssertionError)
      throw error
    }
    return error
  }
  // Nothing threw — fail loudly so a no-op assertion can't pass silently.
  expect().fail('expected an AssertionError to be thrown, but the subject resolved without throwing')
  // Unreachable (expect().fail throws), but keeps the return type honest.
  throw new Error('unreachable')
}

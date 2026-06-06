/**
 * Mocked, deterministic coverage for the two new assertions:
 * `.expectUnder(ms)` (latency / `durationMs`) and `.expectSchema(schema)`
 * (predicate + Standard Schema, sync and async). Also re-checks fail-fast under
 * the new async assertion loop. Uses the shared mock-fetch helper so the live
 * suites never see the stub.
 */

import { describe, expect, mock, spyOn, test } from 'bun:test'
import { createClient } from '../src/client'
import { AssertionError, type StandardSchemaV1 } from '../src/index'
import { installMockFetch, jsonResponse } from './support/mock-fetch'

describe('new assertions (mocked fetch)', () => {
  const fetch = installMockFetch()

  const client = () => createClient({ baseUrl: 'https://api.example.com' })

  /** A factory that resolves after a small delay so durationMs is non-trivial. */
  const slowJson = (body: unknown, status?: number) => async () => {
    await new Promise((r) => setTimeout(r, 25))
    return jsonResponse(body, { status })
  }

  describe('.expectUnder', () => {
    test('passes under a generous budget and exposes durationMs ≥ 0', async () => {
      fetch.respond(slowJson({ ok: true }))

      const res = await client().get('/x').expectUnder(1000)
      expect(typeof res.durationMs).toBe('number')
      expect(res.durationMs).toBeGreaterThanOrEqual(0)
    })

    test('throws AssertionError when the request exceeds the budget', async () => {
      fetch.respond(slowJson({ ok: true }))

      await expect(client().get('/x').expectUnder(1).send()).rejects.toThrow(AssertionError)
    })

    test('the failure message names the budget and the measured time', async () => {
      fetch.respond(slowJson({ ok: true }))

      await expect(client().get('/x').expectUnder(1).send()).rejects.toThrow(/under 1ms but took \d+ms/)
    })
  })

  describe('.expectSchema (predicate)', () => {
    test('passing predicate resolves', async () => {
      fetch.json({ id: 1 })
      const isObject = (b: unknown) => typeof b === 'object' && b !== null
      await expect(client().get('/x').expectSchema(isObject).send()).resolves.toBeDefined()
    })

    test('failing predicate throws AssertionError', async () => {
      fetch.json({ id: 1 })
      const alwaysFalse = () => false
      await expect(client().get('/x').expectSchema(alwaysFalse).send()).rejects.toThrow(AssertionError)
    })
  })

  describe('.expectSchema (Standard Schema)', () => {
    /** A tiny hand-written sync Standard Schema that checks `body.id` is a number. */
    function numberIdSchema(): StandardSchemaV1 {
      return {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate(value) {
            const v = value as { id?: unknown }
            if (typeof v?.id === 'number') return { value }
            return { issues: [{ message: 'id must be a number', path: ['id'] }] }
          },
        },
      }
    }

    test('sync schema that succeeds resolves', async () => {
      fetch.json({ id: 42 })
      await expect(client().get('/x').expectSchema(numberIdSchema()).send()).resolves.toBeDefined()
    })

    test('sync schema with issues throws and the message includes the issue text + path', async () => {
      fetch.json({ id: 'nope' })
      await expect(client().get('/x').expectSchema(numberIdSchema()).send()).rejects.toThrow(
        /id: id must be a number/,
      )
    })

    test('async schema (validate returns a Promise) is awaited by the loop', async () => {
      fetch.json({ name: 'Ada' })
      const asyncSchema: StandardSchemaV1 = {
        '~standard': {
          version: 1,
          vendor: 'test-async',
          async validate(value) {
            await new Promise((r) => setTimeout(r, 5))
            const v = value as { name?: unknown }
            if (typeof v?.name === 'string') return { value }
            return { issues: [{ message: 'name must be a string' }] }
          },
        },
      }
      await expect(client().get('/x').expectSchema(asyncSchema).send()).resolves.toBeDefined()
    })

    test('async schema that reports issues rejects with the issue message', async () => {
      fetch.json({ name: 123 })
      const asyncSchema: StandardSchemaV1 = {
        '~standard': {
          version: 1,
          vendor: 'test-async',
          async validate() {
            await new Promise((r) => setTimeout(r, 5))
            return { issues: [{ message: 'name must be a string' }] }
          },
        },
      }
      await expect(client().get('/x').expectSchema(asyncSchema).send()).rejects.toThrow(
        /name must be a string/,
      )
    })
  })

  test('fail-fast holds under the async loop: a failing earlier assertion blocks a later one', async () => {
    fetch.json({ id: 1 }, { status: 500 })

    // A later async schema whose validate is spied: it must never run because the
    // earlier expectStatus(200) throws first.
    const validate = mock(async () => ({ value: undefined }))
    const laterSchema: StandardSchemaV1 = {
      '~standard': { version: 1, vendor: 'test', validate },
    }

    const builder = client()
      .get('/x')
      .expectStatus(200) // fails first
      .expectSchema(laterSchema) // must NOT run

    await expect(builder.send()).rejects.toThrow(AssertionError)
    expect(validate).not.toHaveBeenCalled()
  })

  test('fail-fast: a failing async schema prevents a later assertion from running', async () => {
    fetch.json({ id: 1 }, { status: 200 })

    const failingSchema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        async validate() {
          return { issues: [{ message: 'always fails' }] }
        },
      },
    }
    const laterPattern = /json/
    const testSpy = spyOn(laterPattern, 'test')

    const builder = client()
      .get('/x')
      .expectSchema(failingSchema) // rejects first (async)
      .expectHeader('content-type', laterPattern) // must NOT run

    await expect(builder.send()).rejects.toThrow(/always fails/)
    expect(testSpy).not.toHaveBeenCalled()
  })
})

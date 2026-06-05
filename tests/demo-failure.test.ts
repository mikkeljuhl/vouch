// DEMO ONLY — an intentionally failing test to show how CI surfaces failures
// (inline annotations + the job-summary "Failures" section). Delete this file /
// close the demo PR; do not merge.
import { describe, test, beforeAll } from 'vitest'
import { createClient, type Client } from '../src/index'

describe('demo failure', () => {
  let client: Client

  beforeAll(() => {
    client = createClient({
      baseUrl: process.env.API_BASE_URL || 'https://jsonplaceholder.typicode.com',
    })
  })

  test('expects the wrong status on purpose', async () => {
    // /todos/1 really returns 200; asserting 418 forces a clean assertion failure
    // with a Vitest expect diff that the github-actions reporter annotates.
    await client.get('/todos/1').expectStatus(418)
  })
})

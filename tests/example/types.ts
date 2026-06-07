/**
 * Small response shapes for the dogfood example suite. They give `body` real
 * types at the call sites (`client.get<User>(...)`), which is the whole point of
 * the generic typing — the suite reads like consumer code, and
 * the consumer gets autocomplete/checking on the parsed body.
 *
 * These mirror the small realistic schema served by the in-process `Bun.serve`
 * mock (see tests/support/mock-server.ts). They are intentionally partial: only
 * the fields the tests touch are modelled.
 */

export interface User {
  id: number
  name: string
  username: string
  email: string
}

export interface Post {
  id: number
  userId: number
  title: string
  body: string
}

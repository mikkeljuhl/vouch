/**
 * Test-fixture helper for file-upload tests. Runtime-detects Bun vs Node so the
 * same `fixture()` call works in both: on Bun it returns a lazy `BunFile` (read
 * by Bun only when streamed), on Node it returns an eager in-memory `Blob` read
 * via `node:fs`. Both are real `Blob`s — `FormData` and `.body()` accept either.
 *
 * The helper imports no test library, so it stays safe to ship from the core.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Read a fixture file relative to the calling test module and return it as a
 * `Blob` ready to pass to `.file(name, blob, filename)` or `.body(blob)`.
 *
 * Resolving relative to the caller's `import.meta.url` makes the path independent
 * of the process cwd, so fixtures resolve identically when run locally or inside
 * the Docker image (keep fixtures under `tests/` so they travel into the image).
 *
 * - **Bun**: returns `Bun.file(url, { type })` — a lazy `BunFile` that streams
 *   on demand. Identical behavior to prior releases.
 * - **Node** (≥20): returns `new Blob([readFileSync(path)], { type })` — eager,
 *   buffered into memory. Fine for test fixtures, which are small.
 *
 * @example
 *   const zip = fixture(import.meta.url, './fixtures/sample.zip', 'application/zip')
 *   await client.post('/upload').file('archive', zip).expectStatus(200)
 */
export function fixture(metaUrl: string, relativePath: string, type?: string): Blob {
  const url = new URL(relativePath, metaUrl)
  const bunRuntime = (globalThis as { Bun?: { file: typeof Bun.file } }).Bun
  if (bunRuntime) {
    return bunRuntime.file(url, type ? { type } : undefined)
  }
  const bytes = readFileSync(fileURLToPath(url))
  return new Blob([bytes], type ? { type } : undefined)
}

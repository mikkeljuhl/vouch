/**
 * Test-fixture helper for file-upload tests (DESIGN.md §4 "File uploads &
 * fixtures"). Engine-agnostic: uses only runtime builtins (`node:fs`/`node:url`,
 * available under both Bun and Node), never a test library, so it is safe to ship
 * from the framework core.
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
 * @example
 *   const zip = fixture(import.meta.url, './fixtures/sample.zip', 'application/zip')
 *   await client.post('/upload').file('archive', zip).expectStatus(200)
 */
export function fixture(metaUrl: string, relativePath: string, type?: string): Blob {
  const path = fileURLToPath(new URL(relativePath, metaUrl))
  return new Blob([readFileSync(path)], type ? { type } : undefined)
}

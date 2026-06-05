import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Target the *lowest* supported runtime (engines: node >=22) so the emitted
  // syntax runs on every supported Node without needless down-leveling.
  target: 'node22',
  // Emit `.cjs` (not `.js`) for the CJS build so the `exports` map can route
  // `require` → `./dist/index.cjs` and `import` → `./dist/index.js` cleanly.
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' }
  },
  // `vitest` is a *peer* dependency (the consumer always runs inside a Vitest
  // process where it is present). Marking it — and its subpaths — external keeps
  // Vitest's `expect`/matcher machinery (~560KB) out of our bundle; the built
  // output keeps a bare `import { expect } from 'vitest'` that resolves to the
  // consumer's own Vitest at runtime.
  external: [/^vitest($|\/)/],
})

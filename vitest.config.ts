import { defineConfig } from 'vitest/config'

// vitest is only used for the Node portability smoke — proof that the built
// `dist/index.js` imports cleanly and runs under Node + vitest. The dogfood
// suite under tests/ uses `bun:test` and stays Bun-only; scoping `include`
// keeps `vitest run` from trying to interpret those files.
//
// The portability file is named `*-vitest.ts` (no `.test.` / `.spec.` /
// `_test.` suffix) so `bun test`'s default discovery skips it — `bun test`
// runs over the workspace in the Docker / GitHub Action image and has no
// `dist/` to import.
export default defineConfig({
  test: {
    include: ['tests/portability/**/*-vitest.ts'],
  },
})

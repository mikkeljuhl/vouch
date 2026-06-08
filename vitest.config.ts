import { defineConfig } from 'vitest/config'

// vitest is only used for the Node portability smoke — proof that the built
// `dist/index.js` imports cleanly and runs under Node + vitest. The dogfood
// suite under tests/ uses `bun:test` and stays Bun-only; scoping `include`
// keeps `vitest run` from trying to interpret those files.
export default defineConfig({
  test: {
    include: ['tests/portability/**/*.test.ts'],
  },
})

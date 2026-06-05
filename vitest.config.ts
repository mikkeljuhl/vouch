import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],

    // Reporting (DESIGN.md §7): the framework ships no custom reporter — it relies
    // on Vitest's built-in `junit` reporter, whose XML an external GHA consumes.
    // We keep the human-friendly `default` console reporter alongside it so local
    // runs stay readable while still emitting machine output.
    reporters: ['default', 'junit'],
    // `outputFile` keyed by reporter name is the Vitest 4 way to route a reporter's
    // output to disk (other reporters print to stdout as usual).
    outputFile: {
      junit: './reports/junit.xml',
    },

    // Concurrency (DESIGN.md §2): test *files* run in parallel by default (Vitest's
    // default pool), while the chains *within* a test stay serial because they are
    // plain `await`ed statements. We do not opt files into intra-file `concurrent`.
    //
    // Test-level retry guards the live dogfood suite against transient public-API
    // flake (network blips, rate limiting). This is the Vitest runner retry, which
    // re-runs a failing test; it is distinct from the framework's per-request
    // `.retry({ times, when })` (which re-issues a single HTTP call before
    // assertions run). One re-run is a reasonable, conservative default.
    retry: 1,
  },
})

import { defineConfig } from 'vitest/config'

// GitHub Actions sets GITHUB_ACTIONS=true. In CI we add Vitest's built-in
// `github-actions` reporter (inline annotations on failing assertions) and the
// `json` reporter (consumed by scripts/ci-summary.mjs to build the job-summary
// table). Locally we keep just `default` + `junit` so runs stay quiet/readable.
const inCI = !!process.env.GITHUB_ACTIONS

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],

    // Reporting (DESIGN.md §7): the framework ships no custom reporter — it relies
    // on Vitest's built-in reporters. `junit` XML is the canonical machine output;
    // in CI we additionally surface inline annotations + a JSON feed for the
    // first-party job-summary script. All reporting stays repo-local (the packaged
    // reusable action remains deferred — DESIGN.md §9).
    reporters: inCI
      ? ['default', 'github-actions', 'junit', 'json']
      : ['default', 'junit'],
    // `outputFile` keyed by reporter name is the Vitest 4 way to route a reporter's
    // output to disk (other reporters print to stdout as usual).
    outputFile: {
      junit: './reports/junit.xml',
      json: './reports/results.json',
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

#!/usr/bin/env bun
// Thin CLI wrapper around `bun test` (DESIGN.md M5). Requires Bun on PATH; the
// install-nothing path is the Docker image. Pure passthrough, plus one
// convenience: `--junit <file>` expands to Bun's JUnit reporter flags.
//
//   apitest                         → bun test
//   apitest tests/users.test.ts     → bun test tests/users.test.ts
//   apitest --junit reports/j.xml   → bun test --reporter=junit --reporter-outfile=reports/j.xml
//   apitest -- <any bun test flags> → forwarded verbatim
//
// A standalone, install-nothing binary (`bun build --compile`) is deferred — see
// DESIGN.md §9 (Bun's test runner isn't an embeddable API).

const argv = process.argv.slice(2)

if (argv[0] === '--help' || argv[0] === '-h') {
  console.log(
    [
      'apitest — run API tests with Bun',
      '',
      'Usage: apitest [paths...] [--junit <file>] [-- <bun test flags>]',
      '',
      '  --junit <file>   write a JUnit XML report to <file>',
      '  -h, --help       show this help',
      '',
      'Any other arguments are passed through to `bun test`.',
    ].join('\n'),
  )
  process.exit(0)
}

// Expand --junit <file> → Bun's reporter flags; pass everything else through.
const passthrough: string[] = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--junit') {
    const file = argv[++i]
    if (!file) {
      console.error('apitest: --junit requires a file path')
      process.exit(2)
    }
    passthrough.push('--reporter=junit', `--reporter-outfile=${file}`)
  } else {
    passthrough.push(arg)
  }
}

const proc = Bun.spawn(['bun', 'test', ...passthrough], {
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
})
process.exit(await proc.exited)

#!/usr/bin/env bun
// Thin CLI wrapper around `bun test`. Requires Bun on PATH; the
// install-nothing path is the Docker image. Pure passthrough, plus two
// conveniences: `--junit <file>` expands to Bun's JUnit reporter flags, and
// `--typecheck` runs an opt-in `tsc --noEmit` pass over the consumer's tests.
//
//   vouch                          → bun test
//   vouch tests/users.test.ts      → bun test tests/users.test.ts
//   vouch --junit reports/j.xml    → bun test --reporter=junit --reporter-outfile=reports/j.xml
//   vouch --typecheck              → tsc --noEmit (then, if clean) bun test
//   vouch --typecheck-only         → tsc --noEmit only; exit with its code
//   vouch -- <any bun test flags>  → forwarded verbatim
//
// Bun (and `bun test`) transpile + type-strip but NEVER type-check, so typecheck
// is its own tsc pass. It is OPT-IN: a plain `vouch <file>` still runs a test
// with type errors (type-stripped) — `--typecheck` is the only thing that gates.
//
// A standalone, install-nothing binary (`bun build --compile`) is deferred
// (Bun's test runner isn't an embeddable API).

import { VERSION } from '../src/index'

// Scaffold written by `vouch init`. Declared before the init dispatch so it is
// initialized when runInit runs (top-level const, no TDZ).
const EXAMPLE_TEST = `import { beforeAll, describe, test } from 'bun:test'
import { createClient, type Client } from '@mikkeljuhl/vouch'

// Point this at your running service — any backend works, vouch sends real HTTP.
const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:8080'

describe('my api', () => {
  let client: Client
  beforeAll(() => {
    client = createClient({ baseUrl })
  })

  test('health check', async () => {
    await client.get('/health').expectStatus(200)
  })
})
`

const argv = process.argv.slice(2)

if (argv[0] === '--version' || argv[0] === '-v') {
  console.log(VERSION)
  process.exit(0)
}

if (argv[0] === 'init') {
  process.exit(await runInit(argv.slice(1)))
}

if (argv[0] === '--help' || argv[0] === '-h') {
  console.log(
    [
      'vouch — run API tests with Bun',
      '',
      'Usage: vouch [paths...] [--typecheck | --typecheck-only] [--junit <file>] [-- <bun test flags>]',
      '',
      '  --typecheck       type-check the test files (tsc --noEmit), then run them',
      '                    (skips the run and exits non-zero if type-checking fails)',
      '  --typecheck-only  type-check only; exit with the type-checker status (no run)',
      '  --junit <file>    write a JUnit XML report to <file>',
      '  -v, --version     print the vouch version',
      '  -h, --help        show this help',
      '',
      'Subcommands:',
      '  init [dir]        scaffold tests/, an example, and tsconfig.json',
      '                    (--no-install skips `bun add`)',
      '',
      'Type-checking uses a baseline tsconfig shipped with vouch, so no tsconfig',
      'authoring is needed. Paths default to **/*.test.ts and **/*.spec.ts',
      '(node_modules excluded). Any other arguments are passed through to `bun test`.',
    ].join('\n'),
  )
  process.exit(0)
}

// Parse out vouch-owned flags; everything else passes through to `bun test`.
// Path-like args (non-flags) double as typecheck target globs.
let typecheck = false
let typecheckOnly = false
const passthrough: string[] = []
const targets: string[] = []

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--typecheck') {
    typecheck = true
  } else if (arg === '--typecheck-only') {
    typecheckOnly = true
  } else if (arg === '--junit') {
    const file = argv[++i]
    if (!file) {
      console.error('vouch: --junit requires a file path')
      process.exit(2)
    }
    passthrough.push('--reporter=junit', `--reporter-outfile=${file}`)
  } else if (arg === '--') {
    // Everything after `--` is forwarded verbatim to `bun test`.
    passthrough.push(...argv.slice(i + 1))
    break
  } else {
    passthrough.push(arg)
    // A bare, non-flag arg is a path (file or dir) → use as a typecheck target.
    if (!arg.startsWith('-')) targets.push(arg)
  }
}

/**
 * Type-check the consumer's test files with a one-flag, no-config experience.
 *
 * Strategy: write a temp tsconfig in cwd that EXTENDS the baseline shipped next
 * to this CLI (resolved via `import.meta.url`, so it works from any cwd / when
 * installed as a dep), and sets `include` to the target globs. Run it through
 * `bun x tsc` (so tsc is fetched if not present locally). The baseline resolves
 * our package types via its exports → dist/index.d.ts and `bun:test` via
 * `@types/bun` (`types: ["bun"]`). Returns the tsc exit code.
 */
async function runTypecheck(targetArgs: string[]): Promise<number> {
  const baseline = new URL('./tsconfig.typecheck.json', import.meta.url).pathname

  // Default globs cover the conventional test naming; exclude node_modules.
  // NOTE: TypeScript's tsconfig `include` does NOT support `{a,b}` brace
  // alternation — a dir target must expand to separate `.test.ts`/`.spec.ts`
  // patterns, or tsc finds no inputs (TS18003).
  const globs =
    targetArgs.length > 0
      ? targetArgs.flatMap((t) =>
          t.endsWith('.ts') ? [t] : [`${t}/**/*.test.ts`, `${t}/**/*.spec.ts`],
        )
      : ['**/*.test.ts', '**/*.spec.ts']

  const tmpConfig = `tsconfig.vouch-typecheck.${process.pid}.json`
  const tmpPath = `${process.cwd()}/${tmpConfig}`

  await Bun.write(
    tmpPath,
    JSON.stringify(
      {
        extends: baseline,
        include: globs,
        exclude: ['node_modules'],
      },
      null,
      2,
    ),
  )

  try {
    const proc = Bun.spawn(['bun', 'x', 'tsc', '--noEmit', '-p', tmpPath], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    })
    return await proc.exited
  } finally {
    // Best-effort cleanup of the temp config.
    try {
      await Bun.file(tmpPath).delete()
    } catch {
      // ignore
    }
  }
}

if (typecheck || typecheckOnly) {
  const code = await runTypecheck(targets)
  if (code !== 0) process.exit(code)
  if (typecheckOnly) process.exit(0)
}

const proc = Bun.spawn(['bun', 'test', ...passthrough], {
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
})
process.exit(await proc.exited)

/**
 * `vouch init [dir]` — scaffold a tests/ dir, an example test, and a tsconfig so
 * the editor lights up, then (unless --no-install) `bun add` the framework.
 * Existing files are never overwritten.
 */
async function runInit(args: string[]): Promise<number> {
  const noInstall = args.includes('--no-install')
  const dir = (args.find((a) => !a.startsWith('-')) ?? '.').replace(/\/+$/, '')
  const at = (rel: string) => `${dir}/${rel}`

  const writeIfAbsent = async (rel: string, content: string): Promise<void> => {
    if (await Bun.file(at(rel)).exists()) {
      console.log(`  skip   ${rel} (exists)`)
      return
    }
    await Bun.write(at(rel), content)
    console.log(`  create ${rel}`)
  }

  await writeIfAbsent(
    'package.json',
    JSON.stringify({ name: 'api-tests', private: true, type: 'module' }, null, 2) + '\n',
  )
  await writeIfAbsent(
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ES2023',
          types: ['bun'],
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['tests'],
      },
      null,
      2,
    ) + '\n',
  )
  await writeIfAbsent('tests/example.test.ts', EXAMPLE_TEST)

  if (!noInstall) {
    console.log('\nInstalling @mikkeljuhl/vouch …')
    const add = Bun.spawn(['bun', 'add', '-d', '@mikkeljuhl/vouch'], {
      cwd: dir,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await add.exited) !== 0) {
      console.log('  (install failed — run it yourself: bun add -d @mikkeljuhl/vouch)')
    }
  }

  console.log(
    [
      '',
      'Done. Next:',
      noInstall ? '  bun add -d @mikkeljuhl/vouch' : '',
      '  export API_BASE_URL=http://localhost:8080   # point at your service',
      '  bun test --watch',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  )
  return 0
}

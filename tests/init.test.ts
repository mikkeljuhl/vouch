import { expect, test } from 'bun:test'

// `vouch init` scaffolds a project. Run it into a throwaway dir OUTSIDE the repo
// (mktemp) so the scaffolded example.test.ts isn't picked up by this suite.
const CLI = `${import.meta.dir}/../cli/vouch.ts`

test('vouch init scaffolds tests/, an example, and tsconfig', async () => {
  const dir = (await Bun.$`mktemp -d`.text()).trim()
  try {
    await Bun.$`bun ${CLI} init ${dir} --no-install`.quiet()
    expect(await Bun.file(`${dir}/tests/example.test.ts`).exists()).toBe(true)
    expect(await Bun.file(`${dir}/tsconfig.json`).exists()).toBe(true)
    expect(await Bun.file(`${dir}/package.json`).exists()).toBe(true)
    expect(await Bun.file(`${dir}/tests/example.test.ts`).text()).toContain('@mikkeljuhl/vouch')
  } finally {
    await Bun.$`rm -rf ${dir}`.quiet()
  }
})

test('vouch init never overwrites existing files', async () => {
  const dir = (await Bun.$`mktemp -d`.text()).trim()
  try {
    await Bun.write(`${dir}/tsconfig.json`, '{"keep":true}\n')
    await Bun.$`bun ${CLI} init ${dir} --no-install`.quiet()
    expect(await Bun.file(`${dir}/tsconfig.json`).text()).toBe('{"keep":true}\n')
  } finally {
    await Bun.$`rm -rf ${dir}`.quiet()
  }
})

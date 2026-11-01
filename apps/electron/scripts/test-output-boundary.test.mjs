import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanTestBuildOutput, testOutputBoundary } from './test-output-boundary.mjs'
import { createRequire } from 'node:module'

void test('real Vite refuses every linked boundary and invalid output without deleting sentinels', async () => {
  const require = createRequire(new URL('../package.json', import.meta.url))
  const { build } = await import(require.resolve('vite'))
  for (const kind of [
    'output-link',
    'ancestor-link',
    'root-link',
    'root',
    'dotdot',
    'escape',
    'empty'
  ]) {
    const checkout = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'output-boundary-')))
    const outside = await fs.mkdtemp(join(tmpdir(), 'output-sentinel-'))
    try {
      const isolated = join(checkout, '.test-build')
      await fs.mkdir(isolated, { recursive: true })
      await fs.mkdir(join(outside, 'app'))
      await fs.writeFile(join(outside, 'sentinel'), 'keep')
      await fs.writeFile(join(outside, 'app/sentinel'), 'keep')
      await fs.writeFile(join(isolated, 'sentinel'), 'keep')
      const source = join(checkout, 'source')
      await fs.mkdir(source)
      await fs.writeFile(join(source, 'entry.js'), 'globalThis.current = 1')
      let output = join(isolated, 'app')
      if (kind === 'root-link') {
        await fs.rm(isolated, { recursive: true })
        await fs.symlink(outside, isolated, 'dir')
      } else if (kind === 'output-link') await fs.symlink(outside, output, 'dir')
      else if (kind === 'ancestor-link') {
        await fs.symlink(outside, join(isolated, 'parent'), 'dir')
        output = join(isolated, 'parent/app')
      } else if (kind === 'root' || kind === 'dotdot') output = join(isolated, 'child', '..')
      else if (kind === 'escape') output = join(isolated, '..', '..', '..', 'escape')
      else if (kind === 'empty') output = ''
      await assert.rejects(cleanTestBuildOutput(checkout, output), /unsafe_test_build_output/)
      // Vite resolves an empty outDir to its root, also outside the boundary.
      await assert.rejects(
        build({
          configFile: false,
          root: source,
          logLevel: 'silent',
          plugins: [testOutputBoundary(checkout)],
          build: {
            outDir: output,
            emptyOutDir: true,
            rollupOptions: { input: join(source, 'entry.js') }
          }
        }),
        /unsafe_test_build_output/
      )
      assert.equal(await fs.readFile(join(outside, 'sentinel'), 'utf8'), 'keep')
      assert.equal(await fs.readFile(join(outside, 'app/sentinel'), 'utf8'), 'keep')
      assert.equal(await fs.readFile(join(isolated, 'sentinel'), 'utf8'), 'keep')
    } finally {
      await fs.rm(checkout, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  }
})

import { mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { assertTestBuildOutput, cleanTestBuildOutput } from './test-output-boundary.mjs'

const checkout = fileURLToPath(new URL('../../../', import.meta.url))
const output = resolve(checkout, '.test-build/electron/out')
// Validate every section before the single cleanup of this build's output.
for (const name of ['main', 'preload', 'renderer']) {
  await assertTestBuildOutput(checkout, resolve(output, name))
}
await cleanTestBuildOutput(checkout, output)

const inherited = process.env.NODE_OPTIONS?.trim() ?? ''
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url)),
    'build',
    '--mode',
    'oss',
    '--config',
    'scripts/electron.vite.test.config.ts'
  ],
  {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env,
      NODE_OPTIONS: /--max[-_]old[-_]space[-_]size(?:=|\s|$)/u.test(inherited)
        ? inherited
        : `${inherited} --max-old-space-size=8192`.trim()
    },
    stdio: 'inherit'
  }
)
if (result.error) throw result.error
if (result.signal) throw new Error(`Test build terminated by ${result.signal}`)
process.exitCode = result.status ?? 1
if (result.status === 0) {
  const root = fileURLToPath(new URL('../../../.test-build/electron/', import.meta.url))
  const electron = fileURLToPath(new URL('../', import.meta.url))
  mkdirSync(root, { recursive: true })
  for (const name of ['node_modules', 'resources', 'package.json']) {
    const target = resolve(electron, name)
    const link = resolve(root, name)
    try {
      symlinkSync(target, link, name === 'package.json' ? 'file' : 'junction')
    } catch (error) {
      if (error.code !== 'EEXIST' || realpathSync(link) !== realpathSync(target)) throw error
    }
  }
}

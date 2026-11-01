import { mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
  const target = fileURLToPath(new URL('../node_modules', import.meta.url))
  mkdirSync(root, { recursive: true })
  try {
    symlinkSync(target, root + '/node_modules', 'junction')
  } catch (error) {
    if (error.code !== 'EEXIST' || realpathSync(root + '/node_modules') !== realpathSync(target))
      throw error
  }
}

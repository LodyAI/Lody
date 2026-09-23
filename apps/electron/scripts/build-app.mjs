import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const electronDir = fileURLToPath(new URL('../', import.meta.url))
const electronViteEntry = fileURLToPath(
  new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url)
)
const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim() ?? ''
const nodeOptions = /--max[-_]old[-_]space[-_]size(?:=|\s|$)/u.test(inheritedNodeOptions)
  ? inheritedNodeOptions
  : `${inheritedNodeOptions} --max-old-space-size=8192`.trim()

function run(entry, args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: electronDir,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions
    },
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  if (result.signal) {
    throw new Error(`Electron application build terminated by ${result.signal}`)
  }

  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(electronViteEntry, ['build', '--mode', 'oss'])

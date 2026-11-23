import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const electronDir = fileURLToPath(new URL('../', import.meta.url))
const packageManagerEntry = process.env.npm_execpath
const electronViteEntry = fileURLToPath(
  new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url)
)
const localEnv = {
  ...process.env,
  LODY_PLATFORM: 'local'
}

if (!packageManagerEntry || !/\.(?:cjs|mjs|js)$/i.test(packageManagerEntry)) {
  throw new Error(
    'dev:local must be launched through pnpm so the package-manager entrypoint is explicit'
  )
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: electronDir,
    env,
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  if (result.signal) {
    throw new Error(`${args.join(' ')} terminated by ${result.signal}`)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function runScript(script) {
  run(process.execPath, [packageManagerEntry, 'run', script])
}

run(process.execPath, [packageManagerEntry, '--dir', '../cli', 'run', 'dev:build'], localEnv)
runScript('sync:cli:dev')
run(process.execPath, [electronViteEntry, 'dev', '--watch', '--mode', 'oss'], localEnv)

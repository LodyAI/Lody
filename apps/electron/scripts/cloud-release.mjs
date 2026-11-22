import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolvePnpmRunner } from '../../cli/pnpm-runner.mjs'
const [environment, ...args] = process.argv.slice(2)
if (!['production', 'staging'].includes(environment)) throw new Error('Invalid cloud environment')
if (process.env.LODY_ENV && process.env.LODY_ENV !== environment)
  throw new Error('Conflicting cloud environment')
const runner = resolvePnpmRunner()
const env = { ...process.env, VITE_LODY_PLATFORM: 'cloud', LODY_ENV: environment }
for (const command of [
  ['run', 'build'],
  ['run', 'package', '--', environment === 'staging' ? '--staging' : '--production', ...args]
]) {
  const result = spawnSync(runner.command, [...runner.args, ...command], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    shell: runner.shell,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

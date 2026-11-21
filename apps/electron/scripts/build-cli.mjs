import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const electronDir = fileURLToPath(new URL('../', import.meta.url))
const childEnv = {
  ...process.env,
  LODY_PLATFORM: process.env.VITE_LODY_PLATFORM === 'cloud' ? 'cloud' : 'local',
  LODY_CLI_INLINE_DEPLOY_ENV: '0'
}

function getRunner() {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && /\.(?:cjs|mjs|js)$/i.test(npmExecPath)) {
    return {
      command: process.execPath,
      args: [npmExecPath, '--dir', '../cli', 'run', 'build'],
      shell: false
    }
  }

  const userAgent = process.env.npm_config_user_agent ?? ''
  if (
    userAgent.startsWith('bun/') ||
    (npmExecPath && /(?:^|[\\/])bun(?:\.exe)?$/i.test(npmExecPath))
  ) {
    return {
      command: 'bun',
      args: ['--cwd=../cli', 'run', 'build'],
      shell: process.platform === 'win32'
    }
  }

  return {
    command: 'pnpm',
    args: ['--dir', '../cli', 'run', 'build'],
    shell: process.platform === 'win32'
  }
}

const runner = getRunner()
let child

try {
  child = spawn(runner.command, runner.args, {
    cwd: electronDir,
    env: childEnv,
    shell: runner.shell,
    stdio: 'inherit'
  })
} catch (error) {
  console.error(error)
  process.exit(1)
}

child.on('exit', (code) => {
  process.exit(code ?? 1)
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})

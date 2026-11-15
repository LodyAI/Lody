#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runTypechecks({ run = runConfig } = {}) {
  const results = await Promise.all(['tsconfig.node.json', 'tsconfig.web.json'].map(run))
  return results.every(Boolean)
}
function runConfig(config) {
  return new Promise((resolve) => {
    const child = spawn(
      'corepack',
      ['pnpm', 'exec', 'tsgo', '--noEmit', '-p', config, '--composite', 'false'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdio: 'inherit',
        shell: process.platform === 'win32'
      }
    )
    child.on('error', (error) => {
      console.error(error)
      resolve(false)
    })
    child.on('close', (code, signal) => resolve(code === 0 && signal === null))
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = (await runTypechecks()) ? 0 : 1
}

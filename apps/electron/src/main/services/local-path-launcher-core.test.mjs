import assert from 'node:assert/strict'
import test from 'node:test'
import { launchCommandPathWithFallback } from './local-path-launcher-core.ts'

void test('opens the deeplink after every command candidate fails', async () => {
  const attempts = []
  const input = {
    kind: 'command',
    command: { command: 'code' },
    fallbackCommands: [{ command: '/Applications/Visual Studio Code.app/code' }],
    fallbackUrl: 'vscode://file/Users/me/project/?windowId=_blank',
    targetPath: '/Users/me/project'
  }

  const result = await launchCommandPathWithFallback(
    input,
    async (command) => {
      attempts.push(command.command)
      return {
        launched: false,
        method: 'command',
        command: command.command,
        error: `missing: ${command.command}`
      }
    },
    async (url) => {
      attempts.push(url)
      return { launched: true, method: 'url', url }
    }
  )

  assert.deepEqual(attempts, [
    'code',
    '/Applications/Visual Studio Code.app/code',
    'vscode://file/Users/me/project/?windowId=_blank'
  ])
  assert.deepEqual(result, {
    launched: true,
    method: 'url',
    url: 'vscode://file/Users/me/project/?windowId=_blank'
  })
})

void test('does not open the deeplink when a command launches', async () => {
  let openedUrl = false
  const result = await launchCommandPathWithFallback(
    {
      kind: 'command',
      command: { command: 'code' },
      fallbackUrl: 'vscode://file/Users/me/project/?windowId=_blank',
      targetPath: '/Users/me/project'
    },
    async (command) => ({ launched: true, method: 'command', command: command.command }),
    async (url) => {
      openedUrl = true
      return { launched: true, method: 'url', url }
    }
  )

  assert.equal(openedUrl, false)
  assert.deepEqual(result, { launched: true, method: 'command', command: 'code' })
})

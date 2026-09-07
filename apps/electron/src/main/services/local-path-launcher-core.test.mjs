import assert from 'node:assert/strict'
import test from 'node:test'
import { launchCommandPathWithFallback, probePathLauncher } from './local-path-launcher-core.ts'

void test('reports a launcher available when any command candidate exists', async () => {
  const checked = []
  const available = await probePathLauncher(
    {
      kind: 'command',
      command: { command: 'cursor' },
      fallbackCommands: [{ command: '/Applications/Cursor.app/cursor' }],
      targetPath: '/Users/me/project'
    },
    async ({ command }) => {
      checked.push(command)
      return command.startsWith('/Applications/')
    },
    async () => false
  )

  assert.equal(available, true)
  assert.deepEqual(checked, ['cursor', '/Applications/Cursor.app/cursor'])
})

void test('uses a registered protocol after command candidates are unavailable', async () => {
  let checkedProtocol = null
  const available = await probePathLauncher(
    {
      kind: 'command',
      command: { command: 'code' },
      fallbackUrl: 'vscode://file/Users/me/project',
      targetPath: '/Users/me/project'
    },
    async () => false,
    async (url) => {
      checkedProtocol = url
      return true
    }
  )

  assert.equal(available, true)
  assert.equal(checkedProtocol, 'vscode://file/Users/me/project')
})

void test('reports a URL launcher unavailable when its protocol is not registered', async () => {
  const available = await probePathLauncher(
    {
      kind: 'url',
      url: 'warp://action/new_tab?path=%2Ftmp',
      targetPath: '/tmp'
    },
    async () => true,
    async () => false
  )

  assert.equal(available, false)
})

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

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

void test('default application opening rejects executable files, bundles and symlink targets', async (t) => {
  const { mkdtemp, writeFile, mkdir, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { canOpenLocalPath } = await import('./local-file-open-policy.ts')
  const root = await mkdtemp(join(tmpdir(), 'lody-open-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const suffix of [
    'command',
    'app',
    'sh',
    'exe',
    'bat',
    'ps1',
    'desktop',
    'AppImage',
    'lnk'
  ]) {
    const target = join(root, `unsafe.${suffix}`)
    await writeFile(target, 'synthetic', { mode: 0o644 })
    assert.equal(await canOpenLocalPath(target), false, suffix)
  }
  const executable = join(root, 'no-extension')
  await writeFile(executable, 'synthetic', { mode: 0o755 })
  assert.equal(await canOpenLocalPath(executable), false)
  await symlink(executable, join(root, 'innocent.txt'))
  assert.equal(await canOpenLocalPath(join(root, 'innocent.txt')), false)
  await mkdir(join(root, 'Tool.app'))
  await writeFile(join(root, 'Tool.app', 'notes.txt'), 'synthetic')
  await symlink(join(root, 'Tool.app'), join(root, 'alias'))
  assert.equal(await canOpenLocalPath(join(root, 'alias', 'notes.txt')), false)
  await writeFile(join(root, 'notes.txt'), 'ordinary document', { mode: 0o644 })
  assert.equal(await canOpenLocalPath(join(root, 'notes.txt')), true)
  assert.equal(await canOpenLocalPath(root), true)
})

void test('launcher commands come from main configuration and custom changes require native approval', async () => {
  const { readFile } = await import('node:fs/promises')
  const { runInNewContext } = await import('node:vm')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const ts = require('typescript')
  const ipc = await import('@lody/shared/electron-ipc')
  const builders = await import('@lody/shared/path-launchers')
  let launchers = []
  let answer = 0
  const dialogs = []
  const owner = { isDestroyed: () => false }
  const deps = {
    electron: {
      dialog: {
        showMessageBox: async (window, options) => {
          assert.equal(window, owner)
          dialogs.push(options)
          return { response: answer }
        }
      }
    },
    '../settings-store': {
      createMainSettingsStore: () => ({
        get: () => launchers,
        set: (_key, value) => {
          launchers = value
        }
      })
    },
    '../menu': { translateMenu: (_key, fallback) => fallback },
    '@lody/shared/path-launchers': builders,
    '@lody/shared/electron-ipc': ipc,
    '@lody/shared/node/process': {},
    '../utils': {},
    './local-path-launcher-core': {},
    './shell-env': {}
  }
  const exports = {}
  runInNewContext(
    ts.transpileModule(
      await readFile(new URL('./local-path-launcher-service.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true
        }
      }
    ).outputText,
    {
      exports,
      process: { platform: 'darwin' },
      require: (id) => (Object.hasOwn(deps, id) ? deps[id] : require(id))
    }
  )
  const request = {
    launcherId: 'vscode',
    targetPath: '/tmp/project; literal',
    targetKind: 'directory'
  }
  const built = exports.resolvePathLauncher(request)
  assert.equal(built.command.command, 'code')
  assert.equal(built.command.args[1], request.targetPath)
  assert.equal(exports.resolvePathLauncher({ ...request, launcherId: 'sh' }), null)
  assert.equal(exports.resolvePathLauncher({ ...request, launcherId: 'custom:editor' }), null)
  const custom = { id: 'editor', label: 'My editor', commandTemplate: 'code-insiders "{path}"' }
  assert.equal((await exports.approvePathLauncher(custom, owner)).approved, false)
  assert.equal(launchers.length, 0)
  answer = 1
  assert.equal((await exports.approvePathLauncher(custom, owner)).approved, true)
  assert.equal(dialogs[1].defaultId, 0)
  assert.equal(dialogs[1].cancelId, 0)
  assert.equal(dialogs[1].detail.includes(custom.commandTemplate), true)
  assert.equal(
    exports.resolvePathLauncher({ ...request, launcherId: 'custom:editor' }).command.command,
    'code-insiders'
  )
  answer = 0
  await exports.approvePathLauncher({ ...custom, commandTemplate: 'sh "{path}"' }, owner)
  assert.equal(
    exports.resolvePathLauncher({ ...request, launcherId: 'custom:editor' }).command.command,
    'code-insiders'
  )
})

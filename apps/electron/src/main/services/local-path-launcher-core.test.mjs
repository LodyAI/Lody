import assert from 'node:assert/strict'
import test from 'node:test'
import {
  launchCommandPathWithFallback,
  selectSafePathLauncherInput,
  probePathLauncher
} from './local-path-launcher-core.ts'

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
  const { mkdtemp, writeFile, mkdir, symlink, rm, chmod } = await import('node:fs/promises')
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
  assert.equal(await canOpenLocalPath(join(root, 'alias', 'notes.txt'), 'darwin'), false)
  await writeFile(join(root, 'notes.txt'), 'ordinary document', { mode: 0o644 })
  assert.equal(await canOpenLocalPath(join(root, 'notes.txt')), true)
  assert.equal(await canOpenLocalPath(root), true)
  const source = join(root, 'go', 'src', 'github.com', 'owner', 'three.js')
  await mkdir(source, { recursive: true })
  const document = join(source, 'README.md')
  await writeFile(document, 'ordinary versioned document')
  await chmod(document, 0o777)
  assert.equal(await canOpenLocalPath(document), true)
  assert.equal(await canOpenLocalPath(source), true)
  const unknown = join(source, 'unknown.binary')
  await writeFile(unknown, 'synthetic executable', { mode: 0o755 })
  assert.equal(await canOpenLocalPath(unknown), false)
  await symlink(join(root, 'unsafe.command'), join(root, 'disguised.md'))
  assert.equal(await canOpenLocalPath(join(root, 'disguised.md')), false)
})

void test('launcher commands come from main configuration and custom changes require native approval', async () => {
  const { readFile } = await import('node:fs/promises')
  const { runInNewContext } = await import('node:vm')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const ts = require('typescript')
  const ipc = await import('@lody/shared/electron-ipc')
  const core = await import('./local-path-launcher-core.ts')
  const pathModule = await import('node:path')
  const { EventEmitter } = await import('node:events')
  const runtimeProcess = { platform: 'darwin', env: {} }
  const started = []
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
    'node:path': new Proxy(
      {},
      {
        get: (_target, name) =>
          (runtimeProcess.platform === 'win32' ? pathModule.win32 : pathModule.posix)[name]
      }
    ),
    'node:fs/promises': {
      stat: async (value) => ({ isFile: () => value.endsWith('.exe') }),
      access: async () => {}
    },
    '@lody/shared/node/process': {
      startProcessLegacy: (spec) => {
        started.push(spec)
        const child = new EventEmitter()
        child.unref = () => {}
        queueMicrotask(() => child.emit('spawn'))
        return { child }
      }
    },
    '../utils': {},
    './local-path-launcher-core': core,
    './shell-env': {
      getUserShellEnvCachedLegacy: async () => ({}),
      shouldUseWindowsShell: (command) =>
        runtimeProcess.platform === 'win32' &&
        (/\.(cmd|bat)$/iu.test(command) ||
          (!/[\\/]/u.test(command) && !/\.(exe|com)$/iu.test(command)))
    }
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
      process: runtimeProcess,
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
  // Replacing renderer preferences repeatedly cannot permanently exhaust main's store.
  answer = 1
  for (let index = 0; index < 21; index++) {
    const next = { ...custom, id: `replacement-${index}` }
    assert.equal((await exports.approvePathLauncher(next, owner)).approved, true)
  }
  assert.equal(launchers.length, 20)
  assert.equal(
    exports.resolvePathLauncher({ ...request, launcherId: 'custom:replacement-0' }),
    null
  )
  assert.equal(
    exports.resolvePathLauncher({ ...request, launcherId: 'custom:replacement-20' }).command
      .command,
    'code-insiders'
  )
  runtimeProcess.platform = 'win32'
  const windowsRequest = { ...request, targetPath: 'C:\\R&D\\repo' }
  const windowsInput = exports.resolvePathLauncher(windowsRequest)
  assert.notEqual(windowsInput, null)
  assert.equal(await exports.hasPathLauncher(windowsInput), true)
  assert.equal((await exports.launchLocalPath(windowsInput)).launched, true)
  assert.equal(started[0].command.endsWith('Code.exe'), true)
  assert.equal(started[0].options.shell, false)
  assert.deepEqual(started[0].args, ['-n', windowsRequest.targetPath])
  const refused = await exports.launchLocalPath({
    kind: 'command',
    command: { command: 'only.cmd' },
    targetPath: windowsRequest.targetPath
  })
  assert.equal(refused.launched, false)
  assert.equal(refused.error, 'unsafe_shell_path')
})

void test('Windows metacharacter paths preserve native executables and URLs while excluding shell candidates', async () => {
  const { buildPathLauncherLaunchInput } = await import('@lody/shared/path-launchers')
  const usesShell = (command) =>
    /\.(cmd|bat)$/iu.test(command) || (!/[\\/]/u.test(command) && !/\.(exe|com)$/iu.test(command))
  for (const character of ['&', '|', '<', '>', '^', '%', '!', '"']) {
    const targetPath = `C:\\R${character}D\\repo`
    const built = buildPathLauncherLaunchInput(
      { kind: 'builtin', id: 'vscode', label: 'VS Code' },
      targetPath,
      'win32'
    )
    const safe = selectSafePathLauncherInput(
      {
        ...built,
        fallbackCommands: [...built.fallbackCommands, { command: 'code.cmd', args: [targetPath] }]
      },
      'win32',
      usesShell
    )
    assert.equal(safe.kind, 'command')
    assert.equal(safe.command.command.endsWith('Code.exe'), true)
    assert.deepEqual(safe.command.args, ['-n', targetPath])
    assert.equal(
      [safe.command, ...safe.fallbackCommands].some((item) => usesShell(item.command)),
      false
    )
    const available = await probePathLauncher(
      safe,
      async (spec) => spec.command.endsWith('Code.exe'),
      async () => false
    )
    assert.equal(available, true)
    const launched = await launchCommandPathWithFallback(
      safe,
      async (spec) => ({ launched: true, method: 'command', command: spec.command }),
      async () => {
        throw new Error('unexpected URL')
      }
    )
    assert.equal(launched.launched, true)
    const urlOnly = selectSafePathLauncherInput(
      { ...built, fallbackCommands: [] },
      'win32',
      usesShell
    )
    assert.equal(urlOnly.kind, 'url')
    assert.equal(urlOnly.url, built.fallbackUrl)
    assert.equal(
      selectSafePathLauncherInput(
        { kind: 'command', command: { command: 'only.cmd' }, targetPath },
        'win32',
        usesShell
      ),
      null
    )
  }
})

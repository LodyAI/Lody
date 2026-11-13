import { isTrustedProductRendererUrl } from './product-renderer-url.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { isClientLossProbeChannel, isIpcInvokeChannel } from '../../preload/ipc-invoke-policy.ts'

void test('invoke policy allows methods only within renderer-facing service groups', () => {
  assert.equal(isIpcInvokeChannel('auth.getSession'), true)
  for (const method of [
    'createMemberInvitation',
    'pendingMemberJoin',
    'prepareMemberJoin',
    'memberJoinRequests',
    'approveMemberJoin',
    'memberKeyDeliveries',
    'retryMemberKeyDelivery',
    'rejectMemberJoin',
    'revokeMemberInvitation',
    'claimMemberJoin',
    'personalPairingOffer',
    'pendingPersonalJoin',
    'preparePersonalJoin',
    'inspectPersonalJoin',
    'approvePersonalJoin',
    'claimPersonalJoin',
    'cancelPersonalJoin',
    'prepareCreation',
    'recordCreated',
    'open',
    'close',
    'status',
    'inspectCachedState',
    'readIdentity',
    'ingestLedgerRecords',
    'ledgerView',
    'managementState',
    'updateKeys',
    'revokeDevice',
    'createRecoveryVault',
    'saveRecoveryVaultFile',
    'setRecoveryPassword',
    'removeRecoveryPassword'
  ])
    assert.equal(isIpcInvokeChannel(`e2ee.${method}`), true)
  for (const method of [
    'sign',
    'exportKey',
    'createDevice',
    'deviceCredential',
    'promoteMember',
    'memberScope',
    'installMemberJoin',
    'unknown'
  ])
    assert.equal(isIpcInvokeChannel(`e2ee.${method}`), false)
  assert.equal(isIpcInvokeChannel('cli.methodAddedWithoutASecondAllowlist'), true)
  assert.equal(isIpcInvokeChannel('lodyAuth:getSession'), false)
  assert.equal(isIpcInvokeChannel('unknown.getState'), false)
  assert.equal(isIpcInvokeChannel('cli.restart.extra'), false)
})

void test('admits the E2E client-loss probe only with the argument main passes when it registered it', () => {
  const flag = '--lody-e2ee-client-loss-probe'
  for (const channel of ['e2ee.inspectClientLoss', 'e2ee.clientLossEffects']) {
    assert.equal(isClientLossProbeChannel(channel, ['electron', 'app']), false)
    assert.equal(isClientLossProbeChannel(channel, ['electron', 'app', flag]), true)
  }
  assert.equal(isClientLossProbeChannel('e2ee.seal', ['electron', flag]), false)
  // The ordinary invoke policy never lists it: production preload rejects the channel.
  assert.equal(isIpcInvokeChannel('e2ee.inspectClientLoss'), false)
})

// Exercise actual decorator registration and a privileged CLI handler with synthetic windows.
void test('privileged IPC rejects browser views, iframes and unknown windows before changing CLI state', async () => {
  const { readFile } = await import('node:fs/promises')
  const { runInNewContext } = await import('node:vm')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const ts = require('typescript')
  const handlers = new Map()
  const sends = new Map()
  const windows = new Map()
  const productWindows = new Set()
  const electron = {
    BrowserWindow: { fromWebContents: (sender) => windows.get(sender) },
    ipcMain: {
      on: (channel, handler) => sends.set(channel, handler),
      handle: (channel, handler) => handlers.set(channel, handler)
    }
  }
  const load = async (
    relative,
    deps,
    env = {},
    platform = 'linux',
    mainDirectory = '/app/out/main'
  ) => {
    const exports = {}
    runInNewContext(
      ts.transpileModule(await readFile(new URL(relative, import.meta.url), 'utf8'), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          experimentalDecorators: true
        }
      }).outputText,
      {
        exports,
        URL,
        __dirname: mainDirectory,
        process: { env, platform },
        console,
        require: (id) => (Object.hasOwn(deps, id) ? deps[id] : require(id))
      }
    )
    return exports
  }
  const decoratorSource = await readFile(require.resolve('electron-ipc-decorator'), 'utf8')
  const decoratorExports = {}
  runInNewContext(decoratorSource, {
    exports: decoratorExports,
    require: (id) => (id === 'electron' ? electron : require(id)),
    console
  })
  const senderGuard = await load('./assert-sender.ts', {
    electron,
    '../window-state': { productWindows },
    './product-renderer-url': { isTrustedProductRendererUrl }
  })
  const service = await load('./product-window-ipc-service.ts', {
    'electron-ipc-decorator': decoratorExports,
    './assert-sender': senderGuard,
    electron
  })
  let running = true
  const cli = await load('./services/cli-ipc.ts', {
    'electron-ipc-decorator': decoratorExports,
    '../product-window-ipc-service': service,
    '../ipc-service-deps': {
      getIpcServiceDeps: () => ({
        cliService: {
          attachCliStateSender() {},
          terminateAutoStart: () => {
            running = false
            return { stopped: true }
          }
        }
      })
    }
  })
  new cli.CliIpc()
  const window = () => {
    const sender = { mainFrame: { url: 'file:///app/out/renderer/index.html' } }
    const owner = { webContents: sender, isDestroyed: () => false }
    windows.set(sender, owner)
    productWindows.add(owner)
    return { sender, senderFrame: sender.mainFrame }
  }
  service.onProductWindowMessage('terminal.input', () => {
    running = false
  })
  const primary = window()
  const auxiliary = window()
  const unknown = window()
  productWindows.delete(windows.get(unknown.sender))
  const view = { mainFrame: { url: 'https://example.com' } }
  windows.set(view, windows.get(primary.sender))
  for (const event of [
    unknown,
    { sender: view, senderFrame: view.mainFrame },
    { ...primary, senderFrame: { url: primary.senderFrame.url } },
    { ...primary, senderFrame: { url: 'https://example.com' } }
  ]) {
    await assert.rejects(handlers.get('cli.terminate')(event), /untrusted renderer/)
    assert.equal(running, true)
    sends.get('terminal.input')(event, { data: 'synthetic' })
    assert.equal(running, true)
  }
  for (const event of [primary, auxiliary]) {
    running = true
    await handlers.get('cli.terminate')(event)
    assert.equal(running, false)
    running = true
    sends.get('terminal.input')(event, { data: 'synthetic' })
    assert.equal(running, false)
  }
  let recovered = false
  let reported = false
  class RecoveryIpc extends service.ProductWindowIpcService {
    static groupName = 'app'
    constructor() {
      super()
      this.registerMethod('requestRendererReload', () => {
        recovered = true
      })
      this.registerMethod('reportRendererFatalError', () => {
        reported = true
      })
      this.registerMethod('openLocalPath', () => {
        throw new Error('privileged handler reached')
      })
    }
  }
  new RecoveryIpc()
  const recovery = window()
  recovery.senderFrame.url = 'file:///app/out/renderer/recovery.html'
  await handlers.get('app.requestRendererReload')(recovery)
  await handlers.get('app.reportRendererFatalError')(recovery)
  assert.equal(recovered, true)
  assert.equal(reported, true)
  await assert.rejects(handlers.get('app.openLocalPath')(recovery), /untrusted renderer/)
  await assert.rejects(handlers.get('cli.terminate')(recovery), /untrusted renderer/)
  for (const url of [
    'file:///foreign/out/renderer/recovery.html',
    'https://example.com/out/renderer/recovery.html'
  ]) {
    const foreign = window()
    foreign.senderFrame.url = url
    await assert.rejects(handlers.get('app.requestRendererReload')(foreign), /untrusted renderer/)
  }
  await assert.rejects(
    handlers.get('app.requestRendererReload')({
      ...recovery,
      senderFrame: { url: recovery.senderFrame.url }
    }),
    /untrusted renderer/
  )
  productWindows.delete(windows.get(recovery.sender))
  await assert.rejects(handlers.get('app.reportRendererFatalError')(recovery), /untrusted renderer/)
  const devGuard = await load(
    './assert-sender.ts',
    {
      electron,
      '../window-state': { productWindows },
      './product-renderer-url': { isTrustedProductRendererUrl }
    },
    { ELECTRON_RENDERER_URL: 'http://localhost:5173' }
  )
  const devRecovery = window()
  devRecovery.senderFrame.url = 'http://localhost:5173/recovery.html'
  devGuard.assertProductWindowSender(devRecovery, 'app.requestRendererReload')
  devGuard.assertProductWindowSender(devRecovery, 'app.reportRendererFatalError')
  assert.throws(
    () => devGuard.assertProductWindowSender(devRecovery, 'cli.terminate'),
    /untrusted renderer/
  )
  const windowsGuard = await load(
    './assert-sender.ts',
    {
      electron,
      '../window-state': { productWindows },
      './product-renderer-url': { isTrustedProductRendererUrl }
    },
    {},
    'win32',
    'c:\\x\\out\\main'
  )
  const windowsProduct = window()
  windowsProduct.senderFrame.url = 'file:///C:/x/out/renderer/index.html'
  windowsGuard.assertProductWindowSender(windowsProduct)
  assert.throws(
    () =>
      windowsGuard.assertProductWindowSender({
        ...windowsProduct,
        senderFrame: { url: windowsProduct.senderFrame.url }
      }),
    /untrusted renderer/
  )
  productWindows.delete(windows.get(windowsProduct.sender))
  assert.throws(() => windowsGuard.assertProductWindowSender(windowsProduct), /untrusted renderer/)
})

void test('preload exposes only the filtered IPC bridge and no raw Electron process environment', async () => {
  const { readFile } = await import('node:fs/promises')
  const { runInNewContext } = await import('node:vm')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const ts = require('typescript')
  const shared = await import('@lody/shared/electron-ipc')
  const policy = await import('../../preload/ipc-invoke-policy.ts')
  for (const contextIsolated of [true, false]) {
    const exposed = {}
    const transmitted = []
    const electron = {
      contextBridge: {
        exposeInMainWorld: (key, value) => {
          exposed[key] = value
        }
      },
      ipcRenderer: {
        on() {},
        invoke: async (channel) => {
          transmitted.push(channel)
          return 'state'
        },
        send: (channel) => {
          transmitted.push(channel)
        }
      }
    }
    const load = async (file, deps) => {
      const exports = {}
      runInNewContext(
        ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true
          }
        }).outputText,
        {
          exports,
          window: exposed,
          console,
          process: {
            contextIsolated,
            platform: 'darwin',
            arch: 'arm64',
            versions: {},
            env: { SYNTHETIC_SECRET: 'must-stay-in-preload' },
            argv: [],
            getSystemVersion: () => 'synthetic'
          },
          require: (id) => {
            if (!Object.hasOwn(deps, id)) throw new Error(`Unexpected preload dependency: ${id}`)
            return deps[id]
          }
        }
      )
      return exports
    }
    const bridge = await load('../../preload/ipc-bridge.ts', {
      electron,
      '@lody/shared/electron-ipc': shared,
      './ipc-invoke-policy': policy
    })
    await load('../../preload/index.ts', {
      electron,
      './ipc-bridge': bridge,
      '@better-auth/electron/preload': { setupRenderer() {} },
      '@electron-toolkit/preload': {
        electronAPI: {
          ipcRenderer: electron.ipcRenderer,
          process: { env: { SYNTHETIC_SECRET: 'must-stay-in-preload' } }
        }
      },
      'node:os': { homedir: () => '/synthetic', hostname: () => 'synthetic' },
      '../system-language-argument': { readPreferredSystemLanguagesArgument: () => ['en'] },
      './boot-profiler': {},
      '@lody/shared/electron-ipc': shared
    })
    assert.equal(exposed.electron, undefined)
    assert.equal(exposed.process, undefined)
    assert.equal(exposed.__LODY_ELECTRON__, true)
    assert.equal(await exposed.ipc.invoke('cli.getState'), 'state')
    await assert.rejects(exposed.ipc.invoke('arbitrary.channel'), /Blocked IPC invoke/)
    assert.throws(() => exposed.ipc.send('arbitrary.channel'), /Blocked IPC send/)
    assert.deepEqual(transmitted, ['cli.getState'])
  }
})

void test('packaged Windows renderer admission ignores path casing without admitting other directories or recovery privileges', () => {
  const windows = { platform: 'win32', mainDirectory: 'c:\\x\\out\\main' }
  for (const entry of ['index.html', 'devbar.html']) {
    assert.equal(isTrustedProductRendererUrl(`file:///C:/x/out/renderer/${entry}`, windows), true)
    assert.equal(
      isTrustedProductRendererUrl(`file:///c:/X/OUT/RENDERER/${entry.toUpperCase()}`, windows),
      true
    )
    assert.equal(
      isTrustedProductRendererUrl(`file:///C:/elsewhere/out/renderer/${entry}`, windows),
      false
    )
  }
  const recovery = 'file:///C:/x/out/renderer/recovery.html'
  assert.equal(isTrustedProductRendererUrl(recovery, windows), false)
  assert.equal(
    isTrustedProductRendererUrl(recovery, { ...windows, channel: 'cli.terminate' }),
    false
  )
  for (const channel of ['app.requestRendererReload', 'app.reportRendererFatalError']) {
    assert.equal(isTrustedProductRendererUrl(recovery, { ...windows, channel }), true)
    assert.equal(
      isTrustedProductRendererUrl('file:///C:/other/out/renderer/recovery.html', {
        ...windows,
        channel
      }),
      false
    )
  }
  for (const sender of [
    'https://example.com/x/out/renderer/index.html',
    'file://remote/C:/x/out/renderer/index.html',
    'file:///C:/x/out/renderer%2Findex.html'
  ]) {
    assert.equal(isTrustedProductRendererUrl(sender, windows), false)
  }
  for (const platform of ['linux', 'darwin']) {
    const posix = { platform, mainDirectory: '/x/out/main' }
    assert.equal(isTrustedProductRendererUrl('file:///x/out/renderer/index.html', posix), true)
    assert.equal(isTrustedProductRendererUrl('file:///X/out/renderer/index.html', posix), false)
    assert.equal(isTrustedProductRendererUrl('file:///x/out/renderer/INDEX.HTML', posix), false)
    assert.equal(isTrustedProductRendererUrl('file:///other/out/renderer/index.html', posix), false)
  }
})

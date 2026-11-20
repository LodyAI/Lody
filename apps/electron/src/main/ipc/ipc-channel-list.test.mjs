import { isTrustedProductRendererUrl } from './product-renderer-url.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { isClientLossProbeChannel, isIpcInvokeChannel } from '../../preload/ipc-invoke-policy.ts'

void test('invoke policy allows methods only within renderer-facing service groups', () => {
  assert.equal(isIpcInvokeChannel('auth.getSession'), true)
  // Full @IpcMethod() parity for E2eeIpc is verified dynamically in e2ee-account-runtime.test.mjs.
  assert.equal(isIpcInvokeChannel('e2ee.open'), true)
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
  const { EventEmitter } = await import('node:events')
  const window = () => {
    const sender = new EventEmitter()
    sender.mainFrame = { url: 'file:///app/out/renderer/index.html' }
    sender.isDestroyed = () => false
    sender.send = (channel, value) => sender.emit(channel, value)
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
  // Native Workspace Meta IPC through the same trusted-window guard and a real host.
  const { mkdtemp, rm, readFile: readText } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const nativeRepo = await import('@lody/shared/node/native-repo')
  const nativeMeta = await import('@lody/shared/node/native-workspace-meta')
  const nativeIpc = await import('@lody/shared/native-workspace-meta-ipc')
  const nativeFlockDocs = await import('@lody/shared/node/native-flock-docs')
  const nativeDocs = await import('@lody/shared/node/native-docs')
  // Electron main does not depend on Loro; the test borrows the shared package's copy.
  const { LoroDoc } = createRequire(
    new URL('../../../../../packages/shared/package.json', import.meta.url)
  )('loro-crdt')
  const nativeDir = await mkdtemp(join(tmpdir(), 'lody-native-meta-ipc-'))
  const hostScript = fileURLToPath(
    new URL('../../../../../packages/shared/tests/fixtures/native-repo-host.mjs', import.meta.url)
  )
  let nativeEnabled = false
  const meta = await load('./services/native-workspace-meta-ipc.ts', {
    'electron-ipc-decorator': decoratorExports,
    '../product-window-ipc-service': service,
    '../../platform': {
      isLocalPlatform: () => true,
      readLocalPlatformSnapshot: async () => ({
        userId: 'local:me',
        workspace: { workspaceId: 'lw_test' }
      })
    },
    '../../services/cli-service': {
      bundledNativeRepoHostLauncher: () => ({ command: process.execPath, args: [hostScript] })
    },
    '@lody/shared/node/native-repo': {
      ...nativeRepo,
      isNativeWorkspaceMetaEnabled: () => nativeEnabled,
      connectNativeRepo: (options) =>
        nativeRepo.connectNativeRepo({ ...options, dataDir: nativeDir })
    },
    '@lody/shared/node/native-workspace-meta': nativeMeta,
    '@lody/shared/node/native-flock-docs': nativeFlockDocs,
    '@lody/shared/node/native-docs': nativeDocs,
    '@lody/shared/native-workspace-meta-ipc': nativeIpc
  })
  new meta.NativeWorkspaceMetaIpc()
  const scope = { workspaceId: 'lw_test' }
  try {
    assert.equal(await handlers.get('nativeWorkspaceMeta.available')(primary, scope), false)
    nativeEnabled = true
    await assert.rejects(
      handlers.get('nativeWorkspaceMeta.available')(unknown, scope),
      /untrusted renderer/
    )
    await assert.rejects(
      handlers.get('nativeWorkspaceMeta.open')(primary, {
        workspaceId: 'lw_foreign',
        observationId: '00000000-0000-4000-8000-000000000001'
      }),
      /scope_denied/
    )
    const first = '00000000-0000-4000-8000-000000000001'
    const second = '00000000-0000-4000-8000-000000000002'
    const primaryUpdates = []
    const auxiliaryUpdates = []
    primary.sender.on(nativeIpc.NATIVE_META_CHANNEL, (event) => primaryUpdates.push(event))
    auxiliary.sender.on(nativeIpc.NATIVE_META_CHANNEL, (event) => auxiliaryUpdates.push(event))
    const snapshot = await handlers.get('nativeWorkspaceMeta.open')(primary, {
      ...scope,
      observationId: first
    })
    assert.deepEqual(snapshot.docs, [])
    await handlers.get('nativeWorkspaceMeta.open')(auxiliary, { ...scope, observationId: second })
    // A command from one window reaches the other window's view before its receipt.
    const receipt = await handlers.get('nativeWorkspaceMeta.commit')(primary, {
      ...scope,
      command: { kind: 'upsert-doc', docId: 'session-a', patch: { title: 'Synthetic' } }
    })
    assert.equal(receipt.outcome, 'committed')
    const delivered = auxiliaryUpdates.at(-1)
    assert.equal(delivered.observationId, second)
    assert.equal(delivered.update.changes.revision, receipt.revision)
    assert.deepEqual(delivered.update.changes.docs[0].meta, { title: 'Synthetic' })
    // A navigating window drops only its own view.
    primary.sender.emit('did-start-navigation', {}, 'file:///other', false, true)
    const seen = primaryUpdates.length
    await handlers.get('nativeWorkspaceMeta.commit')(auxiliary, {
      ...scope,
      command: { kind: 'delete-doc', docId: 'session-a' }
    })
    assert.equal(primaryUpdates.length, seen)
    assert.equal(auxiliaryUpdates.at(-1).update.changes.docs[0].deleted, true)
    await assert.rejects(
      handlers.get('nativeWorkspaceMeta.commit')(primary, {
        ...scope,
        command: { kind: 'upsert-doc', docId: 'x', patch: {}, extra: 1 }
      })
    )
    // Owned named Flock documents: only this workspace's owned ids are admitted.
    const catalogId = nativeIpc.nativeFlockDocIds('lw_test')[0]
    await assert.rejects(
      handlers.get('nativeWorkspaceMeta.openFlockDoc')(auxiliary, {
        ...scope,
        flockDocId: 'lw_foreign:mf:other',
        observationId: '00000000-0000-4000-8000-000000000003'
      }),
      /scope_denied/
    )
    const flockEvents = []
    auxiliary.sender.on(nativeIpc.NATIVE_FLOCK_CHANNEL, (event) => flockEvents.push(event))
    await handlers.get('nativeWorkspaceMeta.openFlockDoc')(auxiliary, {
      ...scope,
      flockDocId: catalogId,
      observationId: '00000000-0000-4000-8000-000000000004'
    })
    assert.equal(flockEvents[0].event.kind, 'snapshot')
    const bundle = {
      version: 0,
      entries: { '["mcpServer","a"]': { c: '1,0,renderer', d: { name: 'a' } } }
    }
    await handlers.get('nativeWorkspaceMeta.commitFlockDoc')(auxiliary, {
      ...scope,
      flockDocId: catalogId,
      payloads: [new TextEncoder().encode(JSON.stringify(bundle))]
    })
    while (!flockEvents.some((event) => event.event.kind === 'changes'))
      await new Promise((resolve) => setImmediate(resolve))
    const changed = flockEvents.find((event) => event.event.kind === 'changes').event.registers
    assert.deepEqual(changed[0].key, ['mcpServer', 'a'])
    assert.equal(changed[0].clockEncoded, '1,0,renderer')
    // Session documents: only owned ids parse; one window's commit reaches the other.
    await assert.rejects(
      handlers.get('nativeWorkspaceMeta.openDoc')(auxiliary, {
        ...scope,
        docId: 'schedule-x',
        observationId: '00000000-0000-4000-8000-000000000005'
      })
    )
    const docEvents = []
    auxiliary.sender.on(nativeIpc.NATIVE_DOC_CHANNEL, (event) => docEvents.push(event))
    await handlers.get('nativeWorkspaceMeta.openDoc')(auxiliary, {
      ...scope,
      docId: 'session-a',
      observationId: '00000000-0000-4000-8000-000000000006'
    })
    assert.equal(docEvents[0].event.kind, 'snapshot')
    const authored = new LoroDoc()
    authored.getList('history').push('turn')
    authored.commit()
    await handlers.get('nativeWorkspaceMeta.commitDoc')(primary, {
      ...scope,
      docId: 'session-a',
      updates: [authored.export({ mode: 'update' })]
    })
    while (!docEvents.some((event) => event.event.kind === 'changes'))
      await new Promise((resolve) => setImmediate(resolve))
    const replica = new LoroDoc()
    replica.import(docEvents[0].event.file)
    for (const event of docEvents.filter((e) => e.event.kind === 'changes'))
      for (const update of event.event.updates) replica.import(update)
    assert.deepEqual(replica.getList('history').toJSON(), ['turn'])
    // A window reopening a retained replica receives only the ops past its version.
    const version = Object.fromEntries(replica.oplogVersion().toJSON())
    const later = new LoroDoc()
    later.import(replica.export({ mode: 'snapshot' }))
    later.getList('history').push('later')
    later.commit()
    await handlers.get('nativeWorkspaceMeta.commitDoc')(primary, {
      ...scope,
      docId: 'session-a',
      updates: [later.export({ mode: 'update', from: replica.oplogVersion() })]
    })
    const reopened = []
    auxiliary.sender.on(nativeIpc.NATIVE_DOC_CHANNEL, (event) => {
      if (event.observationId === '00000000-0000-4000-8000-000000000007') reopened.push(event.event)
    })
    await handlers.get('nativeWorkspaceMeta.openDoc')(auxiliary, {
      ...scope,
      docId: 'session-a',
      observationId: '00000000-0000-4000-8000-000000000007',
      since: version
    })
    assert.equal(reopened[0].kind, 'snapshot')
    assert.equal(reopened[0].delta, true)
    assert.ok(reopened[0].file.byteLength < later.export({ mode: 'snapshot' }).byteLength)
    replica.import(reopened[0].file)
    assert.deepEqual(replica.getList('history').toJSON(), ['turn', 'later'])
    // Remote Session documents: reads, changed paths and checked patches, no replica.
    const remote = { ...scope, docId: 'session-remote' }
    const pathEvents = []
    auxiliary.sender.on(nativeIpc.NATIVE_DOC_PATHS_CHANNEL, (event) => pathEvents.push(event))
    await handlers.get('nativeWorkspaceMeta.observeDocPaths')(auxiliary, {
      ...remote,
      observationId: '00000000-0000-4000-8000-000000000008'
    })
    const queued = { task: 'next', userId: 'local:me', timestamp: 't' }
    const { roomTxId } = await handlers.get('nativeWorkspaceMeta.readDocPath')(primary, {
      ...remote,
      path: ['mq']
    })
    await handlers.get('nativeWorkspaceMeta.applyDocPatch')(primary, {
      ...remote,
      ops: [
        { op: 'arr_splice', path: ['mq'], at: 0, del: 0, items: [queued] },
        { op: 'set', path: ['humanInputReceipts', 'u-1'], value: { userId: 'local:me' } }
      ],
      precondition: { mode: 'rebase', base_room_tx_id: roomTxId }
    })
    while (!pathEvents.some((e) => e.event.kind === 'changes'))
      await new Promise((resolve) => setImmediate(resolve))
    assert.ok(
      pathEvents.some(
        (e) => e.event.kind === 'changes' && e.event.changes.some((c) => c.path[0] === 'mq')
      )
    )
    const mq = await handlers.get('nativeWorkspaceMeta.readDocPath')(auxiliary, {
      ...remote,
      path: ['mq']
    })
    assert.equal(mq.value.length, 1)
    assert.equal(mq.value[0].task, 'next')
    assert.equal(typeof mq.value[0].$cid, 'string')
    // A receipt for another user, or a write outside the input roots, is refused.
    for (const ops of [
      [{ op: 'set', path: ['humanInputReceipts', 'u-2'], value: { userId: 'local:other' } }],
      [{ op: 'unset', path: ['humanInputReceipts', 'u-1'] }],
      [{ op: 'set', path: ['session', 'title'], value: 'x' }]
    ])
      await assert.rejects(
        handlers.get('nativeWorkspaceMeta.applyDocPatch')(primary, {
          ...remote,
          ops,
          precondition: { mode: 'rebase', base_room_tx_id: roomTxId }
        }),
        /native_doc_patch_denied/
      )
    const page = await handlers.get('nativeWorkspaceMeta.readDocListFields')(primary, {
      ...remote,
      start: 0,
      fields: [{ path: ['id'] }]
    })
    assert.equal(page.len, 0)
  } finally {
    const connection = await nativeRepo.connectNativeRepo({
      dataDir: nativeDir,
      launcher: () => {}
    })
    const pid = JSON.parse(await readText(join(nativeDir, 'engine.json'), 'utf8')).pid
    await connection.close()
    process.kill(pid, 'SIGTERM')
    while (
      (() => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      })()
    )
      await new Promise((resolve) => setImmediate(resolve))
    await rm(nativeDir, { recursive: true, force: true })
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

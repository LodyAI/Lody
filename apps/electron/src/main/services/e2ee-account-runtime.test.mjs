import {
  Bytes,
  DatabaseSync,
  E2eeDeviceRevokedError,
  E2eeMemberRemovedError,
  Effect,
  EventEmitter,
  Exit,
  Layer,
  Result,
  Scope,
  TestClock,
  account,
  assert,
  createAccountWorkspace,
  createDesktopQuitBarrier,
  createRequire,
  desktopE2eeFailure,
  drainMainProcessQuitResources,
  electronIpc,
  hashRecordBytes,
  holdWorkspaceTurn,
  identityStorage,
  isIpcInvokeChannel,
  join,
  load,
  makeDesktopE2eeBootstrap,
  makeDesktopE2eeCustody,
  makeDesktopE2eeRuntimeHost,
  makeOfflineAuthIdentityCache,
  nativeAccountFixture,
  personalJoinFixture,
  prepareLedgerCommand,
  proxyEnv,
  randomUUID,
  readFile,
  readdir,
  signLedgerRecord,
  test,
  verifyLedger,
  writeFile
} from './e2ee-account-runtime-test-helpers.mjs'

void test('passive account inspection never reopens an absent or closed owner', async () => {
  let leases = 0,
    custody = 0,
    hosts = 0
  const { api, identity } = await account({
    identityStorage: {
      leaseE2eeIdentity: () =>
        Effect.sync(() => {
          leases++
        })
    },
    custody: () =>
      Effect.sync(() => {
        custody++
        return {}
      }),
    host: () =>
      Effect.sync(() => {
        hosts++
        return {
          inspectCachedState: (workspaceId, machineId) =>
            Effect.succeed({
              workspaceId,
              machineId,
              entryPresent: true,
              cachedPolicies: 1,
              cachedExecutionGrants: 1
            })
        }
      })
  })
  const inspect = () => api.inspectDesktopE2eeCachedState('acc1', 'team', 'machine')
  assert.equal((await inspect()).ownerPresent, false)
  assert.deepEqual([leases, custody, hosts], [0, 0, 0])
  await api.withDesktopE2eeAccount(
    (owner) =>
      Effect.sync(() => {
        owner.readers.set('team', new Map([[1, 2]]))
      }),
    'team'
  )
  const live = await inspect()
  assert.equal(live.ownerPresent, true)
  assert.equal(live.activeContentReaders, 2)
  assert.equal(live.cachedExecutionGrants, 1)
  const opened = [leases, custody, hosts]
  await api.closeDesktopE2eeAccount()
  assert.equal((await inspect()).ownerPresent, false)
  assert.equal((await inspect()).activeContentReaders, 0)
  assert.deepEqual([leases, custody, hosts], opened)
  identity.userId = 'other'
  await assert.rejects(inspect(), /e2ee_host_operation_failed/)
  assert.deepEqual([leases, custody, hosts], opened)
})

void test('failed account cleanup cannot block sign-out or authorize replacement on a second close', async () => {
  const { api, warnings } = await account()
  await api.withDesktopE2eeAccount((owner) =>
    Scope.addFinalizer(owner.scope, Effect.die(new Error('synthetic secret cause')))
  )
  let signedOut = false
  await api.closeDesktopE2eeAccount({
    signOut: async () => {
      signedOut = true
    }
  })
  assert.equal(signedOut, true)
  assert.equal(warnings.length, 1)
  assert.ok(!JSON.stringify(warnings).includes('synthetic secret cause'))
  await assert.rejects(api.closeDesktopE2eeAccount(), /e2ee_restart-required/)
  api.resumeDesktopE2eeAccount()
  await assert.rejects(
    api.withDesktopE2eeAccount(() => Effect.succeed('replacement')),
    /e2ee_restart-required: Restart Lody/
  )
})

void test('cancelled quit reopens admission only after actual in-flight work and cleanup settle', async () => {
  const { api } = await account()
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const work = api.withDesktopE2eeAccount(() =>
    Effect.promise(() => {
      entered.resolve()
      return finish.promise
    })
  )
  await entered.promise
  let closed = false
  const closing = api.closeDesktopE2eeAccount({ quit: true }).then(() => {
    closed = true
  })
  assert.equal(closed, false)
  finish.resolve()
  await work
  await closing
  await assert.rejects(
    api.withDesktopE2eeAccount(() => Effect.void),
    /e2ee_closed/
  )
  api.resumeDesktopE2eeAccount()
  assert.equal(await api.withDesktopE2eeAccount(() => Effect.succeed('available')), 'available')
  await api.closeDesktopE2eeAccount()
})

void test('in-place and subframe navigation retain the ledger lease; document navigation releases it', async () => {
  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    send: () => {}
  })
  const readers = new Map()
  const owner = {
    readers,
    bootstrap: { removedReason: () => Effect.succeed(null) },
    host: {
      pendingClose: () => Effect.succeed(undefined),
      open: () => Effect.succeed('open'),
      status: () => Effect.succeed('ready')
    }
  }
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    '../ipc-service-deps': { getIpcServiceDeps: () => ({}) },
    '../product-window-ipc-service': { ProductWindowIpcService: class {} },
    'electron-ipc-decorator': {
      IpcMethod: () => (_target, _name, descriptor) => descriptor,
      getIpcContext: () => ({ event: { sender } })
    },
    '../../platform': { isLocalPlatform: () => false },
    '../../services/e2ee-bootstrap.mjs': {},
    '../../services/e2ee-account-runtime': {
      withDesktopE2eeAccount: (work) => Effect.runPromise(work(owner)),
      releaseDesktopE2eeReader: () => readers.clear()
    },
    '../assert-sender': { assertProductWindowSender: () => {} }
  })
  const ipc = new E2eeIpc()
  await ipc.open('workspace')
  sender.emit('did-start-navigation', {}, 'synthetic#search', true, true)
  sender.emit('did-start-navigation', {}, 'synthetic-frame', false, false)
  assert.equal(await ipc.status('workspace'), 'ready')
  sender.emit('did-start-navigation', {}, 'synthetic-reload', false, true)
  await assert.rejects(ipc.status('workspace'), /e2ee_not_open/)
})

void test('uncertain admission preserves append and reconciliation failures, then accepts verified retry with a bounded ledger handoff', async () => {
  const sender = Object.assign(new EventEmitter(), {
    id: 17,
    isDestroyed: () => false,
    send: () => {}
  })
  const appendFailure = new Error('synthetic sanitized append failure')
  const reconciliationFailure = new Error('e2ee_invalid-input')
  const request = { workspaceId: 'workspace', requestId: 'stable-request', recordHex: 'aabb' }
  const submitted = []
  let committed = false
  // The desktop's verified originals from genesis, handed to the local agent so it
  // need not replay the same ledger over the network.
  const ledgerView = (records) => ({
    status: { length: records.length, position: `p1:workspace:${records.length}:offset:0` },
    recordsHex: records,
    recordPositions: records.map((_record, index) => index)
  })
  let ledger = ledgerView(['aa', 'bb'])
  const activations = []
  let activationRefusal
  const owner = {
    accountId: 'acc1',
    bootstrap: { deviceCredential: () => Effect.succeed('synthetic-credential') },
    readers: new Map([['workspace', new Set([sender.id])]]),
    host: {
      ledgerView: () => {
        if (ledger === null) throw new Error('synthetic ledger export failure')
        return Effect.succeed(ledger)
      },
      localPairingContext: () => Effect.succeed({ pairingSessionId: '44'.repeat(16) }),
      approveLocalPairing: () => Effect.succeed(request),
      confirmLocalPairing: () =>
        committed
          ? Effect.succeed({ genesisHash: '11'.repeat(32), signingPublicKey: '22'.repeat(32) })
          : Effect.fail(reconciliationFailure)
    }
  }
  const warnings = []
  const localTimeout = new Error('e2ee_local_agent_pending', {
    cause: new Error('synthetic sensitive local payload')
  })
  const { E2eeIpc } = await load(
    '../ipc/services/e2ee-ipc.ts',
    {
      '../ipc-service-deps': {
        getIpcServiceDeps: () => ({
          cliService: {
            getLocalMachineId: async () => 'machine',
            prepareLocalE2eeDevice: async () => {
              throw localTimeout
            },
            activateLocalE2eeDevice: async (message) => {
              activations.push(JSON.parse(JSON.stringify(message)))
              const refusal = activationRefusal
              activationRefusal = undefined
              if (refusal) throw refusal
            }
          }
        })
      },
      '../product-window-ipc-service': { ProductWindowIpcService: class {} },
      'electron-ipc-decorator': {
        IpcMethod: () => (_target, _name, descriptor) => descriptor,
        getIpcContext: () => ({ event: { sender } })
      },
      '../../platform': { isLocalPlatform: () => false },
      '../../services/e2ee-bootstrap.mjs': {},
      '../../services/e2ee-account-runtime': {
        withDesktopE2eeAccount: (work) => Effect.runPromise(work(owner)),
        desktopE2eeCloudClient: async () => ({
          accountId: 'acc1',
          client: {
            appendRecord: (value) => {
              submitted.push(structuredClone(value))
              return Effect.fail(appendFailure)
            }
          }
        })
      },
      '../assert-sender': { assertProductWindowSender: () => {} }
    },
    { warn: (...args) => warnings.push(args) }
  )
  const ipc = new E2eeIpc()
  // Admitting the local agent sends only its envelope when this device holds the
  // current key; a device without it keeps the full round that receives first.
  const refreshes = []
  let holdsKey = true
  ipc.refresh = async (_workspaceId, options) => {
    refreshes.push(options)
  }
  ipc.status = async () => ({ hasCurrentKey: holdsKey })
  const session = '44'.repeat(16)
  await assert.rejects(ipc.prepareLocalAgent('workspace'), (error) => {
    assert.equal(error.message, 'e2ee_local_agent_pending')
    assert.equal(error.cause, undefined)
    assert.equal(ipc.pairingFailure, localTimeout)
    return true
  })
  await assert.rejects(ipc.admitLocalAgent('workspace', session), (error) => {
    assert.equal(error.message, 'e2ee_append_unconfirmed')
    assert.equal(error.cause, undefined)
    assert.equal(ipc.pairingFailure.cause, appendFailure)
    assert.equal(ipc.pairingFailure.errors.length, 2)
    assert.equal(ipc.pairingFailure.errors[0], appendFailure)
    assert.equal(ipc.pairingFailure.errors[1], reconciliationFailure)
    assert.ok(!error.message.includes(appendFailure.message))
    return true
  })
  // The same signed request can have committed despite the failed response.
  // Verified readback on retry wins over that attempt's lost acknowledgement.
  committed = true
  holdsKey = false
  const result = await ipc.admitLocalAgent('workspace', session)
  assert.equal(result.admitted, true)
  assert.equal(result.ready, true)
  assert.equal(ipc.pairingFailure, undefined)
  assert.deepEqual(submitted, [request, request])
  assert.deepEqual(
    refreshes.map((options) => options?.keyMode),
    ['distribute', 'full']
  )
  assert.deepEqual(activations, [
    {
      type: 'activate',
      accountId: 'acc1',
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      ledgerRecordsHex: ['aa', 'bb'],
      ledgerPosition: 'p1:workspace:2:offset:0'
    }
  ])
  // Past either IPC bound the handoff is omitted; the agent reads history itself.
  const handoffs = []
  for (const records of [
    Array.from({ length: 2049 }, () => 'aa'),
    ['aa'.repeat(8192), ...Array.from({ length: 32 }, () => 'bb'.repeat(8192))]
  ]) {
    ledger = ledgerView(records)
    assert.equal((await ipc.admitLocalAgent('workspace', session)).ready, true)
    handoffs.push(activations.at(-1).ledgerRecordsHex?.length ?? null)
  }
  // An older agent's strict schema refuses the fields; it is activated without them.
  ledger = ledgerView(['aa', 'bb'])
  activationRefusal = new Error('e2ee_local_agent_unavailable', {
    cause: new Error('e2ee_invalid_input')
  })
  assert.equal((await ipc.admitLocalAgent('workspace', session)).ready, true)
  handoffs.push(...activations.slice(-2).map((message) => message.ledgerRecordsHex?.length ?? null))
  assert.deepEqual(handoffs, [null, null, 2, null])
  // The handoff is optional: a failed ledger export never fails a confirmed admission.
  ledger = null
  assert.equal((await ipc.admitLocalAgent('workspace', session)).ready, true)
  assert.equal(activations.at(-1).ledgerRecordsHex, undefined)
  assert.deepEqual(warnings, [])
})

void test('a stalled system proxy lookup counts as direct after its bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { resolveSystemProxyEnv, SYSTEM_PROXY_LOOKUP_TIMEOUT_MS } = await load(
    './system-proxy-env.ts',
    { electron: { session: {} }, '@lody/shared/proxy-env': proxyEnv },
    globalThis.console,
    {},
    { process: { env: {} } }
  )
  const probes = []
  const resolving = resolveSystemProxyEnv(['https://relay-a.example', 'https://relay-b.example'], {
    resolveProxy: (url) => {
      probes.push(url)
      // A PAC script that never answers for the first URL; the second is direct.
      return url.includes('relay-a') ? new Promise(() => {}) : Promise.resolve('PROXY proxy:8080')
    }
  })
  let settled = false
  void resolving.then(() => (settled = true))
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(SYSTEM_PROXY_LOOKUP_TIMEOUT_MS)
  // The sandbox realm has its own Object prototype.
  assert.deepEqual(
    { ...(await resolving) },
    {
      HTTP_PROXY: 'http://proxy:8080',
      HTTPS_PROXY: 'http://proxy:8080',
      ALL_PROXY: 'http://proxy:8080',
      NO_PROXY: proxyEnv.DEFAULT_NO_PROXY
    }
  )
  assert.deepEqual(probes, ['https://relay-a.example', 'https://relay-b.example'])
})

void test('a cold iroh open waiting on the system proxy never holds other workspaces', async () => {
  const identity = { userId: 'acc1', generation: 1 }
  const lookups = []
  const hosts = []
  const api = await load(
    './e2ee-account-runtime.ts',
    {
      electron: {
        app: { getPath: () => '/synthetic-user-data', isPackaged: false, getAppPath: () => '/app' }
      },
      '@lody/shared/node/e2ee-identity': { leaseE2eeIdentity: () => Effect.void },
      '../e2ee-custody-electron': { makeElectronE2eeCustody: () => Effect.succeed({}) },
      './e2ee-bootstrap.mjs': { makeDesktopE2eeBootstrap: () => Effect.succeed({}) },
      './e2ee-runtime.mjs': {
        makeDesktopE2eeRuntimeHost: (input) =>
          Effect.sync(() => {
            hosts.push(input.iroh?.proxyUrl ?? null)
            return {}
          })
      },
      './e2ee-iroh-config': {
        desktopIrohConfig: () => ({ file: '/iroh.node', relays: { urls: ['https://relay'] } }),
        proxyUrlFromEnv: (env) => env.HTTPS_PROXY
      },
      './e2ee-iroh.mjs': { loadIrohNative: () => ({}) },
      './system-proxy-env': {
        resolveSystemProxyEnv: () => {
          const lookup = Promise.withResolvers()
          lookups.push(lookup)
          return lookup.promise
        }
      },
      '../ipc/ipc-service-deps': {
        getIpcServiceDeps: () => ({
          authService: {
            subscribeCachedSessionIdentity: () => () => {},
            getCachedSessionIdentity: () => ({ ...identity })
          }
        })
      }
    },
    globalThis.console,
    { VITE_LODY_PLATFORM: 'cloud', VITE_IROH_RELAYS: 'https://relay' },
    { process: { env: {}, resourcesPath: '/resources' } }
  )
  const first = api.withDesktopE2eeAccount((owner) => Effect.succeed(owner.directory), 'team')
  await new Promise((resolve) => setImmediate(resolve))
  lookups[0].resolve({ HTTPS_PROXY: 'http://proxy:1' })
  await first
  // Another workspace's cold open stalls in its proxy lookup, before the permit.
  const stalled = api.withDesktopE2eeAccount((owner) => Effect.succeed(owner.directory), 'other')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(lookups.length, 2)
  // The open workspace keeps working meanwhile.
  assert.equal(
    await api.withDesktopE2eeAccount((owner) => Effect.succeed(owner.accountId), 'team'),
    'acc1'
  )
  lookups[1].resolve({})
  assert.match(await stalled, /other$/)
  assert.deepEqual(hosts, ['http://proxy:1', null])
})

void test('quit retains a supervisor whose stop failed so recovery retries the same owner', async () => {
  const { CliService } = await load(
    './cli-service.ts',
    {
      electron: { app: {}, powerSaveBlocker: {} },
      '../platform': { mainPlatformKind: 'cloud' },
      '@lody/shared/node/installation-profile': { getLodyDataDir: () => '/synthetic-data' },
      '@lody/shared/node/local-cli-host-lease': {
        getLocalCliHostEndpoint: () => '/synthetic-host'
      },
      '@lody/shared/node/local-ipc': { getLocalDaemonRunFilePath: () => '/synthetic-run' },
      '@lody/shared/node/process': {},
      '@lody/shared/node/local-session-control': {},
      '@lody/shared/node/local-project-control': {},
      '@lody/shared/node/local-cli-supervisor': {},
      '@lody/shared/local-machine-rpc': {},
      '@lody/cli-supervisor': {},
      './shell-env': {},
      './system-proxy-env': {},
      '../desktop-log': {},
      '../desktop-log-core': {},
      './desktop-execution-host': {},
      './local-session-control-budget': {}
    },
    { error() {} }
  )
  const service = Object.create(CliService.prototype)
  Object.assign(service, {
    cliAutoStartEnabled: true,
    preventSleepEnabled: false,
    powerSaveBlockerId: null,
    cliState: {},
    cliStateSenders: new Set(),
    trackedCliChildren: new Map()
  })
  const stopFailure = new Error('synthetic child did not exit after SIGKILL')
  let exited = false
  service.supervisor = {
    getState: () => ({ phase: exited ? 'stopped' : 'fatal', desiredState: 'stopped' }),
    stop: async () => {
      if (!exited) throw stopFailure
    }
  }

  await assert.rejects(service.shutdownForQuit(0), (error) => error === stopFailure)
  // The unresolved owner stays visible instead of reporting a stopped CLI.
  assert.equal(service.getCliState().phase, 'fatal')

  exited = true
  await service.shutdownForQuit(0)
  assert.equal(service.getCliState().phase, 'stopped')
})

void test('local pairing timeout remains an unknown outcome and does not poison a later CLI request', async () => {
  const { IpcTimeoutError, IpcConnectError } = await import('@lody/shared/node/local-ipc')
  const { CliService } = await load('./cli-service.ts', {
    electron: { app: {}, powerSaveBlocker: {} },
    '../platform': { mainPlatformKind: 'cloud' },
    '@lody/shared/node/installation-profile': { getLodyDataDir: () => '/synthetic-data' },
    '@lody/shared/node/local-cli-host-lease': { getLocalCliHostEndpoint: () => '/synthetic-host' },
    '@lody/shared/node/local-ipc': { getLocalDaemonRunFilePath: () => '/synthetic-run' },
    '@lody/shared/node/process': {},
    '@lody/shared/node/local-session-control': {},
    '@lody/shared/node/local-project-control': {},
    '@lody/shared/node/local-cli-supervisor': {},
    '@lody/shared/local-machine-rpc': {},
    '@lody/cli-supervisor': {},
    './shell-env': {},
    './system-proxy-env': {},
    '../desktop-log': {},
    '../desktop-log-core': {},
    './desktop-execution-host': {},
    './local-session-control-budget': {}
  })
  // Use the actual service methods without starting its unrelated supervisor.
  const service = Object.create(CliService.prototype)
  service.cliAutoStartEnabled = true
  const timeout = new IpcTimeoutError({
    message: 'synthetic slow local request',
    timeoutMs: 30_000
  })
  let failure = timeout
  service.localControlClient = {
    e2eePrepare: () => (failure ? Effect.fail(failure) : Effect.succeed('prepared')),
    e2eeActivate: () => (failure ? Effect.fail(failure) : Effect.succeed('activated'))
  }
  for (const method of ['prepareLocalE2eeDevice', 'activateLocalE2eeDevice']) {
    await assert.rejects(service[method]({}), (error) => {
      assert.equal(error.message, 'e2ee_local_agent_pending')
      assert.equal(error.cause, timeout)
      return true
    })
  }
  failure = new IpcConnectError({ message: 'synthetic unavailable socket' })
  await assert.rejects(service.prepareLocalE2eeDevice({}), (error) => {
    assert.equal(error.message, 'e2ee_local_agent_unavailable')
    assert.equal(error.cause, failure)
    return true
  })
  failure = undefined
  assert.equal(await service.prepareLocalE2eeDevice({}), 'prepared')
  assert.equal(await service.activateLocalE2eeDevice({}), 'activated')
})

void test('cached identity admits offline work and replaces or closes owners on account transitions', async () => {
  const { api, identity } = await account()
  let closed = false
  assert.equal(
    await api.withDesktopE2eeAccount((owner) =>
      Effect.as(
        Scope.addFinalizer(
          owner.scope,
          Effect.sync(() => {
            closed = true
          })
        ),
        owner.accountId
      )
    ),
    'acc1'
  )
  identity.userId = 'second'
  identity.generation++
  assert.equal(
    await api.withDesktopE2eeAccount((owner) => Effect.succeed(owner.accountId)),
    'second'
  )
  assert.equal(closed, true)
  identity.userId = null
  identity.generation++
  await assert.rejects(
    api.withDesktopE2eeAccount(() => Effect.succeed('wrong')),
    /e2ee_account_unavailable/
  )
  identity.userId = 'second'
  assert.equal(
    await api.withDesktopE2eeAccount((owner) => Effect.succeed(owner.accountId)),
    'second'
  )
  await api.closeDesktopE2eeAccount()
})

void test('auth changes during native open close the stale owner before any work is admitted', async () => {
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  let released = false
  const { api, identity } = await account({
    custody: () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            released = true
          })
        )
        yield* Effect.promise(() => {
          entered.resolve()
          return finish.promise
        })
        return {}
      })
  })
  let admitted = false
  const opening = api.withDesktopE2eeAccount(() =>
    Effect.sync(() => {
      admitted = true
    })
  )
  await entered.promise
  identity.userId = null
  identity.generation++
  finish.resolve()
  await assert.rejects(opening, /e2ee_account_unavailable/)
  assert.equal(admitted, false)
  assert.equal(released, true)
})

void test('a stale cold open closes only the old login, never a workspace the new login already opened', async () => {
  // With workspaces opening concurrently, a turn that began before a re-login must not
  // tear down the new login's open workspace (and its window reader) on its way out.
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  let opens = 0
  const { api, identity } = await account({
    custody: () =>
      Effect.gen(function* () {
        if (++opens > 1) return {}
        yield* Effect.promise(() => {
          entered.resolve()
          return finish.promise
        })
        return {}
      })
  })
  const stale = api.withDesktopE2eeAccount(() => Effect.void, 'ws-1')
  await entered.promise
  identity.generation++
  const current = await api.withDesktopE2eeAccount((owner) => Effect.succeed(owner), 'ws-2')
  finish.resolve()
  await assert.rejects(stale, /e2ee_account_unavailable/)
  assert.equal(
    await api.withDesktopE2eeAccount((owner) => Effect.succeed(owner === current), 'ws-2'),
    true
  )
  assert.equal(opens, 2)
  await api.closeDesktopE2eeAccount()
})

void test('independent workspace directories run account turns concurrently while one directory stays serialized', async () => {
  const { api } = await account()
  const events = []
  const held = holdWorkspaceTurn(api, 'ws-1', events)
  await held.entered
  const same = api.withDesktopE2eeAccount(
    () => Effect.sync(() => events.push('ws-1 second')),
    'ws-1'
  )
  // A slow turn in ws-1 must not hold an unrelated workspace's E2EE operation.
  assert.match(
    await api.withDesktopE2eeAccount((owner) => Effect.succeed(owner.directory), 'ws-2'),
    /ws-2$/
  )
  events.push('ws-2 done')
  held.finish()
  await Promise.all([held.done, same])
  assert.deepEqual([...events], ['ws-2 done', 'ws-1 end', 'ws-1 second'])
  await api.closeDesktopE2eeAccount()
})

void test('account close drains in-flight workspace turns and fences turns started after it', async () => {
  const { api } = await account()
  const events = []
  const held = holdWorkspaceTurn(api, 'ws-1', events)
  await held.entered
  const closing = api.closeDesktopE2eeAccount().then(() => events.push('close done'))
  const later = api.withDesktopE2eeAccount(
    () => Effect.sync(() => events.push('ws-2 turn')),
    'ws-2'
  )
  held.finish()
  await Promise.all([held.done, closing, later])
  assert.deepEqual([...events], ['ws-1 end', 'ws-1 closed', 'close done', 'ws-2 turn'])
  await api.closeDesktopE2eeAccount()
})

void test('an account switch closes the previous account only after its in-flight turns, before admitting new-account turns', async () => {
  const { api, identity } = await account()
  const events = []
  const held = holdWorkspaceTurn(api, 'ws-1', events)
  await held.entered
  identity.userId = 'second'
  identity.generation++
  const turns = ['ws-2', 'ws-3'].map((workspaceId) =>
    api.withDesktopE2eeAccount(
      (owner) => Effect.sync(() => events.push(`${workspaceId} ${owner.accountId}`)),
      workspaceId
    )
  )
  held.finish()
  await Promise.all([held.done, ...turns])
  assert.deepEqual([...events].slice(0, 2), ['ws-1 end', 'ws-1 closed'])
  assert.deepEqual([...events].slice(2).sort(), ['ws-2 second', 'ws-3 second'])
  await api.closeDesktopE2eeAccount()
})

void test('account-wide reset archives only after in-flight workspace turns drain and fences later turns', async () => {
  const events = []
  const { api } = await account({
    identityStorage: {
      leaseE2eeIdentity: () => Effect.void,
      completedE2eeIdentityReset: () => Effect.succeed(undefined),
      archiveE2eeIdentity: () => Effect.sync(() => events.push('archive'))
    }
  })
  const held = holdWorkspaceTurn(api, 'ws-1', events)
  await held.entered
  const reset = api.resetDesktopE2eeIdentity({ resetId: 'reset-1' })
  const later = api.withDesktopE2eeAccount(
    () => Effect.sync(() => events.push('ws-2 turn')),
    'ws-2'
  )
  held.finish()
  await Promise.all([held.done, reset, later])
  assert.deepEqual([...events], ['ws-1 end', 'ws-1 closed', 'archive', 'ws-2 turn'])
  await api.closeDesktopE2eeAccount()
})

void test('only unavailable custody exposes the availability fallback code', async () => {
  const unavailable = await account({ custody: () => Effect.fail({ code: 'unavailable' }) })
  await assert.rejects(
    unavailable.api.withDesktopE2eeAccount(() => Effect.void),
    /e2ee_custody_unavailable/
  )
  const basicText = await account({
    custody: () =>
      makeDesktopE2eeCustody({
        directory: '/synthetic-unused',
        platform: 'linux',
        safeStorage: {
          isEncryptionAvailable: () => true,
          isAsyncEncryptionAvailable: async () => true,
          getSelectedStorageBackend: () => 'basic_text',
          encryptStringAsync: async () => {
            throw new Error('must reject before wrapping')
          },
          decryptStringAsync: async () => {
            throw new Error('must reject before unwrapping')
          }
        }
      })
  })
  await assert.rejects(
    basicText.api.withDesktopE2eeAccount(() => Effect.void),
    /e2ee_custody_unavailable/
  )
  const corrupt = await account({ custody: () => Effect.fail({ code: 'corrupt' }) })
  await assert.rejects(
    corrupt.api.withDesktopE2eeAccount(() => Effect.void),
    /e2ee_corrupt/
  )
  const native = await account()
  const original = new Error('synthetic private native failure')
  for (const [source, operation] of [
    ['account-operation', () => native.api.withDesktopE2eeAccount(() => Effect.fail(original))],
    ['runtime-operation', () => native.api.runDesktopE2eeOperation('acc1', Effect.fail(original))]
  ]) {
    await assert.rejects(operation(), (error) => {
      assert.equal(error.message, 'e2ee_host_operation_failed')
      assert.equal(error.cause, undefined)
      return true
    })
    assert.equal(desktopE2eeFailure().source, source)
    assert.equal(desktopE2eeFailure().cause, original)
  }
  await native.api.closeDesktopE2eeAccount()
})

void test('confirmed identity reopens offline after restart, matches bearer or cookie, and is revoked by logout', async () => {
  const storage = new Map()
  const offlineAuthIdentity = makeOfflineAuthIdentityCache({
    get: (key) => storage.get(key),
    set: (key, value) => storage.set(key, value),
    delete: (key) => storage.delete(key)
  })
  let cookie = 'better-auth.session_token=synthetic-token'
  let cookieUnavailable = false
  let response = { data: { user: { id: 'acc1' }, session: { token: 'synthetic-token' } } }
  let offline = false
  const { AuthService } = await load(
    './auth-service.ts',
    {
      electron: { app: {}, safeStorage: {}, shell: {} },
      '../auth': {
        offlineAuthIdentity,
        authClient: {
          getCookie: () => {
            if (cookieUnavailable) throw new Error('synthetic locked cookie')
            return cookie
          },
          getSession: async () => {
            if (offline) throw new Error('synthetic offline')
            return response
          },
          signOut: async () => {}
        }
      },
      '../posthog-error-reporting': {},
      './desktop-login': {
        DesktopLogin: class {
          cancel() {}
        }
      },
      '../platform': { desktopInstallationProfile: { releaseChannel: 'stable' } },
      '@lody/shared/electron-ipc': {}
    },
    { warn: () => {} }
  )
  const first = new AuthService()
  await first.getSession()
  assert.equal(first.getCachedSessionIdentity().source, 'network')
  offline = true
  // New service has no resolved session or auth request. The disk binding has
  // no timestamp and survives any wall-clock change, including an eight-day gap.
  const reopened = new AuthService()
  assert.equal(reopened.getCachedSessionIdentity().userId, 'acc1')
  assert.equal(reopened.getCachedSessionIdentity().source, 'offline')
  const bearer = (token) => ({ fetchOptions: { headers: { Authorization: `Bearer ${token}` } } })
  assert.equal(reopened.getCachedSessionIdentity(bearer('wrong-token')).userId, null)
  cookie = ''
  const bearerOnly = new AuthService()
  assert.equal(bearerOnly.getCachedSessionIdentity().userId, null)
  assert.equal(bearerOnly.getCachedSessionIdentity(bearer('synthetic-token')).userId, 'acc1')
  assert.equal(bearerOnly.getCachedSessionIdentity().userId, 'acc1')
  cookieUnavailable = true
  assert.equal(bearerOnly.getCachedSessionIdentity().userId, 'acc1')
  assert.equal(new AuthService().getCachedSessionIdentity(bearer('synthetic-token')).userId, 'acc1')
  cookieUnavailable = false
  const observed = []
  bearerOnly.subscribeCachedSessionIdentity(() =>
    observed.push(bearerOnly.getCachedSessionIdentity().userId)
  )
  offline = false
  response = { data: { user: { id: 'acc2' }, session: { token: 'other-token' } } }
  await bearerOnly.getSession()
  assert.deepEqual(observed, ['acc2'])
  offline = true
  await bearerOnly.getSession()
  assert.deepEqual(observed, ['acc2'])
  await bearerOnly.signOut()
  assert.deepEqual(observed, ['acc2', null])
  assert.equal(new AuthService().getCachedSessionIdentity(bearer('other-token')).userId, null)
})

void test('confirmed identity changes release old custody without waiting for another E2EE request', async () => {
  const { api, publishIdentity } = await account()
  const released = Promise.withResolvers()
  await api.withDesktopE2eeAccount((owner) =>
    Scope.addFinalizer(
      owner.scope,
      Effect.sync(() => released.resolve())
    )
  )
  publishIdentity(null)
  await released.promise
  await assert.rejects(
    () => api.withDesktopE2eeAccount(() => Effect.void),
    /e2ee_account_unavailable/
  )
  publishIdentity('replacement-account')
  assert.equal(
    await api.withDesktopE2eeAccount((owner) => Effect.succeed(owner.accountId)),
    'replacement-account'
  )
  await api.closeDesktopE2eeAccount()
})

void test('a confirmed link invitation closes through the quit barrier and reopens its committed encrypted identity', async (t) => {
  const f = await personalJoinFixture(t)
  const owner = await f.open('link-owner')
  await owner.create()
  const before = await owner.ipc.status(f.workspaceId)
  let published
  f.client.memberCreateInvitation = ({ offer }) =>
    f.remote(() => {
      published = structuredClone(offer)
      return { offer }
    })
  const invitation = await owner.ipc.createMemberInvitation({
    workspaceId: f.workspaceId,
    mode: 'link'
  })
  assert.deepEqual(invitation, published)
  let didQuit = false
  const barrier = createDesktopQuitBarrier({
    stop: async () =>
      assert.deepEqual(
        await drainMainProcessQuitResources([{ name: 'e2ee', close: owner.close }]),
        []
      ),
    quit: () => {
      didQuit = true
    },
    reportFailure: (error) => {
      throw error
    }
  })
  await barrier({ preventDefault() {} })
  assert.equal(didQuit, true)
  const reopened = await f.open('link-owner')
  await reopened.attach()
  const after = await reopened.ipc.status(f.workspaceId)
  for (const key of [
    'genesisHash',
    'headHash',
    'length',
    'epoch',
    'hasCurrentKey',
    'hasDeviceCredential'
  ])
    assert.deepEqual(after[key], before[key], key)
})

void test('a window reopening a workspace whose previous reader is still draining gets a reader after that drain, never e2ee_closed', async (t) => {
  // Navigating from a workspace to its control page releases the workspace runtime's
  // reader while the control page opens its own; a keyed device must not be shown
  // as unapproved because the open arrived during the release.
  const f = await personalJoinFixture(t)
  const owner = await f.open('reopen-during-drain')
  await owner.create()
  const before = await owner.ipc.status(f.workspaceId)
  // The releasing reader's locked half: the host entry is closing, its drain not yet run.
  const drain = await Effect.runPromise(owner.host.beginCloseWorkspace(f.workspaceId))
  owner.readers.delete(f.workspaceId)
  const opened = await owner.ipc.open(f.workspaceId)
  assert.equal(opened.genesisHash, before.genesisHash)
  // The original releaser's late drain cannot close the replacement entry.
  await Effect.runPromise(drain)
  const after = await owner.ipc.status(f.workspaceId)
  assert.equal(after.hasCurrentKey, true)
  assert.equal(after.headHash, before.headHash)
  assert.equal((await owner.ipc.ledgerView(f.workspaceId)).status.genesisHash, before.genesisHash)
})

void test('personal join IPC bridges the control-page observation outside the account lock and retains an offline proof', async (t) => {
  const f = await personalJoinFixture(t)
  const first = await f.open('first')
  await first.create()
  let second = await f.open('second')
  const before = await first.ipc.status(f.workspaceId)
  const observed = {
    genesisHash: before.genesisHash,
    headHash: before.headHash,
    length: before.length
  }
  const offer = await first.ipc.personalPairingOffer(f.workspaceId)
  await second.ipc.preparePersonalJoin(offer)
  const invitation = await f.admit(first, second, offer)
  await Effect.runPromise(
    second.bootstrap.acceptPersonalJoin(f.workspaceId, invitation.invitationHex)
  )
  // Reproduce the claim's native open before the renderer supplies its old control-page point.
  await second.ipc.open(f.workspaceId)
  await second.ipc.close(f.workspaceId)
  await assert.rejects(second.ipc.open(f.workspaceId, observed), /unauthorized history/)
  assert.equal(second.readers.has(f.workspaceId), false)
  const ledger = await Effect.runPromise(first.host.ledgerView(f.workspaceId))
  f.client.history = () =>
    f.remote(() => ({
      workspaceId: f.workspaceId,
      genesisHash: before.genesisHash,
      startIndex: 0,
      recordsHex: ledger.recordsHex,
      checkpoint: { length: ledger.status.length, headHash: ledger.status.headHash },
      position: `p1:${f.workspaceId}:${ledger.status.length}:source:0`,
      nextCursor: null
    }))
  assert.equal((await second.ipc.open(f.workspaceId, observed)).length, 2)
  assert.equal(second.readers.get(f.workspaceId).get(23), 1)
  await second.close()
  second = await f.open('second')
  f.client.history = () => Effect.die('offline reopen must use retained proof')
  assert.equal((await second.ipc.open(f.workspaceId, observed)).length, 2)
  await assert.rejects(
    second.ipc.open(f.workspaceId, { ...observed, headHash: '00'.repeat(32) }),
    (error) => error.code === 'local-evidence-conflict'
  )
  assert.equal(second.readers.get(f.workspaceId).get(23), 1)
})

void test('cold renderer marker recovery reads the real IPC boundary without granting status access', async (t) => {
  const f = await personalJoinFixture(t)
  const owner = await f.open('identity-recovery')
  await owner.create()
  const verified = await owner.ipc.status(f.workspaceId)
  await Effect.runPromise(owner.host.closeWorkspace(f.workspaceId))
  owner.readers.delete(f.workspaceId)
  await assert.rejects(owner.ipc.status(f.workspaceId), /e2ee_not_open/)
  const componentsRequire = createRequire(
    new URL('../../../../../packages/components/package.json', import.meta.url)
  )
  const { JSDOM } = componentsRequire('jsdom')
  const dom = new JSDOM('', { url: 'https://synthetic.test' })
  t.after(() => dom.window.close())
  const storage = dom.window.localStorage
  const pin = `lody-e2ee-genesis-pin:${owner.accountId}:${f.workspaceId}`
  const known = `lody-e2ee-known-mode:${owner.accountId}:${f.workspaceId}`
  storage.setItem(pin, 'damaged pin')
  storage.setItem(known, 'damaged marker')
  const { recoverE2eeWorkspaceIdentity } = await load(
    '../../../../../packages/components/src/lib/e2ee-workspace-storage.ts',
    // The VM transpiles this helper to CJS. Keep its protocol dependency on
    // the real ESM namespace instead of requiring ESM-only crypto packages.
    { '@lody/e2ee-core/protocol': await import('@lody/e2ee-core/protocol') }
  )
  await recoverE2eeWorkspaceIdentity({
    storage,
    accountId: owner.accountId,
    workspaceId: f.workspaceId,
    isCurrent: () => true,
    runtime: {
      account: () => owner.ipc.account(),
      status: (id) => owner.ipc.status(id),
      readIdentity: (input) => owner.ipc.readIdentity(input)
    }
  })
  assert.equal(storage.getItem(pin), verified.genesisHash)
  assert.equal(storage.getItem(known), verified.genesisHash)
  const archives = Object.keys(storage)
    .filter((key) => key.startsWith('lody-e2ee-evidence-archive:'))
    .map((key) => JSON.parse(storage.getItem(key)))
  assert.deepEqual(archives.map((value) => value.raw).sort(), ['damaged marker', 'damaged pin'])
  assert.equal(owner.readers.has(f.workspaceId), false)
  await assert.rejects(owner.ipc.status(f.workspaceId), /e2ee_not_open/)
  // The temporary reader was fully released: ordinary admission can reopen it.
  await owner.ipc.open(f.workspaceId)
  assert.equal((await owner.ipc.status(f.workspaceId)).genesisHash, verified.genesisHash)
  const readers = [...owner.readers.get(f.workspaceId)]
  assert.deepEqual(
    {
      ...(await owner.ipc.readIdentity({ accountId: owner.accountId, workspaceId: f.workspaceId }))
    },
    {
      workspaceId: f.workspaceId,
      genesisHash: verified.genesisHash
    }
  )
  assert.deepEqual([...owner.readers.get(f.workspaceId)], readers)
  await assert.rejects(
    owner.ipc.readIdentity({ accountId: 'acc2', workspaceId: f.workspaceId }),
    /e2ee_account_mismatch/
  )
  assert.deepEqual([...owner.readers.get(f.workspaceId)], readers)
  assert.equal((await owner.ipc.status(f.workspaceId)).genesisHash, verified.genesisHash)
  await owner.ipc.close(f.workspaceId)
})

void test('personal IPC recovers a competing recipient after cancellation with lost receipt and process reopen, preserving custody and pins', async (t) => {
  const f = await personalJoinFixture(t)
  let first = await f.open('first')
  await first.create()
  const second = await f.open('second')
  let third = await f.open('third')
  const offer = await first.ipc.personalPairingOffer(f.workspaceId)
  await second.ipc.preparePersonalJoin(offer)
  const preview = await first.ipc.inspectPersonalJoin(f.workspaceId, offer.pairingSessionId)
  await assert.rejects(third.ipc.preparePersonalJoin(offer), /e2ee_conflict/)
  const pending = await third.ipc.pendingPersonalJoin(f.workspaceId)
  assert.notEqual(pending.signingPublicKey, preview.signingPublicKey)
  const original = await Effect.runPromise(third.bootstrap.preparePersonalJoin(offer))
  await third.close()
  third = await f.open('third')
  assert.deepEqual(await third.ipc.pendingPersonalJoin(f.workspaceId), pending)

  // Generic transport conflicts and a reserved admission never authorize local retirement.
  f.relay.statusFailure = new Error('synthetic generic conflict')
  await assert.rejects(
    third.ipc.preparePersonalJoin({ ...offer, pairingSessionId: '81'.repeat(16) }),
    /e2ee_conflict/
  )
  assert.deepEqual(await third.ipc.pendingPersonalJoin(f.workspaceId), pending)
  f.relay.statusFailure = null
  f.rows.get(offer.pairingSessionId).status = 'admitting'
  await assert.rejects(
    first.ipc.cancelPersonalJoin(f.workspaceId, offer.pairingSessionId),
    /e2ee_admission_reserved/
  )
  await assert.rejects(
    second.ipc.preparePersonalJoin({ ...offer, pairingSessionId: '82'.repeat(16) }),
    /e2ee_conflict/
  )
  assert.deepEqual(await third.ipc.pendingPersonalJoin(f.workspaceId), pending)
  assert.equal(
    f.rows.get(offer.pairingSessionId).requestHex,
    (await Effect.runPromise(second.bootstrap.preparePersonalJoin(offer))).requestHex
  )

  // A neighboring workspace remains usable while this recipient is unresolved.
  await first.create('synthetic-unrelated-workspace')
  const independent = await first.ipc.personalPairingOffer('synthetic-unrelated-workspace')
  assert.equal((await third.ipc.preparePersonalJoin(independent)).status, 'pending')
  assert.deepEqual(await third.ipc.pendingPersonalJoin(f.workspaceId), pending)

  f.rows.get(offer.pairingSessionId).status = 'pending'
  f.relay.loseCancelReceipt = true
  await assert.rejects(
    first.ipc.cancelPersonalJoin(f.workspaceId, offer.pairingSessionId),
    /lost cancel receipt/
  )
  await first.close()
  first = await f.open('first')
  await first.attach()
  const next = await first.ipc.personalPairingOffer(f.workspaceId)
  assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
  const terminal = await third.ipc.claimPersonalJoin(f.workspaceId, offer.pairingSessionId)
  assert.equal(terminal.ready, false)
  assert.equal(terminal.status, 'cancelled')
  assert.equal(await third.ipc.pendingPersonalJoin(f.workspaceId), null)
  const renewed = await third.ipc.preparePersonalJoin(next)
  const renewedOriginal = await Effect.runPromise(third.bootstrap.preparePersonalJoin(next))
  assert.equal(renewed.signingPublicKey, original.signingPublicKey)
  assert.equal(renewedOriginal.credentialHash, original.credentialHash)
  f.db(third, 'creations.sqlite', (db) => {
    const archived = db
      .prepare('SELECT pin,request_hex FROM retired_personal_joins WHERE workspace_id=?')
      .get(f.workspaceId)
    assert.equal(archived.request_hex, original.requestHex)
    assert.deepEqual(JSON.parse(archived.pin), offer)
  })
  await assert.rejects(
    third.ipc.preparePersonalJoin({ ...next, endorser: pending.signingPublicKey }),
    /e2ee_conflict/
  )
})

void test('confirmed cancellation survives real SQLite archival failure and the next normal offer/prepare completes retained cleanup', async (t) => {
  const f = await personalJoinFixture(t)
  const first = await f.open('first')
  await first.create()
  const second = await f.open('second')
  const third = await f.open('third')
  const offer = await first.ipc.personalPairingOffer(f.workspaceId)
  await second.ipc.preparePersonalJoin(offer)
  await first.ipc.inspectPersonalJoin(f.workspaceId, offer.pairingSessionId)
  await assert.rejects(third.ipc.preparePersonalJoin(offer), /e2ee_conflict/)
  const original = await Effect.runPromise(third.bootstrap.preparePersonalJoin(offer))
  f.db(first, join('workspaces', f.workspaceId, 'history.sqlite'), (db) =>
    db.exec(
      "CREATE TRIGGER synthetic_archive_block BEFORE UPDATE OF retired ON personal_pairing BEGIN SELECT RAISE(ABORT, 'synthetic approver archival failure'); END"
    )
  )
  f.db(third, 'creations.sqlite', (db) =>
    db.exec(
      "CREATE TRIGGER synthetic_archive_block BEFORE DELETE ON personal_joins BEGIN SELECT RAISE(ABORT, 'synthetic recipient archival failure'); END"
    )
  )
  const cancelled = await first.ipc.cancelPersonalJoin(f.workspaceId, offer.pairingSessionId)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cleanupPending, true)
  assert.equal(first.ipc.pairingFailure.errors.length, 1)
  assert.match(String(desktopE2eeFailure().cause), /synthetic approver archival failure/)
  assert.equal(desktopE2eeFailure().cause.code, 'ERR_SQLITE_ERROR')
  assert.ok(!JSON.stringify(cancelled).includes('synthetic approver archival failure'))
  assert.ok(
    !JSON.stringify(first.ipc.pairingFailure).includes('synthetic approver archival failure')
  )
  const claimed = await third.ipc.claimPersonalJoin(f.workspaceId, offer.pairingSessionId)
  assert.equal(claimed.status, 'cancelled')
  assert.ok(await third.ipc.pendingPersonalJoin(f.workspaceId))
  assert.equal(third.ipc.pairingFailure.errors.length, 1)
  assert.match(String(desktopE2eeFailure().cause), /synthetic recipient archival failure/)
  assert.equal(desktopE2eeFailure().cause.code, 'ERR_SQLITE_ERROR')
  assert.ok(!JSON.stringify(claimed).includes('synthetic recipient archival failure'))
  // Repeated confirmed results do not delete the original when persistence is blocked.
  assert.equal(
    (await first.ipc.cancelPersonalJoin(f.workspaceId, offer.pairingSessionId)).status,
    'cancelled'
  )
  f.db(third, 'creations.sqlite', (db) =>
    assert.equal(
      db.prepare('SELECT request_hex FROM personal_joins WHERE workspace_id=?').get(f.workspaceId)
        .request_hex,
      original.requestHex
    )
  )
  f.db(first, join('workspaces', f.workspaceId, 'history.sqlite'), (db) =>
    db.exec('DROP TRIGGER synthetic_archive_block')
  )
  f.db(third, 'creations.sqlite', (db) => db.exec('DROP TRIGGER synthetic_archive_block'))
  const next = await first.ipc.personalPairingOffer(f.workspaceId)
  assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
  const renewed = await third.ipc.preparePersonalJoin(next)
  assert.equal(renewed.signingPublicKey, original.signingPublicKey)
  assert.equal(
    (await Effect.runPromise(third.bootstrap.preparePersonalJoin(next))).credentialHash,
    original.credentialHash
  )
  f.db(third, 'creations.sqlite', (db) =>
    assert.equal(
      db
        .prepare('SELECT request_hex FROM retired_personal_joins WHERE workspace_id=?')
        .get(f.workspaceId).request_hex,
      original.requestHex
    )
  )
})

void test('desktopE2eeCloudClient routes Convex HTTP calls through Electron net.fetch after app readiness', async () => {
  const ready = Promise.withResolvers()
  const events = []
  let capturedClientFetch
  const { api } = await account({
    electron: {
      app: {
        getPath: () => '/synthetic-user-data',
        whenReady: () => {
          events.push('whenReady:start')
          return ready.promise.then(() => events.push('whenReady:done'))
        }
      },
      net: {
        fetch: async (input, init) => {
          events.push(`net.fetch:${String(input)}`)
          return new Response(JSON.stringify({ ok: true, method: init?.method ?? 'GET' }), {
            status: 200
          })
        }
      }
    },
    cloud: (input) =>
      Effect.sync(() => {
        capturedClientFetch = input.fetch
        return {}
      })
  })
  await api.desktopE2eeCloudClient()
  assert.equal(typeof capturedClientFetch, 'function')
  const pending = capturedClientFetch(new URL('https://synthetic.convex.cloud/api/query'), {
    method: 'POST'
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['whenReady:start'])
  ready.resolve()
  const res = await pending
  assert.deepEqual(await res.json(), { ok: true, method: 'POST' })
  assert.deepEqual(events, [
    'whenReady:start',
    'whenReady:done',
    'net.fetch:https://synthetic.convex.cloud/api/query'
  ])
  await api.closeDesktopE2eeAccount()
})

void test('creation signing and exact retry do not acquire a cloud client', async () => {
  const original = Object.freeze({ genesisRecordHex: 'synthetic-original' })
  const { api } = await account({
    bootstrap: () =>
      Effect.succeed({
        prepareCreation: () => Effect.succeed(original)
      }),
    cloud: () => Effect.die(new Error('unexpected cloud call'))
  })
  assert.equal(
    await api.prepareDesktopE2eeCreation({
      accountId: 'acc1',
      requestId: 'request-0123456789',
      name: 'Synthetic',
      slug: 'synthetic'
    }),
    original
  )
  await api.closeDesktopE2eeAccount()
})

void test('an immutable published session for another recipient retires only the local losing request and preserves its identity on the next offer', async (t) => {
  for (const path of ['claim', 'prepare']) {
    const f = await personalJoinFixture(t)
    const first = await f.open('first')
    await first.create()
    const second = await f.open('second')
    let third = await f.open('third')
    const offer = await first.ipc.personalPairingOffer(f.workspaceId)
    await second.ipc.preparePersonalJoin(offer)
    await assert.rejects(third.ipc.preparePersonalJoin(offer), /e2ee_conflict/)
    const original = await Effect.runPromise(third.bootstrap.preparePersonalJoin(offer))
    await f.admit(first, second, offer)
    await third.close()
    third = await f.open('third')
    const next = await first.ipc.personalPairingOffer(f.workspaceId)
    assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
    if (path === 'claim') {
      const claimed = await third.ipc.claimPersonalJoin(f.workspaceId, offer.pairingSessionId)
      assert.equal(claimed.ready, false)
      assert.equal(claimed.status, 'conflict')
      assert.equal(await third.ipc.pendingPersonalJoin(f.workspaceId), null)
    }
    const result = await third.ipc.preparePersonalJoin(next)
    const renewed = await Effect.runPromise(third.bootstrap.preparePersonalJoin(next))
    assert.equal(result.signingPublicKey, original.signingPublicKey)
    assert.equal(renewed.credentialHash, original.credentialHash)
    assert.equal(f.rows.get(offer.pairingSessionId).status, 'published')
    f.db(third, 'creations.sqlite', (db) => {
      const archived = db
        .prepare('SELECT request_hex FROM retired_personal_joins WHERE workspace_id=?')
        .get(f.workspaceId)
      assert.equal(archived.request_hex, original.requestHex)
    })
  }
})

void test('a pin-only recipient reconciles a foreign published request and accepts one new offer with the same custody', async (t) => {
  const f = await personalJoinFixture(t)
  const first = await f.open('first')
  await first.create()
  const second = await f.open('second')
  let third = await f.open('third')
  const offer = await first.ipc.personalPairingOffer(f.workspaceId)
  await second.ipc.preparePersonalJoin(offer)
  f.db(third, 'creations.sqlite', (db) =>
    db.exec(
      "CREATE TRIGGER synthetic_request_block BEFORE UPDATE OF request_hex ON personal_joins BEGIN SELECT RAISE(ABORT, 'synthetic request save failure'); END"
    )
  )
  await assert.rejects(third.ipc.preparePersonalJoin(offer), /synthetic request save failure/)
  const pending = await third.ipc.pendingPersonalJoin(f.workspaceId)
  assert.deepEqual(pending.offer, offer)
  assert.equal(pending.requestHex, undefined)
  const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(offer.genesisHash, 'hex')))
  const device = await Effect.runPromise(third.custody.openDevice(genesis))
  const publicKey = Buffer.from(device.publicKey.toBytes()).toString('hex')
  const credential = await Effect.runPromise(
    third.custody.deviceCredential(genesis, device.publicKey)
  )
  f.db(third, 'creations.sqlite', (db) => db.exec('DROP TRIGGER synthetic_request_block'))
  await f.admit(first, second, offer)
  await third.close()
  third = await f.open('third')
  assert.deepEqual(await third.ipc.pendingPersonalJoin(f.workspaceId), pending)
  const next = await first.ipc.personalPairingOffer(f.workspaceId)
  assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
  const result = await third.ipc.preparePersonalJoin(next)
  assert.equal(result.status, 'pending')
  assert.equal(result.signingPublicKey, publicKey)
  const reopened = await Effect.runPromise(third.custody.openDevice(genesis))
  assert.equal(
    await Effect.runPromise(third.custody.deviceCredential(genesis, reopened.publicKey)),
    credential
  )
  assert.equal(f.rows.get(offer.pairingSessionId).status, 'published')
  f.db(third, 'creations.sqlite', (db) => {
    const archived = db
      .prepare('SELECT pin,request_hex FROM retired_personal_joins WHERE workspace_id=?')
      .get(f.workspaceId)
    assert.deepEqual(JSON.parse(archived.pin), offer)
    assert.equal(archived.request_hex, null)
  })
})

void test('a pin-only recipient without a relay session retains its pin and can retry the same offer', async (t) => {
  const f = await personalJoinFixture(t)
  const first = await f.open('first')
  await first.create()
  const recipient = await f.open('recipient')
  const offer = await first.ipc.personalPairingOffer(f.workspaceId)
  f.db(recipient, 'creations.sqlite', (db) =>
    db.exec(
      "CREATE TRIGGER synthetic_request_block BEFORE UPDATE OF request_hex ON personal_joins BEGIN SELECT RAISE(ABORT, 'synthetic request save failure'); END"
    )
  )
  await assert.rejects(recipient.ipc.preparePersonalJoin(offer), /synthetic request save failure/)
  const pending = await recipient.ipc.pendingPersonalJoin(f.workspaceId)
  assert.equal(pending.requestHex, undefined)
  f.db(recipient, 'creations.sqlite', (db) => db.exec('DROP TRIGGER synthetic_request_block'))
  await assert.rejects(
    recipient.ipc.preparePersonalJoin({ ...offer, pairingSessionId: '84'.repeat(16) }),
    /e2ee_conflict/
  )
  assert.deepEqual(await recipient.ipc.pendingPersonalJoin(f.workspaceId), pending)
  assert.equal((await recipient.ipc.preparePersonalJoin(offer)).status, 'pending')
  f.db(recipient, 'creations.sqlite', (db) =>
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM retired_personal_joins').get().count, 0)
  )
})

void test('a proven lost approval renews its offer and the same recipient can cancel the released old session before retrying', async (t) => {
  const f = await personalJoinFixture(t)
  const first = await f.open('first')
  await first.create()
  const second = await f.open('second')
  const third = await f.open('third')
  const offer = await first.ipc.personalPairingOffer(f.workspaceId)
  await second.ipc.preparePersonalJoin(offer)
  const original = await Effect.runPromise(second.bootstrap.preparePersonalJoin(offer))
  await first.ipc.inspectPersonalJoin(f.workspaceId, offer.pairingSessionId)
  const losing = await Effect.runPromise(
    first.host.preparePersonalAdmission(f.workspaceId, original.requestHex)
  )
  f.rows.get(offer.pairingSessionId).status = 'admitting'
  await assert.rejects(
    second.ipc.preparePersonalJoin({ ...offer, pairingSessionId: '89'.repeat(16) }),
    /e2ee_conflict/
  )
  const competing = await Effect.runPromise(third.bootstrap.preparePersonalJoin(offer))
  const material = JSON.parse(Buffer.from(competing.requestHex, 'hex').toString())
  const ledger = await Effect.runPromise(first.host.ledgerView(f.workspaceId))
  const records = ledger.recordsHex.map((value) => Buffer.from(value, 'hex'))
  const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(offer.genesisHash, 'hex')))
  const view = Result.getOrThrow(
    verifyLedger({
      anchor: genesis,
      records,
      checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
    })
  )
  const signer = await Effect.runPromise(first.custody.openDevice(genesis))
  const winner = await Effect.runPromise(
    signLedgerRecord(
      Result.getOrThrow(
        prepareLedgerCommand(view, signer.publicKey, {
          _tag: 'AdmitDevice',
          kind: 'personal',
          signingPublicKey: Result.getOrThrow(
            Bytes.signingPublicKey(Buffer.from(material.signingPublicKey, 'hex'))
          ),
          encryptionPublicKey: Result.getOrThrow(
            Bytes.encryptionPublicKey(Buffer.from(material.encryptionPublicKey, 'hex'))
          ),
          possessionSignature: Result.getOrThrow(
            Bytes.signature(Buffer.from(material.possessionSignature, 'hex'))
          )
        })
      ),
      signer
    )
  )
  assert.notEqual(Buffer.from(winner).toString('hex'), losing.recordHex)
  await f.append(first, offer.genesisHash, Buffer.from(winner).toString('hex'))
  const next = await first.ipc.personalPairingOffer(f.workspaceId)
  assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
  // The backend's verified losing-writer settlement releases the reservation;
  // the real handler regression is owned by the backend test suite.
  f.rows.get(offer.pairingSessionId).status = 'pending'
  await second.ipc.cancelPersonalJoin(f.workspaceId, offer.pairingSessionId)
  await second.ipc.preparePersonalJoin(next)
  const renewed = await Effect.runPromise(second.bootstrap.preparePersonalJoin(next))
  assert.equal(renewed.signingPublicKey, original.signingPublicKey)
  assert.equal(renewed.credentialHash, original.credentialHash)
})

void test('a snapshot-joined approver cancels another recipient without retiring its own origin and retains genuine cleanup causes', async (t) => {
  const f = await personalJoinFixture(t)
  const first = await f.open('first')
  await first.create()
  const second = await f.open('second')
  const third = await f.open('third')
  const offer = await first.ipc.personalPairingOffer(f.workspaceId)
  await second.ipc.preparePersonalJoin(offer)
  const invitation = await f.admit(first, second, offer)
  await Effect.runPromise(
    second.bootstrap.acceptPersonalJoin(f.workspaceId, invitation.invitationHex)
  )
  await second.attach()
  const preservedOrigin = JSON.stringify(
    await Effect.runPromise(second.bootstrap.creationFor(f.workspaceId))
  )
  const own = await second.ipc.personalPairingOffer(f.workspaceId)
  await third.ipc.preparePersonalJoin(own)
  const primary = new Error('synthetic primary refresh unavailable')
  second.ipc.pairingFailure = primary
  const cancelled = await second.ipc.cancelPersonalJoin(f.workspaceId, own.pairingSessionId)
  assert.equal(cancelled.cleanupPending, false)
  assert.equal(second.ipc.pairingFailure, primary)
  assert.equal(
    JSON.stringify(await Effect.runPromise(second.bootstrap.creationFor(f.workspaceId))),
    preservedOrigin
  )
  const another = await second.ipc.personalPairingOffer(f.workspaceId)
  f.rows.set(another.pairingSessionId, {
    ...f.rows.get(own.pairingSessionId),
    pairingSessionId: another.pairingSessionId,
    status: 'conflict'
  })
  second.ipc.refresh = async () => {
    throw primary
  }
  f.db(second, join('workspaces', f.workspaceId, 'history.sqlite'), (db) =>
    db.exec(
      "CREATE TRIGGER refuse_actual_cleanup BEFORE UPDATE OF retired ON personal_pairing BEGIN SELECT RAISE(ABORT,'synthetic cleanup unavailable'); END"
    )
  )
  await second.ipc.personalPairingOffer(f.workspaceId)
  assert.equal(second.ipc.pairingFailure.errors[0], primary)
  assert.equal(second.ipc.pairingFailure.errors.length, 2)
  f.db(second, join('workspaces', f.workspaceId, 'history.sqlite'), (db) => {
    assert.equal(
      db
        .prepare('SELECT retired FROM personal_pairing WHERE session=?')
        .get(another.pairingSessionId).retired,
      0
    )
    db.exec('DROP TRIGGER refuse_actual_cleanup')
  })
  const recovered = await second.ipc.personalPairingOffer(f.workspaceId)
  assert.notEqual(recovered.pairingSessionId, another.pairingSessionId)
  assert.equal(
    JSON.stringify(await Effect.runPromise(second.bootstrap.creationFor(f.workspaceId))),
    preservedOrigin
  )
})

void test('isolated desktop workspace reset archives real custody and journals, retains sibling availability and requires fresh joining', async (t) => {
  const { api, setLocked } = await nativeAccountFixture(t)
  const create = (workspaceId) => createAccountWorkspace(api, workspaceId)
  const intent = {
    accountId: 'acc1',
    requestId: 'synthetic-creation-request',
    name: 'Created',
    slug: 'created'
  }
  const staged = await api.prepareDesktopE2eeCreation(intent)
  await api.recordDesktopE2eeCreated({
    workspaceId: 'created',
    genesisHash: staged.genesisHashHex,
    requestId: intent.requestId
  })
  assert.deepEqual(await api.prepareDesktopE2eeCreation(intent), staged)
  await api.withDesktopE2eeAccount((owner) => owner.host.open('created'), 'created')
  await api.resetDesktopE2eeIdentity({ workspaceId: 'created', resetId: randomUUID() })
  await assert.rejects(api.prepareDesktopE2eeCreation(intent), /e2ee_identity-lost/)
  const first = await create('first'),
    sibling = await create('sibling')
  await api.closeDesktopE2eeAccount()
  const device = join(
    first.directory,
    'custody',
    `${first.creation.genesisHashHex}.personal.device`
  )
  await writeFile(device, 'damaged')
  await assert.rejects(api.withDesktopE2eeAccount((owner) => owner.host.open('first'), 'first'))
  const healthy = await api.withDesktopE2eeAccount((owner) => owner.host.open('sibling'), 'sibling')
  assert.equal(healthy.genesisHash, sibling.status.genesisHash)
  const files = async (root) => {
    const result = {}
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory())
        for (const [name, bytes] of Object.entries(await files(join(root, entry.name))))
          result[`${entry.name}/${name}`] = bytes
      else result[entry.name] = (await readFile(join(root, entry.name))).toString('hex')
    }
    return result
  }
  const originals = await files(first.directory)
  const resetId = randomUUID()
  const result = await api.resetDesktopE2eeIdentity({ workspaceId: 'first', resetId })
  assert.ok(result.archive)
  assert.deepEqual(await files(result.archive), originals)
  assert.equal(
    (await api.withDesktopE2eeAccount((owner) => owner.host.status('sibling'), 'sibling'))
      .genesisHash,
    healthy.genesisHash
  )
  await assert.rejects(
    api.withDesktopE2eeAccount((owner) => owner.host.open('first'), 'first'),
    /e2ee_missing-binding/
  )
  const replacement = await create('first')
  assert.notEqual(replacement.signingPublicKey, first.signingPublicKey)
  await api.resetDesktopE2eeIdentity({ workspaceId: 'first', resetId })
  assert.equal(
    (await api.withDesktopE2eeAccount((owner) => owner.host.localPairingContext('first'), 'first'))
      .frontendSigningPublicKey,
    replacement.signingPublicKey
  )
  // A permanently unavailable OS protector never selects file protection. Recovery
  // can archive without opening custody, and later native availability allows joining.
  await api.closeDesktopE2eeAccount()
  setLocked(true)
  await assert.rejects(
    api.withDesktopE2eeAccount((owner) => owner.host.open('first'), 'first'),
    /e2ee_custody_unavailable/
  )
  const all = await api.resetDesktopE2eeIdentity({ resetId: randomUUID() })
  assert.ok(all.archive)
  await assert.rejects(
    api.withDesktopE2eeAccount(() => Effect.void, 'first'),
    /e2ee_custody_unavailable/
  )
  setLocked(false)
  await assert.rejects(
    api.withDesktopE2eeAccount((owner) => owner.host.open('first'), 'first'),
    /e2ee_missing-binding/
  )
  await assert.rejects(
    api.withDesktopE2eeAccount((owner) => owner.host.open('sibling'), 'sibling'),
    /e2ee_missing-binding/
  )
  const afterAccountReset = await create('first')
  await api.resetDesktopE2eeIdentity({ workspaceId: 'first', resetId })
  assert.equal(
    (await api.withDesktopE2eeAccount((owner) => owner.host.localPairingContext('first'), 'first'))
      .frontendSigningPublicKey,
    afterAccountReset.signingPublicKey
  )
})

for (const phase of ['queued', 'draining'])
  for (const scope of ['workspace', 'account'])
    for (const change of ['account switch', 'same-account reauthentication'])
      void test(`confirmed ${scope} reset rejects ${change} while ${phase}`, async (t) => {
        const { api, identity } = await nativeAccountFixture(t)
        const first = await createAccountWorkspace(api, 'workspace')
        identity.userId = 'acc2'
        identity.generation++
        const other = await createAccountWorkspace(api, 'workspace')
        identity.userId = 'acc1'
        identity.generation++
        await api.withDesktopE2eeAccount(() => Effect.void, 'workspace')
        const original = await readFile(join(first.directory, 'creations.sqlite'))
        const unrelated = await readFile(join(other.directory, 'creations.sqlite'))
        const entered = Promise.withResolvers()
        const finish = Promise.withResolvers()
        const pause = Effect.promise(() => {
          entered.resolve()
          return finish.promise
        })
        let blocker
        if (phase === 'queued') {
          blocker = api.withDesktopE2eeAccount(() => pause, 'workspace')
          await entered.promise
        } else {
          await api.withDesktopE2eeAccount(
            (owner) => Scope.addFinalizer(owner.scope, pause),
            'workspace'
          )
        }
        const rejected = assert.rejects(
          api.resetDesktopE2eeIdentity({
            workspaceId: scope === 'workspace' ? 'workspace' : undefined,
            resetId: randomUUID()
          }),
          /e2ee_account_unavailable/
        )
        if (phase === 'draining') await entered.promise
        if (change === 'account switch') identity.userId = 'acc2'
        identity.generation++
        finish.resolve()
        await blocker
        await rejected
        assert.deepEqual(await readFile(join(first.directory, 'creations.sqlite')), original)
        assert.deepEqual(await readFile(join(other.directory, 'creations.sqlite')), unrelated)
      })

void test('workspace-scoped cold identity IPC composes with isolated custody without granting a reader', async (t) => {
  const { api, directory } = await nativeAccountFixture(t)
  const first = await createAccountWorkspace(api, 'workspace')
  const sibling = await createAccountWorkspace(api, 'sibling')
  await api.closeDesktopE2eeAccount()
  const sender = Object.assign(new EventEmitter(), {
    id: 17,
    isDestroyed: () => false,
    send: () => {}
  })
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    '../ipc-service-deps': { getIpcServiceDeps: () => ({}) },
    '../product-window-ipc-service': { ProductWindowIpcService: class {} },
    'electron-ipc-decorator': {
      IpcMethod: () => (_target, _name, descriptor) => descriptor,
      getIpcContext: () => ({ event: { sender } })
    },
    '../../platform': { isLocalPlatform: () => false },
    '../../services/e2ee-bootstrap.mjs': {},
    '../../services/e2ee-account-runtime': {
      ...api,
      desktopE2eeCloudClient: async () => ({
        accountId: 'acc1',
        client: {
          history: () =>
            Effect.succeed({
              workspaceId: 'workspace',
              genesisHash: first.creation.genesisHashHex,
              startIndex: 0,
              recordsHex: [first.creation.genesisRecordHex],
              checkpoint: {
                length: 1,
                headHash: Buffer.from(
                  hashRecordBytes(Buffer.from(first.creation.genesisRecordHex, 'hex')).toBytes()
                ).toString('hex')
              },
              nextCursor: null,
              position: 'p1:workspace:1:fixture'
            }),
          ledgerLog: () => ({
            read: () => Effect.die('no submission needed'),
            appendCas: () => Effect.die('no new signature')
          }),
          staging: () => ({
            stageGroup: () => Effect.die('no rotation requested'),
            readGroup: () => Effect.succeed(null),
            deleteGroup: () => Effect.void
          }),
          mailbox: () => {
            throw new Error('current key already installed')
          }
        }
      })
    },
    '../assert-sender': { assertProductWindowSender: () => {} }
  })
  const ipc = new E2eeIpc()
  assert.deepEqual(
    { ...(await ipc.readIdentity({ accountId: 'acc1', workspaceId: 'workspace' })) },
    {
      workspaceId: 'workspace',
      genesisHash: first.creation.genesisHashHex
    }
  )
  await assert.rejects(ipc.status('workspace'), /e2ee_/)
  await assert.rejects(ipc.readIdentity({ accountId: 'acc2', workspaceId: 'workspace' }), /e2ee_/)
  assert.equal(
    await api.withDesktopE2eeAccount(
      (owner) => Effect.succeed(owner.readers.has('workspace')),
      'workspace',
      false
    ),
    false
  )
  const roots = await readdir(join(directory, 'e2ee-bootstrap'))
  assert.ok(!(await readdir(join(directory, 'e2ee-bootstrap', roots[0]))).includes('control'))
  await ipc.open('workspace')
  assert.equal((await ipc.status('workspace')).genesisHash, first.creation.genesisHashHex)
  const management = await ipc.managementState('workspace')
  assert.equal(management.epoch, 0)
  assert.equal(management.mayRotate, true)
  assert.equal(management.devices.find((entry) => entry.self).key, first.signingPublicKey)
  await ipc.updateKeys('workspace')
  await ipc.revokeDevice('workspace', sibling.signingPublicKey)
  await ipc.readIdentity({ accountId: 'acc1', workspaceId: 'workspace' })
  assert.equal((await ipc.status('workspace')).genesisHash, first.creation.genesisHashHex)
  await ipc.close('workspace')
})

void test('real preload bridge admits only confirmed trusted reset IPC and archives native originals', async (t) => {
  const { api } = await nativeAccountFixture(t)
  const first = await createAccountWorkspace(api, 'workspace')
  const sender = Object.assign(new EventEmitter(), {
    id: 18,
    isDestroyed: () => false,
    send: () => {}
  })
  let trusted = true
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    '../ipc-service-deps': {
      getIpcServiceDeps: () => ({
        cliService: {
          getLocalMachineId: async () => 'machine',
          resetLocalE2eeIdentity: async () => {}
        }
      })
    },
    '../product-window-ipc-service': { ProductWindowIpcService: class {} },
    'electron-ipc-decorator': {
      IpcMethod: () => (_target, _name, descriptor) => descriptor,
      getIpcContext: () => ({ event: { sender } })
    },
    '../../platform': { isLocalPlatform: () => false },
    '../../services/e2ee-bootstrap.mjs': {},
    '../../services/e2ee-account-runtime': api,
    '../assert-sender': {
      assertProductWindowSender: () => {
        if (!trusted) throw new Error('untrusted sender')
      }
    }
  })
  const ipc = new E2eeIpc()
  const { ipcBridge } = await load('../../preload/ipc-bridge.ts', {
    electron: {
      ipcRenderer: { on: () => {}, invoke: (channel, input) => ipc[channel.split('.')[1]](input) }
    },
    './ipc-invoke-policy': { isIpcInvokeChannel, isClientLossProbeChannel: () => false },
    '@lody/shared/electron-ipc': electronIpc
  })
  await ipc.open('workspace')
  const context = await api.withDesktopE2eeAccount(
    (owner) => owner.host.localPairingContext('workspace'),
    'workspace'
  )
  for (const method of ['resetLocalAgent', 'resetIdentity']) {
    const input = { workspaceId: 'workspace', resetId: randomUUID(), confirm: true }
    await assert.rejects(
      ipcBridge.invoke(`e2ee.${method}`, { ...input, confirm: false }),
      /e2ee_invalid-input/
    )
    trusted = false
    await assert.rejects(ipcBridge.invoke(`e2ee.${method}`, input), /untrusted sender/)
    trusted = true
    assert.ok(await readFile(join(first.directory, 'creations.sqlite')))
    const result = await ipcBridge.invoke(`e2ee.${method}`, input)
    if (method === 'resetIdentity') {
      assert.ok(await readFile(join(result.archive, 'creations.sqlite')))
      await assert.rejects(readFile(join(first.directory, 'creations.sqlite')), { code: 'ENOENT' })
    } else {
      const next = await api.withDesktopE2eeAccount(
        (owner) => owner.host.localPairingContext('workspace'),
        'workspace'
      )
      assert.notEqual(next.pairingSessionId, context.pairingSessionId)
    }
  }
  await assert.rejects(ipcBridge.invoke('e2ee.exportKey'), /Blocked IPC invoke/)
})

void test('credential-authenticated member removal drains and deletes through the real IPC boundary; device-only rejection preserves data', async (t) => {
  const f = await personalJoinFixture(t)
  const owner = await f.open('removed-ipc')
  await owner.create()
  const status = await owner.ipc.status(f.workspaceId)
  await assert.rejects(
    owner.ipc.refresh(f.workspaceId, { keyMode: 'none' }),
    /unauthorized history/
  )
  assert.equal((await owner.ipc.status(f.workspaceId)).signingPublicKey, status.signingPublicKey)
  f.relay.memberRemoved = true
  await assert.rejects(
    owner.ipc.refresh(f.workspaceId, { keyMode: 'none' }),
    /^Error: e2ee_member_removed$/
  )
  await assert.rejects(owner.ipc.status(f.workspaceId), /^Error: e2ee_member_removed$/)
  assert.equal(owner.readers.has(f.workspaceId), false)
  assert.equal(
    f.db(
      owner,
      'creations.sqlite',
      (db) => db.prepare('SELECT count(*) AS n FROM creations').get().n
    ),
    0
  )
  await assert.rejects(owner.ipc.open(f.workspaceId), (error) => error.code === 'member_removed')
})

void test('prepareDispatch confirms access loss after its reader closes through the real account boundary', async (t) => {
  for (const [name, response, code] of [
    ['removed', Effect.fail(new E2eeMemberRemovedError()), 'member_removed'],
    ['revoked', Effect.fail(new E2eeDeviceRevokedError()), 'device_revoked'],
    ['allowed', Effect.succeed({ token: 'synthetic-unused-token' }), null],
    ['network', Effect.fail(new Error('synthetic network failure')), null],
    ['unclassified', Effect.fail(new Error('e2ee_member_removed')), null],
    ['other-reader', Effect.succeed({ token: 'synthetic-unused-token' }), null],
    ['account-switch', Effect.fail(new E2eeMemberRemovedError()), null],
    ['credential-change', Effect.fail(new E2eeMemberRemovedError()), null],
    ['credential-change-other-reader', Effect.fail(new E2eeMemberRemovedError()), null],
    ['status-failure', Effect.succeed({ token: 'synthetic-unused-token' }), null]
  ]) {
    await t.test(name, async (subtest) => {
      // Keep credential replacement inside the confirmation budget regardless of
      // real filesystem speed; this test controls verdict ordering, not elapsed I/O.
      const scope = await Effect.runPromise(Scope.make())
      const clock = await Effect.runPromise(Layer.buildWithScope(TestClock.layer(), scope))
      subtest.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
      const { api, identity } = await nativeAccountFixture(subtest, identityStorage, clock)
      let credentialReplaced = false
      let replacement
      let replacementBytes
      const first = await createAccountWorkspace(api, 'workspace')
      const sender = Object.assign(new EventEmitter(), {
        id: 41,
        isDestroyed: () => false,
        send: () => {}
      })
      const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
        '../product-window-ipc-service': { ProductWindowIpcService: class {} },
        'electron-ipc-decorator': {
          IpcMethod: () => (_target, _name, descriptor) => descriptor,
          getIpcContext: () => ({ event: { sender } })
        },
        '../../platform': { isLocalPlatform: () => false },
        '../../services/e2ee-bootstrap.mjs': {},
        '../assert-sender': { assertProductWindowSender: () => {} },
        '../ipc-service-deps': {
          getIpcServiceDeps: () => ({
            authService: { getCachedSessionIdentity: () => ({ ...identity }) }
          })
        },
        '../../services/e2ee-account-runtime': {
          ...api,
          desktopE2eeCloudClient: async () => ({
            accountId: 'acc1',
            client: {
              contentStreamsToken: ({ workspaceId, credential }) =>
                Effect.gen(function* () {
                  assert.equal(workspaceId, 'workspace')
                  assert.equal(credential, retainedCredential)
                  // Response delivery is explicit; no clock or scheduler race.
                  if (name === 'account-switch') {
                    identity.userId = 'acc2'
                    identity.generation++
                  }
                  if (name.startsWith('credential-change')) {
                    yield* Effect.promise(async () => {
                      await api.resetDesktopE2eeIdentity({ workspaceId, resetId: randomUUID() })
                      replacement = await createAccountWorkspace(api, workspaceId)
                      const nextCredential = await api.withDesktopE2eeAccount(
                        (owner) => {
                          owner.readers.set(workspaceId, new Map([[sender.id, 1]]))
                          return owner.bootstrap.deviceCredential(workspaceId)
                        },
                        workspaceId,
                        false
                      )
                      assert.notEqual(nextCredential, retainedCredential)
                      assert.notEqual(replacement.signingPublicKey, first.signingPublicKey)
                      await ipc.close(workspaceId)
                      const cached = await api.withDesktopE2eeAccount(
                        (owner) => owner.host.inspectCachedState(workspaceId, 'synthetic-machine'),
                        workspaceId,
                        false
                      )
                      assert.equal(cached.entryPresent, false)
                      if (name === 'credential-change-other-reader') {
                        await api.withDesktopE2eeAccount(
                          (owner) => {
                            owner.readers.set(workspaceId, new Map([[42, 1]]))
                            return owner.host.open(workspaceId)
                          },
                          workspaceId,
                          false
                        )
                      }
                      replacementBytes = await readFile(
                        join(replacement.directory, 'creations.sqlite')
                      )
                    })
                    credentialReplaced = true
                  }
                  return yield* response
                }),
              machineSharing: () => ({})
            }
          })
        }
      })
      const ipc = new E2eeIpc()
      let dispatched = false
      const retainedCredential = await api.withDesktopE2eeAccount(
        (owner) => {
          owner.readers.set('workspace', new Map([[sender.id, 1]]))
          if (name === 'other-reader') owner.readers.get('workspace').set(42, 1)
          owner.host.prepareDispatch = () =>
            Effect.sync(() => {
              dispatched = true
              return { frame: 'synthetic-dispatch-must-not-escape' }
            })
          if (name === 'status-failure') {
            const status = owner.host.status
            owner.host.status = (workspaceId) =>
              status(workspaceId).pipe(
                Effect.flatMap(() => Effect.fail(new Error('synthetic post-open status failure')))
              )
          }
          return owner.bootstrap.deviceCredential('workspace')
        },
        'workspace',
        false
      )
      // Real close removes the calling reader and drains the native workspace.
      await ipc.close('workspace')
      await assert.rejects(ipc.status('workspace'))
      const original = await readFile(join(first.directory, 'creations.sqlite'))
      const outcome = ipc.prepareDispatch('workspace', 'synthetic-machine', {
        sessionId: 'session',
        userTurnId: 'turn',
        userId: 'display-only',
        timestamp: new Date(0).toISOString(),
        inputConfig: {}
      })
      await assert.rejects(
        outcome,
        code
          ? new RegExp(`^Error: e2ee_${code}$`)
          : name === 'account-switch'
            ? /^Error: e2ee_(?:account_mismatch|missing-binding)$/
            : /^Error: e2ee_host_operation_failed$/
      )
      await Promise.all([...(ipc.dispatchCleanups?.values() ?? [])].map((slot) => slot.done))
      assert.equal(dispatched, false)
      if (name.startsWith('credential-change')) assert.equal(credentialReplaced, true)
      if (code) {
        // Cleanup retains its terminal receipt database, erasing creation/key state.
        const db = new DatabaseSync(join(first.directory, 'creations.sqlite'))
        try {
          assert.equal(db.prepare('SELECT count(*) AS n FROM creations').get().n, 0)
          assert.equal(db.prepare('SELECT count(*) AS n FROM removed_workspaces').get().n, 1)
        } finally {
          db.close()
        }
        await assert.rejects(readdir(join(first.directory, 'workspaces', 'workspace')), {
          code: 'ENOENT'
        })
      } else {
        assert.deepEqual(
          await readFile(join(first.directory, 'creations.sqlite')),
          replacementBytes ?? original
        )
        identity.userId = 'acc1'
        identity.generation++
        const cached = await api.withDesktopE2eeAccount(
          (owner) => owner.host.inspectCachedState('workspace', 'synthetic-machine'),
          'workspace',
          false
        )
        const otherReader = name === 'other-reader' || name === 'credential-change-other-reader'
        assert.equal(cached.entryPresent, otherReader)
        if (otherReader) {
          sender.id = 42
          assert.equal(
            (await ipc.status('workspace')).signingPublicKey,
            (replacement ?? first).signingPublicKey
          )
          sender.id = 41
        }
      }
      await assert.rejects(ipc.status('workspace'))
    })
  }
})

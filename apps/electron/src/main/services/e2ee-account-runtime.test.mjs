import * as identityStorage from '@lody/shared/node/e2ee-identity'
import { E2eeDeviceRevokedError, E2eeMemberRemovedError } from './e2ee-cloud-errors.mts'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { readFile, mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign
} from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { Context, Effect, Fiber, Layer, Scope, Exit, Result, Clock } from 'effect'
import { TestClock } from 'effect/testing'
import { BackendError, KeyMailbox } from '@lody/e2ee-core/services'
import { makeSqliteKeyMailbox, referenceKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite'
import { WorkspaceKeyRoundFailure } from '@lody/e2ee-core'
import {
  Bytes,
  hashRecordBytes,
  verifyLedger,
  derivePairingKeys,
  disposePairingKeys,
  encodePairingSecret,
  formatPairingString,
  prepareLedgerCommand,
  signLedgerRecord
} from '@lody/e2ee-core/protocol'
import { makeDesktopE2eeCustody } from '../e2ee-custody.mts'
import { makeDesktopE2eeBootstrap } from './e2ee-bootstrap.mts'
import { makeDesktopE2eeRuntimeHost } from './e2ee-runtime.mts'
import { makeE2eeCloudClient } from './e2ee-cloud-client.mts'
import {
  makeDesktopAccountPairingHost,
  makeDesktopAccountPairingWorkspaces
} from './e2ee-account-pairing-host.mts'
import { makeOfflineAuthIdentityCache } from '../auth-storage.ts'
import * as electronIpc from '../../../../../packages/shared/src/electron-ipc.ts'
import { isIpcInvokeChannel } from '../../preload/ipc-invoke-policy.ts'
import * as memberJoining from './e2ee-member-join.mts'
import { KEY_DELIVERY_RETRY_DELAYS } from '@lody/e2ee-client/account-requester'
import { memberOfferSigningBytes } from '@lody/e2ee-client/member'
import { PersonalPairingOfferSchema } from './e2ee-personal-pairing.mts'
import { desktopE2eeFailure, rememberDesktopE2eeFailure } from './e2ee-diagnostics.mts'
import { createDesktopQuitBarrier, drainMainProcessQuitResources } from './desktop-shutdown.ts'
import {
  appendLedgerHistory,
  hostLedgerHistory
} from '../../../../../packages/components/src/lib/e2ee-ledger-history.ts'
import {
  readObservedLedgerCheckpoint,
  retainObservedLedgerCheckpoint
} from '../../../../../packages/components/src/lib/e2ee-workspace-storage.ts'
import * as proxyEnv from '../../../../../packages/shared/src/proxy-env.ts'
const require = createRequire(import.meta.url)
async function load(relative, dependencies, console = globalThis.console, env = {}, globals = {}) {
  return loadSync(relative, dependencies, console, env, globals)
}
/** Loads one module in the same sandbox and dependency map as its importer, so main
 * modules split out of `E2eeIpc` share its console, clock and mocked account runtime. */
function loadSync(relative, dependencies, console = globalThis.console, env = {}, globals = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const exports = {}
  runInNewContext(
    ts.transpileModule(source.replaceAll('import.meta.env', JSON.stringify(env)), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true
      }
    }).outputText,
    {
      exports,
      Error,
      crypto: globalThis.crypto,
      Buffer,
      URL,
      setTimeout,
      clearTimeout,
      console,
      ...globals,
      require: (id) =>
        Object.hasOwn(dependencies, id)
          ? dependencies[id]
          : id === './e2ee-diagnostics.mjs'
            ? { rememberDesktopE2eeFailure }
            : id === '../../services/e2ee-member-join.mjs'
              ? memberJoining
              : id === '../../services/e2ee-cloud-errors.mjs' || id === './e2ee-cloud-errors.mjs'
                ? { E2eeMemberRemovedError, E2eeDeviceRevokedError }
                : id === '../../services/e2ee-personal-pairing.mjs'
                  ? { PersonalPairingOfferSchema }
                  : id === '../../services/e2ee-account-pairing-host.mjs'
                    ? { makeDesktopAccountPairingHost }
                    : id === '../../services/e2ee-key-delivery.mjs'
                      ? loadSync('./e2ee-key-delivery.mts', dependencies, console, env, globals)
                      : id === '../../services/e2ee-agent-pairing-service.mjs'
                        ? loadSync(
                            './e2ee-agent-pairing-service.mts',
                            dependencies,
                            console,
                            env,
                            globals
                          )
                        : id === '@lody/e2ee-client/account-requester'
                          ? { KEY_DELIVERY_RETRY_DELAYS }
                          : id === '../../services/e2ee-recovery-vault.mjs' ||
                              id === '../../services/e2ee-passkey-macos.mjs'
                            ? {}
                            : id === '../../services/e2ee-client-loss-probe'
                              ? // Production default: the E2E probe is disabled and forwards work.
                                {
                                  observeClientLossOperation: (_kind, _workspace, _sender, work) =>
                                    work()
                                }
                              : require(id)
    }
  )
  return exports
}
async function account(options = {}) {
  const identity = { userId: 'acc1', generation: 1 }
  let identityListener = () => {}
  const auth = {
    subscribeCachedSessionIdentity: (listener) => {
      identityListener = listener
      return () => {}
    },
    getCachedSessionIdentity: () => ({ ...identity }),
    getBootstrapSession: () => new Promise(() => {}),
    ...options.auth
  }
  const warnings = []
  const api = await load(
    './e2ee-account-runtime.ts',
    {
      electron: { app: { getPath: () => options.directory ?? '/synthetic-user-data' } },
      ...(options.clock
        ? {
            '@lody/shared/node/e2ee-clock': {
              withE2eeTestClock: (work) => Effect.provide(work, options.clock)
            }
          }
        : {}),
      '@lody/shared/node/e2ee-identity': options.identityStorage ?? {
        leaseE2eeIdentity: () => Effect.void
      },
      '../e2ee-custody-electron': {
        makeElectronE2eeCustody: options.custody ?? (() => Effect.succeed({}))
      },
      './e2ee-bootstrap.mjs': {
        makeDesktopE2eeBootstrap: options.bootstrap ?? (() => Effect.succeed({}))
      },
      './e2ee-cloud-client.mjs': { makeE2eeCloudClient: options.cloud },
      './e2ee-runtime.mjs': {
        makeDesktopE2eeRuntimeHost: options.host ?? (() => Effect.succeed({}))
      },
      '../ipc/ipc-service-deps': {
        getIpcServiceDeps: () => ({
          authService: auth
        })
      }
    },
    { warn: (...args) => warnings.push(args) }
  )
  return {
    api,
    warnings,
    identity,
    publishIdentity: (userId) => {
      identity.userId = userId
      identity.generation += 1
      identityListener()
    }
  }
}
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
      ledgerView: () => Effect.succeed(ledger),
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
/** Holds one turn in `workspaceId` until `finish` settles; its owner records its close. */
function holdWorkspaceTurn(api, workspaceId, events) {
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const done = api.withDesktopE2eeAccount(
    (owner) =>
      Effect.gen(function* () {
        yield* Scope.addFinalizer(
          owner.scope,
          Effect.sync(() => events.push(`${workspaceId} closed`))
        )
        entered.resolve()
        yield* Effect.promise(() => finish.promise)
        events.push(`${workspaceId} end`)
      }),
    workspaceId
  )
  return { entered: entered.promise, finish: () => finish.resolve(), done }
}
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

// The relay below models immutable begin bytes and cancel/reservation arbitration;
// native journals, crypto, host approval and the invoked IPC methods remain real.
async function personalJoinFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lody-join-ipc-'))
  const owners = new Set()
  t.after(async () => {
    for (const owner of owners) await owner.close()
    await rm(directory, { recursive: true, force: true })
  })
  const accountId = 'acc3'
  const workspaceId = 'synthetic-personal-workspace'
  const wrapping = Buffer.alloc(32, 93)
  const safeStorage = {
    isEncryptionAvailable: () => true,
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', wrapping, nonce)
      return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()])
    },
    decryptStringAsync: async (value) => {
      const decipher = createDecipheriv('aes-256-gcm', wrapping, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(-16))
      return {
        result: Buffer.concat([
          decipher.update(value.subarray(12, -16)),
          decipher.final()
        ]).toString(),
        shouldReEncrypt: false
      }
    }
  }
  let lockDepth = 0
  const rows = new Map()
  const relay = {
    statusFailure: null,
    loseCancelReceipt: false,
    memberRemoved: false,
    deviceRevoked: false
  }
  const remote = (work) =>
    Effect.try({
      try: () => {
        assert.equal(lockDepth, 0, 'cloud work cannot run under account custody lock')
        return work()
      },
      catch: (error) => error
    })
  const getRow = ({ pairingSessionId }) => {
    const row = rows.get(pairingSessionId)
    if (!row) throw new Error('e2ee_not_found')
    return row
  }
  const client = {
    machineSharing: () => ({}),
    history: () => Effect.fail(new Error('unauthorized history')),
    // An unclassified rejection (raw error text) must never authorize deletion.
    contentStreamsToken: () =>
      relay.memberRemoved
        ? Effect.fail(new E2eeMemberRemovedError())
        : relay.deviceRevoked
          ? Effect.fail(new E2eeDeviceRevokedError())
          : Effect.fail(new Error('e2ee_device_revoked')),
    memberCreateInvitation: () => Effect.fail(new E2eeMemberRemovedError()),
    memberPending: () => Effect.fail(new E2eeMemberRemovedError()),
    memberRead: () => Effect.fail(new E2eeMemberRemovedError()),
    memberReject: () => Effect.fail(new E2eeMemberRemovedError()),
    memberRevoke: () => Effect.fail(new E2eeMemberRemovedError()),
    joinBegin: (request) =>
      remote(() => {
        const existing = rows.get(request.pairingSessionId)
        if (existing) {
          for (const field of [
            'workspaceId',
            'genesisHash',
            'requestHex',
            'signingPublicKey',
            'credentialHash'
          ])
            if (existing[field] !== request[field]) throw new Error('e2ee_conflict')
          return { ...existing }
        }
        const value = { ...request, accountId, status: 'pending' }
        rows.set(request.pairingSessionId, value)
        return { ...value }
      }),
    joinReadRequest: (request) => remote(() => ({ ...getRow(request) })),
    joinStatus: (request) =>
      remote(() => {
        if (relay.statusFailure) throw relay.statusFailure
        return { ...getRow(request) }
      }),
    joinClaim: (request) => remote(() => ({ ...getRow(request) })),
    joinCancel: (request) =>
      remote(() => {
        const row = getRow(request)
        if (row.status === 'admitting' || row.status === 'published')
          throw new Error('e2ee_admission_reserved')
        row.status = 'cancelled'
        if (relay.loseCancelReceipt) {
          relay.loseCancelReceipt = false
          throw new Error('synthetic lost cancel receipt')
        }
        return { status: 'cancelled' }
      })
  }
  const open = async (name) => {
    const path = join(directory, name)
    const scope = await Effect.runPromise(Scope.make())
    const material = await Effect.runPromise(
      Effect.gen(function* () {
        const custody = yield* makeDesktopE2eeCustody({
          directory: join(path, 'custody'),
          platform: 'linux',
          safeStorage
        })
        const bootstrap = yield* makeDesktopE2eeBootstrap({ directory: path, accountId, custody })
        const host = yield* makeDesktopE2eeRuntimeHost({ directory: path, custody, bootstrap })
        return { custody, bootstrap, host }
      }).pipe(Effect.provideService(Scope.Scope, scope))
    )
    const sender = Object.assign(new EventEmitter(), {
      id: 23,
      isDestroyed: () => false,
      send: () => {}
    })
    let removalFence
    const owner = {
      ...material,
      accountId,
      scope,
      readers: new Map(),
      fenceLoss: (workspaceId, reason) =>
        (removalFence ??= { owner, workspaceId, reason, completed: false })
    }
    const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
      '../product-window-ipc-service': { ProductWindowIpcService: class {} },
      'electron-ipc-decorator': {
        IpcMethod: () => (_t, _n, descriptor) => descriptor,
        getIpcContext: () => ({ event: { sender } })
      },
      '../../platform': { isLocalPlatform: () => false },
      '../../services/e2ee-bootstrap.mjs': {},
      '../ipc-service-deps': {
        getIpcServiceDeps: () => ({
          authService: {
            getCachedSessionIdentity: () => ({ userId: owner.accountId, source: 'offline' })
          }
        })
      },
      '../assert-sender': { assertProductWindowSender: () => {} },
      '../../services/e2ee-account-runtime': {
        withDesktopE2eeAccount: async (work, _location, _create, retiring) => {
          if (removalFence && retiring !== removalFence)
            throw Object.assign(new Error(`e2ee_${removalFence.reason}`), {
              code: removalFence.reason
            })
          lockDepth++
          try {
            return await Effect.runPromise(work(owner))
          } catch (error) {
            // Match the account boundary's public projection used by the IPC retry.
            if (error.code === 'snapshot-history-required')
              throw new Error('e2ee_snapshot-history-required', { cause: error })
            throw error
          } finally {
            lockDepth--
          }
        },
        cleanupRemovedDesktopWorkspace: async ({ workspaceId: removedWorkspaceId }) => {
          const erased = await Effect.runPromise(
            owner.bootstrap.resumeRemovedWorkspace(removedWorkspaceId)
          )
          if (erased) {
            owner.readers.delete(removedWorkspaceId)
            if (removalFence) removalFence.completed = true
            removalFence = undefined
          }
          return erased
        },
        runDesktopE2eeOperation: (_accountId, work) => Effect.runPromise(work),
        publicAccessLoss: () => null,
        desktopE2eeCloudClient: async () => ({ accountId, client })
      }
    })
    let closed = false
    const value = {
      ...owner,
      path,
      ipc: new E2eeIpc(),
      close: async () => {
        if (closed) return
        closed = true
        await Effect.runPromise(Scope.close(scope, Exit.void))
      },
      attach: async (id = workspaceId) => {
        await Effect.runPromise(owner.host.open(id))
        owner.readers.set(id, new Map([[sender.id, 1]]))
      },
      create: async (id = workspaceId) => {
        const prepared = await Effect.runPromise(
          owner.bootstrap.prepareCreation({
            accountId,
            requestId: `synthetic-request-${id}`,
            name: 'Synthetic encrypted workspace',
            slug: id
          })
        )
        await Effect.runPromise(
          owner.bootstrap.recordCreated({
            workspaceId: id,
            genesisHash: prepared.genesisHashHex,
            requestId: `synthetic-request-${id}`
          })
        )
        await value.attach(id)
        await Effect.runPromise(
          owner.host.ingestLedgerRecords(id, {
            workspaceId: id,
            genesisHash: prepared.genesisHashHex,
            checkpoint: { length: 1, headHash: prepared.genesisHashHex },
            startIndex: 0,
            recordsHex: [prepared.genesisRecordHex],
            position: `p1:${id}:1:source-1:0`,
            nextCursor: null
          })
        )
      }
    }
    owners.add(value)
    return value
  }
  const db = (owner, name, work) => {
    const connection = new DatabaseSync(join(owner.path, name))
    try {
      return work(connection)
    } finally {
      connection.close()
    }
  }
  const append = async (owner, genesisHash, recordHex) => {
    const status = await Effect.runPromise(owner.host.status(workspaceId))
    await Effect.runPromise(
      owner.host.ingestLedgerRecords(workspaceId, {
        workspaceId,
        genesisHash,
        checkpoint: {
          length: status.length + 1,
          headHash: Buffer.from(hashRecordBytes(Buffer.from(recordHex, 'hex')).toBytes()).toString(
            'hex'
          )
        },
        startIndex: status.length,
        recordsHex: [recordHex],
        position: `p1:${workspaceId}:${status.length + 1}:source-${status.length + 1}:0`,
        nextCursor: null
      })
    )
  }
  const admit = async (owner, recipient, offer) => {
    const request = await Effect.runPromise(recipient.bootstrap.preparePersonalJoin(offer))
    await Effect.runPromise(owner.host.previewPersonalAdmission(workspaceId, request.requestHex))
    const admission = await Effect.runPromise(
      owner.host.preparePersonalAdmission(workspaceId, request.requestHex)
    )
    await append(owner, offer.genesisHash, admission.recordHex)
    const invitation = await Effect.runPromise(
      owner.host.personalInvitation(workspaceId, offer.pairingSessionId)
    )
    const row = rows.get(offer.pairingSessionId)
    row.status = 'published'
    row.invitationHex = invitation.invitationHex
    return invitation
  }
  return { open, rows, relay, db, workspaceId, append, admit, client, remote }
}

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

async function nativeAccountFixture(t, storage = identityStorage, clock) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-identity-reset-'))
  let locked = false
  const wrapping = Buffer.alloc(32, 121)
  const safeStorage = {
    isEncryptionAvailable: () => !locked,
    isAsyncEncryptionAvailable: async () => !locked,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value) => {
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', wrapping, nonce)
      return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()])
    },
    decryptStringAsync: async (value) => {
      const cipher = createDecipheriv('aes-256-gcm', wrapping, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(-16))
      return {
        result: Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString(),
        shouldReEncrypt: false
      }
    }
  }
  const native = await account({
    directory,
    clock,
    identityStorage: storage,
    custody: (path) => makeDesktopE2eeCustody({ directory: path, platform: 'linux', safeStorage }),
    bootstrap: makeDesktopE2eeBootstrap,
    host: makeDesktopE2eeRuntimeHost,
    cloud: () => Effect.succeed({})
  })
  t.after(async () => {
    await native.api.closeDesktopE2eeAccount()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    ...native,
    directory,
    setLocked: (value) => {
      locked = value
    }
  }
}

async function createAccountWorkspace(api, workspaceId) {
  return api.withDesktopE2eeAccount(
    (owner) =>
      Effect.gen(function* () {
        const creation = yield* owner.bootstrap.prepareCreation({
          accountId: owner.accountId,
          requestId: `creation-${workspaceId}-request`,
          name: workspaceId,
          slug: workspaceId
        })
        yield* owner.bootstrap.recordCreated({
          workspaceId,
          requestId: `creation-${workspaceId}-request`,
          genesisHash: creation.genesisHashHex
        })
        const status = yield* owner.host.open(workspaceId)
        const local = yield* owner.host.localPairingContext(workspaceId)
        return {
          directory: owner.directory,
          creation,
          status,
          signingPublicKey: local.frontendSigningPublicKey
        }
      }),
    workspaceId
  )
}

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
    owner.ipc.refresh(f.workspaceId, { installKeys: false }),
    /unauthorized history/
  )
  assert.equal((await owner.ipc.status(f.workspaceId)).signingPublicKey, status.signingPublicKey)
  f.relay.memberRemoved = true
  await assert.rejects(
    owner.ipc.refresh(f.workspaceId, { installKeys: false }),
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

void test('prepareDispatch isolates JWT, transport and parse failures from credential authority through the real cloud client', async (t) => {
  for (const hasReader of [false, true]) {
    for (const code of ['e2ee_member_removed', 'e2ee_device_revoked']) {
      for (const source of [
        'jwt',
        'transport',
        'parse',
        'endpoint',
        'endpoint-slow-cleanup',
        'endpoint-cleanup-failure',
        ...(hasReader
          ? ['endpoint-slow-cleanup-frame']
          : ['endpoint-after-budget', 'transport-after-budget'])
      ]) {
        await t.test(`${hasReader ? 'reader' : 'closed'}-${code}-${source}`, async (subtest) => {
          const scope = await Effect.runPromise(Scope.make())
          const clock = await Effect.runPromise(Layer.buildWithScope(TestClock.layer(), scope))
          subtest.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
          const run = (work) => Effect.runPromise(Effect.provide(work, clock))
          const { api, identity } = await nativeAccountFixture(subtest, identityStorage, clock)
          const first = await createAccountWorkspace(api, 'workspace')
          const sender = Object.assign(new EventEmitter(), {
            id: 41,
            isDestroyed: () => false,
            send: () => {}
          })
          const failure = { data: { code } }
          const diagnostics = []
          let endpointCalls = 0
          let dispatchCalls = 0
          const cleanupEntered = Promise.withResolvers()
          const cleanupDone = Promise.withResolvers()
          const releaseCleanup = Promise.withResolvers()
          subtest.after(() => releaseCleanup.resolve())
          const delayedCleanup = source.startsWith('endpoint-slow-cleanup')
          if (delayedCleanup) await createAccountWorkspace(api, 'independent-workspace')
          let escapedFrames = 0
          const afterBudget = source.endsWith('-after-budget')
          const endpointEntered = Promise.withResolvers()
          const releaseEndpoint = Promise.withResolvers()
          subtest.after(() => releaseEndpoint.resolve())
          const credential = await api.withDesktopE2eeAccount(
            (owner) => {
              owner.readers.set('workspace', new Map([[sender.id, 1]]))
              owner.host.prepareDispatch = () =>
                Effect.sync(() => {
                  dispatchCalls++
                  if (source.endsWith('-frame')) return { frame: 'synthetic-frame-must-not-escape' }
                  throw new Error('synthetic local dispatch failure')
                })
              return owner.bootstrap.deviceCredential('workspace')
            },
            'workspace',
            false
          )
          const client = await Effect.runPromise(
            makeE2eeCloudClient({
              platformKind: 'cloud',
              deploymentUrl: 'https://synthetic.convex.cloud',
              convexToken: async () => {
                if (source === 'jwt') throw failure
                return { token: 'synthetic-jwt' }
              },
              fetch: async (_url, init) => {
                const request = JSON.parse(init.body)
                assert.equal(request.path, 'e2eeContent:contentStreamsToken')
                assert.equal(request.args[0].credential, credential)
                endpointCalls++
                if (afterBudget) {
                  endpointEntered.resolve()
                  await releaseEndpoint.promise
                }
                if (source === 'transport' || source === 'transport-after-budget') throw failure
                const response = Response.json(
                  { status: 'error', errorMessage: 'synthetic rejection', errorData: { code } },
                  { status: 560 }
                )
                if (source === 'parse')
                  response.json = async () => {
                    throw failure
                  }
                return response
              }
            }).pipe(Scope.provide(scope))
          )
          const { E2eeIpc } = await load(
            '../ipc/services/e2ee-ipc.ts',
            {
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
                cleanupRemovedDesktopWorkspace: async (input) => {
                  if (delayedCleanup) {
                    cleanupEntered.resolve()
                    await releaseCleanup.promise
                  }
                  try {
                    if (source === 'endpoint-cleanup-failure')
                      throw new Error('synthetic private cleanup failure')
                    return await api.cleanupRemovedDesktopWorkspace(input)
                  } finally {
                    cleanupDone.resolve()
                  }
                },
                desktopE2eeCloudClient: async () => ({ accountId: 'acc1', client })
              }
            },
            { ...console, warn: (...args) => diagnostics.push(args) }
          )
          const ipc = new E2eeIpc()
          if (!hasReader) await ipc.close('workspace')
          const original = await readFile(join(first.directory, 'creations.sqlite'))
          const snapshot = () => {
            const db = new DatabaseSync(join(first.directory, 'creations.sqlite'))
            try {
              return {
                creations: db
                  .prepare(
                    'SELECT request_id,hex(record) AS record,hex(epoch_blob) AS epoch_blob FROM creations ORDER BY request_id'
                  )
                  .all(),
                receipts: db.prepare('SELECT count(*) AS n FROM removed_workspaces').get().n
              }
            } finally {
              db.close()
            }
          }
          const originalRows = snapshot().creations
          assert.equal(originalRows.length, 1)
          let settled = false
          const outcome = ipc
            .prepareDispatch('workspace', 'synthetic-machine', {
              sessionId: 'session',
              userTurnId: 'turn',
              userId: 'display-only',
              timestamp: new Date(0).toISOString(),
              inputConfig: {}
            })
            .then(
              () => {
                escapedFrames++
                return new Error('unexpected prepared frame')
              },
              (cause) => cause
            )
            .finally(() => {
              settled = true
            })
          if (delayedCleanup) {
            // The exact credential verdict and its durable receipt already exist.
            // Hold only terminal erase; these are the ORIGINAL creation rows.
            await cleanupEntered.promise
            assert.deepEqual(snapshot(), { creations: originalRows, receipts: 1 })
            await run(TestClock.adjust('50 millis'))
            const bounded = settled ? (await outcome).message : undefined
            await run(TestClock.adjust('5 minutes'))
            const eventually = settled ? (await outcome).message : undefined
            // No successor may enter while the original erase still owns the identity.
            let fenceReason
            try {
              await api.withDesktopE2eeAccount(() => Effect.void, 'workspace', false)
            } catch (error) {
              fenceReason = error.message
            }
            const retained = snapshot()
            const independent = await api.withDesktopE2eeAccount(
              (owner) => owner.bootstrap.removedReason('independent-workspace'),
              'independent-workspace',
              false
            )
            assert.equal(independent, null, 'a pending erase cannot fence another workspace')
            releaseCleanup.resolve()
            await cleanupDone.promise
            await outcome
            if (ipc.dispatchCleanups)
              await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
            assert.equal(
              bounded,
              code,
              'known loss must return its exact refusal within 50ms, not await erase'
            )
            assert.equal(eventually, code)
            assert.equal(fenceReason, code, 'pending erase must keep the original identity fenced')
            assert.deepEqual(retained, { creations: originalRows, receipts: 1 })
            assert.equal(escapedFrames, 0)
            assert.ok(diagnostics.some(([, fields]) => fields?.code === 'e2ee_cleanup_pending'))
            assert.equal(
              ipc.dispatchCleanups.size,
              0,
              'actual completion releases the cleanup owner'
            )
            assert.equal(
              await api.withDesktopE2eeAccount(
                (owner) => owner.bootstrap.removedReason('workspace'),
                'workspace',
                false
              ),
              code === 'e2ee_member_removed' ? 'member_removed' : 'device_revoked',
              'actual erase releases the native fence and retains the durable refusal'
            )
          }
          if (afterBudget) {
            // e6 live trace: reader already closed, credential request still has
            // no headers/body when the 300ms budget and IPC response expire.
            await endpointEntered.promise
            await run(TestClock.adjust('321 millis'))
            await api.withDesktopE2eeAccount(() => Effect.void, 'workspace', false)
            const premature = settled ? (await outcome).message : undefined
            assert.deepEqual(snapshot(), { creations: originalRows, receipts: 0 })
            assert.equal(escapedFrames, 0)
            await run(TestClock.adjust('479 millis'))
            releaseEndpoint.resolve()
            await outcome
            if (source.startsWith('endpoint')) await cleanupDone.promise
            assert.equal(
              premature,
              undefined,
              'readerless refusal must await credential diagnosis, not turn timeout into a verdict'
            )
          }
          const error = await outcome
          if (source.startsWith('endpoint')) {
            await cleanupDone.promise
            if (ipc.dispatchCleanups)
              await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
          }
          if (source === 'endpoint-cleanup-failure') {
            assert.equal(error.message, code)
            assert.deepEqual(snapshot(), { creations: originalRows, receipts: 1 })
            await assert.rejects(
              api.withDesktopE2eeAccount(() => Effect.void, 'workspace', false),
              new RegExp(code)
            )
            await assert.rejects(
              api.resetDesktopE2eeIdentity({ workspaceId: 'workspace', resetId: randomUUID() }),
              new RegExp(code)
            )
            assert.equal(
              ipc.dispatchCleanups.size,
              0,
              'settled task releases no native failure fence'
            )
            assert.ok(diagnostics.some(([, fields]) => fields?.code === 'e2ee_cleanup_failed'))
            assert.ok(!JSON.stringify(diagnostics).includes('synthetic private'))
            return
          }
          const db = new DatabaseSync(join(first.directory, 'creations.sqlite'))
          try {
            const authoritative = source.startsWith('endpoint')
            assert.deepEqual(
              {
                message: error.message,
                endpointCalls,
                creations: db.prepare('SELECT count(*) AS n FROM creations').get().n,
                receipts: db.prepare('SELECT count(*) AS n FROM removed_workspaces').get().n
              },
              {
                message: authoritative ? code : 'e2ee_host_operation_failed',
                endpointCalls: source === 'jwt' ? 0 : 1,
                creations: authoritative ? 0 : 1,
                receipts: authoritative ? 1 : 0
              }
            )
          } finally {
            db.close()
          }
          assert.equal(dispatchCalls, hasReader ? 1 : 0)
          assert.equal(escapedFrames, 0)
          if (!source.startsWith('endpoint')) {
            assert.deepEqual(await readFile(join(first.directory, 'creations.sqlite')), original)
            const cached = await api.withDesktopE2eeAccount(
              (owner) => owner.host.inspectCachedState('workspace', 'synthetic-machine'),
              'workspace',
              false
            )
            assert.equal(cached.entryPresent, hasReader)
          }
        })
      }
    }
  }
})

void test('a live reader is cut at prepareDispatch after server-side access loss; stale operations keep the exact code and reader windows get a re-read hint', async (t) => {
  const room = { kind: 'meta' }
  const context = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch'
  }
  const additionalData = new Uint8Array([4, 5, 6])
  const dispatchInput = {
    sessionId: 'session',
    userTurnId: 'turn',
    userId: 'display-only',
    timestamp: new Date(0).toISOString(),
    inputConfig: {}
  }
  for (const [reason, Loss, cut] of [
    ['member_removed', E2eeMemberRemovedError, 'prepareDispatch'],
    ['device_revoked', E2eeDeviceRevokedError, 'prepareDispatch'],
    ['member_removed', E2eeMemberRemovedError, 'contentStreamsToken'],
    ['device_revoked', E2eeDeviceRevokedError, 'contentStreamsToken'],
    ['network', null, 'prepareDispatch']
  ]) {
    await t.test(`${reason}-${cut}`, async (subtest) => {
      const { api, identity } = await nativeAccountFixture(subtest)
      const first = await createAccountWorkspace(api, 'workspace')
      const pushes = []
      const sender = Object.assign(new EventEmitter(), {
        id: 41,
        isDestroyed: () => false,
        send: (channel, payload) => pushes.push({ channel, payload: { ...payload } })
      })
      const server = { lost: false, checks: 0 }
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
              contentStreamsToken: () => {
                server.checks += 1
                return !server.lost
                  ? Effect.succeed({ token: 'synthetic-unused-token' })
                  : Loss
                    ? Effect.fail(new Loss())
                    : Effect.fail(new Error('synthetic network failure'))
              },
              machineSharing: () => ({}),
              history: () => Effect.fail(new Error('synthetic history unavailable'))
            }
          })
        }
      })
      const ipc = new E2eeIpc()
      await ipc.open('workspace')
      // Dispatch policy needs a shared machine; only the IPC/account boundary is under test.
      await api.withDesktopE2eeAccount(
        (owner) =>
          Effect.sync(() => {
            owner.host.prepareDispatch = () =>
              Effect.sync(() => ({
                frame: 'synthetic-prepared-dispatch',
                checksSeenByPreparation: server.checks
              }))
          }),
        'workspace',
        false
      )
      const sealInput = {
        epoch: 0,
        room,
        context,
        plaintext: new TextEncoder().encode('synthetic live content'),
        additionalData
      }
      const sealed = await ipc.seal('workspace', sealInput)
      const openInput = { room, context, ...sealed, additionalData }
      assert.deepEqual(await ipc.openContent('workspace', openInput), sealInput.plaintext)
      // The credential check is already asked while the local preparation runs: the
      // renderer's dispatch fast path cannot absorb a serial server round trip.
      const checksBefore = server.checks
      assert.deepEqual(await ipc.prepareDispatch('workspace', 'synthetic-machine', dispatchInput), {
        frame: 'synthetic-prepared-dispatch',
        checksSeenByPreparation: checksBefore + 1
      })
      assert.equal(server.checks, checksBefore + 1)

      // The server accepted the removal/revocation; this live process has not learned it.
      server.lost = true
      const stale = () =>
        Promise.allSettled([
          ipc.openContent('workspace', openInput),
          ipc.seal('workspace', sealInput),
          ipc.prepareDispatch('workspace', 'synthetic-machine', dispatchInput)
        ])
      if (!Loss) {
        // An unconfirmed check establishes nothing: the reader keeps working.
        assert.deepEqual(
          (await stale()).map((result) => result.status),
          ['fulfilled', 'fulfilled', 'fulfilled']
        )
        assert.deepEqual(pushes, [])
        assert.equal((await ipc.status('workspace')).signingPublicKey, first.signingPublicKey)
        return
      }
      await assert.rejects(
        cut === 'prepareDispatch'
          ? ipc.prepareDispatch('workspace', 'synthetic-machine', dispatchInput)
          : ipc.contentStreamsToken('workspace'),
        new RegExp(`^Error: e2ee_${reason}$`)
      )
      await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
      // Replayed stale arguments stay refused with the same exact, renderer-visible code.
      assert.deepEqual(
        (await stale()).map((result) => result.reason?.message),
        [`e2ee_${reason}`, `e2ee_${reason}`, `e2ee_${reason}`]
      )
      assert.deepEqual(pushes, [
        { channel: 'e2ee.accessLost', payload: { workspaceId: 'workspace' } }
      ])
      // The window's own re-read after the hint is classified as terminal loss.
      await assert.rejects(
        ipc.refresh('workspace', { installKeys: false }),
        new RegExp(`^Error: e2ee_${reason}$`)
      )
      assert.equal(
        api.countDesktopE2eeReaders('acc1', 'workspace', sender.id),
        0,
        'the original reader is closed'
      )
    })
  }
})

// All timing is driven by TestClock; native custody and the account boundary are real.
void test('dispatch confirmation fences its reader and bounds only the waiter', async (t) => {
  for (const scenario of [
    'closed-reader',
    'account-switch',
    'reauthenticated',
    'reader-reopened',
    'renderer-replaced',
    'credential-replaced',
    'unreachable',
    'early-loss',
    'late-loss',
    'loss-during-binding-read'
  ]) {
    await t.test(scenario, async (t) => {
      const scope = await Effect.runPromise(Scope.make())
      const clock = await Effect.runPromise(Layer.buildWithScope(TestClock.layer(), scope))
      t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
      const run = (work) => Effect.runPromise(Effect.provide(work, clock))
      const { api, identity, publishIdentity } = await nativeAccountFixture(
        t,
        identityStorage,
        clock
      )
      await createAccountWorkspace(api, 'workspace')
      const asked = Promise.withResolvers()
      const answer = Promise.withResolvers()
      const prepared = Promise.withResolvers()
      t.after(() => answer.resolve(false))
      const pushed = Promise.withResolvers()
      const bindingEntered = Promise.withResolvers()
      const releaseBinding = Promise.withResolvers()
      const lossCleanupQueued = Promise.withResolvers()
      let bindingHeld = false,
        lossSent = false
      t.after(() => releaseBinding.resolve())
      const sender = Object.assign(new EventEmitter(), {
        id: 42,
        isDestroyed: () => false,
        send: (channel, payload) => pushed.resolve({ channel, payload: { ...payload } })
      })
      let activeSender = sender
      const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
        '../product-window-ipc-service': { ProductWindowIpcService: class {} },
        'electron-ipc-decorator': {
          IpcMethod: () => (_t, _n, d) => d,
          getIpcContext: () => ({ event: { sender: activeSender } })
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
          withDesktopE2eeAccount: (...args) => {
            if (bindingHeld && lossSent) lossCleanupQueued.resolve()
            return api.withDesktopE2eeAccount(...args)
          },
          runDesktopE2eeOperation: async (...args) => {
            const value = await api.runDesktopE2eeOperation(...args)
            // Signal after the native boundary's post-operation account recheck.
            if (value?.frame === 'synthetic-frame') prepared.resolve()
            return value
          },
          desktopE2eeCloudClient: async () => ({
            accountId: 'acc1',
            client: {
              contentStreamsToken: () =>
                Effect.gen(function* () {
                  asked.resolve()
                  const lost = yield* Effect.promise(() => answer.promise)
                  if (lost) {
                    lossSent = true
                    return yield* Effect.fail(new E2eeDeviceRevokedError())
                  }
                  return { token: 'synthetic-token' }
                }),
              machineSharing: () => ({}),
              history: () => Effect.fail(new Error('unused'))
            }
          })
        }
      })
      const ipc = new E2eeIpc()
      await ipc.open('workspace')
      if (scenario === 'reader-reopened' || scenario === 'renderer-replaced') {
        activeSender = Object.assign(new EventEmitter(), {
          id: 43,
          isDestroyed: () => false,
          send: () => {}
        })
        await ipc.open('workspace')
        activeSender = sender
      }
      await api.withDesktopE2eeAccount(
        (owner) =>
          Effect.sync(() => {
            if (scenario === 'loss-during-binding-read') {
              const status = owner.host.status
              let reads = 0
              owner.host.status = (workspace) =>
                Effect.gen(function* () {
                  const value = yield* status(workspace)
                  if (++reads === 2) {
                    bindingHeld = true
                    bindingEntered.resolve()
                    yield* Effect.promise(() => releaseBinding.promise)
                    bindingHeld = false
                  }
                  return value
                })
            }
            owner.host.prepareDispatch = () =>
              Effect.sync(() => {
                return { frame: 'synthetic-frame' }
              })
          }),
        'workspace',
        false
      )
      let settled = false
      const dispatch = ipc.prepareDispatch('workspace', 'machine', {
        sessionId: 'session',
        userTurnId: 'turn',
        userId: 'acc1',
        timestamp: new Date(0).toISOString(),
        inputConfig: {}
      })
      const result = dispatch
        .then(
          (value) => ({ value }),
          (error) => ({ error })
        )
        .finally(() => {
          settled = true
        })
      await asked.promise
      await prepared.promise
      if (scenario === 'closed-reader') await ipc.close('workspace')
      if (scenario === 'reader-reopened') {
        await ipc.close('workspace')
        await ipc.open('workspace')
      }
      if (scenario === 'renderer-replaced') {
        sender.emit('render-process-gone')
        await ipc.open('workspace')
      }
      if (scenario === 'credential-replaced') {
        await api.resetDesktopE2eeIdentity({ workspaceId: 'workspace', resetId: randomUUID() })
        await createAccountWorkspace(api, 'workspace')
        await ipc.open('workspace')
      }
      if (scenario === 'account-switch' || scenario === 'reauthenticated') {
        publishIdentity(scenario === 'account-switch' ? 'acc2' : 'acc1')
        await api.closeDesktopE2eeAccount()
      }
      if (scenario === 'loss-during-binding-read') {
        await run(TestClock.adjust('50 millis'))
        await bindingEntered.promise
        answer.resolve(true)
        // Queueing terminal cleanup proves the exact verdict was latched while
        // the final account lock still holds the binding read.
        await lossCleanupQueued.promise
        await run(TestClock.adjust('50 millis'))
        const refusedBeforeDrain = settled
        releaseBinding.resolve()
        const outcome = await result
        assert.equal(refusedBeforeDrain, true, 'known loss cannot wait on a stalled final read')
        await pushed.promise
        await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
        assert.equal(outcome.value, undefined, 'loss learned before frame handoff must discard it')
        assert.equal(outcome.error?.message, 'e2ee_device_revoked')
        await assert.rejects(ipc.status('workspace'), /^Error: e2ee_device_revoked$/)
      } else if (scenario === 'unreachable' || scenario === 'late-loss') {
        // The local frame is ready; network uncertainty must not impose its 30s timeout.
        await run(TestClock.adjust('49 millis'))
        assert.equal(settled, false)
        await run(TestClock.adjust('1 millis'))
        // Clock stays at 50ms and the credential response is still held.
        assert.deepEqual((await result).value, { frame: 'synthetic-frame' })
        assert.equal(settled, true)
        answer.resolve(scenario === 'late-loss')
        if (scenario === 'late-loss') {
          assert.deepEqual(await pushed.promise, {
            channel: 'e2ee.accessLost',
            payload: { workspaceId: 'workspace' }
          })
          await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
          await assert.rejects(ipc.status('workspace'), /^Error: e2ee_device_revoked$/)
        }
      } else {
        answer.resolve(scenario === 'early-loss')
        const outcome = await result
        assert.equal(outcome.value, undefined)
        assert.match(
          outcome.error?.message ?? '',
          scenario === 'early-loss'
            ? /e2ee_device_revoked/
            : /e2ee_(account_mismatch|host_operation_failed|closed)/
        )
      }
      answer.resolve(false)
      await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
    })
  }
})

void test('30ms local dispatch stays fast with an 800ms credential reply', async (t) => {
  const scope = await Effect.runPromise(Scope.make())
  const clock = await Effect.runPromise(Layer.buildWithScope(TestClock.layer(), scope))
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const run = (work) => Effect.runPromise(Effect.provide(work, clock))
  const { api, identity } = await nativeAccountFixture(t, identityStorage, clock)
  const workspaceId = `fast-${randomUUID()}`
  await createAccountWorkspace(api, workspaceId)
  const asked = Promise.withResolvers(),
    local = Promise.withResolvers(),
    credential = Promise.withResolvers()
  const sender = Object.assign(new EventEmitter(), {
    id: 44,
    isDestroyed: () => false,
    send: () => {}
  })
  let waiterSettled = false
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    '../product-window-ipc-service': { ProductWindowIpcService: class {} },
    'electron-ipc-decorator': {
      IpcMethod: () => (_t, _n, d) => d,
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
      runDesktopE2eeOperation: async (...args) => {
        const value = await api.runDesktopE2eeOperation(...args)
        if (value?.frameHex) local.resolve()
        else if (value === undefined) waiterSettled = true
        return value
      },
      desktopE2eeCloudClient: async () => ({
        accountId: 'acc1',
        client: {
          contentStreamsToken: () =>
            Effect.gen(function* () {
              asked.resolve()
              yield* Effect.sleep('800 millis')
              credential.resolve()
              return { token: 'synthetic-token' }
            }).pipe(Effect.provide(clock)),
          machineSharing: () => ({}),
          history: () => Effect.fail(new Error('unused'))
        }
      })
    }
  })
  const ipc = new E2eeIpc()
  await ipc.open(workspaceId)
  const original = {
    requestId: '0a'.repeat(16),
    frameHex: '0b'.repeat(300),
    targetMachineId: 'machine',
    requesterDevice: '0c'.repeat(32),
    expiresAt: 4_102_444_800_000
  }
  const input = {
    sessionId: 'session',
    userTurnId: 'turn',
    userId: 'acc1',
    timestamp: new Date(0).toISOString(),
    inputConfig: {}
  }
  const ack = {
    type: 'session/dispatch-turn_response',
    sessionId: input.sessionId,
    userTurnId: input.userTurnId,
    accepted: true,
    disposition: 'accepted'
  }
  await api.withDesktopE2eeAccount(
    (owner) =>
      Effect.sync(() => {
        owner.host.prepareDispatch = () => Effect.sleep('30 millis').pipe(Effect.as(original))
        owner.host.acceptDispatchResponse = () => Effect.succeed(ack)
      }),
    workspaceId,
    false
  )
  const [
    { createEncryptedDispatchLegacy },
    { dispatchUserTurn },
    { createConversationSession },
    { createSessionSendResources },
    { EncryptedPrepareTimeout },
    { LoroDoc }
  ] = await Promise.all([
    import('../../../../../packages/components/src/providers/encrypted-dispatch-legacy.ts'),
    import('../../../../../packages/components/src/lib/session-send-delivery.ts'),
    import('../../../../../packages/components/src/lib/conversation-view/create-conversation-session.ts'),
    import('../../../../../packages/components/src/lib/session-send-resources.ts'),
    import('../../../../../packages/components/src/lib/encrypted-dispatch-outcome.ts'),
    Promise.resolve(
      createRequire(new URL('../../../../../packages/components/package.json', import.meta.url))(
        'loro-crdt'
      )
    )
  ])
  const doc = new LoroDoc()
  const session = createConversationSession(doc, { sessionId: input.sessionId })
  const resources = createSessionSendResources({
    acquire: async () => ({
      sessionData: session.sessionData,
      getState: () => session.mirror.getState(),
      setState: session.mirror.setState.bind(session.mirror),
      waitUntilSynced: async () => {}
    }),
    releaseRef: () => {}
  })
  await session.sessionData.commands.appendTurn({
    id: input.userTurnId,
    role: 'user',
    userId: input.userId,
    timestamp: input.timestamp,
    status: 'pending',
    items: [{ type: 'text', text: 'synthetic fast dispatch' }],
    fileDiff: [],
    inputConfig: {
      cliType: 'builtin',
      agentType: 'codex',
      inputBlocks: [{ type: 'text', text: 'synthetic fast dispatch' }]
    }
  })
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const reports = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __LODY_E2E_CLIENT_LOSS__: true,
      ipc: { send: (_channel, payload) => reports.push(payload) }
    }
  })
  let onBatch,
    responseFulfilled = 0,
    late = 0,
    returnedAt
  const frames = []
  const readerReady = Promise.withResolvers()
  const dispatcher = createEncryptedDispatchLegacy({
    workspaceId,
    prepare: async (machine, input) => {
      const result = await ipc.prepareDispatch(workspaceId, machine, input)
      returnedAt = await run(Clock.currentTimeMillis)
      return result
    },
    accept: async (machine, input, frame) => {
      const result = await ipc.acceptDispatchResponse(workspaceId, machine, input, frame)
      responseFulfilled++
      return result
    },
    client: async () => ({
      ensureJsonStream: async () => {},
      readJsonLive: (_stream, _state, batch, options) => {
        onBatch = batch
        readerReady.resolve()
        return new Promise((resolve) => options.signal.addEventListener('abort', resolve))
      },
      appendJson: async (_stream, frame) => {
        await readerReady.promise
        frames.push(frame)
        onBatch({ messages: [{ id: frame.id, frame: '0d'.repeat(300) }] })
      }
    })
  })
  let meta = { id: input.sessionId, machineId: 'machine' }
  const activated = Promise.withResolvers()
  const runtime = {
    contentMode: 'e2ee',
    sendResources: resources,
    repo: { getDocMeta: async () => ({ meta }) },
    writer: {
      upsertDocMeta: async (_room, patch) => {
        meta = { ...meta, ...patch }
        activated.resolve()
      }
    },
    prepareEncryptedDispatch: async (machine, input) => {
      try {
        return await dispatcher.prepare(machine, input)
      } catch (error) {
        if (error instanceof EncryptedPrepareTimeout) late++
        throw error
      }
    }
  }
  // The native work uses TestClock; Node's mock timers drive the real renderer 200ms deadline.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let sending
  try {
    sending = dispatchUserTurn(runtime, input.sessionId, input.userTurnId)
    await asked.promise
    await run(TestClock.adjust('30 millis'))
    t.mock.timers.tick(30)
    await local.promise
    await run(TestClock.adjust('70 millis'))
    t.mock.timers.tick(70)
    // Flush the native account boundary without advancing either clock. Old 300ms
    // code has not settled its waiter; drive its real renderer fallback to RED.
    await api.withDesktopE2eeAccount(() => Effect.void, workspaceId, false)
    if (!waiterSettled) {
      await run(TestClock.adjust('100 millis'))
      t.mock.timers.tick(100)
      await activated.promise
    } else await sending
    assert.equal(late, 0, 'healthy send must not enter the renderer deadline fallback')
    assert.ok(returnedAt < 200, 'prepared frame must arrive before the renderer deadline')
    assert.equal(reports.at(-1)?.effects.turnStarts, 1)
    assert.equal(responseFulfilled, 1, 'real dispatchResponse boundary fulfilled')
    assert.equal(frames.length, 1)
    assert.equal(meta.latestUserMsgId, input.userTurnId, 'normal durable activation is retained')
    await run(TestClock.adjust('700 millis'))
    await credential.promise
    assert.equal(frames.length, 1, 'late successful confirmation never sends again')
  } finally {
    await run(TestClock.adjust('1 second'))
    await dispatcher.close()
    await sending
    t.mock.timers.reset()
    await resources.dispose()
    session.dispose()
    doc.free()
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else delete globalThis.window
  }
})

void test('credential-authenticated device revocation stops, drains and deletes only this device identity, and keeps its reason', async (t) => {
  const f = await personalJoinFixture(t)
  const owner = await f.open('revoked-ipc')
  await owner.create()
  const status = await owner.ipc.status(f.workspaceId)
  f.relay.deviceRevoked = true
  await assert.rejects(owner.ipc.contentStreamsToken(f.workspaceId), /^Error: e2ee_device_revoked$/)
  assert.equal(owner.readers.has(f.workspaceId), false)
  await assert.rejects(owner.ipc.status(f.workspaceId), /^Error: e2ee_device_revoked$/)
  await assert.rejects(
    owner.ipc.seal(f.workspaceId, {
      epoch: 0,
      room: { kind: 'meta' },
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'update_batch'
      },
      plaintext: new Uint8Array([1]),
      additionalData: new Uint8Array([2])
    }),
    /^Error: e2ee_device_revoked$/
  )
  assert.equal(
    f.db(
      owner,
      'creations.sqlite',
      (db) => db.prepare('SELECT count(*) AS n FROM creations').get().n
    ),
    0
  )
  await assert.rejects(readFile(join(owner.path, 'workspaces', f.workspaceId, 'history.sqlite')), {
    code: 'ENOENT'
  })
  // A later open, with a freshly constructed owner, reports the persisted reason.
  await assert.rejects(owner.ipc.open(f.workspaceId), (error) => error.code === 'device_revoked')
  assert.ok(status.signingPublicKey)
})

void test('credential-authenticated joining management uses exact-identity removal cleanup through IPC', async (t) => {
  const f = await personalJoinFixture(t)
  const actions = [
    (ipc) =>
      ipc.createMemberInvitation({
        workspaceId: f.workspaceId,
        mode: 'email',
        email: 'synthetic@example.test'
      }),
    (ipc) => ipc.memberJoinRequests(f.workspaceId),
    (ipc) => ipc.approveMemberJoin(f.workspaceId, '11'.repeat(16), 'explicit'),
    (ipc) => ipc.rejectMemberJoin(f.workspaceId, '11'.repeat(16)),
    (ipc) => ipc.revokeMemberInvitation(f.workspaceId, '22'.repeat(32))
  ]
  for (const [index, invoke] of actions.entries()) {
    const owner = await f.open(`removed-join-${index}`)
    await owner.create()
    const before = await owner.ipc.status(f.workspaceId)
    await assert.rejects(invoke(owner.ipc), /^Error: e2ee_member_removed$/)
    assert.equal(await Effect.runPromise(owner.bootstrap.hasRemovedWorkspace(f.workspaceId)), true)
    assert.equal(owner.readers.has(f.workspaceId), false)
    assert.equal(
      f.db(
        owner,
        'creations.sqlite',
        (db) => db.prepare('SELECT COUNT(*) AS count FROM workspace_bindings').get().count
      ),
      0
    )
    await assert.rejects(
      readFile(join(owner.path, 'workspaces', f.workspaceId, 'history.sqlite')),
      { code: 'ENOENT' }
    )
    assert.ok(before.signingPublicKey)
  }
})

void test('automatic removal retries the exclusive native identity lease and preserves a sibling workspace', async (t) => {
  const { api } = await nativeAccountFixture(t)
  const first = await createAccountWorkspace(api, 'removed')
  await createAccountWorkspace(api, 'sibling')
  const scope = await Effect.runPromise(Scope.make())
  await Effect.runPromise(
    identityStorage.leaseE2eeIdentity(first.directory).pipe(Scope.provide(scope))
  )
  const drain = await api.withDesktopE2eeAccount(
    (owner) =>
      Effect.gen(function* () {
        const status = yield* owner.host.status('removed')
        const credential = yield* owner.bootstrap.deviceCredential('removed')
        yield* owner.bootstrap.recordRemovedWorkspace({
          workspaceId: 'removed',
          genesisHash: status.genesisHash,
          signingPublicKey: status.signingPublicKey,
          credential
        })
        return yield* owner.host.beginCloseWorkspace('removed')
      }),
    'removed'
  )
  await Effect.runPromise(drain)
  await assert.rejects(
    api.cleanupRemovedDesktopWorkspace({ accountId: 'acc1', workspaceId: 'removed' }),
    /e2ee_identity-busy/
  )
  const original = join(
    first.directory,
    'custody',
    first.creation.genesisHashHex + '.personal.device'
  )
  assert.ok((await readFile(original)).length > 0)
  await Effect.runPromise(Scope.close(scope, Exit.void))
  assert.equal(
    await api.cleanupRemovedDesktopWorkspace({ accountId: 'acc1', workspaceId: 'removed' }),
    true
  )
  await assert.rejects(readFile(original), (error) => error.code === 'ENOENT')
  const status = await api.withDesktopE2eeAccount(
    (owner) => owner.host.status('sibling'),
    'sibling'
  )
  assert.equal(status.epoch, 0)
  await assert.rejects(
    api.withDesktopE2eeAccount((owner) => owner.host.open('removed'), 'removed'),
    /e2ee_member_removed/
  )
})

void test('slow terminal deletion fences only that workspace and never holds the account lock', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  let hold = true
  const storage = {
    ...identityStorage,
    leaseE2eeIdentity: (directory, exclusive) =>
      Effect.gen(function* () {
        yield* identityStorage.leaseE2eeIdentity(directory, exclusive)
        if (exclusive && directory.endsWith('/removed') && hold) {
          entered.resolve()
          yield* Effect.promise(() => release.promise)
        }
      })
  }
  const { api } = await nativeAccountFixture(t, storage)
  await createAccountWorkspace(api, 'removed')
  await createAccountWorkspace(api, 'sibling')
  const drain = await api.withDesktopE2eeAccount(
    (owner) =>
      Effect.gen(function* () {
        const status = yield* owner.host.status('removed')
        const credential = yield* owner.bootstrap.deviceCredential('removed')
        yield* owner.bootstrap.recordRemovedWorkspace({
          workspaceId: 'removed',
          genesisHash: status.genesisHash,
          signingPublicKey: status.signingPublicKey,
          credential
        })
        return yield* owner.host.beginCloseWorkspace('removed')
      }),
    'removed'
  )
  await Effect.runPromise(drain)
  const removal = api.cleanupRemovedDesktopWorkspace({
    accountId: 'acc1',
    workspaceId: 'removed'
  })
  try {
    await entered.promise
    assert.equal(
      (await api.withDesktopE2eeAccount((owner) => owner.host.status('sibling'), 'sibling')).epoch,
      0
    )
    await assert.rejects(
      api.withDesktopE2eeAccount(() => Effect.void, 'removed'),
      /e2ee_member_removed/
    )
  } finally {
    hold = false
    release.resolve()
    await removal
  }
})

void test('remote commands use workspace custody and never create an account control identity', async (t) => {
  const { api, directory } = await nativeAccountFixture(t)
  const first = await createAccountWorkspace(api, 'first')
  const second = await createAccountWorkspace(api, 'second')
  const sender = Object.assign(new EventEmitter(), {
    id: 19,
    isDestroyed: () => false,
    send: () => {}
  })
  const sessions = new Map()
  const { E2eeIpc } = await load(
    '../ipc/services/e2ee-ipc.ts',
    {
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
            machineBegin: ({ workspaceId, offer }) =>
              Effect.sync(() => {
                sessions.set(workspaceId, {
                  pairingSessionId: offer.pairingSessionId,
                  status: 'pending',
                  offer
                })
                return sessions.get(workspaceId)
              }),
            machineInspect: ({ workspaceId }) => Effect.succeed(sessions.get(workspaceId)),
            machineCancel: ({ workspaceId }) =>
              Effect.sync(() => {
                const next = {
                  ...sessions.get(workspaceId),
                  status: 'cancelled',
                  noAdmissionReserved: true
                }
                sessions.set(workspaceId, next)
                return next
              })
          }
        })
      },
      '../assert-sender': { assertProductWindowSender: () => {} }
    },
    globalThis.console,
    {
      VITE_CONVEX_DEPLOY_URL: 'https://cloud.synthetic.test',
      VITE_SERVER_URL: 'https://edge.synthetic.test'
    }
  )
  const ipc = new E2eeIpc()
  const { ipcBridge } = await load('../../preload/ipc-bridge.ts', {
    electron: {
      ipcRenderer: {
        on: () => {},
        invoke: (channel, ...args) => ipc[channel.split('.')[1]](...args)
      }
    },
    './ipc-invoke-policy': { isIpcInvokeChannel, isClientLossProbeChannel: () => false },
    '@lody/shared/electron-ipc': electronIpc
  })
  for (const [workspaceId, expected] of [
    ['first', first],
    ['second', second]
  ]) {
    await ipcBridge.invoke('e2ee.open', workspaceId)
    const started = await ipcBridge.invoke('e2ee.beginRemoteMachinePairing', workspaceId)
    const offer = JSON.parse(
      Buffer.from(started.command.split(' --offer ')[1], 'base64url').toString()
    )
    assert.equal(offer.frontendSigningPublicKey, expected.signingPublicKey)
    assert.equal(offer.genesisHash, expected.creation.genesisHashHex)
    await assert.rejects(
      ipcBridge.invoke(
        'e2ee.approveRemoteMachinePairing',
        workspaceId,
        offer.pairingSessionId,
        Array(8).fill('00000000').join(' ')
      ),
      /e2ee_conflict/
    )
    assert.equal(
      (await ipcBridge.invoke('e2ee.beginRemoteMachinePairing', workspaceId)).command,
      started.command
    )
    assert.equal(
      (
        await ipcBridge.invoke(
          'e2ee.inspectRemoteMachinePairing',
          workspaceId,
          offer.pairingSessionId
        )
      ).status,
      'pending'
    )
    assert.equal(
      (
        await ipcBridge.invoke(
          'e2ee.cancelRemoteMachinePairing',
          workspaceId,
          offer.pairingSessionId
        )
      ).status,
      'cancelled'
    )
    const next = await ipcBridge.invoke('e2ee.beginRemoteMachinePairing', workspaceId)
    assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
    assert.equal(
      (await ipcBridge.invoke('e2ee.status', workspaceId)).genesisHash,
      expected.creation.genesisHashHex
    )
    await ipcBridge.invoke('e2ee.close', workspaceId)
  }
  assert.notEqual(first.signingPublicKey, second.signingPublicKey)
  const roots = await readdir(join(directory, 'e2ee-bootstrap'))
  assert.ok(!(await readdir(join(directory, 'e2ee-bootstrap', roots[0]))).includes('control'))
})

async function memberIpcFixture(options = {}) {
  const identity = { userId: 'A', generation: 1 }
  const signed = [],
    closed = []
  const cloudEntered = deferredMember(),
    cloudGate = deferredMember(),
    keyEntered = deferredMember(),
    keyGate = deferredMember()
  let holdCloud = false
  let trusted = true
  const makeOwner = (accountId, label) => ({
    accountId,
    label,
    readers: new Map([['team', new Map([[1, 1]])]]),
    bootstrap: {
      deviceCredential: () => Effect.succeed('credential'),
      acceptMemberJoin: () => Effect.void,
      // No locally accepted join: every claim asks the relay first.
      acceptedMemberJoin: () => Effect.succeed(null),
      ...options.bootstrap
    },
    host: {
      inspectCachedState: (workspaceId, machineId) =>
        Effect.succeed({
          workspaceId,
          machineId,
          entryPresent: false,
          cachedPolicies: 0,
          cachedExecutionGrants: 0
        }),
      memberOffer: () =>
        Effect.sync(() => {
          signed.push(label)
          return { workspaceId: 'team', genesisHash: '11'.repeat(32), mode: 'link' }
        }),
      pendingClose: () => Effect.succeed(undefined),
      open: () => Effect.succeed({ hasCurrentKey: true }),
      ingestLedgerRecords: () => Effect.void,
      status: () => Effect.succeed({ hasCurrentKey: true }),
      keyRound: () =>
        Effect.promise(async () => {
          keyEntered.resolve()
          await keyGate.promise
        }),
      // A joining member's claim installs through the receive-only round.
      receiveKeys: () =>
        Effect.promise(async () => {
          keyEntered.resolve()
          await keyGate.promise
        }),
      beginCloseWorkspace: () =>
        Effect.sync(() => {
          closed.push(label)
          return Effect.void
        }),
      ...options.host
    }
  })
  // Delivery runs a distribute-only round; the synthetic host answers it like keyRound.
  const withDistribution = (owner) => {
    owner.host.distributeKeys ??= (...args) => owner.host.keyRound(...args)
    return owner
  }
  let current = withDistribution(makeOwner('A', 'original-A'))
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    send: () => {}
  })
  const cloud = {
    accountId: 'A',
    client: {
      memberClaim: () =>
        Effect.succeed({
          accountId: 'A',
          workspaceId: 'team',
          requestId: 'request',
          state: 'committed'
        }),
      appendRecord: () => Effect.void,
      ...options.client
    }
  }
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    effect: { Effect },
    '../product-window-ipc-service': { ProductWindowIpcService: class {} },
    'electron-ipc-decorator': {
      IpcMethod: () => (_t, _n, d) => d,
      getIpcContext: () => ({ event: { sender } })
    },
    '../../platform': { isLocalPlatform: () => false },
    '../assert-sender': {
      assertProductWindowSender: () => {
        if (!trusted) throw new Error('untrusted sender')
      }
    },
    '../ipc-service-deps': {
      getIpcServiceDeps: () => ({
        authService: { getCachedSessionIdentity: () => ({ ...identity }) }
      })
    },
    '../../services/e2ee-bootstrap.mjs': {},
    '../../services/e2ee-account-runtime': {
      inspectDesktopE2eeCachedState: async (accountId, workspaceId, machineId) => {
        if (current.accountId !== accountId) throw new Error('e2ee_account_mismatch')
        return {
          ...(await Effect.runPromise(current.host.inspectCachedState(workspaceId, machineId))),
          accountId,
          ownerPresent: true,
          activeContentReaders: [...(current.readers.get(workspaceId)?.values() ?? [])].reduce(
            (sum, n) => sum + n,
            0
          )
        }
      },
      withDesktopE2eeAccount: async (work) => Effect.runPromise(work(current)),
      desktopE2eeCloudClient: async () => {
        cloudEntered.resolve()
        if (holdCloud) await cloudGate.promise
        return cloud
      },
      releaseDesktopE2eeReader: () => {},
      // Only errors the real boundary projected carry a public loss; none here.
      publicAccessLoss: () => null,
      runDesktopE2eeOperation: async (accountId, work) => {
        if (identity.userId !== accountId) throw new Error('e2ee_account_mismatch')
        const result = await Effect.runPromise(work).catch((error) => {
          throw options.projectFailure ? options.projectFailure(error) : error
        })
        if (identity.userId !== accountId) throw new Error('e2ee_account_mismatch')
        return result
      }
    },
    ...options.deps
  })
  const ipc = new E2eeIpc()
  ipc.permissionHistory = async () => []
  if (!options.realRefresh) ipc.refresh = async () => {}
  return {
    ipc,
    identity,
    signed,
    closed,
    cloudEntered,
    cloudGate,
    keyEntered,
    keyGate,
    makeOwner: (...args) => withDistribution(makeOwner(...args)),
    setTrusted(value) {
      trusted = value
    },
    setOwner(owner) {
      current = owner
    },
    owner() {
      return current
    },
    holdCloud() {
      holdCloud = true
    }
  }
}
function deferredMember() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
void test('member invitation retains its original native namespace across a delayed cloud call', async () => {
  const f = await memberIpcFixture()
  f.holdCloud()
  const operation = f.ipc.createMemberInvitation({ workspaceId: 'team', mode: 'link' })
  const rejected = assert.rejects(operation, /e2ee_account_mismatch/)
  await f.cloudEntered.promise
  f.setOwner(f.makeOwner('A', 'replacement-A'))
  f.cloudGate.resolve()
  await rejected
  assert.deepEqual(f.signed, [])
})
for (const sameAccount of [true, false])
  void test(`late member installation cannot read or release a replacement namespace (same account: ${sameAccount})`, async () => {
    const f = await memberIpcFixture()
    const operation = f.ipc.claimMemberJoin('team', 'request')
    const rejected = assert.rejects(operation, /e2ee_account_mismatch/)
    await f.keyEntered.promise
    if (!sameAccount) {
      f.identity.userId = 'B'
      f.identity.generation++
    }
    const replacement = f.makeOwner(f.identity.userId, 'replacement')
    f.setOwner(replacement)
    f.keyGate.resolve()
    await rejected
    assert.equal(replacement.readers.get('team').get(1), 1)
    assert.deepEqual(f.closed, [])
  })
void test('a background reader closes only the namespace returned by its own open', async () => {
  const f = await memberIpcFixture()
  const opened = await f.ipc.open('team', undefined, 'A')
  const replacement = f.makeOwner('A', 'replacement')
  f.setOwner(replacement)
  await f.ipc.close('team', 'A', opened.readerOwner)
  assert.equal(replacement.readers.get('team').get(1), 1)
  assert.deepEqual(f.closed, [])
  f.identity.userId = 'B'
  f.identity.generation++
  await assert.rejects(f.ipc.open('team', undefined, 'A'), /e2ee_account_mismatch/)
})

const approvalRequest = '55'.repeat(16)
// IPC results come from the service's separate VM realm.
const plain = (value) => JSON.parse(JSON.stringify(value))
const approvalDevice = '77'.repeat(32)
const personalApprovalRequest = 'personal-device-12345678-1234-1234-1234-123456789abc'
/** Real personal approval IPC over a controlled cloud and native-host boundary. */
async function personalApprovalFixture({
  confirmed = true,
  publish = true,
  publication,
  invitationGate,
  invitationGates,
  prepareGate,
  local = { hasCurrentKey: true },
  receive,
  distribution,
  appendReceiptLost = false
} = {}) {
  const session = '44'.repeat(16)
  let committed = false
  let ingested = false
  let published = false
  let publicationAttempted = false
  const writes = new Map()
  const f = await memberIpcFixture({
    realRefresh: true,
    client: {
      joinReadRequest: () => Effect.succeed({ requestHex: 'abcd', status: 'pending' }),
      appendRecord: (pending) =>
        Effect.sync(() => {
          const original = writes.get(pending.requestId)
          if (original) assert.deepEqual(plain(pending), original)
          else writes.set(pending.requestId, plain(pending))
          committed = true
          if (appendReceiptLost) throw new Error('synthetic append response lost')
        }),
      history: () =>
        Effect.succeed({ checkpoint: {}, nextCursor: null, admission: committed && confirmed }),
      joinPublish: () =>
        Effect.promise(async () => {
          assert.equal(ingested, true, 'only a locally verified admission may publish')
          publicationAttempted = true
          publication?.entered.resolve()
          if (publication) await publication.release.promise
          if (!publish) throw new Error('synthetic publication unavailable')
          published = true
        })
    },
    host: {
      previewPersonalAdmission: () =>
        Effect.succeed({ pairingSessionId: session, signingPublicKey: approvalDevice }),
      preparePersonalAdmission: () =>
        Effect.promise(async () => {
          if (prepareGate) {
            prepareGate.entered.resolve()
            await prepareGate.release.promise
          }
          return { requestId: personalApprovalRequest, recordHex: 'ab' }
        }),
      ingestLedgerRecords: (_workspace, page) =>
        Effect.sync(() => {
          if (page.admission) ingested = true
        }),
      personalInvitation: (workspaceId) =>
        Effect.promise(async () => {
          if (!ingested) throw new Error('e2ee_local-evidence-conflict')
          const gate =
            invitationGates?.get(workspaceId) ??
            (workspaceId === 'team' ? invitationGate : undefined)
          if (gate) {
            gate.entered.resolve()
            await gate.release.promise
          }
          return { invitationHex: 'cafe' }
        }),
      status: () => Effect.succeed({ hasCurrentKey: local.hasCurrentKey }),
      ...(receive ? { receiveKeys: receive } : {}),
      ...(distribution ? { distributeKeys: distribution } : {}),
      keyDeliveryTarget: (_workspace, device) =>
        Effect.succeed(ingested && device === approvalDevice),
      keyDeliveryEvidence: () => Effect.succeed('delivered'),
      ...(!confirmed ? { keyRound: () => Effect.void } : {})
    }
  })
  return {
    ...f,
    session,
    published: () => published,
    publicationAttempted: () => publicationAttempted,
    committed: () => committed,
    writes
  }
}
for (const publish of [true, false])
  void test(`personal approval publishes before a blocked key round; publication succeeds: ${publish}`, async () => {
    const f = await personalApprovalFixture({ publish })
    const approval = f.ipc.approvePersonalJoin('team', f.session)
    try {
      await f.keyEntered.promise
      // The old full-refresh sequence reaches this gate before it can publish.
      assert.equal(f.publicationAttempted(), true)
      assert.equal(f.published(), publish)
      assert.deepEqual(plain(await approval), { admitted: true, invitationPublished: publish })
      assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivering')
      // Closing the approving window cannot abandon a committed device's delivery.
      f.owner().readers.get('team').delete(1)
      assert.deepEqual(f.closed, [])
    } finally {
      f.keyGate.resolve()
      await approval.catch(() => {})
      await f.ipc.keyDeliveryIdle('A', 'team')
    }
    assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivered')
    assert.deepEqual(f.closed, ['original-A'])
  })
void test('personal approval cannot publish or start delivery before ledger confirmation', async () => {
  const f = await personalApprovalFixture({ confirmed: false })
  try {
    await assert.rejects(f.ipc.approvePersonalJoin('team', f.session), /e2ee_append_unconfirmed/)
    assert.equal(f.published(), false)
    assert.equal(keyDeliveryState(f, personalApprovalRequest), null)
  } finally {
    f.keyGate.resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
  }
})
void test('a late personal invitation publication cannot restart delivery after workspace reset', async () => {
  const publication = { entered: deferredMember(), release: deferredMember() }
  const f = await personalApprovalFixture({ publication })
  const approval = f.ipc.approvePersonalJoin('team', f.session)
  let delivery
  try {
    await publication.entered.promise
    await f.keyEntered.promise
    delivery = f.ipc.keyDeliveryIdle('A', 'team')
    await f.ipc
      .resetIdentity({ workspaceId: 'team', resetId: randomUUID(), confirm: true })
      .catch(() => {})
    f.keyGate.resolve()
    await delivery
    publication.release.resolve()
    await assert.rejects(approval, /e2ee_account_mismatch/)
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
  } finally {
    f.keyGate.resolve()
    publication.release.resolve()
    await approval.catch(() => {})
    await delivery
  }
})
for (const change of [
  'workspace-reset',
  'account-reset',
  'same-account-login',
  'signed-out',
  'different-account',
  'same-account-owner'
])
  void test(`pending personal invitation is invalidated by ${change} before delivery registration`, async () => {
    const invitationGate = { entered: deferredMember(), release: deferredMember() }
    const f = await personalApprovalFixture({ invitationGate })
    const approval = f.ipc.approvePersonalJoin('team', f.session)
    const outcome = approval.then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    try {
      await invitationGate.entered.promise
      if (change.endsWith('reset')) {
        await f.ipc
          .resetIdentity({
            ...(change === 'workspace-reset' ? { workspaceId: 'team' } : {}),
            resetId: randomUUID(),
            confirm: true
          })
          .catch(() => {})
      } else if (change === 'same-account-owner') {
        f.setOwner(f.makeOwner('A', 'replacement-A'))
      } else {
        f.identity.userId = undefined
        f.identity.generation += 1
        f.identity.userId =
          change === 'signed-out' ? undefined : change === 'different-account' ? 'B' : 'A'
        f.identity.generation += 1
      }
      invitationGate.release.resolve()
      const result = await outcome
      assert.ok(result.error, 'the old approval cannot authorize work under a later identity')
      assert.equal(f.published(), false)
      assert.equal(f.committed(), true)
      assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
      assert.equal(f.ipc.personalApprovals.size, 0)
    } finally {
      invitationGate.release.resolve()
      f.keyGate.resolve()
      await outcome
      await f.ipc.keyDeliveryIdle('A', 'team')
    }
  })
for (const resetScope of ['workspace', 'account'])
  void test(`${resetScope} reset fences the correct concurrent personal approvals`, async () => {
    const team = { entered: deferredMember(), release: deferredMember() }
    const other = { entered: deferredMember(), release: deferredMember() }
    const f = await personalApprovalFixture({
      invitationGates: new Map([
        ['team', team],
        ['other', other]
      ])
    })
    f.owner().readers.set('other', new Map([[1, 1]]))
    const first = f.ipc.approvePersonalJoin('team', f.session).then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    let second
    try {
      await team.entered.promise
      second = f.ipc.approvePersonalJoin('other', f.session).then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      await other.entered.promise
      await f.ipc
        .resetIdentity({
          ...(resetScope === 'workspace' ? { workspaceId: 'team' } : {}),
          resetId: randomUUID(),
          confirm: true
        })
        .catch(() => {})
      other.release.resolve()
      const result = await second
      team.release.resolve()
      assert.ok((await first).error)
      assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
      if (resetScope === 'account') {
        assert.ok(result.error)
        assert.equal(f.ipc.keyDelivery.slots.has('A\nother'), false)
      } else {
        assert.deepEqual(plain(result.value), { admitted: true, invitationPublished: true })
        await f.keyEntered.promise
        f.keyGate.resolve()
        await f.ipc.keyDeliveryIdle('A', 'other')
        assert.equal(
          f.ipc.keyDelivery.slots.get('A\nother').requests.get(personalApprovalRequest).state,
          'delivered'
        )
      }
      assert.equal(f.ipc.personalApprovals.size, 0)
    } finally {
      team.release.resolve()
      other.release.resolve()
      f.keyGate.resolve()
      await first
      await second
      await f.ipc.keyDeliveryIdle('A', 'other')
    }
  })
void test('a control-only personal approver receives its missing current key before distributing without blocking admission', async () => {
  const local = { hasCurrentKey: false }
  const received = deferredMember(),
    release = deferredMember()
  let receiving = false
  const f = await personalApprovalFixture({
    local,
    receive: () =>
      Effect.promise(async () => {
        receiving = true
        received.resolve()
        await release.promise
        local.hasCurrentKey = true
      }),
    distribution: () => Effect.sync(() => assert.equal(local.hasCurrentKey, true))
  })
  try {
    assert.deepEqual(plain(await f.ipc.approvePersonalJoin('team', f.session)), {
      admitted: true,
      invitationPublished: true
    })
    await Promise.race([received.promise, f.ipc.keyDeliveryIdle('A', 'team')])
    assert.equal(receiving, true)
    assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivering')
  } finally {
    release.resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
  }
  assert.equal(local.hasCurrentKey, true)
  assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivered')
})
void test('personal key failures keep admission, exhaust bounded backoff, and accept the original personal-device retry id', async () => {
  const local = { hasCurrentKey: false }
  let outage = true,
    now = 1_800_000_000_000
  const f = await personalApprovalFixture({
    local,
    receive: () =>
      Effect.suspend(() => {
        if (outage) return Effect.fail(new Error('e2ee_management_retry'))
        local.hasCurrentKey = true
        return Effect.void
      }),
    distribution: () => Effect.sync(() => assert.equal(local.hasCurrentKey, true))
  })
  const clock = fakeKeyDeliveryTimers()
  f.ipc.keyDeliveryTimers = clock.timers
  f.ipc.keyDeliveryNow = () => now
  assert.deepEqual(plain(await f.ipc.approvePersonalJoin('team', f.session)), {
    admitted: true,
    invitationPublished: true
  })
  for (let retry = 0; retry <= 8; retry++) {
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'failed')
    assert.equal(f.committed(), true)
    if (retry === 8) {
      assert.deepEqual(clock.pending, [])
      break
    }
    const timer = clock.pending.shift()
    assert.equal(timer.ms, KEY_DELIVERY_RETRY_DELAYS[retry])
    now += timer.ms
    timer.run()
  }
  outage = false
  const retried = plain(await f.ipc.retryMemberKeyDelivery('team', personalApprovalRequest))
  assert.equal(retried.requestId, personalApprovalRequest)
  await f.ipc.keyDeliveryIdle('A', 'team')
  assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivered')
  assert.equal(local.hasCurrentKey, true)
  assert.deepEqual(clock.pending, [])
})
for (const Terminal of [E2eeDeviceRevokedError, E2eeMemberRemovedError])
  void test(`personal delivery ends without retry when local key receipt reports ${Terminal.name}`, async () => {
    const f = await personalApprovalFixture({
      local: { hasCurrentKey: false },
      receive: () => Effect.fail(new Terminal()),
      distribution: () => Effect.die(new Error('must not distribute after terminal access loss'))
    })
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    assert.deepEqual(plain(await f.ipc.approvePersonalJoin('team', f.session)), {
      admitted: true,
      invitationPublished: true
    })
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
    assert.equal(f.committed(), true)
    assert.deepEqual(clock.pending, [])
  })
void test('main retries a personal delivery after an outage and installs the local key without a page or poll', async () => {
  const local = { hasCurrentKey: false }
  let outage = true
  const f = await personalApprovalFixture({
    local,
    receive: () =>
      Effect.suspend(() => {
        if (outage) return Effect.fail(new Error('e2ee_management_retry'))
        local.hasCurrentKey = true
        return Effect.void
      }),
    distribution: () => Effect.sync(() => assert.equal(local.hasCurrentKey, true))
  })
  const clock = fakeKeyDeliveryTimers()
  f.ipc.keyDeliveryTimers = clock.timers
  f.ipc.keyDeliveryNow = () => 1_800_000_000_000
  await f.ipc.approvePersonalJoin('team', f.session)
  await f.ipc.keyDeliveryIdle('A', 'team')
  assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'failed')
  outage = false
  clock.pending.shift().run()
  await f.ipc.keyDeliveryIdle('A', 'team')
  assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivered')
  assert.equal(local.hasCurrentKey, true)
  assert.deepEqual(clock.pending, [])
})
void test('personal approval reconciles an unknown append result and retries publication with the same admission original', async () => {
  const f = await personalApprovalFixture({ appendReceiptLost: true, publish: false })
  try {
    const expected = { admitted: true, invitationPublished: false }
    assert.deepEqual(plain(await f.ipc.approvePersonalJoin('team', f.session)), expected)
    assert.deepEqual(plain(await f.ipc.approvePersonalJoin('team', f.session)), expected)
    assert.equal(f.committed(), true)
    assert.deepEqual(
      [...f.writes],
      [[personalApprovalRequest, { requestId: personalApprovalRequest, recordHex: 'ab' }]]
    )
  } finally {
    f.keyGate.resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
  }
})
void test('reset while native admission preparation is pending prevents any later cloud append', async () => {
  const prepareGate = { entered: deferredMember(), release: deferredMember() }
  const f = await personalApprovalFixture({ prepareGate })
  const approval = f.ipc.approvePersonalJoin('team', f.session)
  const outcome = approval.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  try {
    await prepareGate.entered.promise
    await f.ipc
      .resetIdentity({ workspaceId: 'team', resetId: randomUUID(), confirm: true })
      .catch(() => {})
    prepareGate.release.resolve()
    assert.ok((await outcome).error)
    assert.equal(f.committed(), false)
    assert.equal(f.writes.size, 0)
    assert.equal(f.published(), false)
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
  } finally {
    prepareGate.release.resolve()
    f.keyGate.resolve()
    await outcome
    await f.ipc.keyDeliveryIdle('A', 'team')
  }
})
void test('a personal delivery retry cannot cross a same-account logout and login generation', async () => {
  let outage = true
  const delivered = []
  const f = await personalApprovalFixture({
    distribution: () =>
      Effect.sync(() => {
        if (outage) throw new Error('e2ee_management_retry')
        delivered.push(f.identity.generation)
      })
  })
  const clock = fakeKeyDeliveryTimers()
  f.ipc.keyDeliveryTimers = clock.timers
  await f.ipc.approvePersonalJoin('team', f.session)
  await f.ipc.keyDeliveryIdle('A', 'team')
  assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'failed')
  f.identity.userId = undefined
  f.identity.generation++
  f.identity.userId = 'A'
  f.identity.generation++
  outage = false
  clock.pending.shift().run()
  await f.ipc.keyDeliveryIdle('A', 'team')
  assert.deepEqual(delivered, [])
  assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
  assert.deepEqual(clock.pending, [])
})
void test('a personal delivery registered before publication retires after same-account re-login', async () => {
  const publication = { entered: deferredMember(), release: deferredMember() }
  const f = await personalApprovalFixture({ publication })
  const approval = f.ipc.approvePersonalJoin('team', f.session).then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  let delivery
  try {
    await publication.entered.promise
    await f.keyEntered.promise
    delivery = f.ipc.keyDeliveryIdle('A', 'team')
    f.identity.userId = undefined
    f.identity.generation++
    f.identity.userId = 'A'
    f.identity.generation++
    publication.release.resolve()
    assert.ok((await approval).error)
    f.keyGate.resolve()
    await delivery
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
  } finally {
    publication.release.resolve()
    f.keyGate.resolve()
    await approval
    await delivery
  }
})
/** Mirrors runDesktopE2eeOperation's public projection: only top-level typed access loss
 * and allow-listed codes survive; nested key-round causes become a generic failure. */
const projectNativeFailure = (error) =>
  error instanceof E2eeMemberRemovedError
    ? new Error('e2ee_member_removed')
    : error instanceof E2eeDeviceRevokedError
      ? new Error('e2ee_device_revoked')
      : error?.code === 'restart-required'
        ? new Error('e2ee_restart-required: Restart Lody to finish releasing encrypted resources.')
        : typeof error?.code === 'string'
          ? new Error(`e2ee_${error.code}`)
          : error instanceof Error && /^e2ee_/.test(error.message)
            ? error
            : new Error('e2ee_host_operation_failed')
/** Real approval, ledger refresh and delivery paths over a synthetic relay and host.
 * `ledger` controls whether relay history carries the admission; the local verified
 * ledger makes the device a target only after ingesting it, like KeyDistributor. */
async function memberApprovalFixture(keyRound, ledger = { relayHasAdmission: true }) {
  let committed = false
  let ingested = false
  return memberIpcFixture({
    realRefresh: true,
    projectFailure: projectNativeFailure,
    deps: {
      '../../services/e2ee-member-join.mjs': {
        MemberOfferSchema: memberJoining.MemberOfferSchema,
        decodeMemberKeyPackage: () => ({
          request: { signingPublicKey: { toBytes: () => Buffer.from(approvalDevice, 'hex') } }
        })
      }
    },
    client: {
      memberRead: ({ requestId }) =>
        Effect.succeed({
          workspaceId: 'team',
          requestId,
          source: 'email',
          keyPackageHex: 'abcd',
          signingPublicKey: approvalDevice,
          state: committed ? 'committed' : 'pending'
        }),
      appendRecord: () =>
        Effect.sync(() => {
          committed = true
        }),
      history: () =>
        ledger.historyFails
          ? Effect.fail(new Error('synthetic relay history unavailable'))
          : Effect.succeed({
              checkpoint: {},
              nextCursor: null,
              admission: ledger.relayHasAdmission
            }),
      memberPending: () =>
        Effect.succeed({ invitations: [], items: [], hasMore: false, seatPreview: null })
    },
    host: {
      prepareMemberAdmission: () => Effect.succeed({ workspaceId: 'team', recordHex: 'ab' }),
      ingestLedgerRecords: (_workspace, page) =>
        Effect.sync(() => {
          if (page.admission) ingested = true
        }),
      keyDeliveryTarget: (_workspace, device) =>
        Effect.sync(() => ingested && device === approvalDevice),
      // Positive evidence of a stored envelope; `ledger.evidence` can withhold it.
      keyDeliveryEvidence: (_workspace, device) =>
        Effect.sync(() =>
          !ingested || device !== approvalDevice
            ? 'e2ee_admission_not_ingested'
            : (ledger.evidence?.() ?? 'delivered')
        ),
      ...(keyRound ? { keyRound } : {})
    }
  })
}
void test(
  'an admin sees a committed member admitted before key delivery ends; main finishes delivery after the window closes',
  { timeout: 5000 },
  async () => {
    // keyRound never settles until keyGate opens: the approval must not wait for it.
    const f = await memberApprovalFixture()
    const approved = await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    assert.deepEqual(plain(approved), {
      admitted: true,
      keyPending: true,
      keyDelivery: 'delivering'
    })
    await f.keyEntered.promise
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivering' }
    ])
    // The only renderer window goes away while the key round is still running.
    f.owner().readers.get('team').delete(1)
    assert.deepEqual(f.closed, [])
    f.keyGate.resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
    // Main's own reader kept the workspace open, then released it after delivery.
    assert.deepEqual(f.closed, ['original-A'])
    f.owner().readers.set('team', new Map([[1, 1]]))
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
  }
)
const fakeKeyDeliveryTimers = () => {
  const pending = []
  return {
    pending,
    timers: {
      set: (run, ms) => {
        const timer = { run, ms }
        pending.push(timer)
        return timer
      },
      clear: (timer) => {
        const index = pending.indexOf(timer)
        if (index >= 0) pending.splice(index, 1)
      }
    }
  }
}
const keyDeliveryState = (f, requestId) =>
  plain(f.ipc.keyDelivery.slots.get('A\nteam')?.requests.get(requestId) ?? null)
void test(
  'an account-pairing key delivery that fails is retried by main on its own due timer until delivered, with no page, poll or explicit retry',
  { timeout: 5000 },
  async () => {
    const outcomes = [Effect.fail(new Error('e2ee_management_retry')), Effect.void]
    const f = await memberApprovalFixture(() => outcomes.shift() ?? Effect.die('unexpected round'))
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    const requestId = `account-device-${randomUUID()}`
    // What the account-pairing host calls once the admission commits.
    f.ipc.trackKeyDelivery('A', 'team', requestId, approvalDevice)
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(keyDeliveryState(f, requestId).state, 'failed')
    // Main scheduled the next round at the failure's backoff.
    assert.deepEqual(
      clock.pending.map((timer) => timer.ms),
      [KEY_DELIVERY_RETRY_DELAYS[0]]
    )
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    clock.pending.shift().run()
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(keyDeliveryState(f, requestId).state, 'delivered')
    assert.equal(outcomes.length, 0)
    assert.deepEqual(clock.pending, [])
  }
)
void test(
  'a new device waiting for its key gets the first desktop delivery retry 500 ms after a failed delivery',
  { timeout: 5000 },
  async () => {
    // A transient refusal right after approval must not hold the requester back for the
    // long tail of the backoff: the first retry follows the shared fast schedule.
    const f = await memberApprovalFixture(() => Effect.fail(new Error('e2ee_management_retry')))
    f.ipc.keyDeliveryNow = () => 1_000
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    const requestId = `account-device-${randomUUID()}`
    f.ipc.trackKeyDelivery('A', 'team', requestId, approvalDevice)
    await f.ipc.keyDeliveryIdle('A', 'team')
    const failed = keyDeliveryState(f, requestId)
    assert.equal(failed.state, 'failed')
    assert.equal(failed.retryAt, 1_500)
    assert.deepEqual(
      clock.pending.map((timer) => timer.ms),
      [500]
    )
  }
)
void test(
  'the main-owned key delivery timer is bounded and ends when the signed-in account changes',
  { timeout: 5000 },
  async () => {
    let rounds = 0
    const f = await memberApprovalFixture(() =>
      Effect.suspend(() => {
        rounds += 1
        return Effect.fail(new Error('e2ee_management_retry'))
      })
    )
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    const requestId = `account-device-${randomUUID()}`
    f.ipc.trackKeyDelivery('A', 'team', requestId, approvalDevice)
    await f.ipc.keyDeliveryIdle('A', 'team')
    for (let retry = 0; retry < 8; retry++) {
      assert.equal(clock.pending.length, 1)
      now += clock.pending[0].ms
      clock.pending.shift().run()
      await f.ipc.keyDeliveryIdle('A', 'team')
    }
    assert.equal(rounds, 9)
    // The bound stops the timer; the failure stays visible for a poll or explicit retry.
    assert.deepEqual(clock.pending, [])
    assert.equal(keyDeliveryState(f, requestId).state, 'failed')

    // A later admission starts a fresh bound; an account change before the timer fires
    // drops the slot without another round.
    const next = `account-device-${randomUUID()}`
    f.ipc.trackKeyDelivery('A', 'team', next, approvalDevice)
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(clock.pending.length, 1)
    f.identity.userId = 'B'
    const before = rounds
    clock.pending.shift().run()
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(rounds, before)
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
  }
)
void test(
  'a request admitted while the second delivery pass runs is still delivered by main without a poll',
  { timeout: 5000 },
  async () => {
    // Each round waits for its own gate, so the test decides when each pass ends.
    const gates = []
    const entered = []
    const f = await memberApprovalFixture(() =>
      Effect.promise(() => {
        const gate = deferredMember()
        gates.push(gate)
        entered.shift()?.resolve()
        return gate.promise
      })
    )
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    const round = () => {
      const signal = deferredMember()
      entered.push(signal)
      return signal.promise
    }
    const first = `account-device-${randomUUID()}`
    const second = `account-device-${randomUUID()}`
    const third = `account-device-${randomUUID()}`
    let started = round()
    f.ipc.trackKeyDelivery('A', 'team', first, approvalDevice)
    await started
    // Admitted during pass one: covered by the follow-up pass.
    f.ipc.trackKeyDelivery('A', 'team', second, approvalDevice)
    started = round()
    gates[0].resolve()
    await started
    // Admitted during pass two, the last pass of this run.
    f.ipc.trackKeyDelivery('A', 'team', third, approvalDevice)
    gates[1].resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(keyDeliveryState(f, third).state, 'pending')
    // Main scheduled it at once; firing that timer is the only step taken here.
    assert.deepEqual(
      clock.pending.map((timer) => timer.ms),
      [0]
    )
    started = round()
    clock.pending.shift().run()
    await started
    gates[2].resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
    for (const requestId of [first, second, third])
      assert.equal(keyDeliveryState(f, requestId).state, 'delivered')
    assert.deepEqual(clock.pending, [])
  }
)
void test(
  'a workspace reset ends its pending key delivery so no timer reopens it',
  { timeout: 5000 },
  async () => {
    let rounds = 0
    const f = await memberApprovalFixture(() =>
      Effect.suspend(() => {
        rounds += 1
        return Effect.fail(new Error('e2ee_management_retry'))
      })
    )
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    f.ipc.trackKeyDelivery('A', 'team', `account-device-${randomUUID()}`, approvalDevice)
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(clock.pending.length, 1)
    // The reset itself is outside this fixture; the delivery must end before it runs.
    await f.ipc
      .resetIdentity({ workspaceId: 'team', resetId: randomUUID(), confirm: true })
      .catch(() => {})
    assert.deepEqual(clock.pending, [])
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
    assert.equal(rounds, 1)
  }
)
void test(
  'a key delivery round already in flight never reopens a workspace reset during it',
  { timeout: 5000 },
  async () => {
    let rounds = 0
    const f = await memberApprovalFixture(() =>
      Effect.sync(() => {
        rounds += 1
      })
    )
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    let opens = 0
    const owner = f.owner()
    const open = owner.host.open
    owner.host.open = (...args) => {
      opens += 1
      return open(...args)
    }
    // The round has started and waits for its cloud client when the reset arrives.
    f.holdCloud()
    f.ipc.trackKeyDelivery('A', 'team', `account-device-${randomUUID()}`, approvalDevice)
    await f.cloudEntered.promise
    const inFlight = f.ipc.keyDelivery.slots.get('A\nteam').running
    await f.ipc
      .resetIdentity({ workspaceId: 'team', resetId: randomUUID(), confirm: true })
      .catch(() => {})
    f.cloudGate.resolve()
    await inFlight
    assert.equal(opens, 0)
    assert.equal(rounds, 0)
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
    assert.deepEqual(clock.pending, [])
  }
)
void test(
  'a key delivery round already in flight never opens the workspace after the account changes',
  { timeout: 5000 },
  async () => {
    let rounds = 0
    const f = await memberApprovalFixture(() =>
      Effect.sync(() => {
        rounds += 1
      })
    )
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    let opens = 0
    const owner = f.owner()
    const open = owner.host.open
    owner.host.open = (...args) => {
      opens += 1
      return open(...args)
    }
    // The round has started and waits for its cloud client when account B signs in.
    f.holdCloud()
    f.ipc.trackKeyDelivery('A', 'team', `account-device-${randomUUID()}`, approvalDevice)
    await f.cloudEntered.promise
    const inFlight = f.ipc.keyDelivery.slots.get('A\nteam').running
    f.identity.userId = 'B'
    f.identity.generation++
    f.cloudGate.resolve()
    await inFlight
    assert.equal(opens, 0)
    assert.equal(rounds, 0)
    // The slot is aborted and dropped, so no timer or poll resumes it for account B.
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
    assert.deepEqual(clock.pending, [])
  }
)
void test(
  'a failed key delivery stays visible by code and the next due periodic poll retries it until delivered',
  { timeout: 5000 },
  async () => {
    const outcomes = [Effect.fail(new Error('e2ee_management_retry')), Effect.void]
    const f = await memberApprovalFixture(() => outcomes.shift() ?? Effect.die('unexpected round'))
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    const approved = await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    assert.equal(approved.admitted, true)
    await f.ipc.keyDeliveryIdle('A', 'team')
    const failed = [{ requestId: approvalRequest, state: 'failed', code: 'e2ee_management_retry' }]
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), failed)
    // A poll inside the backoff interval does not start another round.
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), failed)
    assert.equal(outcomes.length, 1)
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    // The email admission worker's next poll drives the due retry.
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
  }
)

void test(
  'a committed admission missing from the local verified ledger is never reported delivered; a later poll ingests it first',
  { timeout: 5000 },
  async () => {
    // Distribution selects targets from the local verified ledger: without the
    // admission a key round succeeds with zero recipients.
    const ledger = { relayHasAdmission: false, historyFails: true }
    let rounds = 0
    const f = await memberApprovalFixture(
      () =>
        Effect.sync(() => {
          rounds++
        }),
      ledger
    )
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    const approved = await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    assert.equal(approved.admitted, true)
    await f.ipc.keyDeliveryIdle('A', 'team')
    const lagging = plain((await f.ipc.memberKeyDeliveries('team')).items)
    assert.equal(lagging.length, 1)
    assert.notEqual(lagging[0].state, 'delivered')
    // The relay now serves the admission; the next due poll ingests before distributing.
    ledger.historyFails = false
    ledger.relayHasAdmission = true
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
    assert.ok(rounds >= 1)
  }
)
for (const [name, nested] of [
  ['member removal', () => new E2eeMemberRemovedError()],
  ['device revocation', () => new E2eeDeviceRevokedError()],
  ['a missing binding', () => Object.assign(new Error('synthetic'), { code: 'missing-binding' })],
  [
    'a restart-required owner',
    () => Object.assign(new Error('synthetic'), { code: 'restart-required' })
  ]
])
  void test(
    `${name} nested in a key-round failure ends delivery from this device without retries`,
    { timeout: 5000 },
    async () => {
      let rounds = 0
      const f = await memberApprovalFixture(() =>
        Effect.suspend(() => {
          rounds++
          return Effect.fail(
            new WorkspaceKeyRoundFailure({
              receive: Result.succeed({}),
              distribution: Result.fail(nested()),
              reportsAfterSend: Result.succeed({}),
              cursors: {}
            })
          )
        })
      )
      let now = 1_000
      f.ipc.keyDeliveryNow = () => now
      await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
      await f.ipc.keyDeliveryIdle('A', 'team')
      assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [])
      now += 10 * 60_000
      await f.ipc.memberJoinRequests('team')
      await f.ipc.keyDeliveryIdle('A', 'team')
      assert.equal(rounds, 1)
    }
  )

void test(
  'a successful key round without a stored envelope for the member stays retryable',
  { timeout: 5000 },
  async () => {
    // A blocked target, an ineligible sender or a joined round all end the round in success.
    const ledger = { relayHasAdmission: true, evidence: () => 'e2ee_key_not_sent' }
    const f = await memberApprovalFixture(() => Effect.void, ledger)
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'failed', code: 'e2ee_key_not_sent' }
    ])
    ledger.evidence = () => 'delivered'
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
  }
)
void test(
  'a workspace closed during a key round is reopened and delivered by the next due poll',
  { timeout: 5000 },
  async () => {
    const outcomes = [
      Effect.fail(
        new WorkspaceKeyRoundFailure({
          receive: Result.succeed({}),
          distribution: Result.fail(Object.assign(new Error('synthetic'), { code: 'closed' })),
          reportsAfterSend: Result.succeed({}),
          cursors: {}
        })
      ),
      Effect.void
    ]
    const f = await memberApprovalFixture(() => outcomes.shift() ?? Effect.die('unexpected round'))
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    await f.ipc.keyDeliveryIdle('A', 'team')
    const [closed] = plain((await f.ipc.memberKeyDeliveries('team')).items)
    assert.equal(closed.state, 'failed')
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
  }
)

void test(
  'a delivery round ended by an unexpected exception is not left shown as delivering',
  { timeout: 5000 },
  async (t) => {
    const f = await memberApprovalFixture(() => Effect.void)
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    // The daily-log sink fails once, right after the request was marked delivering.
    const info = console.info
    t.after(() => {
      console.info = info
    })
    let broken = true
    console.info = (event, fields) => {
      if (broken && fields?.state === 'delivering') {
        broken = false
        throw new Error('synthetic log sink failure')
      }
    }
    await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'failed', code: 'e2ee_key_delivery_interrupted' }
    ])
    // Retryable with the usual backoff: the next due poll delivers it.
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
  }
)
void test('passive cache inspection stays account/product-window bound without opening a reader or cloud call', async () => {
  const f = await memberIpcFixture()
  const owner = f.makeOwner('A', 'passive-A')
  owner.readers.clear()
  f.setOwner(owner)
  const snapshot = await f.ipc.inspectCachedState('team', 'machine')
  assert.equal(snapshot.accountId, 'A')
  assert.equal(snapshot.workspaceId, 'team')
  assert.equal(snapshot.machineId, 'machine')
  assert.equal(snapshot.activeContentReaders, 0)
  assert.equal(snapshot.cachedExecutionGrants, 0)
  assert.equal(owner.readers.size, 0)
  assert.deepEqual(f.signed, [])
  assert.deepEqual(f.closed, [])
  f.identity.userId = 'B'
  await assert.rejects(f.ipc.inspectCachedState('team', 'machine'), /e2ee_account_mismatch/)
  f.identity.userId = 'A'
  f.setTrusted(false)
  await assert.rejects(f.ipc.inspectCachedState('team', 'machine'), /untrusted sender/)
  f.setTrusted(true)
  await assert.rejects(f.ipc.inspectCachedState('', 'machine'), /e2ee_invalid-input/)
})

async function accountPairingFixture(t, options = {}) {
  // Real custody, bootstrap, ledger hosts and SQLite journals on both devices; the
  // cloud is an in-memory relay plus the approver's own ledger as the history source.
  const f = await personalJoinFixture(t)
  const approver = await f.open('apprvr')
  await approver.create()
  const newDevice = await f.open('new-device')
  const { genesisHash } = await Effect.runPromise(approver.host.status(f.workspaceId))
  // Like the service: a request `after` a position returns only the later records.
  const ledgerPage = async (request = {}) => {
    const ledger = await Effect.runPromise(approver.host.ledgerView(f.workspaceId))
    const start = request.after ? Number(request.after.split(':')[2]) : 0
    return {
      workspaceId: f.workspaceId,
      genesisHash,
      startIndex: start,
      recordsHex: ledger.recordsHex.slice(start),
      checkpoint: { length: ledger.status.length, headHash: ledger.status.headHash },
      position: `p1:${f.workspaceId}:${ledger.status.length}:source-${ledger.status.length}:0`,
      nextCursor: null
    }
  }
  const requests = new Map()
  const approvals = new Map()
  const appended = []
  const mailboxRequests = []
  const cloud = {
    // Key delivery is not modelled: the mailbox records who asked, then refuses.
    keyServices: (access) =>
      Effect.sync(() => {
        mailboxRequests.push({ ...access })
        const refuse = () => Effect.fail(new Error('synthetic mailbox unavailable'))
        return {
          mailbox: () => ({
            put: refuse,
            read: refuse,
            fetch: refuse,
            status: refuse,
            report: refuse,
            repair: refuse
          }),
          staging: () => ({ stageGroup: refuse, readGroup: refuse, deleteGroup: refuse }),
          history: () => (request) => Effect.promise(() => ledgerPage(request))
        }
      }),
    history: (request) => Effect.promise(() => ledgerPage(request)),
    appendRecord: (request) =>
      Effect.promise(async () => {
        appended.push(request)
        await f.append(approver, genesisHash, request.recordHex)
        return { ok: true }
      }),
    pairingSubmit: (request) =>
      Effect.sync(() => {
        if (!requests.has(request.lookupId))
          requests.set(request.lookupId, { ...request, requestId: 'request-1' })
        const row = requests.get(request.lookupId)
        return {
          requestId: row.requestId,
          status: 'pending',
          deviceName: row.deviceName,
          approximateLocation: null,
          requestedAt: Date.now(),
          expiresAt: row.expiresAt
        }
      }),
    pairingRead: ({ lookupId }) =>
      Effect.sync(() => {
        const row = requests.get(lookupId)
        return row
          ? {
              requestId: row.requestId,
              status: 'pending',
              deviceName: row.deviceName,
              approximateLocation: null,
              requestedAt: Date.now(),
              expiresAt: row.expiresAt,
              lookupId,
              requestHex: row.requestHex,
              requestTagHex: row.requestTagHex,
              workspaces: row.workspaces
            }
          : null
      }),
    pairingDecline: () => Effect.succeed({ status: 'declined' }),
    pairingPublish: (request) =>
      Effect.sync(() => {
        const list = approvals.get(request.lookupId) ?? []
        list.push({
          approvalHex: request.approvalHex,
          approvalTagHex: request.approvalTagHex,
          publishedAt: Date.now(),
          invitations: request.invitations.map(
            ({ workspaceId, genesisHash: g, invitationHex }) => ({
              workspaceId,
              genesisHash: g,
              invitationHex
            })
          )
        })
        approvals.set(request.lookupId, list)
        return { status: 'published' }
      }),
    pairingClaim: ({ lookupId }) =>
      Effect.sync(() =>
        requests.has(lookupId)
          ? { status: 'pending', approvals: approvals.get(lookupId) ?? [] }
          : null
      )
  }
  const hints = [{ workspaceId: f.workspaceId, name: 'Synthetic encrypted workspace', genesisHash }]
  const hostFor = (owner, name, extra = {}) => {
    const db = new DatabaseSync(join(owner.path, name))
    t.after(() => db.close())
    return makeDesktopAccountPairingHost({
      accountId: owner.accountId,
      deviceName: 'Synthetic second desktop',
      db,
      cloud,
      withOwner: (_workspaceId, work) => Effect.runPromise(work(owner)),
      run: (effect) => Effect.runPromise(effect),
      workspaces: () => hints,
      ...extra
    })
  }
  const requester = hostFor(newDevice, 'account-pairing.sqlite')
  const approving = hostFor(
    approver,
    'account-pairing.sqlite',
    options.deliverKeys ? { deliverKeys: options.deliverKeys } : {}
  )

  return {
    f,
    approver,
    newDevice,
    genesisHash,
    cloud,
    requester,
    approving,
    mailboxRequests,
    appended
  }
}

void test('account-wide pairing runs from the new device request to an installed invitation on real hosts', async (t) => {
  const { f, approver, newDevice, genesisHash, requester, approving, appended } =
    await accountPairingFixture(t)
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  assert.equal(request.status, 'waiting')
  assert.deepEqual(
    request.workspaces.map((item) => [item.workspaceId, item.state]),
    [[f.workspaceId, 'pending']]
  )
  // The new device has a retained identity but no access yet.
  await assert.rejects(Effect.runPromise(newDevice.host.open(f.workspaceId)))

  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  assert.deepEqual(preview.workspaces, [
    { workspaceId: f.workspaceId, name: 'Synthetic encrypted workspace' }
  ])
  assert.equal(preview.deviceName, 'Synthetic second desktop')
  const result = await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  assert.deepEqual(result.workspaces, [{ workspaceId: f.workspaceId, outcome: 'admitted' }])
  assert.equal(appended.length, 1)

  const joined = await Effect.runPromise(requester.accountPairingRequest())
  assert.equal(joined.status, 'joined')
  // The installed invitation opens the workspace with the new device's own identity.
  const opened = await Effect.runPromise(newDevice.host.open(f.workspaceId))
  assert.equal(opened.deviceKind, 'personal')
  const approverStatus = await Effect.runPromise(approver.host.status(f.workspaceId))
  assert.notEqual(opened.signingPublicKey, approverStatus.signingPublicKey)
  assert.equal(opened.genesisHash, genesisHash)
  // A finished code cannot be used again on either device.
  await assert.rejects(
    Effect.runPromise(approving.inspectAccountPairing(request.pairingString)),
    (error) => error.code === 'pairing-used'
  )
})

void test('the new device opens the paired workspace and asks for its keys right after installing', async (t) => {
  const { f, newDevice, requester, approving, mailboxRequests } = await accountPairingFixture(t)
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  mailboxRequests.length = 0
  const modes = []
  const keyRound = newDevice.host.keyRound
  newDevice.host.keyRound = (...args) => {
    modes.push(args[4])
    return keyRound(...args)
  }
  assert.equal((await Effect.runPromise(requester.accountPairingRequest())).status, 'joined')
  // Like the per-workspace claim: open, refresh and receive this device's own key with
  // its own credential, without waiting for the workspace to be opened later. Reports,
  // distribution and repair wait for a later full round.
  const credential = await Effect.runPromise(newDevice.bootstrap.deviceCredential(f.workspaceId))
  assert.deepEqual(
    mailboxRequests.map((item) => [item.workspaceId, item.credential]),
    [[f.workspaceId, credential]]
  )
  assert.deepEqual(modes, ['receive'])
})

void test('installing an approval reads only the ledger records after the history the request already verified', async (t) => {
  // The request verified the full history from genesis; the claim reuses that verified
  // prefix and downloads only later records instead of paging the whole ledger again.
  const { f, cloud, requester, approving } = await accountPairingFixture(t)
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  const read = cloud.history
  const requests = []
  cloud.history = (input) => {
    requests.push({ ...input })
    return read(input)
  }
  assert.equal((await Effect.runPromise(requester.accountPairingRequest())).status, 'joined')
  assert.ok(requests.length > 0)
  assert.deepEqual(
    requests.filter((input) => input.after === undefined && input.cursor === undefined),
    []
  )
})

/** Approver listing over six synthetic personal workspaces whose status reads wait for
 * the test. Records concurrent reads and every close. */
function blockedApproverListing() {
  const genesisHash = 'ab'.repeat(32)
  const hints = Array.from({ length: 6 }, (_, index) => ({
    workspaceId: `team-${index}`,
    name: `Team ${index}`,
    genesisHash
  }))
  const gates = new Map()
  const started = []
  const closed = []
  let active = 0
  let peak = 0
  let notify = () => {}
  const owner = {
    accountId: 'A',
    readers: new Map(),
    host: {
      status: (workspaceId) =>
        Effect.promise(() => {
          started.push(workspaceId)
          active += 1
          peak = Math.max(peak, active)
          notify()
          return new Promise((resolve) => gates.set(workspaceId, resolve)).then((value) => {
            active -= 1
            return value
          })
        }),
      closeWorkspace: (workspaceId) => Effect.sync(() => void closed.push(workspaceId))
    },
    bootstrap: {}
  }
  const { approverWorkspaces } = makeDesktopAccountPairingWorkspaces({
    accountId: 'A',
    cloud: {},
    withOwner: (_workspaceId, work) => Effect.runPromise(work(owner)),
    run: (effect) => Effect.runPromise(effect),
    workspaces: () => hints
  })
  const startedCount = (count) =>
    new Promise((resolve) => {
      notify = () => started.length >= count && resolve()
      notify()
    })
  const settle = (workspaceId) =>
    gates.get(workspaceId)({
      deviceKind: 'personal',
      genesisHash,
      signingPublicKey: 'cd'.repeat(32)
    })
  return {
    hints,
    started,
    closed,
    peak: () => peak,
    approverWorkspaces,
    startedCount,
    settle
  }
}

void test('approving on a desktop with many workspaces inspects four at a time and keeps their order', async () => {
  // Inspection latency must not grow by one owner turn per workspace, while the
  // approval preview keeps the account's workspace order.
  const listing = blockedApproverListing()
  const done = Effect.runPromise(listing.approverWorkspaces())
  await listing.startedCount(4)
  assert.equal(listing.started.length, 4)
  // Settling one inspection starts the next; later ones settle before earlier ones.
  listing.settle('team-1')
  await listing.startedCount(5)
  listing.settle('team-3')
  await listing.startedCount(6)
  for (const workspaceId of ['team-5', 'team-4', 'team-2', 'team-0']) listing.settle(workspaceId)
  const workspaces = await done
  assert.equal(listing.peak(), 4)
  assert.deepEqual(
    workspaces.map((item) => item.workspaceId),
    listing.hints.map((hint) => hint.workspaceId)
  )
  assert.deepEqual(listing.closed, [])
})

void test('an interrupted approver inspection closes every workspace any concurrent inspection opened', async () => {
  // Pairing must not leave workspaces open that no window reads: settled ones and
  // ones whose inspection was still running are all closed again.
  const listing = blockedApproverListing()
  const fiber = Effect.runFork(listing.approverWorkspaces())
  await listing.startedCount(4)
  listing.settle('team-0')
  listing.settle('team-1')
  await listing.startedCount(6)
  await Effect.runPromise(Fiber.interrupt(fiber))
  assert.deepEqual([...listing.closed].sort(), [...listing.started].sort())
})

void test('after a failed first delivery, main retries the account-pairing key on its own timer until the new device holds the current key', async (t) => {
  // Real custody, ledger hosts and reference mailbox on both devices. The approval hands
  // the admitted device to the real E2eeIpc delivery (trackKeyDelivery, distribute-only
  // round, mailbox evidence, due timer); the test never runs a delivery itself.
  let ipcFixture
  const { f, approver, newDevice, genesisHash, cloud, requester, approving } =
    await accountPairingFixture(t, {
      deliverKeys: (workspaceId, requestId, device) =>
        ipcFixture.ipc.trackKeyDelivery('A', workspaceId, requestId, device)
    })
  const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(genesisHash, 'hex')))
  const mailboxScope = Effect.runSync(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(mailboxScope, Exit.void)))
  const mailbox = await Effect.runPromise(
    makeSqliteKeyMailbox({
      path: join(approver.path, 'reference-mailbox.sqlite'),
      mode: 'create',
      genesis,
      ledger: () =>
        Effect.promise(async () => {
          const ledger = await Effect.runPromise(approver.host.ledgerView(f.workspaceId))
          const records = ledger.recordsHex.map((value) => Buffer.from(value, 'hex'))
          return Result.getOrThrow(
            verifyLedger({
              anchor: genesis,
              records,
              checkpoint: { length: records.length, head: hashRecordBytes(records.at(-1)) }
            })
          )
        })
    }).pipe(Scope.provide(mailboxScope))
  )
  const portFor = async (owner) => {
    const device = await Effect.runPromise(owner.custody.openDevice(genesis))
    return Context.get(
      await Effect.runPromise(
        Layer.buildWithScope(referenceKeyMailbox(mailbox, device.publicKey), mailboxScope)
      ),
      KeyMailbox
    )
  }
  const approverPort = await portFor(approver)
  // Envelope storage is refused until `refusing` is cleared; every attempt is recorded.
  let refusing = true
  const puts = []
  const sending = {
    ...approverPort,
    put: (id, frame) => {
      puts.push({ id, frame: Buffer.from(frame).toString('hex') })
      return refusing
        ? Effect.fail(new BackendError({ service: 'KeyMailbox', reason: 'unavailable' }))
        : approverPort.put(id, frame)
    }
  }
  ipcFixture = await memberIpcFixture({
    bootstrap: {
      deviceCredential: (workspaceId) => approver.bootstrap.deviceCredential(workspaceId)
    },
    host: {
      open: (workspaceId) => approver.host.open(workspaceId),
      status: (workspaceId) => approver.host.status(workspaceId),
      ingestLedgerRecords: (workspaceId, page) =>
        approver.host.ingestLedgerRecords(workspaceId, page),
      keyDeliveryTarget: (workspaceId, device) =>
        approver.host.keyDeliveryTarget(workspaceId, device),
      distributeKeys: (workspaceId, port) => approver.host.distributeKeys(workspaceId, port),
      keyDeliveryEvidence: (workspaceId, device, port) =>
        approver.host.keyDeliveryEvidence(workspaceId, device, port),
      // The approver's real host stays open for the rest of the test.
      beginCloseWorkspace: () => Effect.succeed(Effect.void)
    },
    client: { history: (request) => cloud.history(request), mailbox: () => sending }
  })
  let now = 1_000
  ipcFixture.ipc.keyDeliveryNow = () => now
  const clock = fakeKeyDeliveryTimers()
  ipcFixture.ipc.keyDeliveryTimers = clock.timers
  const slot = () => ipcFixture.ipc.keyDelivery.slots.get(`A\n${f.workspaceId}`)
  const approverCredential = await Effect.runPromise(
    approver.bootstrap.deviceCredential(f.workspaceId)
  )
  let desktopPort
  cloud.keyServices = (access) =>
    Effect.promise(async () => {
      assert.notEqual(access.credential, approverCredential)
      desktopPort ??= await portFor(newDevice)
      return { mailbox: () => desktopPort, history: () => cloud.history }
    })

  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  const result = await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  assert.deepEqual(result.workspaces, [{ workspaceId: f.workspaceId, outcome: 'admitted' }])
  await ipcFixture.ipc.keyDeliveryIdle('A', f.workspaceId)
  // The refused store leaves the key unsent; the approval already returned admitted.
  const [[requestId, delivery]] = [...slot().requests]
  assert.match(requestId, /^account-device-[0-9a-f-]{36}$/)
  assert.equal(delivery.state, 'failed')
  assert.equal(delivery.code, 'e2ee_key_not_sent')
  assert.ok(puts.length > 0)
  const firstAttempt = puts.map((item) => ({ ...item }))

  // Admitted and joined is not keyed: the claim's own key round finds no envelope.
  assert.equal((await Effect.runPromise(requester.accountPairingRequest())).status, 'joined')
  const joined = await Effect.runPromise(newDevice.host.open(f.workspaceId))
  assert.equal(joined.hasCurrentKey, false)
  // Exactly the device the verified ledger admitted.
  assert.equal(delivery.device, joined.signingPublicKey)

  // Only the injected clock moves; main's own timer runs the next round.
  refusing = false
  puts.length = 0
  assert.equal(clock.pending.length, 1)
  now += clock.pending[0].ms
  clock.pending.shift().run()
  await ipcFixture.ipc.keyDeliveryIdle('A', f.workspaceId)
  assert.equal(slot().requests.get(requestId).state, 'delivered')
  assert.deepEqual(clock.pending, [])
  // The retry stores the same envelope under the same id: no re-encryption.
  assert.deepEqual(puts.slice(0, firstAttempt.length), firstAttempt)

  await Effect.runPromise(newDevice.host.keyRound(f.workspaceId, () => desktopPort))
  assert.equal((await Effect.runPromise(newDevice.host.status(f.workspaceId))).hasCurrentKey, true)
  const room = { kind: 'meta' }
  const context = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch'
  }
  const plaintext = new TextEncoder().encode('synthetic account pairing history')
  const additionalData = new Uint8Array([4, 5, 6])
  const sealed = await Effect.runPromise(
    approver.host.seal(f.workspaceId, { epoch: 0, room, context, plaintext, additionalData })
  )
  assert.deepEqual(
    await Effect.runPromise(
      newDevice.host.openContent(f.workspaceId, { room, context, ...sealed, additionalData })
    ),
    plaintext
  )
})

void test('an unrelated unfinished per-workspace pairing blocks only that workspace, with a clear state', async (t) => {
  const { f, approver, newDevice, genesisHash, requester, approving } =
    await accountPairingFixture(t)
  // The new device already started the per-workspace exchange from another offer.
  const offer = await Effect.runPromise(approver.host.personalPairingOffer(f.workspaceId))
  await Effect.runPromise(newDevice.bootstrap.preparePersonalJoin(offer))
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  const state = await Effect.runPromise(requester.accountPairingRequest())
  assert.equal(state.status, 'waiting')
  assert.deepEqual(
    state.workspaces.map((item) => [item.workspaceId, item.state]),
    [[f.workspaceId, 'blocked']]
  )
  // The unfinished exchange is kept, not overwritten.
  const pending = await Effect.runPromise(newDevice.bootstrap.pendingPersonalJoin(f.workspaceId))
  assert.equal(pending.offer.pairingSessionId, offer.pairingSessionId)
  void genesisHash
})

class ObservedLedgerStorage {
  data = new Map()
  get length() {
    return this.data.size
  }
  getItem(key) {
    return this.data.get(key) ?? null
  }
  key(index) {
    return [...this.data.keys()][index] ?? null
  }
  removeItem(key) {
    this.data.delete(key)
  }
  setItem(key, value) {
    this.data.set(key, String(value))
  }
  clear() {
    this.data.clear()
  }
}

void test('account pairing keeps a control-page observation made before approval when the invitation snapshot is newer', async (t) => {
  const { f, approver, newDevice, genesisHash, requester, approving } =
    await accountPairingFixture(t)
  // The desktop opened the control page before it joined and verified the
  // server's genesis. That observation is durable local evidence.
  const storage = new ObservedLedgerStorage()
  const observed = appendLedgerHistory(
    null,
    {
      workspaceId: f.workspaceId,
      genesisHash,
      startIndex: 0,
      recordsHex: [
        (await Effect.runPromise(approver.host.ledgerView(f.workspaceId))).recordsHex[0]
      ],
      checkpoint: { length: 1, headHash: genesisHash },
      position: `p1:${f.workspaceId}:1:source:0`,
      nextCursor: null
    },
    { workspaceId: f.workspaceId, genesisHash, localPin: null }
  )
  assert.equal(observed.view.length, 1)
  assert.equal(
    retainObservedLedgerCheckpoint(storage, newDevice.accountId, f.workspaceId, observed),
    true
  )
  assert.equal(readObservedLedgerCheckpoint(storage, newDevice.accountId, f.workspaceId).length, 1)

  // Approval admits the desktop into a later snapshot. The join installs the
  // endorsement and its own genesis original, but not the intervening record.
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  assert.equal((await Effect.runPromise(requester.accountPairingRequest())).status, 'joined')
  assert.equal((await Effect.runPromise(newDevice.host.open(f.workspaceId))).deviceKind, 'personal')

  // The control page publishes that host view. The signed snapshot cannot name
  // the earlier checkpoint, but the retained genesis original proves it; the
  // page must not claim a rollback or fork.
  const published = hostLedgerHistory(
    await Effect.runPromise(newDevice.host.ledgerView(f.workspaceId))
  )
  assert.equal(published.view.length, 2)
  assert.ok(published.records.length < published.view.length)
  assert.equal(
    retainObservedLedgerCheckpoint(storage, newDevice.accountId, f.workspaceId, published),
    true
  )
  assert.equal(readObservedLedgerCheckpoint(storage, newDevice.accountId, f.workspaceId).length, 2)

  // The approved desktop still receives the current epoch key. A later key
  // round, not the control-page read, installs it.
  const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(genesisHash, 'hex')))
  const mailboxScope = Effect.runSync(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(mailboxScope, Exit.void)))
  const mailbox = await Effect.runPromise(
    makeSqliteKeyMailbox({
      path: join(newDevice.path, 'reference-mailbox.sqlite'),
      mode: 'create',
      genesis,
      ledger: () =>
        Effect.promise(async () => {
          const ledger = await Effect.runPromise(approver.host.ledgerView(f.workspaceId))
          const records = ledger.recordsHex.map((value) => Buffer.from(value, 'hex'))
          return Result.getOrThrow(
            verifyLedger({
              anchor: genesis,
              records,
              checkpoint: { length: records.length, head: hashRecordBytes(records.at(-1)) }
            })
          )
        })
    }).pipe(Scope.provide(mailboxScope))
  )
  const approverDevice = await Effect.runPromise(approver.custody.openDevice(genesis))
  const desktopDevice = await Effect.runPromise(newDevice.custody.openDevice(genesis))
  const approverMailbox = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(referenceKeyMailbox(mailbox, approverDevice.publicKey), mailboxScope)
    ),
    KeyMailbox
  )
  const desktopMailbox = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(referenceKeyMailbox(mailbox, desktopDevice.publicKey), mailboxScope)
    ),
    KeyMailbox
  )
  await Effect.runPromise(approver.host.keyRound(f.workspaceId, () => approverMailbox))
  await Effect.runPromise(newDevice.host.keyRound(f.workspaceId, () => desktopMailbox))
  assert.equal((await Effect.runPromise(newDevice.host.status(f.workspaceId))).hasCurrentKey, true)

  // A conflicting earlier observation remains blocking evidence, not repair.
  const conflicting = new ObservedLedgerStorage()
  conflicting.setItem(
    `lody-e2ee-observed-ledger:${encodeURIComponent(newDevice.accountId)}:${encodeURIComponent(f.workspaceId)}:1:${'00'.repeat(32)}`,
    JSON.stringify({ genesisHash, headHash: '00'.repeat(32), length: 1 })
  )
  assert.throws(
    () =>
      retainObservedLedgerCheckpoint(conflicting, newDevice.accountId, f.workspaceId, published),
    /Ledger history changed/
  )
})

/** Two real accounts (custody, bootstrap, host and account lock) behind real E2eeIpc,
 * sharing a synthetic relay: one ledger, member requests and a reference key mailbox. */
async function twoDeviceMemberJoin(t, { latency = () => Effect.void } = {}) {
  const logs = []
  const capture = { ...console, info: (...entry) => logs.push(entry) }
  const owner = await nativeAccountFixture(t)
  const member = await nativeAccountFixture(t)
  member.identity.userId = 'member'
  member.identity.userId = 'member'
  const created = await createAccountWorkspace(owner.api, 'team')
  const hexOf = (bytes) => Buffer.from(bytes).toString('hex')
  const genesisHash = created.creation.genesisHashHex
  const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(genesisHash, 'hex')))
  const records = [Buffer.from(created.creation.genesisRecordHex, 'hex')]
  const view = () =>
    Result.getOrThrow(
      verifyLedger({
        anchor: genesis,
        records,
        checkpoint: { length: records.length, head: hashRecordBytes(records.at(-1)) }
      })
    )
  // Relay behaviour toward members: removal and an unbounded history chain.
  const relay = { memberRemoved: false, endlessHistory: false }
  const history = (device) =>
    Effect.andThen(
      latency('history', { device }),
      Effect.sync(() => ({
        workspaceId: 'team',
        genesisHash,
        startIndex: 0,
        recordsHex: records.map(hexOf),
        checkpoint: {
          length: records.length,
          headHash: hexOf(hashRecordBytes(records.at(-1)).toBytes())
        },
        nextCursor: null,
        position: `p1:team:${records.length}:fixture`
      }))
    )
  const scope = Effect.runSync(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const directory = await mkdtemp(join(tmpdir(), 'two-device-mailbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const mailbox = await Effect.runPromise(
    makeSqliteKeyMailbox({
      path: join(directory, 'mailbox.sqlite'),
      mode: 'create',
      genesis,
      ledger: () => Effect.sync(view)
    }).pipe(Scope.provide(scope))
  )
  const port = async (publicKeyHex) => {
    const service = Context.get(
      await Effect.runPromise(
        Layer.buildWithScope(
          referenceKeyMailbox(
            mailbox,
            Result.getOrThrow(Bytes.signingPublicKey(Buffer.from(publicKeyHex, 'hex')))
          ),
          scope
        )
      ),
      KeyMailbox
    )
    // Every mailbox call pays the relay's latency, like a real HTTPS round trip.
    return Object.fromEntries(
      Object.entries(service).map(([name, method]) => [
        name,
        (...args) =>
          Effect.andThen(
            latency(`mailbox.${name}`, {
              device: publicKeyHex === offer.endorser ? 'owner' : 'member',
              self: publicKeyHex,
              recipient: args[0]?.recipient,
              args
            }),
            method(...args)
          )
      ])
    )
  }
  const requests = new Map()
  // Rotation stages one envelope group per published epoch; every member reads it.
  const groups = new Map()
  const staging = () => ({
    stageGroup: (group) =>
      Effect.sync(() => {
        groups.set(group.recordHash, group)
      }),
    readGroup: (key) => Effect.succeed(groups.get(key.recordHash) ?? null),
    deleteGroup: () => Effect.void
  })
  // The relay keeps each invitation it was given and returns it with the request it answers.
  const offers = new Map()
  const invite = async () => {
    const minted = await owner.api.withDesktopE2eeAccount(
      (account) => account.host.memberOffer('team', 'email', 9_000_000_000_000),
      'team',
      false
    )
    offers.set(minted.token, minted)
    return minted
  }
  const offer = await invite()
  const ownerPort = await port(offer.endorser)
  let memberPort
  const relayed = (device, name, value) =>
    Effect.andThen(latency(name, { device }), Effect.sync(value))
  const ownerCloud = {
    accountId: 'acc1',
    client: {
      memberPending: () =>
        relayed('owner', 'memberPending', () => ({
          invitations: [],
          items: [...requests.values()]
            .filter((request) => request.state === 'pending')
            .map((request) => ({
              ...request,
              applicantName: 'Member',
              applicantEmail: 'm@x.test'
            })),
          hasMore: false,
          seatPreview: { status: 'not_billed', reason: 'covered' }
        })),
      memberRead: ({ requestId }) =>
        relayed('owner', 'memberRead', () => ({ ...requests.get(requestId) })),
      appendRecord: (pending) =>
        relayed('owner', 'appendRecord', () => {
          records.push(Buffer.from(pending.recordHex, 'hex'))
          for (const request of requests.values()) request.state = 'committed'
          return { status: 'committed' }
        }),
      history: () => history('owner'),
      ledgerLog: () => ({
        read: () =>
          Effect.andThen(
            latency('ledgerLog.read', { device: 'owner' }),
            Effect.sync(() => ({
              records: [...records],
              checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
            }))
          ),
        appendCas: (_anchor, expected, record) =>
          Effect.andThen(
            latency('ledgerLog.appendCas', { device: 'owner' }),
            Effect.sync(() => {
              assert.equal(expected.length, records.length)
              records.push(Buffer.from(record))
            })
          )
      }),
      contentStreamsToken: () => relayed('owner', 'contentStreamsToken', () => ({ token: 't' })),
      mailbox: () => ownerPort,
      staging
    }
  }
  const memberCloudFor = (accountId, mailboxPort) => ({
    accountId,
    client: {
      memberSubmit: ({ token, keyPackageHex }) =>
        relayed('member', 'memberSubmit', () => {
          const proof = memberJoining.decodeMemberKeyPackage(keyPackageHex)
          const requestId = hexOf(proof.request.requestId.toBytes())
          const request = {
            id: requestId,
            workspaceId: 'team',
            accountId,
            keyPackageHex,
            signingPublicKey: hexOf(proof.request.signingPublicKey.toBytes()),
            requestId,
            source: 'email',
            state: 'pending',
            expiresAt: 9_000_000_000_000,
            offer: offers.get(token)
          }
          requests.set(requestId, request)
          return { ...request }
        }),
      memberClaim: ({ requestId }) =>
        relayed('member', 'memberClaim', () => ({ ...requests.get(requestId) })),
      history: () =>
        relay.memberRemoved
          ? Effect.fail(new Error('synthetic unauthorized history'))
          : Effect.map(history('member'), (page) =>
              relay.endlessHistory ? { ...page, nextCursor: 'synthetic-more' } : page
            ),
      // Credential-bound: the typed result that authorizes local cleanup.
      contentStreamsToken: () =>
        relay.memberRemoved
          ? Effect.suspend(() => {
              relay.onRemovalConfirmed?.()
              return Effect.fail(new E2eeMemberRemovedError())
            })
          : relayed('member', 'contentStreamsToken', () => ({ token: 't' })),
      mailbox: () => mailboxPort(),
      staging
    }
  })
  const memberCloud = memberCloudFor('member', () => memberPort)
  const ipc = async (fixture, cloud, id) => {
    const sender = Object.assign(new EventEmitter(), {
      id,
      isDestroyed: () => false,
      send: () => {}
    })
    const { E2eeIpc } = await load(
      '../ipc/services/e2ee-ipc.ts',
      {
        '../ipc-service-deps': {
          getIpcServiceDeps: () => ({
            authService: { getCachedSessionIdentity: () => ({ ...fixture.identity }) }
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
          ...fixture.api,
          desktopE2eeCloudClient: async () => cloud
        },
        '../assert-sender': { assertProductWindowSender: () => {} }
      },
      capture
    )
    return new E2eeIpc()
  }
  const approver = await ipc(owner, ownerCloud, 1)
  const joiner = await ipc(member, memberCloud, 2)
  return {
    offer,
    approver,
    joiner,
    ownerApi: owner.api,
    memberApi: member.api,
    memberIdentity: member.identity,
    memberDirectory: member.directory,
    setMemberLocked: member.setLocked,
    relay,
    logs,
    async submit() {
      const submitted = await joiner.prepareMemberJoin(offer)
      memberPort = await port(submitted.signingPublicKey)
      return submitted
    },
    invite,
    offers,
    requests,
    records,
    /** Another account's member, joining through the same relay with its own invitation
     * unless `invitation` names one. */
    async addMember(accountId, senderId, invitation) {
      const fixture = await nativeAccountFixture(t)
      fixture.identity.userId = accountId
      let ownPort
      const other = await ipc(
        fixture,
        memberCloudFor(accountId, () => ownPort),
        senderId
      )
      const submitted = await other.prepareMemberJoin(invitation ?? (await invite()))
      ownPort = await port(submitted.signingPublicKey)
      return { ipc: other, submitted }
    }
  }
}
// Observed on the packaged B run (R16 clean13): ~1.9 s per Convex relay call and ~0.4 s to
// mint a Convex token. The cloud client reuses one unexpired token (pinned by
// e2ee-cloud-client.test.mjs), so a critical path pays at most one mint. A committed member
// retries claims 3 s apart.
const RELAY_CALL_S = 1.9
const TOKEN_MINT_S = 0.4
/** A claim's own relay calls: after ready, main starts a full round (its first call is a
 * second mailbox fetch) that runs beside the claim, not before its result. */
const claimCalls = (calls) => {
  const second = calls.indexOf('mailbox.fetch', calls.indexOf('mailbox.fetch') + 1)
  return second === -1 ? calls.length : second
}
void test(
  'member key delivery and claim transitions are logged under a short request tag, never the request id',
  { timeout: 20_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, true)
    const trail = f.logs.map(([event, fields]) => `${event}:${fields.state}:${fields.phase ?? ''}`)
    assert.deepEqual(trail, [
      '[E2EE] key-delivery:pending:',
      '[E2EE] key-delivery:delivering:',
      '[E2EE] key-delivery:delivered:',
      '[E2EE] member-claim:committed:ready'
    ])
    assert.ok(f.logs.every(([, fields]) => /^[0-9a-f]{12}$/.test(fields.request)))
    assert.ok(!JSON.stringify(f.logs).includes(submitted.requestId))
  }
)

/** An invitation the relay signs with a key of its own, as a forging relay would. */
const relaySignedOffer = (genuine, changes = {}) => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const endorser = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')
  const unsigned = { ...genuine, ...changes, endorser }
  delete unsigned.signature
  const signature = sign(null, memberOfferSigningBytes(unsigned), privateKey).toString('hex')
  return { ...unsigned, signature }
}
void test(
  'a relay-forged email request is never admitted unattended and waits for explicit approval',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    const stored = f.requests.get(submitted.requestId)
    const genuine = stored.offer
    const before = f.records.length
    // `source: 'email'` alone, an invitation signed by the relay's own key, and a genuine
    // signature over different pins: none is an invitation this approver can verify.
    for (const [forged, refusal] of [
      [undefined, /e2ee_member_invitation_invalid/],
      // Verifies under the relay's own key, which the ledger never admitted.
      [relaySignedOffer(genuine), /e2ee_member_invitation_endorser_ineligible/],
      [{ ...genuine, expiresAt: genuine.expiresAt - 1 }, /e2ee_member_invitation_invalid/]
    ]) {
      stored.offer = forged
      await assert.rejects(
        f.approver.approveMemberJoin('team', submitted.requestId, 'automatic'),
        refusal
      )
      assert.equal(f.records.length, before)
    }
    // The applicant stays listed, and an administrator's explicit approval still admits it.
    assert.equal(
      JSON.stringify(
        (await f.approver.memberJoinRequests('team')).items.map((item) => item.requestId)
      ),
      JSON.stringify([submitted.requestId])
    )
    assert.equal(
      (await f.approver.approveMemberJoin('team', submitted.requestId, 'explicit')).admitted,
      true
    )
    await f.approver.keyDeliveryIdle('acc1', 'team')
  }
)
void test(
  'an email invitation admits one applicant: another account presenting its token is refused as used',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const first = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', first.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    const before = f.records.length
    // The relay replays the same invitation for another account's keys.
    const other = await f.addMember('thr', 3, f.offer)
    assert.equal(other.submitted.requestId, first.requestId)
    await assert.rejects(
      f.approver.approveMemberJoin('team', other.submitted.requestId, 'automatic'),
      /e2ee_member_invitation_used/
    )
    assert.equal(f.records.length, before)
  }
)
void test(
  'invitations from an admin who was later demoted are no longer admitted unattended',
  { timeout: 40_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const admin = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', admin.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', admin.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    await f.approver.setMemberRole('team', admin.requestId, 'admin')
    await f.joiner.open('team')
    await f.joiner.refresh('team', { installKeys: false })
    const mint = async () => {
      const minted = await f.memberApi.withDesktopE2eeAccount(
        (account) => account.host.memberOffer('team', 'email', 9_000_000_000_000),
        'team',
        false
      )
      f.offers.set(minted.token, minted)
      return minted
    }
    const early = await mint()
    const late = await mint()
    // While the endorser is an admin its invitation is admitted unattended.
    const accepted = await f.addMember('acc3', 3, early)
    await f.approver.memberJoinRequests('team')
    assert.equal(
      (await f.approver.approveMemberJoin('team', accepted.submitted.requestId, 'automatic'))
        .admitted,
      true
    )
    await f.approver.keyDeliveryIdle('acc1', 'team')
    await f.approver.setMemberRole('team', admin.requestId, 'member')
    const waiting = await f.addMember('acc4', 4, late)
    // Listed and pinned like any applicant: only the endorser's current role refuses it.
    await f.approver.memberJoinRequests('team')
    const before = f.records.length
    await assert.rejects(
      f.approver.approveMemberJoin('team', waiting.submitted.requestId, 'automatic'),
      /e2ee_member_invitation_endorser_ineligible/
    )
    assert.equal(f.records.length, before)
  }
)

const e2eeIpcDependencies = (runtime, sender, recordMethod = () => {}) => ({
  '../ipc-service-deps': { getIpcServiceDeps: () => ({ cliService: {} }) },
  '../product-window-ipc-service': { ProductWindowIpcService: class {} },
  'electron-ipc-decorator': {
    IpcMethod: () => (_target, name, descriptor) => {
      recordMethod(name)
      return descriptor
    },
    getIpcContext: () => ({ event: { sender } })
  },
  '../../platform': { isLocalPlatform: () => false },
  '../../services/e2ee-bootstrap.mjs': {},
  '../../services/e2ee-account-runtime': runtime,
  '../assert-sender': { assertProductWindowSender: () => {} }
})

void test('preload admits every renderer-facing E2EE IPC method', async () => {
  // Preload lists the E2EE methods it admits; every `@IpcMethod()` must be on it,
  // or the renderer cannot call a method the product already uses (#2204 shipped
  // the account pairing methods without it).
  const methods = []
  await load(
    '../ipc/services/e2ee-ipc.ts',
    e2eeIpcDependencies({}, new EventEmitter(), (name) => methods.push(name))
  )
  assert.ok(methods.includes('requestAccountPairing'))
  assert.deepEqual(
    methods.filter((method) => !isIpcInvokeChannel(`e2ee.${method}`)),
    []
  )
})

/** Another device (the phone) created an encrypted workspace under this account;
 * this desktop has never opened anything. Account pairing runs through the real
 * IPC service, account runtime, custody and journals, as production wires them. */
async function newDesktopAccountPairing(t, pairingSubmit) {
  const phone = await nativeAccountFixture(t)
  const created = await createAccountWorkspace(phone.api, 'workspace')
  const genesisHash = created.creation.genesisHashHex
  const ledgerPage = async () => {
    const ledger = await phone.api.withDesktopE2eeAccount(
      (owner) => owner.host.ledgerView('workspace'),
      'workspace'
    )
    return {
      workspaceId: 'workspace',
      genesisHash,
      startIndex: 0,
      recordsHex: ledger.recordsHex,
      checkpoint: { length: ledger.status.length, headHash: ledger.status.headHash },
      position: `p1:workspace:${ledger.status.length}:source-${ledger.status.length}:0`,
      nextCursor: null
    }
  }
  const desktop = await nativeAccountFixture(t)
  const client = {
    history: () => Effect.promise(ledgerPage),
    pairingSubmit,
    pairingClaim: () => Effect.succeed({ status: 'pending', approvals: [] })
  }
  const sender = Object.assign(new EventEmitter(), {
    id: 31,
    isDestroyed: () => false,
    send: () => {}
  })
  const { E2eeIpc } = await load(
    '../ipc/services/e2ee-ipc.ts',
    e2eeIpcDependencies(
      {
        ...desktop.api,
        desktopE2eeCloudClient: async () => ({ accountId: 'acc1', client }),
        desktopAccountPairingDatabase: (accountId) =>
          join(desktop.directory, `account-pairing-${accountId}.sqlite`)
      },
      sender
    )
  )
  const ipc = new E2eeIpc()
  const hints = [{ workspaceId: 'workspace', name: 'Phone workspace', genesisHash }]
  return { ipc, hints, genesisHash }
}

void test('a brand-new desktop gets a pairing code for a workspace another device created', async (t) => {
  const submitted = []
  const { ipc, hints, genesisHash } = await newDesktopAccountPairing(t, (request) =>
    Effect.sync(() => {
      submitted.push(request)
      return {
        requestId: 'request-1',
        status: 'pending',
        deviceName: request.deviceName,
        approximateLocation: null,
        requestedAt: Date.now(),
        expiresAt: request.expiresAt
      }
    })
  )
  // The renderer first asks for a retained request, then starts one.
  assert.equal(await ipc.accountPairingRequest(hints), null)
  const state = await ipc.requestAccountPairing({}, hints)
  assert.equal(state.status, 'waiting')
  assert.match(state.pairingString, /\S/)
  assert.deepEqual(state.workspaces, [
    { workspaceId: 'workspace', name: 'Phone workspace', state: 'pending', approval: 'waiting' }
  ])
  assert.deepEqual(
    submitted.map((request) => request.workspaces),
    [[{ workspaceId: 'workspace', genesisHash }]]
  )
})

void test('IPC requestAccountPairing decouples preserveExisting from multi-workspace hints and optional workspaceId', async (t) => {
  const phone = await nativeAccountFixture(t)
  const first = await createAccountWorkspace(phone.api, 'workspace-a')
  const second = await createAccountWorkspace(phone.api, 'workspace-b')
  const ledgerPage = async (workspaceId) => {
    const genesisHash =
      workspaceId === 'workspace-a' ? first.creation.genesisHashHex : second.creation.genesisHashHex
    const ledger = await phone.api.withDesktopE2eeAccount(
      (owner) => owner.host.ledgerView(workspaceId),
      workspaceId
    )
    return {
      workspaceId,
      genesisHash,
      startIndex: 0,
      recordsHex: ledger.recordsHex,
      checkpoint: { length: ledger.status.length, headHash: ledger.status.headHash },
      position: `p1:${workspaceId}:${ledger.status.length}:source-${ledger.status.length}:0`,
      nextCursor: null
    }
  }
  const submitted = []
  const desktop = await nativeAccountFixture(t)
  const client = {
    history: ({ workspaceId }) => Effect.promise(() => ledgerPage(workspaceId)),
    pairingSubmit: (request) =>
      Effect.sync(() => {
        submitted.push(request)
        return {
          requestId: `request-${submitted.length}`,
          status: 'pending',
          deviceName: request.deviceName,
          approximateLocation: null,
          requestedAt: Date.now(),
          expiresAt: request.expiresAt
        }
      }),
    pairingClaim: () => Effect.succeed({ status: 'pending', approvals: [] })
  }
  const sender = Object.assign(new EventEmitter(), {
    id: 32,
    isDestroyed: () => false,
    send: () => {}
  })
  const { E2eeIpc } = await load(
    '../ipc/services/e2ee-ipc.ts',
    e2eeIpcDependencies(
      {
        ...desktop.api,
        desktopE2eeCloudClient: async () => ({ accountId: 'acc1', client }),
        desktopAccountPairingDatabase: (accountId) =>
          join(desktop.directory, `account-pairing-${accountId}.sqlite`)
      },
      sender
    )
  )
  const ipc = new E2eeIpc()
  const hints = [
    { workspaceId: 'workspace-a', name: 'Alpha', genesisHash: first.creation.genesisHashHex },
    { workspaceId: 'workspace-b', name: 'Beta', genesisHash: second.creation.genesisHashHex }
  ]
  const makeCode = (fillByte) => {
    const secret = new Uint8Array(16).fill(fillByte)
    const keys = Result.getOrThrow(derivePairingKeys(secret))
    const lookupId = Buffer.from(keys.lookupId).toString('hex')
    disposePairingKeys(keys)
    const pairingString = formatPairingString(Result.getOrThrow(encodePairingSecret(secret)))
    secret.fill(0)
    return { pairingString, lookupId }
  }
  const codeOne = makeCode(11)
  const codeTwo = makeCode(22)

  // Account-wide external link confirmation passes preserveExisting across 2+ workspaces.
  const allState = await ipc.requestAccountPairing(
    { pairingString: codeOne.pairingString, preserveExisting: true },
    hints
  )
  assert.equal(allState.status, 'waiting')
  assert.deepEqual(allState.workspaces.map((w) => w.workspaceId).sort(), [
    'workspace-a',
    'workspace-b'
  ])
  // Another preserveExisting request refuses with pairing-elsewhere while codeOne is open.
  await assert.rejects(
    ipc.requestAccountPairing(
      { pairingString: codeTwo.pairingString, preserveExisting: true },
      hints
    ),
    { message: 'e2ee_pairing-elsewhere' }
  )
  // Cancelling with a non-matching lookupId preserves codeOne; matching lookupId cancels it.
  await ipc.cancelAccountPairing({ expectedLookupId: codeTwo.lookupId })
  assert.equal((await ipc.accountPairingRequest(hints))?.status, 'waiting')
  await ipc.cancelAccountPairing({ expectedLookupId: codeOne.lookupId })
  assert.equal((await ipc.accountPairingRequest(hints))?.status, 'expired')

  // Automatic pairing passes workspaceId explicitly and scopes to that single workspace.
  const singleState = await ipc.requestAccountPairing(
    {
      pairingString: codeTwo.pairingString,
      preserveExisting: true,
      workspaceId: 'workspace-b'
    },
    [hints[1]]
  )
  assert.deepEqual(
    singleState.workspaces.map((w) => w.workspaceId),
    ['workspace-b']
  )
})

for (const code of ['pairing-unavailable', 'pairing-rate-limited'])
  void test(`a relay refusal (${code}) reaches the new desktop's UI with its reason`, async (t) => {
    const refusal = Object.assign(new Error('synthetic private relay cause'), { code })
    const { ipc, hints } = await newDesktopAccountPairing(t, () => Effect.fail(refusal))
    await assert.rejects(ipc.requestAccountPairing({}, hints), (error) => {
      assert.equal(error.message, `e2ee_${code}`)
      assert.equal(ipc.pairingFailure, refusal)
      return true
    })
  })
// Critical path from the approval result: approver calls until its envelope `put`, one
// member claim that just missed it plus the 3 s cadence, then the claim that installs.
void test(
  'an admitted member is ready within 30 s of the approval result on the critical path',
  { timeout: 20_000 },
  async (t) => {
    const calls = { owner: [], member: [] }
    let held
    let reachedPut
    const f = await twoDeviceMemberJoin(t, {
      latency: (name, { device }) => {
        calls[device].push(name)
        if (!(held && device === 'owner' && name === 'mailbox.put')) return Effect.void
        reachedPut.resolve()
        return Effect.promise(() => held.promise)
      }
    })
    await f.approver.open('team')
    // The approver has already run full key rounds, as after earlier pairings.
    await f.approver.refresh('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    held = deferredMember()
    reachedPut = deferredMember()
    const approvalStart = calls.owner.length
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    await reachedPut.promise
    const approval = calls.owner.slice(approvalStart)
    const toPut = approval.length - approval.lastIndexOf('memberRead') - 1
    // The member's first committed claim accepts the verified history; a later retry
    // runs just before the envelope exists and misses it.
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, false)
    calls.member = []
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, false)
    const missed = calls.member.length
    held.resolve()
    await f.approver.keyDeliveryIdle('acc1', 'team')
    calls.member = []
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, true)
    const installing = claimCalls(calls.member)
    // Off the ready path, main still flushes the member's installation report and then
    // releases the workspace the claim opened.
    await f.joiner.memberSettleIdle('member', 'team')
    assert.ok(calls.member.slice(installing).includes('mailbox.report'))
    assert.equal(
      await f.memberApi.withDesktopE2eeAccount(
        (account) => Effect.succeed(account.readers.has('team')),
        'team',
        false
      ),
      false
    )
    const seconds = (toPut + missed + installing) * RELAY_CALL_S + TOKEN_MINT_S + 3
    t.diagnostic(
      `to put ${toPut}, missed claim ${missed}, installing claim ${installing}: about ${seconds.toFixed(1)} s`
    )
    assert.ok(seconds <= 30, `about ${seconds.toFixed(1)} s from approval to ready`)
  }
)
/** Relay round trips on the critical path, from the calling fibers' fork/join structure
 * rather than wall-clock time. A call follows every earlier call of its own fiber, the
 * calls its forking fibers made before it, and the subtrees of fibers that finished
 * before it was created; concurrently running siblings do not delay each other.
 * Concurrent `Effect.forEach` forks detached children and evaluates them at once, so
 * the forking fiber is the one current at a fiber's first evaluation. */
function criticalPath(t) {
  // A fresh fiber id, ordered against every fiber created so far.
  const serial = () => Effect.runFork(Effect.void).id
  const Impl = Effect.runFork(Effect.void).constructor
  const evaluate = Impl.prototype.evaluate
  const forkedBy = new WeakMap()
  const born = serial()
  Impl.prototype.evaluate = function (effect) {
    if (this.id > born && !forkedBy.has(this))
      forkedBy.set(this, Fiber.getCurrent() ?? this._parent)
    return evaluate.call(this, effect)
  }
  t.after(() => {
    Impl.prototype.evaluate = evaluate
  })
  const parent = (fiber) => forkedBy.get(fiber) ?? fiber._parent
  const fibers = new Map()
  let longest = 0
  const track = (fiber) => {
    let entry = fibers.get(fiber)
    if (entry) return entry
    entry = { own: undefined, subtree: 0, finished: undefined, children: new Set() }
    fibers.set(fiber, entry)
    const tracked = entry
    fiber.addObserver(() => {
      tracked.finished = serial()
    })
    if (parent(fiber)) track(parent(fiber)).children.add(fiber)
    return entry
  }
  const finishedBefore = (entry, id, except) => {
    let longestChild = 0
    for (const child of entry.children) {
      const done = fibers.get(child)
      if (child !== except && done.finished !== undefined && done.finished < id)
        longestChild = Math.max(longestChild, done.subtree)
    }
    return longestChild
  }
  const start = (fiber) => {
    const above = parent(fiber)
    if (!above) return 0
    const entry = fibers.get(above)
    return Math.max(entry.own ?? start(above), finishedBefore(entry, fiber.id, fiber))
  }
  return {
    call: () =>
      Effect.withFiberSucceed((fiber) => {
        const entry = track(fiber)
        const depth =
          Math.max(entry.own ?? start(fiber), finishedBefore(entry, Number.POSITIVE_INFINITY)) + 1
        entry.own = depth
        for (let at = fiber; at; at = parent(at)) {
          const above = fibers.get(at)
          above.subtree = Math.max(above.subtree, depth)
        }
        longest = Math.max(longest, depth)
      }),
    longest: () => longest
  }
}
/** The J07 shape: an approver, five member devices and a removed sixth member whose
 * removal rotated to epoch 1. The approver's next full round sends the new epoch key
 * to the five remaining devices. */
async function rotatedTeam(t, latency) {
  const f = await twoDeviceMemberJoin(t, { latency })
  await f.approver.open('team')
  const joined = async (joiner, submitted, accountId) => {
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    let claimed = await joiner.claimMemberJoin('team', submitted.requestId)
    for (let attempt = 0; !claimed.ready && attempt < 3; attempt++)
      claimed = await joiner.claimMemberJoin('team', submitted.requestId)
    assert.equal(claimed.ready, true)
    await joiner.memberSettleIdle(accountId, 'team')
  }
  await joined(f.joiner, await f.submit(), 'member')
  const others = []
  for (const [index, name] of ['m2', 'm3', 'm4', 'm5', 'm6'].entries()) {
    const other = await f.addMember(name, 10 + index)
    await joined(other.ipc, other.submitted, name)
    others.push(other)
  }
  await f.approver.removeMember('team', others.at(-1).submitted.requestId)
  await f.approver.updateKeys('team')
  return f
}
// At ~1.3 s per relay call (B on-site run22: 36 serial mailbox calls, 47.7 s) only about
// ten round trips fit beside the rest of J07/continue's 60 s window.
void test(
  'a full key round reaches every other device in a bounded number of serial relay round trips',
  { timeout: 120_000 },
  async (t) => {
    let path
    const calls = []
    const f = await rotatedTeam(t, (name, { device }) => {
      if (!path || device !== 'owner' || !name.startsWith('mailbox.')) return Effect.void
      calls.push(name)
      // A relay call suspends its fiber, as a network round trip does.
      return Effect.andThen(path.call(), Effect.yieldNow)
    })
    path = criticalPath(t)
    await f.approver.refresh('team')
    const tally = Object.entries(
      calls.reduce((counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }), {})
    )
    t.diagnostic(`round trips ${path.longest()} of ${calls.length} calls: ${tally.join(' ')}`)
    assert.equal(calls.filter((name) => name === 'mailbox.put').length, 5)
    assert.ok(path.longest() <= 10, `${path.longest()} serial mailbox round trips`)
  }
)
void test(
  'a delivery refused during a concurrent round stays pending with its original while the other devices are delivered',
  { timeout: 120_000 },
  async (t) => {
    let watching = false
    let refusing = true
    let refused
    const puts = []
    const f = await rotatedTeam(t, (name, { device, args }) => {
      if (!watching || device !== 'owner' || name !== 'mailbox.put') return Effect.void
      const [slot, frame] = args
      puts.push({ slot, frame: Buffer.from(frame).toString('hex') })
      refused ??= puts.at(-1)
      return refusing && slot === refused.slot
        ? Effect.fail(new BackendError({ service: 'KeyMailbox', reason: 'conflict' }))
        : Effect.yieldNow
    })
    watching = true
    await f.approver.refresh('team')
    refusing = false
    assert.equal(new Set(puts.map((put) => put.slot)).size, 5)
    // The next round re-sends only the refused task, with its exact original ciphertext.
    puts.length = 0
    await f.approver.refresh('team')
    assert.deepEqual(puts, [refused])
    puts.length = 0
    await f.approver.refresh('team')
    assert.deepEqual(puts, [])
  }
)
void test(
  'a member accepted before a rotation is ready only with the current epoch key, never the old one',
  { timeout: 30_000 },
  async (t) => {
    let held
    const f = await twoDeviceMemberJoin(t, {
      latency: (name, { device }) =>
        held && device === 'owner' && name === 'mailbox.put'
          ? Effect.promise(() => held.promise)
          : Effect.void
    })
    await f.approver.open('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    held = deferredMember()
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    // Accepted locally while the epoch 0 envelope is still on its way.
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, false)
    const release = held
    held = undefined
    release.resolve()
    await f.approver.keyDeliveryIdle('acc1', 'team')
    // Before the member's next claim, another member joins and is removed, and the
    // required rotation publishes epoch 1.
    const other = await f.addMember('thr', 3)
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', other.submitted.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    await f.approver.removeMember('team', other.submitted.requestId)
    await f.approver.updateKeys('team')
    const epoch = async (api) =>
      (await api.withDesktopE2eeAccount((account) => account.host.status('team'), 'team', false))
        .epoch
    assert.equal(await epoch(f.ownerApi), 1)
    let claimed = await f.joiner.claimMemberJoin('team', submitted.requestId)
    for (let attempt = 0; !claimed.ready && attempt < 3; attempt++)
      claimed = await f.joiner.claimMemberJoin('team', submitted.requestId)
    assert.equal(claimed.ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    assert.equal(await epoch(f.memberApi), 1)
  }
)
void test(
  'a fast-path claim whose relay history is still paging after 256 pages is not ready',
  { timeout: 30_000 },
  async () => {
    let pages = 0
    let ingested = 0
    const f = await memberIpcFixture({
      bootstrap: { acceptedMemberJoin: () => Effect.succeed(approvalRequest) },
      client: {
        // A 257th page always follows: the local ledger cannot be confirmed current.
        history: () =>
          Effect.sync(() => ({ checkpoint: {}, nextCursor: `page-${++pages}`, recordsHex: [] })),
        mailbox: () => ({}),
        staging: () => ({})
      },
      host: {
        status: () => Effect.succeed({ hasCurrentKey: true, position: 'p1:team:1:fixture' }),
        ingestLedgerRecords: () =>
          Effect.sync(() => {
            ingested++
          }),
        receiveKeys: () => Effect.void
      }
    })
    const claimed = await f.ipc.claimMemberJoin('team', approvalRequest)
    assert.equal(ingested, 256)
    assert.deepEqual({ ...claimed }, { ready: false, state: 'committed' })
  }
)
void test(
  'access loss during the fast-path catch-up removes the local workspace',
  { timeout: 30_000 },
  async (t) => {
    let held
    const f = await twoDeviceMemberJoin(t, {
      latency: (name, { device }) =>
        held && device === 'owner' && name === 'mailbox.put'
          ? Effect.promise(() => held.promise)
          : Effect.void
    })
    await f.approver.open('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    held = deferredMember()
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, false)
    held.resolve()
    held = undefined
    await f.approver.keyDeliveryIdle('acc1', 'team')
    // The member is removed before its next claim; only its credential can confirm it.
    f.relay.memberRemoved = true
    await assert.rejects(
      f.joiner.claimMemberJoin('team', submitted.requestId),
      /^Error: e2ee_member_removed$/
    )
    // The removal receipt fences this identity: reopening reports the removal.
    await assert.rejects(f.joiner.open('team'), /e2ee_member_removed/)
  }
)
void test(
  'a member whose retained join predates signed invitations still reopens its workspace',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    // The join was retained by a build that wrote invitations without an endorsement.
    const find = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
        if (entry.isFile() && entry.name === 'creations.sqlite')
          return join(entry.parentPath, entry.name)
      return null
    }
    const path = await find(f.memberDirectory)
    assert.ok(path)
    const db = new DatabaseSync(path)
    try {
      const row = db
        .prepare('SELECT offer,history FROM member_joins WHERE workspace_id=?')
        .get('team')
      assert.ok(row.history)
      const { signature, ...unsigned } = JSON.parse(row.offer)
      assert.ok(signature)
      db.prepare('UPDATE member_joins SET offer=? WHERE workspace_id=?').run(
        JSON.stringify(unsigned),
        'team'
      )
    } finally {
      db.close()
    }
    const creation = await f.memberApi.withDesktopE2eeAccount(
      (account) => account.bootstrap.creationFor('team'),
      'team',
      false
    )
    assert.equal(creation.genesisHash, f.offer.genesisHash)
  }
)
void test(
  'a removed member that has not yet observed its removal can submit a new invitation',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const first = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', first.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', first.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    // An administrator removes the member and invites it again. The member opens the new
    // invitation before any refresh or token request has told this device of the removal.
    f.relay.memberRemoved = true
    const again = await f.ownerApi.withDesktopE2eeAccount(
      (account) => account.host.memberOffer('team', 'link', 9_000_000_000_000),
      'team',
      false
    )
    assert.notEqual(JSON.stringify(again), JSON.stringify(f.offer))
    const second = await f.joiner.prepareMemberJoin(again)
    assert.notEqual(second.requestId, first.requestId)
    assert.notEqual(second.signingPublicKey, first.signingPublicKey)
    await assert.rejects(f.joiner.open('team'), /e2ee_member_removed/)
    // The new request is the retained pending join; the removed one no longer refuses it.
    assert.equal(
      JSON.stringify(await f.joiner.pendingMemberJoin('team')),
      JSON.stringify({ offer: again, requestId: second.requestId })
    )
  }
)
void test(
  'a removed member whose local erase failed can accept a new invitation once the fault clears',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const first = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', first.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', first.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    f.relay.memberRemoved = true
    // The OS key store becomes unavailable just as the removal is confirmed, so the
    // receipt is recorded but the local erase that follows it fails.
    f.relay.onRemovalConfirmed = () => {
      f.relay.onRemovalConfirmed = undefined
      f.setMemberLocked(true)
    }
    const again = await f.ownerApi.withDesktopE2eeAccount(
      (account) => account.host.memberOffer('team', 'link', 9_000_000_000_000),
      'team',
      false
    )
    await assert.rejects(f.joiner.prepareMemberJoin(again))
    // Once the key store is back, accepting the same invitation finishes the erase and joins.
    f.setMemberLocked(false)
    const second = await f.joiner.prepareMemberJoin(again)
    assert.notEqual(second.requestId, first.requestId)
    assert.equal(
      JSON.stringify(await f.joiner.pendingMemberJoin('team')),
      JSON.stringify({ offer: again, requestId: second.requestId })
    )
  }
)
void test(
  'a sign-in change while a removed join is cleaned up refuses the new invitation',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const first = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', first.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', first.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    f.relay.memberRemoved = true
    // The same account signs in again while the confirmed removal is being cleaned up.
    f.relay.onRemovalConfirmed = () => {
      f.memberIdentity.generation = (f.memberIdentity.generation ?? 0) + 1
    }
    const again = await f.ownerApi.withDesktopE2eeAccount(
      (account) => account.host.memberOffer('team', 'link', 9_000_000_000_000),
      'team',
      false
    )
    await assert.rejects(f.joiner.prepareMemberJoin(again), /^Error: e2ee_host_operation_failed$/)
    f.relay.onRemovalConfirmed = undefined
    // The removal still ends the old workspace, but no request was made for the new sign-in.
    await assert.rejects(f.joiner.open('team'), /e2ee_member_removed/)
    assert.equal(await f.joiner.pendingMemberJoin('team'), null)
  }
)
void test(
  'a current member refuses another invitation and keeps its workspace',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const first = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', first.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', first.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    const again = await f.ownerApi.withDesktopE2eeAccount(
      (account) => account.host.memberOffer('team', 'link', 9_000_000_000_000),
      'team',
      false
    )
    await assert.rejects(f.joiner.prepareMemberJoin(again), /^Error: e2ee_conflict$/)
    assert.equal((await f.joiner.open('team')).hasCurrentKey, true)
  }
)

/** A sign-in server that answers only when told to: each call stays pending until its
 * caller cancels it or the test answers it. */
function slowSignIn() {
  const pending = new Set()
  return {
    pending,
    convexToken: (_options, signal) =>
      new Promise((resolve, reject) => {
        const call = { resolve }
        pending.add(call)
        signal?.addEventListener(
          'abort',
          () => {
            pending.delete(call)
            reject(signal.reason)
          },
          { once: true }
        )
      }),
    answerAll: () => {
      for (const call of pending) call.resolve({ data: { token: 'synthetic-auth-jwt' } })
      pending.clear()
    }
  }
}
/** The account's own cloud client against one synthetic history endpoint. */
async function slowSignInAccount(t, signIn) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-slow-sign-in-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { api } = await account({
    directory,
    auth: { convexToken: signIn.convexToken },
    cloud: (input) =>
      makeE2eeCloudClient({
        ...input,
        deploymentUrl: 'https://synthetic.convex.cloud',
        fetch: async () =>
          Response.json({
            status: 'success',
            value: {
              workspaceId: 'workspace',
              genesisHash: '11'.repeat(32),
              checkpoint: { headHash: '11'.repeat(32), length: 1 },
              startIndex: 1,
              recordsHex: [],
              position: 'p1:workspace:1:synthetic',
              nextCursor: null
            }
          })
      })
  })
  t.after(() => api.closeDesktopE2eeAccount())
  return api
}
const settle = async (until) => {
  for (let turn = 0; turn < 200 && !until(); turn++)
    await new Promise((resolve) => setImmediate(resolve))
}
void test('quitting ends a request waiting on a slow sign-in token within the quit budget', async (t) => {
  // Injected clock: the 15 s quit budget and the 30 s request deadline only pass when ticked.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signIn = slowSignIn()
  const api = await slowSignInAccount(t, signIn)
  const { client } = await api.desktopE2eeCloudClient()
  // Stands in for a key round's history read; the host's close awaits that round.
  const round = Effect.runPromiseExit(client.history({ workspaceId: 'workspace' }))
  await settle(() => signIn.pending.size === 1)
  assert.equal(signIn.pending.size, 1)
  let finished = false
  const drained = drainMainProcessQuitResources(
    [
      {
        name: 'e2ee',
        close: async () => {
          await api.closeDesktopE2eeAccount({ quit: true })
          await round
        }
      }
    ],
    15_000
  ).finally(() => {
    finished = true
  })
  await settle(() => finished)
  t.mock.timers.tick(15_000)
  assert.deepEqual(await drained, [])
  // Cancelling the quit left no token request behind.
  assert.equal(signIn.pending.size, 0)
  assert.equal(Exit.isFailure(await round), true)
})
void test('a slow sign-in token still completes a request when nothing is quitting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signIn = slowSignIn()
  const api = await slowSignInAccount(t, signIn)
  const { client } = await api.desktopE2eeCloudClient()
  const read = Effect.runPromise(client.history({ workspaceId: 'workspace' }))
  await settle(() => signIn.pending.size === 1)
  // Slower than the quit budget, inside the request's own deadline.
  t.mock.timers.tick(20_000)
  signIn.answerAll()
  assert.equal((await read).position, 'p1:workspace:1:synthetic')
})

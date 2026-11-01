import * as identityStorage from '@lody/shared/node/e2ee-identity'
import { E2eeDeviceRevokedError, E2eeMemberRemovedError } from './e2ee-cloud-errors.mts'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile, mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { Effect, Scope, Exit, Result } from 'effect'
import {
  Bytes,
  hashRecordBytes,
  verifyLedger,
  prepareLedgerCommand,
  signLedgerRecord
} from '@lody/e2ee-core/protocol'
import { makeDesktopE2eeCustody } from '../e2ee-custody.mts'
import { makeDesktopE2eeBootstrap } from './e2ee-bootstrap.mts'
import { makeDesktopE2eeRuntimeHost } from './e2ee-runtime.mts'
import { makeDesktopAccountPairingHost } from './e2ee-account-pairing-host.mts'
import { makeOfflineAuthIdentityCache } from '../auth-storage.ts'
import * as electronIpc from '../../../../../packages/shared/src/electron-ipc.ts'
import { isIpcInvokeChannel } from '../../preload/ipc-invoke-policy.ts'
import * as memberJoining from './e2ee-member-join.mts'
import { PersonalPairingOfferSchema } from './e2ee-personal-pairing.mts'
import { desktopE2eeFailure, rememberDesktopE2eeFailure } from './e2ee-diagnostics.mts'
import { createDesktopQuitBarrier, drainMainProcessQuitResources } from './desktop-shutdown.ts'
const require = createRequire(import.meta.url)
async function load(relative, dependencies, console = globalThis.console, env = {}) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8')
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
                    : id === '../../services/e2ee-client-loss-probe'
                      ? // Production default: the E2E probe is disabled and forwards work.
                        { observeClientLossOperation: (_kind, _workspace, _sender, work) => work() }
                      : require(id)
    }
  )
  return exports
}
async function account(options = {}) {
  const identity = { userId: 'account', generation: 1 }
  let identityListener = () => {}
  const auth = {
    subscribeCachedSessionIdentity: (listener) => {
      identityListener = listener
      return () => {}
    },
    getCachedSessionIdentity: () => ({ ...identity }),
    getBootstrapSession: () => new Promise(() => {})
  }
  const warnings = []
  const api = await load(
    './e2ee-account-runtime.ts',
    {
      electron: { app: { getPath: () => options.directory ?? '/synthetic-user-data' } },
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
  const inspect = () => api.inspectDesktopE2eeCachedState('account', 'team', 'machine')
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
  const sender = Object.assign(new EventEmitter(), { id: 7 })
  const readers = new Map()
  const owner = {
    readers,
    host: { open: () => Effect.succeed('open'), status: () => Effect.succeed('ready') }
  }
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    '../ipc-service-deps': { getIpcServiceDeps: () => ({}) },
    'electron-ipc-decorator': {
      IpcService: class {},
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

void test('uncertain admission preserves append and reconciliation failures, then accepts verified retry', async () => {
  const sender = Object.assign(new EventEmitter(), { id: 17 })
  const appendFailure = new Error('synthetic sanitized append failure')
  const reconciliationFailure = new Error('e2ee_invalid-input')
  const request = { workspaceId: 'workspace', requestId: 'stable-request', recordHex: 'aabb' }
  const submitted = []
  let committed = false
  const owner = {
    accountId: 'account',
    bootstrap: { deviceCredential: () => Effect.succeed('synthetic-credential') },
    readers: new Map([['workspace', new Set([sender.id])]]),
    host: {
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
            activateLocalE2eeDevice: async () => {}
          }
        })
      },
      'electron-ipc-decorator': {
        IpcService: class {},
        IpcMethod: () => (_target, _name, descriptor) => descriptor,
        getIpcContext: () => ({ event: { sender } })
      },
      '../../platform': { isLocalPlatform: () => false },
      '../../services/e2ee-bootstrap.mjs': {},
      '../../services/e2ee-account-runtime': {
        withDesktopE2eeAccount: (work) => Effect.runPromise(work(owner)),
        desktopE2eeCloudClient: async () => ({
          accountId: 'account',
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
  ipc.refresh = async () => {}
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
  const result = await ipc.admitLocalAgent('workspace', session)
  assert.equal(result.admitted, true)
  assert.equal(result.ready, true)
  assert.equal(ipc.pairingFailure, undefined)
  assert.deepEqual(submitted, [request, request])
  assert.deepEqual(warnings, [])
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
    'account'
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
    [
      'runtime-operation',
      () => native.api.runDesktopE2eeOperation('account', Effect.fail(original))
    ]
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

void test('main cached identity follows resolved sessions, transport failures and definitive sign-out without a new query', async () => {
  let response = { data: { user: { id: 'first' }, session: { token: 'synthetic-token' } } }
  let offline = false
  const { AuthService } = await load(
    './auth-service.ts',
    {
      electron: { app: {}, safeStorage: {}, shell: {} },
      '../auth': {
        offlineAuthIdentity: makeOfflineAuthIdentityCache({
          get: () => null,
          set: () => {},
          delete: () => {}
        }),
        authClient: {
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
  const service = new AuthService()
  assert.equal(service.getCachedSessionIdentity().userId, null)
  await service.getSession()
  assert.equal(service.getCachedSessionIdentity().userId, 'first')
  offline = true
  await service.getSession()
  assert.equal(service.getCachedSessionIdentity().userId, 'first')
  offline = false
  response = { data: null }
  await service.getSession()
  assert.equal(service.getCachedSessionIdentity().userId, null)
  response = { data: { user: { id: 'second' }, session: { token: 'synthetic-token2' } } }
  await service.getSession()
  const before = service.getCachedSessionIdentity()
  assert.equal(before.userId, 'second')
  await service.signOut()
  const after = service.getCachedSessionIdentity()
  assert.equal(after.userId, null)
  assert.ok(after.generation > before.generation)
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
  let response = { data: { user: { id: 'account' }, session: { token: 'synthetic-token' } } }
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
  assert.equal(reopened.getCachedSessionIdentity().userId, 'account')
  assert.equal(reopened.getCachedSessionIdentity().source, 'offline')
  const bearer = (token) => ({ fetchOptions: { headers: { Authorization: `Bearer ${token}` } } })
  assert.equal(reopened.getCachedSessionIdentity(bearer('wrong-token')).userId, null)
  cookie = ''
  const bearerOnly = new AuthService()
  assert.equal(bearerOnly.getCachedSessionIdentity().userId, null)
  assert.equal(bearerOnly.getCachedSessionIdentity(bearer('synthetic-token')).userId, 'account')
  assert.equal(bearerOnly.getCachedSessionIdentity().userId, 'account')
  cookieUnavailable = true
  assert.equal(bearerOnly.getCachedSessionIdentity().userId, 'account')
  assert.equal(
    new AuthService().getCachedSessionIdentity(bearer('synthetic-token')).userId,
    'account'
  )
  cookieUnavailable = false
  const observed = []
  bearerOnly.subscribeCachedSessionIdentity(() =>
    observed.push(bearerOnly.getCachedSessionIdentity().userId)
  )
  offline = false
  response = { data: { user: { id: 'other-account' }, session: { token: 'other-token' } } }
  await bearerOnly.getSession()
  assert.deepEqual(observed, ['other-account'])
  offline = true
  await bearerOnly.getSession()
  assert.deepEqual(observed, ['other-account'])
  await bearerOnly.signOut()
  assert.deepEqual(observed, ['other-account', null])
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

void test('personal join cancellation preserves remote success when local retirement fails and retries without a network lock', async () => {
  const sender = Object.assign(new EventEmitter(), { id: 18 })
  let localFailure = true,
    retired = false,
    lockDepth = 0
  const diagnostic = new Error('synthetic private storage failure')
  const owner = {
    accountId: 'account',
    readers: new Map(),
    bootstrap: {
      pendingPersonalJoin: () => Effect.succeed({ pairingSessionId: '44'.repeat(16) }),
      retirePersonalJoin: () =>
        Effect.suspend(() =>
          localFailure
            ? Effect.fail(diagnostic)
            : Effect.sync(() => {
                retired = true
              })
        )
    }
  }
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    'electron-ipc-decorator': {
      IpcService: class {},
      IpcMethod: () => (_t, _n, descriptor) => descriptor,
      getIpcContext: () => ({ event: { sender } })
    },
    '../../platform': { isLocalPlatform: () => false },
    '../../services/e2ee-bootstrap.mjs': {},
    '../ipc-service-deps': { getIpcServiceDeps: () => ({}) },
    '../assert-sender': { assertProductWindowSender: () => {} },
    '../../services/e2ee-account-runtime': {
      withDesktopE2eeAccount: async (work) => {
        lockDepth++
        try {
          return await Effect.runPromise(work(owner))
        } finally {
          lockDepth--
        }
      },
      desktopE2eeCloudClient: async () => ({
        accountId: 'account',
        client: {
          joinCancel: () =>
            Effect.sync(() => {
              assert.equal(lockDepth, 0)
              return { status: 'cancelled' }
            })
        }
      })
    }
  })
  const ipc = new E2eeIpc()
  const result = await ipc.cancelPersonalJoin('workspace', '44'.repeat(16))
  assert.equal(result.status, 'cancelled')
  assert.equal(retired, false)
  assert.equal(ipc.pairingFailure.errors[0], diagnostic)
  localFailure = false
  assert.equal((await ipc.cancelPersonalJoin('workspace', '44'.repeat(16))).status, 'cancelled')
  assert.equal(retired, true)
})

void test('cancelled personal approval uses terminal cancellation rather than retiring an uncertain signed record', async () => {
  const sender = Object.assign(new EventEmitter(), { id: 19 })
  let cancelled = false
  const owner = {
    accountId: 'account',
    readers: new Map([['workspace', new Set([sender.id])]]),
    bootstrap: { deviceCredential: () => Effect.succeed('synthetic-credential') },
    host: {
      cancelPersonalPairing: () =>
        Effect.sync(() => {
          cancelled = true
        }),
      retirePersonalPairing: () =>
        Effect.die(new Error('uncertain record must not use generic retirement'))
    }
  }
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    'electron-ipc-decorator': {
      IpcService: class {},
      IpcMethod: () => (_t, _n, descriptor) => descriptor,
      getIpcContext: () => ({ event: { sender } })
    },
    '../../platform': { isLocalPlatform: () => false },
    '../../services/e2ee-bootstrap.mjs': {},
    '../ipc-service-deps': { getIpcServiceDeps: () => ({}) },
    '../assert-sender': { assertProductWindowSender: () => {} },
    '../../services/e2ee-account-runtime': {
      withDesktopE2eeAccount: (work) => Effect.runPromise(work(owner)),
      desktopE2eeCloudClient: async () => ({
        accountId: 'account',
        client: { joinReadRequest: () => Effect.succeed({ status: 'cancelled' }) }
      })
    }
  })
  const ipc = new E2eeIpc()
  await assert.rejects(ipc.inspectPersonalJoin('workspace', '44'.repeat(16)), /e2ee_join_cancelled/)
  assert.equal(cancelled, true)
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
  const accountId = 'synthetic-personal-account'
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
        yield* bootstrap.recordAccountIdentity({ accountId, cryptoUserId: 'aa'.repeat(32) })
        const host = yield* makeDesktopE2eeRuntimeHost({ directory: path, custody, bootstrap })
        return { custody, bootstrap, host }
      }).pipe(Effect.provideService(Scope.Scope, scope))
    )
    const sender = Object.assign(new EventEmitter(), { id: 23 })
    const owner = { ...material, accountId, readers: new Map() }
    const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
      'electron-ipc-decorator': {
        IpcService: class {},
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
        withDesktopE2eeAccount: async (work) => {
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
          if (erased) owner.readers.delete(removedWorkspaceId)
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
    {}
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
    owner.ipc.readIdentity({ accountId: 'other-account', workspaceId: f.workspaceId }),
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

for (const change of ['account switch', 'same-account logout/login'])
  void test(`D03 registration waits outside the account lock and rejects a late response after ${change}`, async () => {
    const entered = Promise.withResolvers()
    const response = Promise.withResolvers()
    let signatures = 0
    let cached = 0
    const { api, publishIdentity } = await account({
      bootstrap: () =>
        Effect.succeed({
          creationNeedsAccountIdentity: () => Effect.succeed(true),
          recordAccountIdentity: () =>
            Effect.sync(() => {
              cached++
            }),
          prepareCreation: () =>
            Effect.sync(() => {
              signatures++
              return 'signed'
            })
        }),
      cloud: () =>
        Effect.succeed({
          accountIdentity: () =>
            Effect.promise(async () => {
              entered.resolve()
              return response.promise
            })
        })
    })
    const creation = api.prepareDesktopE2eeCreation({
      accountId: 'account',
      requestId: 'request-0123456789',
      name: 'Synthetic',
      slug: 'synthetic'
    })
    await entered.promise
    assert.equal(
      await api.withDesktopE2eeAccount((owner) => Effect.succeed(owner.accountId)),
      'account'
    )
    if (change === 'account switch') publishIdentity('other-account')
    else {
      publishIdentity(null)
      publishIdentity('account')
    }
    response.resolve({ accountId: 'account', cryptoUserId: 'aa'.repeat(32) })
    await assert.rejects(creation, /e2ee_/)
    assert.equal(signatures, 0)
    assert.equal(cached, 0)
    assert.equal(
      await api.withDesktopE2eeAccount((owner) => Effect.succeed(owner.accountId)),
      change === 'account switch' ? 'other-account' : 'account'
    )
    await api.closeDesktopE2eeAccount()
  })

void test('D03 exact signed retry and registered local identity do not acquire a cloud client', async () => {
  const original = Object.freeze({ genesisRecordHex: 'synthetic-original' })
  const { api } = await account({
    bootstrap: () =>
      Effect.succeed({
        creationNeedsAccountIdentity: () => Effect.succeed(false),
        prepareCreation: () => Effect.succeed(original)
      }),
    cloud: () => Effect.die(new Error('unexpected cloud call'))
  })
  assert.equal(
    await api.prepareDesktopE2eeCreation({
      accountId: 'account',
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

void test('the operation boundary keeps typed access loss exact and never trusts a matching message', async () => {
  const { api } = await account()
  for (const [typed, code] of [
    [new E2eeMemberRemovedError(), 'member_removed'],
    [new E2eeDeviceRevokedError(), 'device_revoked'],
    // A typed loss wrapped as another error's cause is still the server's answer.
    [new Error('synthetic wrapper', { cause: new E2eeMemberRemovedError() }), 'member_removed']
  ]) {
    const error = await api.runDesktopE2eeOperation('account', Effect.fail(typed)).catch((e) => e)
    assert.equal(error.message, `e2ee_${code}`)
    assert.equal(api.publicAccessLoss(error), code)
  }
  const forged = await api
    .runDesktopE2eeOperation('account', Effect.fail(new Error('e2ee_member_removed')))
    .catch((e) => e)
  assert.equal(forged.message, 'e2ee_host_operation_failed')
  assert.equal(api.publicAccessLoss(forged), null)
  assert.equal(api.publicAccessLoss(new Error('e2ee_member_removed')), null)
})

void test('management diagnostics preserve safe recovery actions without exposing native causes', async () => {
  const { api } = await account()
  for (const code of [
    'rotation_candidate_unavailable',
    'management_unauthorized',
    'management_retry'
  ]) {
    await assert.rejects(
      api.runDesktopE2eeOperation('account', Effect.fail({ code, cause: 'synthetic-secret' })),
      (error) => {
        assert.equal(error.message, `e2ee_${code}`)
        assert.equal(error.cause, undefined)
        assert.equal(JSON.stringify(error).includes('synthetic-secret'), false)
        return true
      }
    )
  }
})

async function nativeAccountFixture(t, storage = identityStorage) {
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
    identityStorage: storage,
    custody: (path) => makeDesktopE2eeCustody({ directory: path, platform: 'linux', safeStorage }),
    bootstrap: makeDesktopE2eeBootstrap,
    host: makeDesktopE2eeRuntimeHost,
    cloud: () =>
      Effect.succeed({
        accountIdentity: () =>
          Effect.succeed({ accountId: 'account', cryptoUserId: 'aa'.repeat(32) })
      })
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
        yield* owner.bootstrap.recordAccountIdentity({
          accountId: owner.accountId,
          cryptoUserId: 'aa'.repeat(32)
        })
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
    accountId: 'account',
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
        identity.userId = 'other-account'
        identity.generation++
        const other = await createAccountWorkspace(api, 'workspace')
        identity.userId = 'account'
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
        if (change === 'account switch') identity.userId = 'other-account'
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
  const sender = Object.assign(new EventEmitter(), { id: 17 })
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    '../ipc-service-deps': { getIpcServiceDeps: () => ({}) },
    'electron-ipc-decorator': {
      IpcService: class {},
      IpcMethod: () => (_target, _name, descriptor) => descriptor,
      getIpcContext: () => ({ event: { sender } })
    },
    '../../platform': { isLocalPlatform: () => false },
    '../../services/e2ee-bootstrap.mjs': {},
    '../../services/e2ee-account-runtime': {
      ...api,
      desktopE2eeCloudClient: async () => ({
        accountId: 'account',
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
    { ...(await ipc.readIdentity({ accountId: 'account', workspaceId: 'workspace' })) },
    {
      workspaceId: 'workspace',
      genesisHash: first.creation.genesisHashHex
    }
  )
  await assert.rejects(ipc.status('workspace'), /e2ee_/)
  await assert.rejects(
    ipc.readIdentity({ accountId: 'other-account', workspaceId: 'workspace' }),
    /e2ee_/
  )
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
  await ipc.readIdentity({ accountId: 'account', workspaceId: 'workspace' })
  assert.equal((await ipc.status('workspace')).genesisHash, first.creation.genesisHashHex)
  await ipc.close('workspace')
})

void test('real preload bridge admits only confirmed trusted reset IPC and archives native originals', async (t) => {
  const { api } = await nativeAccountFixture(t)
  const first = await createAccountWorkspace(api, 'workspace')
  const sender = Object.assign(new EventEmitter(), { id: 18 })
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
    'electron-ipc-decorator': {
      IpcService: class {},
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
  await assert.rejects(owner.ipc.status(f.workspaceId), /e2ee_not_open/)
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
    ['credential-change', Effect.fail(new E2eeMemberRemovedError()), null]
  ]) {
    await t.test(name, async (subtest) => {
      const { api, identity } = await nativeAccountFixture(subtest)
      let nativeOwner
      const first = await createAccountWorkspace(api, 'workspace')
      const sender = Object.assign(new EventEmitter(), { id: 41 })
      const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
        'electron-ipc-decorator': {
          IpcService: class {},
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
            accountId: 'account',
            client: {
              contentStreamsToken: ({ workspaceId, credential }) =>
                Effect.gen(function* () {
                  assert.equal(workspaceId, 'workspace')
                  assert.equal(credential, retainedCredential)
                  // Response delivery is explicit; no clock or scheduler race.
                  if (name === 'account-switch') {
                    identity.userId = 'other-account'
                    identity.generation++
                  }
                  if (name === 'credential-change')
                    nativeOwner.bootstrap.deviceCredential = () =>
                      Effect.succeed('replacement-credential')
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
          nativeOwner = owner
          owner.readers.set('workspace', new Map([[sender.id, 1]]))
          if (name === 'other-reader') owner.readers.get('workspace').set(42, 1)
          owner.host.prepareDispatch = () =>
            Effect.sync(() => {
              dispatched = true
              return { frame: 'synthetic-dispatch-must-not-escape' }
            })
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
      assert.equal(dispatched, false)
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
        assert.deepEqual(await readFile(join(first.directory, 'creations.sqlite')), original)
        identity.userId = 'account'
        identity.generation++
        const cached = await api.withDesktopE2eeAccount(
          (owner) => owner.host.inspectCachedState('workspace', 'synthetic-machine'),
          'workspace',
          false
        )
        assert.equal(cached.entryPresent, name === 'other-reader')
        if (name === 'other-reader') {
          sender.id = 42
          assert.equal((await ipc.status('workspace')).signingPublicKey, first.signingPublicKey)
          sender.id = 41
        }
      }
      await assert.rejects(ipc.status('workspace'))
    })
  }
})

void test('a failed prepareDispatch diagnoses its device credential and reports only an exact access loss', async (t) => {
  const input = {
    sessionId: 'session',
    userTurnId: 'turn',
    userId: 'display-only',
    timestamp: new Date(0).toISOString(),
    inputConfig: {}
  }
  for (const [flag, code] of [
    ['memberRemoved', 'member_removed'],
    ['deviceRevoked', 'device_revoked'],
    [null, null]
  ]) {
    const f = await personalJoinFixture(t)
    const owner = await f.open(`dispatch-${code ?? 'unchanged'}`)
    await owner.create()
    // A local native failure that carries no access-loss classification of its own.
    owner.host.prepareDispatch = () => Effect.die(new Error('synthetic native dispatch failure'))
    if (flag) f.relay[flag] = true
    const outcome = owner.ipc.prepareDispatch(f.workspaceId, 'synthetic-machine', input)
    if (code) {
      // Only the server's exact credential answer records loss, stops and cleans up.
      await assert.rejects(outcome, new RegExp(`^Error: e2ee_${code}$`))
      assert.equal(owner.readers.has(f.workspaceId), false)
      assert.equal(
        await Effect.runPromise(owner.bootstrap.hasRemovedWorkspace(f.workspaceId)),
        true
      )
      await assert.rejects(owner.ipc.open(f.workspaceId), (error) => error.code === code)
    } else {
      // An unclassified credential answer is not removal: the failure stays generic.
      await assert.rejects(outcome, (error) => {
        assert.doesNotMatch(error.message, /member_removed|device_revoked/)
        return true
      })
      assert.equal(owner.readers.has(f.workspaceId), true)
      assert.equal(
        await Effect.runPromise(owner.bootstrap.hasRemovedWorkspace(f.workspaceId)),
        false
      )
    }
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
  await assert.rejects(owner.ipc.status(f.workspaceId), /e2ee_not_open/)
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
    /e2ee_not_open|e2ee_device_revoked/
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
    api.cleanupRemovedDesktopWorkspace({ accountId: 'account', workspaceId: 'removed' }),
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
    await api.cleanupRemovedDesktopWorkspace({ accountId: 'account', workspaceId: 'removed' }),
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
    accountId: 'account',
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
  const sender = Object.assign(new EventEmitter(), { id: 19 })
  const sessions = new Map()
  const { E2eeIpc } = await load(
    '../ipc/services/e2ee-ipc.ts',
    {
      '../ipc-service-deps': { getIpcServiceDeps: () => ({}) },
      'electron-ipc-decorator': {
        IpcService: class {},
        IpcMethod: () => (_target, _name, descriptor) => descriptor,
        getIpcContext: () => ({ event: { sender } })
      },
      '../../platform': { isLocalPlatform: () => false },
      '../../services/e2ee-bootstrap.mjs': {},
      '../../services/e2ee-account-runtime': {
        ...api,
        desktopE2eeCloudClient: async () => ({
          accountId: 'account',
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

async function memberIpcFixture() {
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
      acceptMemberJoin: () => Effect.void
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
      open: () => Effect.succeed({ hasCurrentKey: true }),
      ingestLedgerRecords: () => Effect.void,
      status: () => Effect.succeed({ hasCurrentKey: true }),
      keyRound: () =>
        Effect.promise(async () => {
          keyEntered.resolve()
          await keyGate.promise
        }),
      beginCloseWorkspace: () =>
        Effect.sync(() => {
          closed.push(label)
          return Effect.void
        })
    }
  })
  let current = makeOwner('A', 'original-A')
  const sender = Object.assign(new EventEmitter(), { id: 1 })
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
      appendRecord: () => Effect.void
    }
  }
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    effect: { Effect },
    'electron-ipc-decorator': {
      IpcService: class {},
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
      runDesktopE2eeOperation: async (accountId, work) => {
        if (identity.userId !== accountId) throw new Error('e2ee_account_mismatch')
        const result = await Effect.runPromise(work)
        if (identity.userId !== accountId) throw new Error('e2ee_account_mismatch')
        return result
      }
    }
  })
  const ipc = new E2eeIpc()
  ipc.permissionHistory = async () => []
  ipc.refresh = async () => {}
  return {
    ipc,
    identity,
    signed,
    closed,
    cloudEntered,
    cloudGate,
    keyEntered,
    keyGate,
    makeOwner,
    setTrusted(value) {
      trusted = value
    },
    setOwner(owner) {
      current = owner
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

for (const code of ['machine_not_owned', 'machine_not_shared']) {
  void test(`encrypted execution refusal preserves ${code} at the public account boundary`, async () => {
    const { api } = await account()
    await assert.rejects(
      api.withDesktopE2eeAccount(() => Effect.fail({ code })),
      (error) => {
        assert.equal(error.message, `e2ee_${code}`)
        assert.equal('cause' in error, false)
        return true
      }
    )
  })
}

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

async function accountPairingFixture(t) {
  // Real custody, bootstrap, ledger hosts and SQLite journals on both devices; the
  // cloud is an in-memory relay plus the approver's own ledger as the history source.
  const f = await personalJoinFixture(t)
  const approver = await f.open('approver')
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
    accountIdentity: () =>
      Effect.succeed({ accountId: approver.accountId, cryptoUserId: 'aa'.repeat(32) }),
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
  const hostFor = (owner, name) => {
    const db = new DatabaseSync(join(owner.path, name))
    t.after(() => db.close())
    return makeDesktopAccountPairingHost({
      accountId: owner.accountId,
      deviceName: 'Synthetic second desktop',
      db,
      cloud,
      withOwner: (_workspaceId, work) => Effect.runPromise(work(owner)),
      run: (effect) => Effect.runPromise(effect),
      workspaces: () => hints
    })
  }
  const requester = hostFor(newDevice, 'account-pairing.sqlite')
  const approving = hostFor(approver, 'account-pairing.sqlite')

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
  assert.equal((await Effect.runPromise(requester.accountPairingRequest())).status, 'joined')
  // Like the per-workspace claim: open, refresh and run a key round with this
  // device's own credential, without waiting for the workspace to be opened later.
  const credential = await Effect.runPromise(newDevice.bootstrap.deviceCredential(f.workspaceId))
  assert.deepEqual(
    mailboxRequests.map((item) => [item.workspaceId, item.credential]),
    [[f.workspaceId, credential]]
  )
})

void test('pairing leaves no runtime entry open for a workspace no window is reading', async (t) => {
  const { f, newDevice, genesisHash, requester, approving } = await accountPairingFixture(t)
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  await Effect.runPromise(requester.accountPairingRequest())
  // An open entry would accept this page; a closed one refuses it.
  await assert.rejects(
    Effect.runPromise(
      newDevice.host.ingestLedgerRecords(f.workspaceId, {
        workspaceId: f.workspaceId,
        genesisHash,
        checkpoint: { length: 1, headHash: genesisHash },
        startIndex: 0,
        recordsHex: [],
        position: `p1:${f.workspaceId}:1:source:0`,
        nextCursor: null
      })
    ),
    (error) => error.code === 'closed'
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

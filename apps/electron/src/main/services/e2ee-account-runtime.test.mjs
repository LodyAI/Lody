import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { Effect, Scope, Exit } from 'effect'
import { makeDesktopE2eeCustody } from '../e2ee-custody.mts'
import { makeDesktopE2eeBootstrap } from './e2ee-bootstrap.mts'
import { makeDesktopE2eeRuntimeHost } from './e2ee-runtime.mts'
import { makeOfflineAuthIdentityCache } from '../auth-storage.ts'
import { PersonalPairingOfferSchema } from './e2ee-personal-pairing.mts'
import { desktopE2eeFailure } from './e2ee-diagnostics.mts'
const require = createRequire(import.meta.url)
async function load(relative, dependencies, console = globalThis.console) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8')
  const exports = {}
  runInNewContext(
    ts.transpileModule(source.replaceAll('import.meta.env', '{}'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true
      }
    }).outputText,
    {
      exports,
      Error,
      setTimeout,
      clearTimeout,
      console,
      require: (id) =>
        Object.hasOwn(dependencies, id)
          ? dependencies[id]
          : id === '../../services/e2ee-personal-pairing.mjs'
            ? { PersonalPairingOfferSchema }
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
      electron: { app: { getPath: () => '/synthetic-user-data' } },
      '../e2ee-custody-electron': {
        makeElectronE2eeCustody: options.custody ?? (() => Effect.succeed({}))
      },
      './e2ee-bootstrap.mjs': { makeDesktopE2eeBootstrap: () => Effect.succeed({}) },
      './e2ee-runtime.mjs': { makeDesktopE2eeRuntimeHost: () => Effect.succeed({}) },
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
  await assert.rejects(api.closeDesktopE2eeAccount(), /e2ee_cleanup_failed/)
  api.resumeDesktopE2eeAccount()
  await assert.rejects(
    api.withDesktopE2eeAccount(() => Effect.succeed('replacement')),
    /e2ee_host_operation_failed/
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
  const relay = { statusFailure: null, loseCancelReceipt: false }
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
        owner.readers.set(id, new Set([sender.id]))
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
  return { open, rows, relay, db, workspaceId }
}

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
    third.ipc.preparePersonalJoin({ ...offer, pairingSessionId: '82'.repeat(16) }),
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

import * as recoveryHistory from './e2ee-recovery-history.mts'
import * as identityStorage from '@lody/shared/node/e2ee-identity'

import { E2eeDeviceRevokedError, E2eeMemberRemovedError } from './e2ee-cloud-errors.mts'

import { KEY_DELIVERY_READER } from './e2ee-key-delivery.mts'

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

import { Script } from 'node:vm'

import test from 'node:test'

import ts from 'typescript'

import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Scope,
  Exit,
  Result,
  Clock
} from 'effect'

import { TestClock } from 'effect/testing'

import { BackendError, KeyMailbox } from '@lody/e2ee-core/services'

import { makeSqliteKeyMailbox, referenceKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite'

import { WorkspaceKeyRoundFailure } from '@lody/e2ee-core'

import {
  Bytes,
  hashRecordBytes,
  verifyLedger,
  decodeRecord,
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

const compiledScriptCache = new Map()

function getCompiledScript(relative, env) {
  const envJson = JSON.stringify(env)
  const cacheKey = `${relative}\0${envJson}`
  let script = compiledScriptCache.get(cacheKey)
  if (!script) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
    const { outputText } = ts.transpileModule(source.replaceAll('import.meta.env', envJson), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true
      }
    })
    script = new Script(outputText, { filename: relative })
    compiledScriptCache.set(cacheKey, script)
  }
  return script
}

async function load(relative, dependencies, console = globalThis.console, env = {}, globals = {}) {
  return loadSync(relative, dependencies, console, env, globals)
}

/** Loads one module in the same sandbox and dependency map as its importer, so main
 * modules split out of `E2eeIpc` share its console, clock and mocked account runtime. */
function loadSync(relative, dependencies, console = globalThis.console, env = {}, globals = {}) {
  const exports = {}
  getCompiledScript(relative, env).runInNewContext({
    exports,
    Error,
    crypto: globalThis.crypto,
    Buffer,
    URL,
    Request,
    setTimeout,
    clearTimeout,
    console,
    ...globals,
    require: (id) =>
      Object.hasOwn(dependencies, id)
        ? dependencies[id]
        : id === '../../services/e2ee-recovery-history.mjs'
          ? recoveryHistory
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
                          : id === '@lody/e2ee-core/protocol'
                            ? { decodeRecord }
                            : id === '../../services/e2ee-recovery-vault.mjs' ||
                                id === '../../services/e2ee-passkey-macos.mjs'
                              ? {}
                              : id === '../../services/e2ee-client-loss-probe'
                                ? // Production default: the E2E probe is disabled and forwards work.
                                  {
                                    observeClientLossOperation: (
                                      _kind,
                                      _workspace,
                                      _sender,
                                      work
                                    ) => work()
                                  }
                                : id === '../auth-fetch'
                                  ? loadSync(
                                      '../auth-fetch.ts',
                                      dependencies,
                                      console,
                                      env,
                                      globals
                                    )
                                  : require(id)
  })
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
      electron: options.electron ?? {
        app: {
          getPath: () => options.directory ?? '/synthetic-user-data',
          whenReady: () => Promise.resolve()
        },
        net: { fetch: globalThis.fetch }
      },
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
    effect: { Effect, Deferred, Cause, Data, Exit },
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

/** An invitation the relay signs with a key of its own, as a forging relay would. */
const relaySignedOffer = (genuine, changes = {}) => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const endorser = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')
  const unsigned = { ...genuine, ...changes, endorser }
  delete unsigned.signature
  const signature = sign(null, memberOfferSigningBytes(unsigned), privateKey).toString('hex')
  return { ...unsigned, signature }
}

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
export {
  identityStorage,
  E2eeDeviceRevokedError,
  E2eeMemberRemovedError,
  KEY_DELIVERY_READER,
  assert,
  EventEmitter,
  readFileSync,
  readFile,
  mkdtemp,
  rm,
  readdir,
  writeFile,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  tmpdir,
  join,
  DatabaseSync,
  createRequire,
  Script,
  test,
  ts,
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Scope,
  Exit,
  Result,
  Clock,
  TestClock,
  BackendError,
  KeyMailbox,
  makeSqliteKeyMailbox,
  referenceKeyMailbox,
  WorkspaceKeyRoundFailure,
  Bytes,
  hashRecordBytes,
  verifyLedger,
  decodeRecord,
  derivePairingKeys,
  disposePairingKeys,
  encodePairingSecret,
  formatPairingString,
  prepareLedgerCommand,
  signLedgerRecord,
  makeDesktopE2eeCustody,
  makeDesktopE2eeBootstrap,
  makeDesktopE2eeRuntimeHost,
  makeE2eeCloudClient,
  makeDesktopAccountPairingHost,
  makeDesktopAccountPairingWorkspaces,
  makeOfflineAuthIdentityCache,
  electronIpc,
  isIpcInvokeChannel,
  memberJoining,
  KEY_DELIVERY_RETRY_DELAYS,
  memberOfferSigningBytes,
  PersonalPairingOfferSchema,
  desktopE2eeFailure,
  rememberDesktopE2eeFailure,
  createDesktopQuitBarrier,
  drainMainProcessQuitResources,
  appendLedgerHistory,
  hostLedgerHistory,
  readObservedLedgerCheckpoint,
  retainObservedLedgerCheckpoint,
  proxyEnv,
  require,
  compiledScriptCache,
  getCompiledScript,
  load,
  loadSync,
  account,
  holdWorkspaceTurn,
  personalJoinFixture,
  nativeAccountFixture,
  createAccountWorkspace,
  memberIpcFixture,
  deferredMember,
  approvalRequest,
  plain,
  approvalDevice,
  personalApprovalRequest,
  personalApprovalFixture,
  projectNativeFailure,
  memberApprovalFixture,
  fakeKeyDeliveryTimers,
  keyDeliveryState,
  accountPairingFixture,
  blockedApproverListing,
  ObservedLedgerStorage,
  twoDeviceMemberJoin,
  RELAY_CALL_S,
  TOKEN_MINT_S,
  claimCalls,
  relaySignedOffer,
  e2eeIpcDependencies,
  newDesktopAccountPairing,
  criticalPath,
  rotatedTeam,
  slowSignIn,
  slowSignInAccount,
  settle
}

import { openSqliteConnection } from '../../../../../packages/e2ee-core/src/adapters/node-sqlite/store.ts'

import { existsSync } from 'node:fs'

import assert from 'node:assert/strict'

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { DatabaseSync } from 'node:sqlite'

import test from 'node:test'

import {
  decodeE2eeIntentRecord,
  scheduleDeclarationSubject
} from '@lody/shared/e2ee-execution-intent'

import { createDesktopE2eeContent } from '../../../../../packages/components/src/providers/desktop-e2ee-content.ts'

import { Clock, Context, Effect, Layer, Result, Scope, Exit, Deferred, Fiber } from 'effect'

import {
  KeyMailbox,
  WorkspaceScope,
  LedgerViewSource,
  LedgerPinStore
} from '@lody/e2ee-core/services'

import { InstalledEpochKeys, VerifiedLedger } from '@lody/e2ee-core'

import { BackendError } from '@lody/e2ee-core/services'

import { disposeEpochKey } from '@lody/e2ee-core/internal'

import {
  makeSqliteKeyMailbox,
  referenceKeyMailbox,
  sqliteInstalledKeyStore,
  sqliteLedgerPinStore
} from '@lody/e2ee-core/adapters/node-sqlite'

import {
  Bytes,
  encodeCbor,
  decodeRecord,
  prepareLedgerRecord,
  commitEpochKey,
  sealHistoryPacket,
  hashRecordBytes,
  mailboxDigest,
  prepareJoinRequest,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  getCommittedEpochStagingKey,
  signDeviceCredentialBinding,
  verifyExecutionIntent,
  prepareLedgerCommand,
  signLedgerRecord,
  extendLedger,
  verifyLedger
} from '@lody/e2ee-core/protocol'

import { accountUserId, inspectContentFrame } from '@lody/e2ee-core/protocol'

import { desktopE2eePorts, makeDesktopE2eeCustody } from '../e2ee-custody.mts'

import { makeDesktopE2eeBootstrap } from './e2ee-bootstrap.mts'

import { makeDesktopE2eeRuntimeHost } from './e2ee-runtime.mts'

import { makeDesktopLocalPairing } from './e2ee-local-pairing.mts'

import { decodeMemberKeyPackage } from './e2ee-member-join.mts'

import { createDesktopQuitBarrier, drainMainProcessQuitResources } from './desktop-shutdown.ts'

// Authenticated synthetic OS storage; this suite does not exercise a user's keychain.
const wrapping = Buffer.alloc(32, 86)

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

const intent = Object.freeze({
  accountId: '2w8hg7s65mt3pgj9a1bnwsbcedx48wr',
  requestId: 'request-0123456789',
  name: 'Encrypted example',
  slug: 'encrypted-example'
})

const execute = (work) => Effect.runPromise(Effect.scoped(work))

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lody-e2ee-bootstrap-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const openOwner = (directory, override = (custody) => custody, registerIdentity = true) =>
  Effect.gen(function* () {
    const custody = yield* makeDesktopE2eeCustody({
      directory: join(directory, 'custody'),
      platform: 'linux',
      safeStorage
    })
    const bootstrap = yield* makeDesktopE2eeBootstrap({
      directory,
      accountId: intent.accountId,
      custody: override(custody)
    })
    if (registerIdentity) return { custody, bootstrap }
  })

const workspaceId = 'synthetic-workspace'

const hex = (value) => Buffer.from(value).toString('hex')

const ownerWithHost = (directory, hostOptions = {}) =>
  Effect.gen(function* () {
    const owner = yield* openOwner(directory)
    const host = yield* makeDesktopE2eeRuntimeHost({ directory, ...owner, ...hostOptions })
    return { ...owner, host }
  })

const bind = (owner) =>
  Effect.gen(function* () {
    const prepared = yield* owner.bootstrap.prepareCreation(intent)
    yield* owner.bootstrap.recordCreated({
      workspaceId,
      genesisHash: prepared.genesisHashHex,
      requestId: intent.requestId
    })
    return prepared
  })

const makeRecords = (custody, prepared, count) =>
  Effect.gen(function* () {
    const genesis = Result.getOrThrow(
      Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
    )
    const signer = yield* custody.openDevice(genesis)
    const records = [new Uint8Array(Buffer.from(prepared.genesisRecordHex, 'hex'))]
    let view = Result.getOrThrow(
      verifyLedger({
        anchor: genesis,
        records,
        checkpoint: { head: hashRecordBytes(records[0]), length: 1 }
      })
    )
    const joining = yield* custody.prepareDevice()
    const membershipId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(17)))
    const request = yield* prepareJoinRequest({
      genesis,
      requestId: Result.getOrThrow(Bytes.requestId(new Uint8Array(16).fill(18))),
      userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(19))),
      encryptionPublicKey: joining.enc,
      expiresAt: null,
      signer: joining
    })
    for (let index = 1; index < count; index++) {
      const command =
        index === 1
          ? { _tag: 'AdmitMember', membershipId, request }
          : { _tag: 'SetRole', membershipId, role: index % 2 ? 'member' : 'admin' }
      const record = yield* signLedgerRecord(
        Result.getOrThrow(prepareLedgerCommand(view, signer.publicKey, command)),
        signer
      )
      records.push(record)
      view = Result.getOrThrow(
        extendLedger(view, [record], { head: hashRecordBytes(record), length: records.length })
      )
    }
    yield* custody.discardDevice(joining)
    return records
  })

const page = (records, genesisHash, start, end = records.length) => ({
  workspaceId,
  genesisHash,
  checkpoint: { length: records.length, headHash: hex(hashRecordBytes(records.at(-1)).toBytes()) },
  startIndex: start,
  recordsHex: records.slice(start, end).map(hex),
  position: `p1:${workspaceId}:${end}:source-${end}:0`,
  nextCursor: end === records.length ? null : `cursor-${end}`
})

const historyDb = (directory, work) => {
  const db = new DatabaseSync(join(directory, 'workspaces', workspaceId, 'history.sqlite'))
  try {
    return work(db)
  } finally {
    db.close()
  }
}

const memberWithHost = Effect.fnUntraced(function* (folder) {
  const custody = yield* makeDesktopE2eeCustody({
    directory: join(folder, 'custody'),
    platform: 'linux',
    safeStorage
  })
  const bootstrap = yield* makeDesktopE2eeBootstrap({
    directory: folder,
    accountId: 'acc2',
    custody
  })
  const host = yield* makeDesktopE2eeRuntimeHost({ directory: folder, custody, bootstrap })
  return { custody, bootstrap, host }
})

async function managementFailureFixture(t, commandType) {
  for (const failure of ['stage', 'cas']) {
    const directory = await fixture(t)
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const prepared = yield* bind(owner)
        const genesis = Result.getOrThrow(
          Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
        )
        let records =
          commandType === 'removeMember'
            ? yield* makeRecords(owner.custody, prepared, 2)
            : [Buffer.from(prepared.genesisRecordHex, 'hex')]
        let view = Result.getOrThrow(
          verifyLedger({
            anchor: genesis,
            records,
            checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
          })
        )
        const signer = yield* owner.custody.openDevice(genesis)
        const targets = []
        for (let index = 0; index < 2; index++) {
          if (commandType === 'removeMember' && index === 1) {
            targets.push(
              [...view.inspectState().devices].find(
                ([, device]) => hex(device.membershipId.toBytes()) === '11'.repeat(16)
              )[0]
            )
            continue
          }
          const machine = yield* owner.custody.prepareDevice()
          const admission = yield* prepareDeviceAdmission({
            genesis,
            membershipId: view.inspectState().owner,
            signer: machine,
            encryptionPublicKey: machine.enc,
            kind: 'machine',
            machineId: `revocation-fixture-${index}`
          })
          const record = yield* signLedgerRecord(
            Result.getOrThrow(prepareLedgerCommand(view, signer.publicKey, admission)),
            signer
          )
          records.push(record)
          view = Result.getOrThrow(
            extendLedger(view, [record], {
              head: hashRecordBytes(record),
              length: records.length
            })
          )
          targets.push(hex(machine.publicKey.toBytes()))
          yield* owner.custody.discardDevice(machine)
        }
        if (commandType === 'removeMember') {
          const capability = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(view, signer.publicKey, {
                _tag: 'DeclareCapabilities',
                capabilities: [1]
              })
            ),
            signer
          )
          records.push(capability)
          view = Result.getOrThrow(
            extendLedger(view, [capability], {
              head: hashRecordBytes(capability),
              length: records.length
            })
          )
        }
        const independentCommand =
          commandType === 'revoke'
            ? { type: 'revoke', target: targets[1] }
            : { type: 'removeMember', membershipId: '11'.repeat(16) }
        yield* owner.host.open(workspaceId)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, prepared.genesisHashHex, 0)
        )
        let blocked = false,
          stagingUnavailable = false
        const staged = new Map(),
          attempts = [],
          submitted = []
        const remote = () => ({
          history: () => Effect.succeed(page(records, prepared.genesisHashHex, 0)),
          mailbox: () => {
            throw new Error('this flow installs its own committed candidate')
          },
          log: {
            read: () =>
              Effect.succeed({ records, checkpoint: { head: view.head, length: view.length } }),
            appendCas: (_anchor, expected, record) =>
              Effect.suspend(() => {
                submitted.push(Buffer.from(record))
                if (blocked && failure === 'cas')
                  return Effect.fail(new Error('synthetic unknown CAS result'))
                assert.equal(view.head.equals(expected.head), true)
                view = Result.getOrThrow(
                  extendLedger(view, [record], {
                    head: hashRecordBytes(record),
                    length: view.length + 1
                  })
                )
                records = [...records, record]
                return Effect.void
              })
          },
          staging: () => ({
            stageGroup: (group) =>
              Effect.suspend(() => {
                attempts.push(group)
                if (stagingUnavailable || (blocked && failure === 'stage'))
                  return Effect.fail(new Error('synthetic staging outage'))
                staged.set(group.recordHash, group)
                return Effect.void
              }),
            readGroup: (key) =>
              stagingUnavailable
                ? Effect.fail(new Error('synthetic staging read outage'))
                : Effect.succeed(staged.get(key.recordHash) ?? null),
            deleteGroup: () => Effect.void
          })
        })
        const managementDirectory = join(directory, 'workspaces', workspaceId)
        const ownKey = hex(signer.publicKey.toBytes())
        const snapshot = () => {
          const candidate = openSqliteConnection(
            join(managementDirectory, `epoch-candidates-${ownKey}.sqlite`)
          )
          const journal = openSqliteConnection(
            join(managementDirectory, `management-submission-${ownKey}.sqlite`)
          )
          try {
            return {
              rows: candidate
                .prepare('SELECT * FROM epoch_rotation_candidates ORDER BY rowid')
                .all(),
              pending:
                journal.prepare('SELECT pending FROM submission_journal').get()?.pending ?? null
            }
          } finally {
            candidate.close()
            journal.close()
          }
        }
        yield* owner.host.manage(workspaceId, { type: 'revoke', target: targets[0] }, remote)
        blocked = true
        assert.equal(
          Result.isFailure(
            yield* Effect.result(owner.host.manage(workspaceId, { type: 'rotate' }, remote))
          ),
          true
        )
        const retained = snapshot()
        assert.equal(retained.rows.length, 1)
        assert.equal(retained.pending !== null, failure === 'cas')
        const original = Buffer.from(retained.rows[0].record)
        assert.equal(Buffer.from(attempts[0].record).equals(original), true)
        if (failure === 'cas') stagingUnavailable = true
        const point = view.head
        yield* owner.host.closeWorkspace(workspaceId)
        yield* owner.host.open(workspaceId)
        assert.equal(
          (yield* owner.host.managementState(workspaceId)).devices.find((entry) => entry.self).key,
          ownKey
        )
        const submissionsBeforeRecovery = submitted.length
        const revoke = yield* Effect.result(
          owner.host.manage(workspaceId, independentCommand, remote)
        )
        if (failure === 'stage') {
          assert.equal(Result.isSuccess(revoke), true)
          assert.equal(revoke.success, 'Committed')
          assert.equal(view.inspectState().devices.has(targets[1]), false)
          if (commandType === 'removeMember')
            assert.equal(view.inspectState().members.has('11'.repeat(16)), false)
          assert.equal(view.inspectState().epoch.number, 0)
          assert.equal(view.inspectState().epoch.rotationRequired, true)
          assert.equal(attempts.length, 1)
          assert.deepEqual(snapshot().rows, retained.rows)
          assert.equal(snapshot().pending, null)
          const request = {
            epoch: 0,
            room: { kind: 'doc', docId: 'revocation-survives-outage' },
            context: {
              protocol: 'loro-streams-crdt-payload-protection',
              version: 2,
              kind: 'update_batch'
            },
            plaintext: new Uint8Array([1]),
            additionalData: new Uint8Array([2])
          }
          const sealed = yield* owner.host.seal(workspaceId, request)
          assert.deepEqual(
            yield* owner.host.openContent(workspaceId, { ...request, ...sealed }),
            request.plaintext
          )
          blocked = false
          assert.equal(
            yield* owner.host.manage(workspaceId, { type: 'rotate' }, remote),
            'Committed'
          )
          assert.equal(attempts.length, 2)
          assert.equal(Buffer.from(attempts[1].record).equals(original), false)
          for (const target of targets)
            assert.equal(
              attempts[1].envelopes.some((entry) => entry.recipient === target),
              false
            )
          const rows = snapshot().rows
          assert.equal(rows[0].outcome, 'Conflict')
          assert.equal(rows[0].consumed, 1)
          assert.deepEqual(rows[0].record, retained.rows[0].record)
          assert.deepEqual(rows[0].envelopes, retained.rows[0].envelopes)
        } else {
          assert.deepEqual(
            submitted.slice(submissionsBeforeRecovery),
            [original],
            'unknown CAS retries its original bytes while staging remains unavailable'
          )
          assert.equal(attempts.length, 1, 'pending publication resumes without staging again')
          assert.equal(Result.isFailure(revoke), true)
          assert.equal(view.head.equals(point), true)
          assert.equal(view.inspectState().devices.has(targets[1]), true)
          assert.deepEqual(snapshot().rows, retained.rows)
          assert.deepEqual(snapshot().pending, retained.pending)
          assert.equal(
            submitted.slice(1).every((record) => record.equals(original)),
            true
          )
          blocked = false
          assert.equal(
            yield* owner.host.manage(workspaceId, independentCommand, remote),
            'Committed'
          )
          assert.equal(Buffer.from(records.at(-2)).equals(original), true)
          assert.equal(view.inspectState().devices.has(targets[1]), false)
          if (commandType === 'removeMember') {
            const operation = Result.getOrThrow(decodeRecord(records.at(-1))).body.operation
            assert.equal(operation.type, 'removeMember')
            assert.equal(hex(operation.membershipId.toBytes()), '11'.repeat(16))
            assert.equal(view.inspectState().members.has('11'.repeat(16)), false)
            assert.equal(view.inspectState().epoch.rotationRequired, true)
          }
        }
        assert.equal(view.inspectState().epoch.number, 1)
        assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
        assert.equal((yield* owner.host.managementState(workspaceId)).updatePending, false)
        assert.equal(snapshot().pending, null)
      })
    )
  }
}

const maintenanceFixture = (directory) =>
  Effect.gen(function* () {
    const owner = yield* ownerWithHost(directory)
    const prepared = yield* bind(owner)
    yield* owner.host.open(workspaceId)
    const genesis = Result.getOrThrow(
      Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
    )
    const record = Buffer.from(prepared.genesisRecordHex, 'hex')
    let view = Result.getOrThrow(
      verifyLedger({
        anchor: genesis,
        records: [record],
        checkpoint: { head: hashRecordBytes(record), length: 1 }
      })
    )
    const device = yield* owner.custody.openDevice(genesis)
    const keys = Context.get(
      yield* Layer.build(
        InstalledEpochKeys.layer.pipe(
          Layer.provideMerge(
            sqliteInstalledKeyStore({
              path: join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite'),
              mode: 'open'
            })
          ),
          Layer.provideMerge(VerifiedLedger.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              desktopE2eePorts(owner.custody, device),
              Layer.succeed(WorkspaceScope, { genesis }),
              Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(view) }),
              Layer.succeed(LedgerPinStore, {
                read: () => Effect.succeed(null),
                write: () => Effect.void
              })
            )
          )
        )
      ),
      InstalledEpochKeys
    )
    const frame = yield* Effect.acquireUseRelease(
      keys.read(0),
      (key) =>
        prepareEpochEnvelope({
          context: { genesis, epoch: 0, sender: device.publicKey, recipient: device.publicKey },
          key,
          signer: device,
          ledger: () => Effect.succeed(view)
        }),
      (key) => Effect.sync(() => disposeEpochKey(key))
    )
    const path = join(directory, 'maintenance-mailbox.sqlite')
    const backend = yield* makeSqliteKeyMailbox({
      path,
      mode: 'create',
      genesis,
      ledger: () => Effect.succeed(view)
    })
    const mailbox = Context.get(
      yield* Layer.build(referenceKeyMailbox(backend, device.publicKey)),
      KeyMailbox
    )
    yield* mailbox.put('ab'.repeat(16), frame)
    return {
      owner,
      mailbox,
      path,
      frame,
      device,
      genesis,
      prepared,
      keys,
      view: () => view,
      setView: (next) => {
        view = next
      }
    }
  })

function expectNoEntry(snapshot) {
  assert.equal(snapshot.entryPresent, false)
  assert.equal(snapshot.cachedPolicies, 0)
  assert.equal(snapshot.cachedExecutionGrants, 0)
}

const sharingCacheFixture = Effect.fnUntraced(function* (directory) {
  const owner = yield* ownerWithHost(directory)
  const prepared = yield* bind(owner)
  yield* owner.host.open(workspaceId)
  const records = yield* makeRecords(owner.custody, prepared, 2)
  const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex')))
  const signer = yield* owner.custody.openDevice(genesis)
  const machine = yield* owner.custody.prepareDevice()
  yield* Effect.addFinalizer(() => owner.custody.discardDevice(machine).pipe(Effect.orDie))
  let view = Result.getOrThrow(
    verifyLedger({
      anchor: genesis,
      records,
      checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
    })
  )
  const append = Effect.fnUntraced(function* (command) {
    const proposal =
      command instanceof Uint8Array
        ? Result.getOrThrow(prepareLedgerRecord(view, command))
        : Result.getOrThrow(prepareLedgerCommand(view, signer.publicKey, command))
    const record = yield* signLedgerRecord(proposal, signer)
    records.push(record)
    view = Result.getOrThrow(
      extendLedger(view, [record], { head: hashRecordBytes(record), length: records.length })
    )
  })
  yield* append(
    yield* prepareDeviceAdmission({
      genesis,
      membershipId: view.inspectState().owner,
      encryptionPublicKey: machine.enc,
      kind: 'machine',
      machineId: 'cache-machine',
      signer: machine
    })
  )
  yield* append({ _tag: 'DeclareCapabilities', capabilities: [1] })
  const ingest = () =>
    owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
  yield* ingest()
  let head = null,
    version = null
  const remote = {
    readHead: (binding) => Effect.succeed(binding.generation === head?.generation ? head : null),
    readVersion: (binding) =>
      Effect.succeed(binding.generation === version?.generation ? version : null),
    readRequest: () => Effect.succeed(null),
    commit: (input) =>
      Effect.gen(function* () {
        const { machineSharingDigest } = yield* Effect.promise(
          () => import('@lody/e2ee-core/protocol')
        )
        const { credential: _credential, expectedHead: _expected, ...original } = input
        version = {
          ...original,
          digest: Result.getOrThrow(machineSharingDigest(Buffer.from(input.frameHex, 'hex')))
        }
        head = { ...version, status: 'active' }
        return { status: 'committed', version }
      })
  }
  const initial = yield* owner.host.readMachineSharing(workspaceId, 'cache-machine', remote)
  yield* owner.host.updateMachineSharing(
    workspaceId,
    'cache-machine',
    initial.generation,
    '81'.repeat(16),
    { kind: 'machine', sharedWithTeam: true },
    remote
  )
  yield* owner.host.readMachineSharing(workspaceId, 'cache-machine', remote)
  const cache = () => owner.host.inspectCachedState(workspaceId, 'cache-machine')
  assert.equal((yield* cache()).cachedExecutionGrants, 1)
  return {
    owner,
    prepared,
    genesis,
    signer,
    machine,
    records,
    view: () => view,
    append,
    ingest,
    remote,
    cache,
    generation: initial.generation
  }
})
export {
  openSqliteConnection,
  existsSync,
  assert,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  tmpdir,
  join,
  DatabaseSync,
  test,
  decodeE2eeIntentRecord,
  scheduleDeclarationSubject,
  createDesktopE2eeContent,
  Clock,
  Context,
  Effect,
  Layer,
  Result,
  Scope,
  Exit,
  Deferred,
  Fiber,
  KeyMailbox,
  WorkspaceScope,
  LedgerViewSource,
  LedgerPinStore,
  InstalledEpochKeys,
  VerifiedLedger,
  BackendError,
  disposeEpochKey,
  makeSqliteKeyMailbox,
  referenceKeyMailbox,
  sqliteInstalledKeyStore,
  sqliteLedgerPinStore,
  Bytes,
  encodeCbor,
  decodeRecord,
  prepareLedgerRecord,
  commitEpochKey,
  sealHistoryPacket,
  hashRecordBytes,
  mailboxDigest,
  prepareJoinRequest,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  getCommittedEpochStagingKey,
  signDeviceCredentialBinding,
  verifyExecutionIntent,
  prepareLedgerCommand,
  signLedgerRecord,
  extendLedger,
  verifyLedger,
  accountUserId,
  inspectContentFrame,
  desktopE2eePorts,
  makeDesktopE2eeCustody,
  makeDesktopE2eeBootstrap,
  makeDesktopE2eeRuntimeHost,
  makeDesktopLocalPairing,
  decodeMemberKeyPackage,
  createDesktopQuitBarrier,
  drainMainProcessQuitResources,
  wrapping,
  safeStorage,
  intent,
  execute,
  fixture,
  openOwner,
  workspaceId,
  hex,
  ownerWithHost,
  bind,
  makeRecords,
  page,
  historyDb,
  memberWithHost,
  managementFailureFixture,
  maintenanceFixture,
  expectNoEntry,
  sharingCacheFixture
}

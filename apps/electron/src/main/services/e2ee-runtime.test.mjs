import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Context, Effect, Layer, Result, Scope, Exit } from 'effect'
import {
  KeyMailbox,
  WorkspaceScope,
  LedgerViewSource,
  LedgerPinStore
} from '@lody/e2ee-core/services'
import { InstalledEpochKeys, VerifiedLedger } from '@lody/e2ee-core'
import { disposeEpochKey } from '@lody/e2ee-core/internal'
import {
  makeSqliteKeyMailbox,
  referenceKeyMailbox,
  sqliteInstalledKeyStore
} from '@lody/e2ee-core/adapters/node-sqlite'
import {
  Bytes,
  encodeCbor,
  prepareLedgerRecord,
  commitEpochKey,
  sealHistoryPacket,
  hashRecordBytes,
  prepareJoinRequest,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  getCommittedEpochStagingKey,
  signDeviceCredentialBinding,
  prepareLedgerCommand,
  signLedgerRecord,
  extendLedger,
  verifyLedger
} from '@lody/e2ee-core/protocol'
import { desktopE2eePorts, makeDesktopE2eeCustody } from '../e2ee-custody.mts'
import { makeDesktopE2eeBootstrap } from './e2ee-bootstrap.mts'
import { makeDesktopE2eeRuntimeHost } from './e2ee-runtime.mts'
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
  accountId: 'synthetic-account',
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
    if (registerIdentity)
      yield* bootstrap.recordAccountIdentity({
        accountId: intent.accountId,
        cryptoUserId: 'aa'.repeat(32)
      })
    return { custody, bootstrap }
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
void test('binding is immutable, retained reopen asks only for a suffix, and corrupted cache recovers locally', async (t) => {
  const directory = await fixture(t)
  let saved
  let records
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      saved = yield* bind(owner)
      const conflict = yield* Effect.result(
        owner.bootstrap.recordCreated({ workspaceId, genesisHash: 'a'.repeat(64) })
      )
      assert.equal(conflict.failure.code, 'conflict')
      records = yield* makeRecords(owner.custody, saved, 1000)
      assert.equal((yield* owner.host.open(workspaceId)).position, null)
      for (let start = 0; start < records.length; start += 64)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, saved.genesisHashHex, start, Math.min(start + 64, records.length))
        )
      const current = yield* owner.host.status(workspaceId)
      assert.equal(current.length, 1000)
      assert.equal(current.hasCurrentKey, true)
      assert.equal(current.deviceKind, 'personal')
      assert.equal((yield* owner.host.ledgerView(workspaceId)).recordsHex.length, 1000)
    })
  )
  // No history/network capability is provided at all on reopen.
  await execute(
    Effect.gen(function* () {
      const { host } = yield* ownerWithHost(directory)
      const reopened = yield* host.open(workspaceId)
      assert.equal(reopened.position, `p1:${workspaceId}:1000:source-1000:0`)
      assert.equal(reopened.length, 1000)
      const empty = page(records, saved.genesisHashHex, 1000)
      yield* host.ingestLedgerRecords(workspaceId, empty)
    })
  )
  const oldFeed = historyDb(directory, (db) => db.prepare('SELECT name FROM cache').get().name)
  historyDb(directory, (db) => db.prepare('UPDATE cache SET origin=?').run('{corrupt'))
  await execute(
    Effect.gen(function* () {
      const { host } = yield* ownerWithHost(directory)
      assert.equal((yield* host.open(workspaceId)).length, 1000)
    })
  )
  await assert.rejects(readFile(join(directory, 'workspaces', workspaceId, oldFeed)), {
    code: 'ENOENT'
  })
})
void test('a failed originals transaction never advances the pin; reopening retains the last accepted view', async (t) => {
  const directory = await fixture(t)
  let saved
  let records
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      saved = yield* bind(owner)
      records = yield* makeRecords(owner.custody, saved, 3)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(
        workspaceId,
        page(records.slice(0, 1), saved.genesisHashHex, 0)
      )
      historyDb(directory, (db) =>
        db.exec(
          "CREATE TRIGGER synthetic_full BEFORE INSERT ON records WHEN NEW.position > 0 BEGIN SELECT RAISE(ABORT, 'synthetic full'); END"
        )
      )
      const failed = yield* Effect.result(
        owner.host.ingestLedgerRecords(workspaceId, page(records, saved.genesisHashHex, 1))
      )
      assert.equal(Result.isFailure(failed), true)
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
      historyDb(directory, (db) => db.exec('DROP TRIGGER synthetic_full'))
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, saved.genesisHashHex, 1))
    })
  )
  await execute(
    Effect.gen(function* () {
      const { host } = yield* ownerWithHost(directory)
      assert.equal((yield* host.open(workspaceId)).length, 3)
    })
  )
})
void test('missing binding or existing device refuses to create a replacement identity', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const missing = yield* Effect.result(owner.host.open(workspaceId))
      assert.equal(Result.isFailure(missing), true)
      yield* bind(owner)
    })
  )
  const original = await readFile(join(directory, 'creations.sqlite'))
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      assert.equal((yield* owner.host.open(workspaceId)).length, 1)
    })
  )
  assert.deepEqual(await readFile(join(directory, 'creations.sqlite')), original)
})

void test('retains an earlier renderer checkpoint before first native takeover and refuses server rollback', async (t) => {
  const directory = await fixture(t)
  let prepared
  let records
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      prepared = yield* bind(owner)
      records = yield* makeRecords(owner.custody, prepared, 3)
      const observed = {
        genesisHash: prepared.genesisHashHex,
        length: 3,
        headHash: hex(hashRecordBytes(records[2]).toBytes())
      }
      const status = yield* owner.host.open(workspaceId, observed)
      assert.equal(status.continuityPending, true)
      assert.equal(status.hasCurrentKey, false)
      const stale = yield* Effect.result(
        owner.host.ingestLedgerRecords(
          workspaceId,
          page(records.slice(0, 1), prepared.genesisHashHex, 0)
        )
      )
      assert.equal(stale.failure.code, 'local-evidence-conflict')
    })
  )
  // The restriction survives restart even if the renderer never sends it again.
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      assert.equal((yield* owner.host.open(workspaceId)).continuityPending, true)
      const ready = yield* owner.host.ingestLedgerRecords(
        workspaceId,
        page(records, prepared.genesisHashHex, 0)
      )
      assert.equal(ready.continuityPending, false)
      assert.equal(ready.length, 3)
      assert.equal(ready.hasCurrentKey, true)
    })
  )
})
void test('closing waits for admitted native unprotect before releasing the runtime', async (t) => {
  const directory = await fixture(t)
  const scope = await Effect.runPromise(Scope.make())
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let hold = false
  try {
    const owner = await Effect.runPromise(
      Effect.gen(function* () {
        const base = yield* openOwner(directory)
        const custody = {
          ...base.custody,
          installed: {
            ...base.custody.installed,
            unprotect: async (blob) => {
              if (hold) {
                entered.resolve()
                await release.promise
              }
              return base.custody.installed.unprotect(blob)
            }
          }
        }
        const host = yield* makeDesktopE2eeRuntimeHost({
          directory,
          bootstrap: base.bootstrap,
          custody
        })
        return { ...base, host }
      }).pipe(Scope.provide(scope))
    )
    await Effect.runPromise(bind(owner))
    await Effect.runPromise(owner.host.open(workspaceId))
    hold = true
    const reading = Effect.runPromise(owner.host.status(workspaceId))
    await entered.promise
    let closed = false
    const closing = Effect.runPromise(owner.host.close).then(() => {
      closed = true
    })
    assert.equal(closed, false)
    release.resolve()
    await Promise.all([reading, closing])
    assert.equal(closed, true)
    assert.equal(
      Result.isFailure(await Effect.runPromise(Effect.result(owner.host.status(workspaceId)))),
      true
    )
  } finally {
    release.resolve()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

void test('rebases after 64 added records across reopen, without compacting each final page', async (t) => {
  const directory = await fixture(t)
  let saved, records
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      saved = yield* bind(owner)
      records = yield* makeRecords(owner.custody, saved, 66)
    })
  )
  let start = 0
  for (const end of [33, 64, 65, 66]) {
    await execute(
      Effect.gen(function* () {
        const { host } = yield* ownerWithHost(directory)
        yield* host.open(workspaceId)
        yield* host.ingestLedgerRecords(
          workspaceId,
          page(records.slice(0, end), saved.genesisHashHex, start)
        )
        assert.equal((yield* host.status(workspaceId)).length, end)
      })
    )
    const origin = historyDb(directory, (db) => db.prepare('SELECT origin FROM cache').get().origin)
    assert.equal(origin === null ? null : JSON.parse(origin).length, end < 65 ? null : 65)
    start = end
  }
})

void test('overlapping pages compare verified bytes, append only their suffix and keep input errors local', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      const records = yield* makeRecords(owner.custody, prepared, 7)
      yield* owner.host.open(workspaceId)
      const first = page(records.slice(0, 3), prepared.genesisHashHex, 0)
      const initial = yield* owner.host.ingestLedgerRecords(workspaceId, first)
      const gap = yield* Effect.result(
        owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 4))
      )
      assert.equal(gap.failure.code, 'invalid-input')
      // If invalid input closed the owner, reopening would trust this altered cache
      // locator instead of retaining the live feed's position.
      historyDb(directory, (db) =>
        db.prepare('UPDATE records SET locator=? WHERE position=2').run('p1:changed')
      )
      assert.equal((yield* owner.host.status(workspaceId)).position, initial.position)
      assert.deepEqual(yield* owner.host.ingestLedgerRecords(workspaceId, first), initial)
      const overlapping = page(records, prepared.genesisHashHex, 1)
      const advanced = yield* owner.host.ingestLedgerRecords(workspaceId, overlapping)
      assert.equal(advanced.length, 7)
      assert.equal(advanced.position, overlapping.position)
      // A slower window's old endpoint is safe only because these exact bytes
      // and its checkpoint already belong to the locally verified prefix.
      assert.deepEqual(yield* owner.host.ingestLedgerRecords(workspaceId, first), advanced)
      assert.deepEqual(
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records.slice(0, 3), prepared.genesisHashHex, 3)
        ),
        advanced
      )
      assert.equal(
        historyDb(directory, (db) => db.prepare('SELECT COUNT(*) AS n FROM records').get().n),
        7
      )
      const conflict = { ...first, recordsHex: [...first.recordsHex] }
      conflict.recordsHex[1] = conflict.recordsHex[2]
      const rejected = yield* Effect.result(owner.host.ingestLedgerRecords(workspaceId, conflict))
      assert.equal(rejected.failure.code, 'local-evidence-conflict')
      assert.equal(
        historyDb(directory, (db) => db.prepare('SELECT COUNT(*) AS n FROM records').get().n),
        7
      )
    })
  )
})

void test('content IPC binding encrypts allowed rooms and isolates a rejected room or corrupt frame', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const context = {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'update_batch'
      }
      const plaintext = new TextEncoder().encode('CANARY-content-boundary-synthetic')
      const additionalData = new Uint8Array([17, 22, 3])
      for (const room of [
        { kind: 'meta' },
        { kind: 'doc', docId: 'session' },
        { kind: 'flock', flockDocId: `${workspaceId}:mf:local` },
        { kind: 'flock', flockDocId: `${workspaceId}:wf:workspace` }
      ]) {
        const sealed = yield* owner.host.seal(workspaceId, {
          epoch: 0,
          room,
          context,
          plaintext,
          additionalData
        })
        assert.equal(Buffer.from(sealed.sealed).includes(plaintext), false)
        assert.deepEqual(
          yield* owner.host.openContent(workspaceId, { room, context, ...sealed, additionalData }),
          plaintext
        )
        const changed = new Uint8Array(sealed.sealed)
        changed[changed.length - 1] ^= 1
        assert.equal(
          Result.isFailure(
            yield* Effect.result(
              owner.host.openContent(workspaceId, {
                room,
                context,
                ...sealed,
                sealed: changed,
                additionalData
              })
            )
          ),
          true
        )
      }
      assert.equal(
        Result.isFailure(
          yield* Effect.result(
            owner.host.seal(workspaceId, {
              epoch: 0,
              room: { kind: 'flock', flockDocId: 'code-index' },
              context,
              plaintext,
              additionalData
            })
          )
        ),
        true
      )
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
      const valid = yield* owner.host.seal(workspaceId, {
        epoch: 0,
        room: { kind: 'meta' },
        context,
        plaintext,
        additionalData
      })
      assert.ok(valid.sealed.length > plaintext.length)
    })
  )
})

void test('obsolete-cache deletion failure preserves the rebuilt feed and subsequent local opens', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      const records = yield* makeRecords(owner.custody, prepared, 2)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
    })
  )
  historyDb(directory, (db) => db.prepare('UPDATE cache SET origin=?').run('{corrupt'))
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory, {
        removeObsoleteCache: async () => {
          throw Object.assign(new Error('synthetic busy'), { code: 'EBUSY' })
        }
      })
      const state = yield* owner.host.open(workspaceId)
      assert.equal(state.length, 2)
      assert.equal(state.hasCurrentKey, true)
    })
  )
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      assert.equal((yield* owner.host.open(workspaceId)).length, 2)
    })
  )
})

void test('a slow mailbox round does not hold the local workspace lock and reports its installed key', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const record = Buffer.from(prepared.genesisRecordHex, 'hex')
      const view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records: [record],
          checkpoint: { head: hashRecordBytes(record), length: 1 }
        })
      )
      const device = yield* owner.custody.openDevice(genesis)
      const host = yield* makeSqliteKeyMailbox({
        path: join(directory, 'reference-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const context = yield* Layer.build(referenceKeyMailbox(host, device.publicKey))
      const mailbox = Context.get(context, KeyMailbox)
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const slow = KeyMailbox.of({
        ...mailbox,
        report: (report, publication) =>
          Effect.gen(function* () {
            entered.resolve()
            yield* Effect.promise(() => release.promise)
            yield* mailbox.report(report, publication)
          })
      })
      const work = Effect.runPromise(owner.host.keyRound(workspaceId, () => slow))
      yield* Effect.promise(() => entered.promise)
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
      release.resolve()
      yield* Effect.promise(() => work)
      assert.equal(
        (yield* mailbox.status({
          genesis: prepared.genesisHashHex,
          epoch: 0,
          recipient: hex(device.publicKey.toBytes())
        })).status,
        'InstallationReported'
      )
    })
  )
})

void test('workspace close fences and drains a held key round without blocking another workspace', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const other = yield* owner.bootstrap.prepareCreation({
        ...intent,
        requestId: 'request-independent-123',
        slug: 'independent'
      })
      yield* owner.bootstrap.recordCreated({
        workspaceId: 'independent',
        genesisHash: other.genesisHashHex,
        requestId: other.requestId
      })
      yield* owner.host.open('independent')
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const record = Buffer.from(prepared.genesisRecordHex, 'hex')
      const view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records: [record],
          checkpoint: { head: hashRecordBytes(record), length: 1 }
        })
      )
      const device = yield* owner.custody.openDevice(genesis)
      const mailboxHost = yield* makeSqliteKeyMailbox({
        path: join(directory, 'held-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const mailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, device.publicKey)),
        KeyMailbox
      )
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers(),
        aborted = Promise.withResolvers()
      const work = Effect.runPromise(
        owner.host.keyRound(workspaceId, (signal) => {
          signal.addEventListener('abort', () => aborted.resolve(), { once: true })
          return KeyMailbox.of({
            ...mailbox,
            report: (report, publication) =>
              Effect.gen(function* () {
                entered.resolve()
                yield* Effect.promise(() => release.promise)
                yield* mailbox.report(report, publication)
              })
          })
        })
      )
      yield* Effect.promise(() => entered.promise)
      let closed = false
      const closing = Effect.runPromise(owner.host.closeWorkspace(workspaceId)).then(() => {
        closed = true
      })
      yield* Effect.promise(() => aborted.promise)
      assert.equal(closed, false)
      assert.equal((yield* owner.host.status('independent')).hasCurrentKey, true)
      assert.equal((yield* Effect.result(owner.host.status(workspaceId))).failure.code, 'closed')
      release.resolve()
      yield* Effect.promise(() => work)
      yield* Effect.promise(() => closing)
      assert.equal(closed, true)
      const staleIngest = yield* Effect.result(
        owner.host.ingestLedgerRecords(workspaceId, page([record], prepared.genesisHashHex, 0))
      )
      assert.equal(staleIngest.failure.code, 'closed')
      // A late IPC cannot recreate the now-unleased workspace owner.
      const stillClosed = yield* Effect.result(owner.host.keyRound(workspaceId, () => mailbox))
      assert.equal(stillClosed.failure.code, 'closed')
      assert.equal((yield* owner.host.open(workspaceId)).hasCurrentKey, true)
    })
  )
})

void test('local machine approval retains its exact signed original across restart and verifies the intended session', async (t) => {
  const directory = await fixture(t)
  const original = await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const context = yield* owner.host.localPairingContext(workspaceId)
      assert.match(context.pairingSessionId, /^[0-9a-f]{32}$/)
      assert.deepEqual(yield* owner.host.localPairingContext(workspaceId), context)
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
      const other = yield* openOwner(join(directory, 'machine'))
      const machine = yield* other.custody.prepareDevice()
      const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(context.genesisHash, 'hex')))
      const credentialHash = new Uint8Array(32).fill(73)
      const possession = yield* prepareDeviceAdmission({
        genesis,
        membershipId: Result.getOrThrow(
          Bytes.membershipId(Buffer.from(context.membershipId, 'hex'))
        ),
        encryptionPublicKey: machine.enc,
        kind: 'machine',
        signer: machine
      })
      const signature = yield* signDeviceCredentialBinding({
        genesis,
        pairingSessionId: Buffer.from(context.pairingSessionId, 'hex'),
        signingPublicKey: machine.publicKey,
        credentialHash,
        signer: machine
      })
      const material = {
        ok: true,
        type: 'prepare',
        machineId: 'synthetic-local-machine',
        pairingSessionId: context.pairingSessionId,
        signingPublicKey: hex(machine.publicKey.toBytes()),
        encryptionPublicKey: hex(machine.enc.toBytes()),
        possessionSignature: hex(possession.possessionSignature.toBytes()),
        credentialHash: hex(credentialHash),
        bindingSignature: hex(signature.toBytes()),
        protection: 'file'
      }
      const wrongSession = yield* Effect.result(
        owner.host.stageLocalPairing(workspaceId, {
          ...material,
          pairingSessionId: '00'.repeat(16)
        })
      )
      assert.ok(Result.isFailure(wrongSession))
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
      const alteredHash = yield* Effect.result(
        owner.host.stageLocalPairing(workspaceId, {
          ...material,
          credentialHash: '01'.repeat(32)
        })
      )
      assert.ok(Result.isFailure(alteredHash))
      const staged = yield* owner.host.stageLocalPairing(workspaceId, material)
      assert.deepEqual(staged, {
        pairingSessionId: context.pairingSessionId,
        protection: 'file',
        admitted: false
      })
      // A second window and retry after a lost prepare response keep the pending
      // approval's session and material; neither authorizes a new attempt.
      assert.deepEqual(yield* owner.host.localPairingContext(workspaceId), context)
      assert.deepEqual(yield* owner.host.stageLocalPairing(workspaceId, material), staged)
      assert.deepEqual(yield* owner.host.localPairingContext(workspaceId), context)
      // Preparing and cancelling the UI does not sign or append a ledger record.
      assert.equal((yield* owner.host.ledgerView(workspaceId)).recordsHex.length, 1)
      const request = yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId)
      assert.deepEqual(
        yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId),
        request
      )
      assert.equal(request.credentialHash, material.credentialHash)
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
      return {
        request,
        session: context.pairingSessionId,
        frontendSigningPublicKey: context.frontendSigningPublicKey,
        prepared,
        material
      }
    })
  )
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* owner.host.open(workspaceId)
      assert.equal(
        (yield* owner.host.localPairingContext(workspaceId)).pairingSessionId,
        original.session
      )
      assert.deepEqual(
        yield* owner.host.approveLocalPairing(workspaceId, original.session),
        original.request
      )
      const records = [
        Buffer.from(original.prepared.genesisRecordHex, 'hex'),
        Buffer.from(original.request.recordHex, 'hex')
      ]
      yield* owner.host.ingestLedgerRecords(
        workspaceId,
        page(records, original.prepared.genesisHashHex, 0)
      )
      assert.deepEqual(yield* owner.host.confirmLocalPairing(workspaceId, original.session), {
        machineId: original.material.machineId,
        pairingSessionId: original.session,
        frontendSigningPublicKey: original.frontendSigningPublicKey,
        genesisHash: original.prepared.genesisHashHex,
        signingPublicKey: original.material.signingPublicKey
      })
      assert.equal(yield* owner.host.approveLocalPairing(workspaceId, original.session), null)
      assert.equal((yield* owner.host.status(workspaceId)).length, 2)
    })
  )
})

void test('local status exposes only credential availability for old developer workspaces', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* openOwner(directory)
      yield* bind(owner)
      const host = yield* makeDesktopE2eeRuntimeHost({
        directory,
        ...owner,
        bootstrap: {
          ...owner.bootstrap,
          deviceCredential: () => Effect.fail(new Error('missing credential'))
        }
      })
      const status = yield* host.open(workspaceId)
      assert.equal(status.hasCurrentKey, true)
      assert.equal(status.hasDeviceCredential, false)
      assert.equal('credential' in status, false)
    })
  )
})

for (const outcome of ['unsigned', 'uncertain', 'committed', 'competing', 'admitted', 'revoked']) {
  void test(`local machine pairing preserves pending sessions and renews only after ${outcome} evidence`, async (t) => {
    const directory = await fixture(t)
    let original
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const prepared = yield* bind(owner)
        yield* owner.host.open(workspaceId)
        const context = yield* owner.host.localPairingContext(workspaceId)
        const genesis = Result.getOrThrow(
          Bytes.genesisHash(Buffer.from(context.genesisHash, 'hex'))
        )
        const machine = yield* owner.custody.prepareDevice()
        const credentialHash = new Uint8Array(32).fill(73)
        const possession = yield* prepareDeviceAdmission({
          genesis,
          membershipId: Result.getOrThrow(
            Bytes.membershipId(Buffer.from(context.membershipId, 'hex'))
          ),
          encryptionPublicKey: machine.enc,
          kind: 'machine',
          signer: machine
        })
        const signature = yield* signDeviceCredentialBinding({
          genesis,
          pairingSessionId: Buffer.from(context.pairingSessionId, 'hex'),
          signingPublicKey: machine.publicKey,
          credentialHash,
          signer: machine
        })
        const material = {
          ok: true,
          type: 'prepare',
          machineId: 'synthetic-machine',
          pairingSessionId: context.pairingSessionId,
          signingPublicKey: hex(machine.publicKey.toBytes()),
          encryptionPublicKey: hex(machine.enc.toBytes()),
          possessionSignature: hex(possession.possessionSignature.toBytes()),
          credentialHash: hex(credentialHash),
          bindingSignature: hex(signature.toBytes()),
          protection: 'file'
        }
        yield* owner.host.stageLocalPairing(workspaceId, material)
        let request =
          outcome === 'unsigned' || outcome === 'admitted' || outcome === 'revoked'
            ? null
            : yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId)
        if (outcome === 'admitted' || outcome === 'revoked') {
          // Another verified admission can settle staged material even when this
          // local journal never signed a request (approve then returns null).
          const records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
          const view = Result.getOrThrow(
            verifyLedger({
              anchor: genesis,
              records,
              checkpoint: { length: 1, head: hashRecordBytes(records[0]) }
            })
          )
          const signer = yield* owner.custody.openDevice(genesis)
          const record = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(view, signer.publicKey, {
                _tag: 'AdmitDevice',
                kind: 'machine',
                machineId: material.machineId,
                signingPublicKey: machine.publicKey,
                encryptionPublicKey: machine.enc,
                possessionSignature: possession.possessionSignature
              })
            ),
            signer
          )
          request = { recordHex: hex(record) }
        }
        if (outcome === 'committed' || outcome === 'admitted' || outcome === 'revoked') {
          const records = [
            Buffer.from(prepared.genesisRecordHex, 'hex'),
            Buffer.from(request.recordHex, 'hex')
          ]
          if (outcome === 'revoked') {
            const view = Result.getOrThrow(
              verifyLedger({
                anchor: genesis,
                records,
                checkpoint: { length: records.length, head: hashRecordBytes(records.at(-1)) }
              })
            )
            const signer = yield* owner.custody.openDevice(genesis)
            records.push(
              yield* signLedgerRecord(
                Result.getOrThrow(
                  prepareLedgerCommand(view, signer.publicKey, {
                    _tag: 'RevokeDevice',
                    target: machine.publicKey
                  })
                ),
                signer
              )
            )
          }
          yield* owner.host.ingestLedgerRecords(
            workspaceId,
            page(records, prepared.genesisHashHex, 0)
          )
        } else if (outcome === 'competing') {
          // Include enough records to compact: terminal evidence must survive retained reopen.
          const records = yield* makeRecords(owner.custody, prepared, 70)
          for (let start = 0; start < records.length; start += 64)
            yield* owner.host.ingestLedgerRecords(
              workspaceId,
              page(records, prepared.genesisHashHex, start, Math.min(start + 64, records.length))
            )
        }
        if (outcome === 'admitted')
          assert.equal(
            yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId),
            null
          )
        original = { request, material, context }
        yield* owner.custody.discardDevice(machine)
      })
    )
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        yield* owner.host.open(workspaceId)
        const context = yield* owner.host.localPairingContext(workspaceId)
        if (outcome === 'uncertain' || outcome === 'unsigned') {
          assert.equal(context.pairingSessionId, original.context.pairingSessionId)
          const approved = yield* owner.host.approveLocalPairing(
            workspaceId,
            context.pairingSessionId
          )
          if (outcome === 'uncertain') assert.deepEqual(approved, original.request)
          else assert.equal(typeof approved.recordHex, 'string')
          const conflict = yield* Effect.result(
            owner.host.stageLocalPairing(workspaceId, {
              ...original.material,
              signingPublicKey: '11'.repeat(32)
            })
          )
          assert.equal(conflict.failure.code, 'conflict')
        } else {
          assert.notEqual(context.pairingSessionId, original.context.pairingSessionId)
          const stale = yield* Effect.result(
            owner.host.approveLocalPairing(workspaceId, original.context.pairingSessionId)
          )
          assert.equal(stale.failure.code, 'conflict')
          const replacement = yield* owner.custody.prepareDevice()
          const genesis = Result.getOrThrow(
            Bytes.genesisHash(Buffer.from(context.genesisHash, 'hex'))
          )
          const credentialHash = new Uint8Array(32).fill(74)
          const possession = yield* prepareDeviceAdmission({
            genesis,
            membershipId: Result.getOrThrow(
              Bytes.membershipId(Buffer.from(context.membershipId, 'hex'))
            ),
            encryptionPublicKey: replacement.enc,
            kind: 'machine',
            signer: replacement
          })
          const signature = yield* signDeviceCredentialBinding({
            genesis,
            pairingSessionId: Buffer.from(context.pairingSessionId, 'hex'),
            signingPublicKey: replacement.publicKey,
            credentialHash,
            signer: replacement
          })
          const staged = yield* owner.host.stageLocalPairing(workspaceId, {
            ...original.material,
            pairingSessionId: context.pairingSessionId,
            signingPublicKey: hex(replacement.publicKey.toBytes()),
            encryptionPublicKey: hex(replacement.enc.toBytes()),
            possessionSignature: hex(possession.possessionSignature.toBytes()),
            credentialHash: hex(credentialHash),
            bindingSignature: hex(signature.toBytes())
          })
          assert.equal(staged.admitted, false)
          const request = yield* owner.host.approveLocalPairing(
            workspaceId,
            context.pairingSessionId
          )
          assert.ok(request)
          assert.notEqual(request.requestId, original.request?.requestId)
          yield* owner.custody.discardDevice(replacement)
        }
      })
    )
  })
}

void test('a second personal desktop verifies its pinned snapshot, installs through mailbox, exchanges encrypted content and reopens offline', async (t) => {
  const directory = await fixture(t)
  const secondDirectory = join(directory, 'second-desktop')
  let offered, prepared, request, admission, invitation, ciphertext
  const room = { kind: 'meta' }
  const context = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch'
  }
  const additionalData = new Uint8Array([7, 18])
  const plaintext = new TextEncoder().encode('synthetic two-personal-device content')
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory)
      prepared = yield* bind(first)
      yield* first.host.open(workspaceId)
      yield* first.host.ingestLedgerRecords(
        workspaceId,
        page([Buffer.from(prepared.genesisRecordHex, 'hex')], prepared.genesisHashHex, 0)
      )
      offered = yield* first.host.personalPairingOffer(workspaceId)
      assert.deepEqual(yield* first.host.personalPairingOffer(workspaceId), offered)
      const second = yield* ownerWithHost(secondDirectory)
      request = yield* second.bootstrap.preparePersonalJoin(offered)
      assert.deepEqual(yield* second.bootstrap.preparePersonalJoin(offered), request)
      const bad = JSON.parse(Buffer.from(request.requestHex, 'hex').toString())
      bad.credentialHash = '00'.repeat(32)
      const altered = Buffer.from(JSON.stringify(bad)).toString('hex')
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.previewPersonalAdmission(workspaceId, altered))
        )
      )
      const inspected = yield* first.host.previewPersonalAdmission(workspaceId, request.requestHex)
      assert.equal(inspected.signingPublicKey, request.signingPublicKey)
      assert.equal((yield* first.host.status(workspaceId)).length, 1)
      admission = yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex)
      assert.deepEqual(
        yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex),
        admission
      )
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.personalInvitation(workspaceId, offered.pairingSessionId))
        )
      )
    })
  )
  // Both recipient request and approving signature survive closing all native owners.
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory)
      const second = yield* ownerWithHost(secondDirectory)
      assert.deepEqual(yield* second.bootstrap.preparePersonalJoin(offered), request)
      yield* first.host.open(workspaceId)
      assert.deepEqual(
        yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex),
        admission
      )
      const records = [
        Buffer.from(prepared.genesisRecordHex, 'hex'),
        Buffer.from(admission.recordHex, 'hex')
      ]
      yield* first.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 1))
      invitation = yield* first.host.personalInvitation(workspaceId, offered.pairingSessionId)
      assert.deepEqual(
        yield* first.host.personalInvitation(workspaceId, offered.pairingSessionId),
        invitation
      )
      const corrupt = JSON.parse(Buffer.from(invitation.invitationHex, 'hex').toString())
      corrupt.headSignature = '00'.repeat(64)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            second.bootstrap.acceptPersonalJoin(
              workspaceId,
              Buffer.from(JSON.stringify(corrupt)).toString('hex')
            )
          )
        )
      )
      assert.ok(Result.isFailure(yield* Effect.result(second.host.open(workspaceId))))
      yield* second.bootstrap.acceptPersonalJoin(workspaceId, invitation.invitationHex)
      const joined = yield* second.host.open(workspaceId)
      assert.equal(joined.length, 2)
      assert.equal(joined.deviceKind, 'personal')
      assert.equal(joined.hasDeviceCredential, true)
      assert.equal(joined.hasCurrentKey, false)
      assert.equal(joined.position, `p1:${workspaceId}:2:source-2:0`)
      const unrelated = (yield* makeRecords(first.custody, prepared, 2))[1]
      const forgedSuffix = [...records, unrelated]
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            second.host.ingestLedgerRecords(workspaceId, {
              ...page(forgedSuffix, prepared.genesisHashHex, 2),
              startIndex: 3
            })
          )
        )
      )
      assert.equal((yield* second.host.status(workspaceId)).length, 2)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            second.host.ingestLedgerRecords(
              workspaceId,
              page(forgedSuffix, prepared.genesisHashHex, 2)
            )
          )
        )
      )
      const restoredAfterBadSuffix = yield* second.host.open(workspaceId)
      assert.equal(restoredAfterBadSuffix.length, 2)
      assert.equal(restoredAfterBadSuffix.position, joined.position)
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)), length: 2 }
        })
      )
      const mailboxHost = yield* makeSqliteKeyMailbox({
        path: join(directory, 'two-desktop-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const firstDevice = yield* first.custody.openDevice(genesis)
      const secondDevice = yield* second.custody.openDevice(genesis)
      const firstMailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, firstDevice.publicKey)),
        KeyMailbox
      )
      const secondMailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, secondDevice.publicKey)),
        KeyMailbox
      )
      yield* first.host.keyRound(workspaceId, () => firstMailbox)
      yield* second.host.keyRound(workspaceId, () => secondMailbox)
      assert.equal((yield* second.host.status(workspaceId)).hasCurrentKey, true)
      ciphertext = yield* first.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      assert.deepEqual(
        yield* second.host.openContent(workspaceId, {
          room,
          context,
          ...ciphertext,
          additionalData
        }),
        plaintext
      )
      const reply = yield* second.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      assert.deepEqual(
        yield* first.host.openContent(workspaceId, { room, context, ...reply, additionalData }),
        plaintext
      )
      assert.deepEqual((yield* second.host.ledgerView(workspaceId)).recordPositions, [0])
    })
  )
  await execute(
    Effect.gen(function* () {
      const second = yield* ownerWithHost(secondDirectory)
      const reopened = yield* second.host.open(workspaceId)
      assert.equal(reopened.length, 2)
      assert.equal(reopened.hasCurrentKey, true)
      assert.deepEqual(
        yield* second.host.openContent(workspaceId, {
          room,
          context,
          ...ciphertext,
          additionalData
        }),
        plaintext
      )
    })
  )
  // A disposable cache cannot change the imported pin or require downloading the prefix.
  historyDb(secondDirectory, (db) => db.prepare('UPDATE cache SET origin=?').run('{corrupt'))
  await execute(
    Effect.gen(function* () {
      const second = yield* ownerWithHost(secondDirectory)
      assert.equal((yield* second.host.open(workspaceId)).hasCurrentKey, true)
    })
  )
})

void test('a snapshot-joined desktop installs only the current epoch and derives older content from the verified history chain', async (t) => {
  const directory = await fixture(t),
    secondDirectory = join(directory, 'second-desktop')
  const room = { kind: 'meta' },
    context = { protocol: 'loro-streams-crdt-payload-protection', version: 2, kind: 'update_batch' }
  const additionalData = new Uint8Array([21]),
    plaintext = new TextEncoder().encode('synthetic older epoch content')
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory),
        prepared = yield* bind(first)
      yield* first.host.open(workspaceId)
      const oldContent = yield* first.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const signer = yield* first.custody.openDevice(genesis)
      const records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
      let view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)), length: 1 }
        })
      )
      const keysLayer = InstalledEpochKeys.layer.pipe(
        Layer.provideMerge(
          sqliteInstalledKeyStore({
            path: join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite'),
            mode: 'open'
          })
        ),
        Layer.provideMerge(VerifiedLedger.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            desktopE2eePorts(first.custody, signer),
            Layer.succeed(WorkspaceScope, { genesis }),
            Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(view) }),
            Layer.succeed(LedgerPinStore, {
              read: () => Effect.succeed(null),
              write: () => Effect.void
            })
          )
        )
      )
      const keys = Context.get(yield* Layer.build(keysLayer), InstalledEpochKeys)
      const currentKey = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(61)))
      yield* Effect.acquireUseRelease(
        keys.read(0),
        (previousKey) =>
          Effect.gen(function* () {
            const commitment = Result.getOrThrow(commitEpochKey(genesis, 1, currentKey))
            const previousEpochKey = Result.getOrThrow(
              sealHistoryPacket({ genesis, epoch: 1, currentKey, previousKey })
            )
            const body = Result.getOrThrow(
              encodeCbor([
                view.head.toBytes(),
                signer.publicKey.toBytes(),
                [7, 1, commitment.toBytes(), previousEpochKey]
              ])
            )
            const rotation = yield* signLedgerRecord(
              Result.getOrThrow(prepareLedgerRecord(view, body)),
              signer
            )
            records.push(rotation)
            view = Result.getOrThrow(
              extendLedger(view, [rotation], { head: hashRecordBytes(rotation), length: 2 })
            )
            yield* first.host.ingestLedgerRecords(
              workspaceId,
              page(records, prepared.genesisHashHex, 0)
            )
            yield* keys.saveAndReload(1, currentKey)
          }),
        (key) => Effect.sync(() => disposeEpochKey(key))
      )
      disposeEpochKey(currentKey)
      const offer = yield* first.host.personalPairingOffer(workspaceId)
      const second = yield* ownerWithHost(secondDirectory),
        request = yield* second.bootstrap.preparePersonalJoin(offer)
      const admission = yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex)
      records.push(Buffer.from(admission.recordHex, 'hex'))
      view = Result.getOrThrow(
        extendLedger(view, [records.at(-1)], { head: hashRecordBytes(records.at(-1)), length: 3 })
      )
      yield* first.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 2))
      const invitation = yield* first.host.personalInvitation(workspaceId, offer.pairingSessionId)
      yield* second.bootstrap.acceptPersonalJoin(workspaceId, invitation.invitationHex)
      assert.equal((yield* second.host.open(workspaceId)).epoch, 1)
      const mailboxHost = yield* makeSqliteKeyMailbox({
        path: join(directory, 'history-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const secondSigner = yield* second.custody.openDevice(genesis)
      const firstMailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, signer.publicKey)),
        KeyMailbox
      )
      const secondMailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, secondSigner.publicKey)),
        KeyMailbox
      )
      yield* first.host.keyRound(workspaceId, () => firstMailbox)
      yield* second.host.keyRound(workspaceId, () => secondMailbox)
      assert.equal((yield* second.host.status(workspaceId)).hasCurrentKey, true)
      assert.deepEqual(
        yield* second.host.openContent(workspaceId, {
          room,
          context,
          ...oldContent,
          additionalData
        }),
        plaintext
      )
      // The old key is derived from the authenticated history packet, never sent via staging/mailbox.
      const oldEpochFetch = yield* Effect.result(
        secondMailbox.fetch(
          { genesis: prepared.genesisHashHex, epoch: 0, recipient: request.signingPublicKey },
          null,
          100
        )
      )
      assert.equal(oldEpochFetch.failure.reason, 'unauthorized')
      const reply = yield* second.host.seal(workspaceId, {
        epoch: 1,
        room,
        context,
        plaintext,
        additionalData
      })
      assert.deepEqual(
        yield* first.host.openContent(workspaceId, { room, context, ...reply, additionalData }),
        plaintext
      )
    })
  )
})

void test('the approval display pins the exact request and canceled unsigned sessions can renew without replacing keys', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory)
      yield* bind(first)
      yield* first.host.open(workspaceId)
      const offer = yield* first.host.personalPairingOffer(workspaceId)
      const second = yield* ownerWithHost(join(directory, 'second'))
      const third = yield* ownerWithHost(join(directory, 'third'))
      const a = yield* second.bootstrap.preparePersonalJoin(offer)
      const b = yield* third.bootstrap.preparePersonalJoin(offer)
      assert.notEqual(a.signingPublicKey, b.signingPublicKey)
      yield* first.host.previewPersonalAdmission(workspaceId, a.requestHex)
      const substituted = yield* Effect.result(
        first.host.preparePersonalAdmission(workspaceId, b.requestHex)
      )
      assert.equal(substituted.failure.code, 'conflict')
      assert.equal((yield* first.host.status(workspaceId)).length, 1)
      // Caller has reconciled the backend terminal canceled state before these narrow local operations.
      yield* second.bootstrap.retirePersonalJoin(workspaceId, offer.pairingSessionId)
      yield* second.bootstrap.retirePersonalJoin(workspaceId, offer.pairingSessionId)
      yield* first.host.retirePersonalPairing(workspaceId, offer.pairingSessionId)
      yield* first.host.retirePersonalPairing(workspaceId, offer.pairingSessionId)
      const next = yield* first.host.personalPairingOffer(workspaceId)
      assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            second.bootstrap.preparePersonalJoin({ ...next, endorser: b.signingPublicKey })
          )
        )
      )
      const renewed = yield* second.bootstrap.preparePersonalJoin(next)
      assert.equal(renewed.signingPublicKey, a.signingPublicKey)
      assert.equal(renewed.credentialHash, a.credentialHash)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.preparePersonalAdmission(workspaceId, a.requestHex))
        )
      )
      yield* first.host.previewPersonalAdmission(workspaceId, renewed.requestHex)
      const signed = yield* first.host.preparePersonalAdmission(workspaceId, renewed.requestHex)
      assert.ok(signed.recordHex)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.retirePersonalPairing(workspaceId, next.pairingSessionId))
        )
      )
      assert.deepEqual(
        yield* first.host.preparePersonalAdmission(workspaceId, renewed.requestHex),
        signed
      )
    })
  )
})

void test('a verified competing parent settles a lost personal admission without discarding its original or replacing recipient identity', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory),
        prepared = yield* bind(first)
      yield* first.host.open(workspaceId)
      const offer = yield* first.host.personalPairingOffer(workspaceId)
      const second = yield* ownerWithHost(join(directory, 'second'))
      const request = yield* second.bootstrap.preparePersonalJoin(offer)
      const signed = yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            first.host.retirePersonalPairing(workspaceId, offer.pairingSessionId)
          )
        )
      )
      assert.deepEqual(
        yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex),
        signed
      )
      // A valid, different CAS winner at the exact signed parent is ledger proof.
      const competing = yield* makeRecords(first.custody, prepared, 2)
      yield* first.host.ingestLedgerRecords(
        workspaceId,
        page(competing, prepared.genesisHashHex, 0)
      )
      const next = yield* first.host.personalPairingOffer(workspaceId)
      assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
      yield* first.host.retirePersonalPairing(workspaceId, offer.pairingSessionId)
      const retained = historyDb(directory, (db) =>
        db
          .prepare('SELECT record,request_id,retired FROM personal_pairing WHERE session=?')
          .get(offer.pairingSessionId)
      )
      assert.equal(hex(retained.record), signed.recordHex)
      assert.equal(retained.request_id, signed.requestId)
      assert.equal(retained.retired, 1)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.preparePersonalAdmission(workspaceId, request.requestHex))
        )
      )
      // The recipient has reconciled terminal conflict before retiring the old request.
      yield* second.bootstrap.retirePersonalJoin(workspaceId, offer.pairingSessionId)
      const renewed = yield* second.bootstrap.preparePersonalJoin(next)
      assert.equal(renewed.signingPublicKey, request.signingPublicKey)
      assert.equal(renewed.credentialHash, request.credentialHash)
      const nextSigned = yield* first.host.preparePersonalAdmission(workspaceId, renewed.requestHex)
      assert.notEqual(nextSigned.recordHex, signed.recordHex)
      assert.equal((yield* first.host.status(workspaceId)).length, 2)
    })
  )
})

void test('terminal cancellation can archive a signed pre-reservation intent, while unknown or committed admissions remain protected', async (t) => {
  const directory = await fixture(t)
  let request, signed, offer
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory)
      yield* bind(first)
      yield* first.host.open(workspaceId)
      offer = yield* first.host.personalPairingOffer(workspaceId)
      const second = yield* ownerWithHost(join(directory, 'second'))
      request = yield* second.bootstrap.preparePersonalJoin(offer)
      signed = yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            first.host.retirePersonalPairing(workspaceId, offer.pairingSessionId)
          )
        )
      )
      // Main invokes only after the service confirmed this session terminal-cancelled
      // before append reservation. All original bytes remain available locally.
      yield* first.host.cancelPersonalPairing(workspaceId, offer.pairingSessionId)
      yield* first.host.cancelPersonalPairing(workspaceId, offer.pairingSessionId)
      yield* second.bootstrap.retirePersonalJoin(workspaceId, offer.pairingSessionId)
    })
  )
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory),
        second = yield* ownerWithHost(join(directory, 'second'))
      yield* first.host.open(workspaceId)
      const next = yield* first.host.personalPairingOffer(workspaceId)
      assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
      const retained = historyDb(directory, (db) =>
        db
          .prepare('SELECT record,request_id,retired FROM personal_pairing WHERE session=?')
          .get(offer.pairingSessionId)
      )
      assert.equal(hex(retained.record), signed.recordHex)
      assert.equal(retained.request_id, signed.requestId)
      assert.equal(retained.retired, 1)
      const renewed = yield* second.bootstrap.preparePersonalJoin(next)
      assert.equal(renewed.signingPublicKey, request.signingPublicKey)
      assert.equal(renewed.credentialHash, request.credentialHash)
      const committed = yield* first.host.preparePersonalAdmission(workspaceId, renewed.requestHex)
      const records = [
        Buffer.from(next.genesisRecordHex, 'hex'),
        Buffer.from(committed.recordHex, 'hex')
      ]
      yield* first.host.ingestLedgerRecords(workspaceId, page(records, next.genesisHash, 0))
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.cancelPersonalPairing(workspaceId, next.pairingSessionId))
        )
      )
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.retirePersonalPairing(workspaceId, next.pairingSessionId))
        )
      )
      assert.equal((yield* first.host.status(workspaceId)).length, 2)
    })
  )
})

for (const recovery of ['retry', 'cancel-and-renew']) {
  void test(`a pending personal pin remains discoverable before request persistence and ${recovery} reuses original custody after reopen`, async (t) => {
    const directory = await fixture(t)
    const secondDirectory = join(directory, 'second')
    let offer, originalKey, originalCredential
    await execute(
      Effect.gen(function* () {
        const first = yield* ownerWithHost(directory)
        yield* bind(first)
        yield* first.host.open(workspaceId)
        offer = yield* first.host.personalPairingOffer(workspaceId)
        const second = yield* ownerWithHost(secondDirectory)
        assert.equal(yield* second.bootstrap.pendingPersonalJoin(workspaceId), null)
        const db = new DatabaseSync(join(secondDirectory, 'creations.sqlite'))
        try {
          db.exec(
            "CREATE TRIGGER synthetic_request_full BEFORE UPDATE OF request_hex ON personal_joins BEGIN SELECT RAISE(ABORT, 'synthetic request persistence failure'); END"
          )
        } finally {
          db.close()
        }
        const failed = yield* Effect.result(second.bootstrap.preparePersonalJoin(offer))
        assert.ok(Result.isFailure(failed))
        const pending = yield* second.bootstrap.pendingPersonalJoin(workspaceId)
        assert.deepEqual(pending, { offer, pairingSessionId: offer.pairingSessionId })
        const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(offer.genesisHash, 'hex')))
        const device = yield* second.custody.openDevice(genesis)
        originalKey = hex(device.publicKey.toBytes())
        originalCredential = yield* second.custody.deviceCredential(genesis, device.publicKey)
        // Querying the pin cannot manufacture request evidence or change native keys.
        assert.deepEqual(yield* second.bootstrap.pendingPersonalJoin(workspaceId), pending)
        const unchanged = yield* second.custody.openDevice(genesis)
        assert.equal(hex(unchanged.publicKey.toBytes()), originalKey)
        assert.equal(
          yield* second.custody.deviceCredential(genesis, unchanged.publicKey),
          originalCredential
        )
      })
    )
    await execute(
      Effect.gen(function* () {
        const second = yield* ownerWithHost(secondDirectory)
        assert.deepEqual(yield* second.bootstrap.pendingPersonalJoin(workspaceId), {
          offer,
          pairingSessionId: offer.pairingSessionId
        })
        const db = new DatabaseSync(join(secondDirectory, 'creations.sqlite'))
        try {
          db.exec('DROP TRIGGER synthetic_request_full')
        } finally {
          db.close()
        }
        let targetOffer = offer
        if (recovery === 'cancel-and-renew') {
          // These local retirement calls follow authoritative terminal cancellation;
          // the IPC/relay suite separately tests that admission arbitration boundary.
          const first = yield* ownerWithHost(directory)
          yield* first.host.open(workspaceId)
          yield* first.host.cancelPersonalPairing(workspaceId, offer.pairingSessionId)
          yield* second.bootstrap.retirePersonalJoin(workspaceId, offer.pairingSessionId)
          targetOffer = yield* first.host.personalPairingOffer(workspaceId)
          assert.notEqual(targetOffer.pairingSessionId, offer.pairingSessionId)
        }
        const renewed = yield* second.bootstrap.preparePersonalJoin(targetOffer)
        assert.equal(renewed.signingPublicKey, originalKey)
        const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(offer.genesisHash, 'hex')))
        const device = yield* second.custody.openDevice(genesis)
        assert.equal(
          yield* second.custody.deviceCredential(genesis, device.publicKey),
          originalCredential
        )
        assert.deepEqual(yield* second.bootstrap.pendingPersonalJoin(workspaceId), {
          offer: targetOffer,
          pairingSessionId: targetOffer.pairingSessionId,
          signingPublicKey: originalKey,
          credentialHash: renewed.credentialHash,
          requestHex: renewed.requestHex
        })
      })
    )
  })
}

void test('D03 unknown identity companion blocks only new signatures; existing workspace and signed originals reopen offline', async (t) => {
  const directory = await fixture(t)
  let original
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      original = yield* bind(owner)
      yield* owner.host.open(workspaceId)
    })
  )
  const protectedBytes = Buffer.from('{"version":99,"opaque":"future account identity"}')
  await writeFile(join(directory, 'account-identity.json'), protectedBytes)
  await execute(
    Effect.gen(function* () {
      const owner = yield* openOwner(directory, (value) => value, false)
      const host = yield* makeDesktopE2eeRuntimeHost({ directory, ...owner })
      assert.equal((yield* host.open(workspaceId)).hasCurrentKey, true)
      assert.equal(yield* owner.bootstrap.creationNeedsAccountIdentity(intent), false)
      assert.deepEqual(yield* owner.bootstrap.prepareCreation(intent), original)
      const next = { ...intent, requestId: 'another-request-01234567' }
      const rejected = yield* Effect.result(owner.bootstrap.creationNeedsAccountIdentity(next))
      assert.equal(rejected.failure.code, 'corrupt')
      assert.equal((yield* host.status(workspaceId)).hasCurrentKey, true)
    })
  )
  assert.deepEqual(await readFile(join(directory, 'account-identity.json')), protectedBytes)
})

void test('superseded unsigned retirement retains its native cause in main before host sanitization and recovers', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const context = yield* owner.host.localPairingContext(workspaceId)
      const db = new DatabaseSync(join(directory, 'workspaces', workspaceId, 'history.sqlite'))
      try {
        db.exec(
          "CREATE TRIGGER fail_unsigned_retirement BEFORE INSERT ON retired_local_pairings BEGIN SELECT RAISE(ABORT,'synthetic retirement write failure'); END"
        )
        let original
        const failed = yield* Effect.result(
          owner.host.retireSupersededLocalPairing(
            workspaceId,
            context.pairingSessionId,
            (error) => {
              original = error
            }
          )
        )
        assert.equal(failed._tag, 'Failure')
        assert.equal(failed.failure.code, 'storage')
        assert.equal(failed.failure.cause, undefined)
        assert.equal(original.code, 'storage')
        assert.match(original.cause.message, /synthetic retirement write failure/)
        assert.equal(original.cause.errcode, 1811)
        assert.equal(
          (yield* owner.host.localPairingContext(workspaceId)).pairingSessionId,
          context.pairingSessionId
        )
        db.exec('DROP TRIGGER fail_unsigned_retirement')
        yield* owner.host.retireSupersededLocalPairing(
          workspaceId,
          context.pairingSessionId,
          () => {
            throw new Error('successful retry must not report failure')
          }
        )
        assert.notEqual(
          (yield* owner.host.localPairingContext(workspaceId)).pairingSessionId,
          context.pairingSessionId
        )
        assert.equal(
          db.prepare('SELECT session FROM retired_local_pairings').get().session,
          context.pairingSessionId
        )
      } finally {
        db.close()
      }
    })
  )
})

void test('reopens without a candidate and installs committed staging originals before mailbox repair', async (t) => {
  const directory = await fixture(t)
  let prepared, records, group
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const signer = yield* owner.custody.openDevice(genesis)
      records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
      let view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records,
          checkpoint: { head: hashRecordBytes(records[0]), length: 1 }
        })
      )
      const ports = Layer.mergeAll(
        desktopE2eePorts(owner.custody, signer),
        Layer.succeed(WorkspaceScope, { genesis }),
        Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(view) }),
        Layer.succeed(LedgerPinStore, {
          read: () => Effect.succeed(null),
          write: () => Effect.void
        })
      )
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
            Layer.provideMerge(ports)
          )
        ),
        InstalledEpochKeys
      )
      const next = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(71)))
      try {
        const packet = yield* Effect.acquireUseRelease(
          keys.read(0),
          (previousKey) =>
            Effect.succeed(
              Result.getOrThrow(
                sealHistoryPacket({ genesis, epoch: 1, currentKey: next, previousKey })
              )
            ),
          (key) => Effect.sync(() => disposeEpochKey(key))
        )
        const commitment = Result.getOrThrow(commitEpochKey(genesis, 1, next))
        const body = Result.getOrThrow(
          encodeCbor([
            view.head.toBytes(),
            signer.publicKey.toBytes(),
            [7, 1, commitment.toBytes(), packet]
          ])
        )
        const record = yield* signLedgerRecord(
          Result.getOrThrow(prepareLedgerRecord(view, body)),
          signer
        )
        records.push(record)
        view = Result.getOrThrow(
          extendLedger(view, [record], { head: hashRecordBytes(record), length: 2 })
        )
        const frame = yield* prepareEpochEnvelope({
          context: {
            genesis,
            epoch: Result.getOrThrow(Bytes.epochNumber(1)),
            sender: signer.publicKey,
            recipient: signer.publicKey
          },
          key: next,
          signer,
          ledger: () => Effect.succeed(view)
        })
        group = {
          ...Result.getOrThrow(getCommittedEpochStagingKey(view, 1)),
          record,
          envelopes: [{ recipient: hex(signer.publicKey.toBytes()), frame }]
        }
      } finally {
        disposeEpochKey(next)
      }
    })
  )
  // The publication key has been wiped and all former native owners are closed.
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, false)
      assert.equal((yield* owner.host.status(workspaceId)).writeEpoch, 0)
      yield* owner.host.closeWorkspace(workspaceId)
      assert.equal((yield* owner.host.open(workspaceId)).writeEpoch, 0)
      const oldRequest = {
        epoch: 0,
        room: { kind: 'doc', docId: 'staged-document' },
        context: {
          protocol: 'loro-streams-crdt-payload-protection',
          version: 2,
          kind: 'update_batch'
        },
        plaintext: new Uint8Array([4, 5]),
        additionalData: new Uint8Array([3])
      }
      const retained = yield* owner.host.seal(workspaceId, oldRequest)
      assert.deepEqual(
        yield* owner.host.openContent(workspaceId, { ...oldRequest, ...retained }),
        oldRequest.plaintext
      )

      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const signer = yield* owner.custody.openDevice(genesis)
      const view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
        })
      )
      const mailboxHost = yield* makeSqliteKeyMailbox({
        path: join(directory, 'staged-only-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const mailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, signer.publicKey)),
        KeyMailbox
      )
      let unavailable = true
      const staging = () => ({
        readGroup: () =>
          Effect.suspend(() =>
            unavailable ? Effect.fail(new Error('temporary-staging')) : Effect.succeed(group)
          )
      })
      assert.equal(
        Result.isFailure(
          yield* Effect.result(owner.host.keyRound(workspaceId, () => mailbox, staging))
        ),
        true
      )
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, false)
      const afterFailure = yield* owner.host.seal(workspaceId, oldRequest)
      assert.deepEqual(
        yield* owner.host.openContent(workspaceId, { ...oldRequest, ...afterFailure }),
        oldRequest.plaintext
      )
      unavailable = false
      yield* owner.host.keyRound(workspaceId, () => mailbox, staging)
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
      const sealed = yield* owner.host.seal(workspaceId, {
        epoch: 1,
        room: { kind: 'doc', docId: 'staged-document' },
        context: {
          protocol: 'loro-streams-crdt-payload-protection',
          version: 2,
          kind: 'update_batch'
        },
        plaintext: new Uint8Array([1, 2]),
        additionalData: new Uint8Array([3])
      })
      assert.ok(sealed.sealed.length > 2)
    })
  )
})

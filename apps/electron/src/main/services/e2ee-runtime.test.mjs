import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Context, Effect, Layer, Result, Scope, Exit } from 'effect'
import { KeyMailbox } from '@lody/e2ee-core/services'
import { makeSqliteKeyMailbox, referenceKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite'
import {
  Bytes,
  hashRecordBytes,
  prepareJoinRequest,
  prepareDeviceAdmission,
  signDeviceCredentialBinding,
  prepareLedgerCommand,
  signLedgerRecord,
  extendLedger,
  verifyLedger
} from '@lody/e2ee-core/protocol'
import { makeDesktopE2eeCustody } from '../e2ee-custody.mts'
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
const openOwner = (directory, override = (custody) => custody) =>
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
      // Preparing and cancelling the UI does not sign or append a ledger record.
      assert.equal((yield* owner.host.ledgerView(workspaceId)).recordsHex.length, 1)
      const request = yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId)
      assert.deepEqual(
        yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId),
        request
      )
      assert.equal(request.credentialHash, material.credentialHash)
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
      return { request, session: context.pairingSessionId, prepared, material }
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

for (const outcome of ['unsigned', 'uncertain', 'committed', 'competing']) {
  void test(`local machine pairing can replace lost material only after ${outcome} evidence`, async (t) => {
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
        const request =
          outcome === 'unsigned'
            ? null
            : yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId)
        if (outcome === 'committed') {
          yield* owner.host.ingestLedgerRecords(
            workspaceId,
            page(
              [
                Buffer.from(prepared.genesisRecordHex, 'hex'),
                Buffer.from(request.recordHex, 'hex')
              ],
              prepared.genesisHashHex,
              0
            )
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
        original = { request, material, context }
        yield* owner.custody.discardDevice(machine)
      })
    )
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        yield* owner.host.open(workspaceId)
        const context = yield* owner.host.localPairingContext(workspaceId)
        if (outcome === 'uncertain') {
          assert.equal(context.pairingSessionId, original.context.pairingSessionId)
          assert.deepEqual(
            yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId),
            original.request
          )
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

import { openSqliteConnection } from '../../../../../packages/e2ee-core/src/adapters/node-sqlite/store.ts'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Context, Effect, Layer, Result, Scope, Exit, Deferred, Fiber } from 'effect'
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
  decodeRecord,
  prepareLedgerRecord,
  commitEpochKey,
  sealHistoryPacket,
  hashRecordBytes,
  mailboxDigest,
  epochDeliveryId,
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
import { decodeMemberKeyPackage } from './e2ee-member-join.mts'
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
for (const damage of ['history', 'pin']) {
  void test(`damaged authoritative ${damage} has a distinct recovery code and preserves originals`, async (t) => {
    const directory = await fixture(t)
    let prepared, records
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        prepared = yield* bind(owner)
        records = yield* makeRecords(owner.custody, prepared, 3)
        yield* owner.host.open(workspaceId)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, prepared.genesisHashHex, 0)
        )
      })
    )
    const pinPath = join(directory, 'workspaces', workspaceId, 'ledger-pin.sqlite')
    const pin = new DatabaseSync(pinPath)
    const trusted = pin.prepare('SELECT * FROM ledger_pin').all()
    if (damage === 'pin') pin.exec('UPDATE ledger_pin SET count=0')
    pin.close()
    const damaged = records[2].slice()
    damaged[damaged.length - 1] ^= 1
    if (damage === 'history')
      historyDb(directory, (db) =>
        db.prepare('UPDATE records SET record=? WHERE position=2').run(damaged)
      )
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const failed = yield* Effect.result(owner.host.open(workspaceId))
        assert.equal(
          failed.failure.code,
          damage === 'history' ? 'local-history-recovery-required' : 'trusted-pin-unavailable'
        )
        const managementFailure = yield* Effect.result(
          owner.host.manage(workspaceId, { type: 'rotate' }, () => {
            throw new Error('unusable host must not access remote ports')
          })
        )
        assert.equal(managementFailure.failure.code, failed.failure.code)
        // The damaged workspace cannot prevent another independent workspace opening.
        const next = yield* owner.bootstrap.prepareCreation({
          ...intent,
          requestId: 'second-recovery-request',
          slug: 'second'
        })
        yield* owner.bootstrap.recordCreated({
          workspaceId: 'second-workspace',
          genesisHash: next.genesisHashHex,
          requestId: 'second-recovery-request'
        })
        assert.equal((yield* owner.host.open('second-workspace')).hasCurrentKey, true)
      })
    )
    const after = new DatabaseSync(pinPath)
    if (damage === 'history')
      assert.deepEqual(after.prepare('SELECT * FROM ledger_pin').all(), trusted)
    else assert.equal(after.prepare('SELECT count FROM ledger_pin').get().count, 0)
    after.close()
    if (damage === 'history')
      historyDb(directory, (db) =>
        assert.deepEqual(
          new Uint8Array(db.prepare('SELECT record FROM records WHERE position=2').get().record),
          damaged
        )
      )
  })
}
void test('a failed workspace finalizer reports restart, retains its fence and leaves a sibling available', async (t) => {
  const directory = await fixture(t)
  const scope = Effect.runSync(Scope.make())
  const run = (work) => Effect.runPromise(work.pipe(Scope.provide(scope)))
  const owner = await run(ownerWithHost(directory))
  await run(bind(owner))
  await run(owner.host.open(workspaceId))
  const next = await run(
    owner.bootstrap.prepareCreation({
      ...intent,
      requestId: 'sibling-finalizer-request',
      slug: 'sibling'
    })
  )
  await run(
    owner.bootstrap.recordCreated({
      workspaceId: 'sibling',
      genesisHash: next.genesisHashHex,
      requestId: 'sibling-finalizer-request'
    })
  )
  await run(owner.host.open('sibling'))
  const original = DatabaseSync.prototype.close
  let retained
  try {
    DatabaseSync.prototype.close = function () {
      retained = this
      throw new Error('synthetic history close failure')
    }
    const failed = await run(Effect.exit(owner.host.closeWorkspace(workspaceId)))
    DatabaseSync.prototype.close = original
    assert.equal(Exit.isFailure(failed), true)
    const blocked = await run(Effect.result(owner.host.open(workspaceId)))
    assert.equal(blocked.failure.code, 'restart-required')
    const managementFailure = await run(
      Effect.result(
        owner.host.manage(workspaceId, { type: 'rotate' }, () => {
          throw new Error('failed close must not access remote ports')
        })
      )
    )
    assert.equal(managementFailure.failure.code, 'restart-required')
    assert.equal((await run(owner.host.status('sibling'))).hasCurrentKey, true)
    const retry = await run(Effect.exit(owner.host.closeWorkspace(workspaceId)))
    assert.equal(Exit.isFailure(retry), true)
  } finally {
    DatabaseSync.prototype.close = original
    if (retained) original.call(retained)
    await run(Effect.exit(Scope.close(scope, Exit.void)))
  }
})

for (const damage of ['history', 'pin']) {
  void test(`a corrupt ${damage} SQLite image preserves bytes and reports a safe recovery code`, async (t) => {
    const directory = await fixture(t)
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        yield* bind(owner)
        yield* owner.host.open(workspaceId)
      })
    )
    const path = join(
      directory,
      'workspaces',
      workspaceId,
      damage === 'history' ? 'history.sqlite' : 'ledger-pin.sqlite'
    )
    const original = Buffer.from('synthetic damaged SQLite image')
    await writeFile(path, original)
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const failed = yield* Effect.result(owner.host.open(workspaceId))
        assert.equal(
          failed.failure.code,
          damage === 'history' ? 'local-history-recovery-required' : 'trusted-pin-unavailable'
        )
      })
    )
    assert.deepEqual(await readFile(path), original)
  })
}

const memberWithHost = Effect.fnUntraced(function* (folder) {
  const custody = yield* makeDesktopE2eeCustody({
    directory: join(folder, 'custody'),
    platform: 'linux',
    safeStorage
  })
  const bootstrap = yield* makeDesktopE2eeBootstrap({
    directory: folder,
    accountId: 'other-account',
    custody
  })
  yield* bootstrap.recordAccountIdentity({
    accountId: 'other-account',
    cryptoUserId: 'bb'.repeat(32)
  })
  const host = yield* makeDesktopE2eeRuntimeHost({ directory: folder, custody, bootstrap })
  return { custody, bootstrap, host }
})

void test('a different account retains its KeyPackage, joins as Member, exchanges encrypted content and reopens offline', async (t) => {
  const directory = await fixture(t)
  const memberDirectory = join(directory, 'member')
  const openMember = (folder = memberDirectory) => memberWithHost(folder)
  let offer, original, admission, prepared, encrypted
  const room = { kind: 'meta' }
  const context = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch'
  }
  const plaintext = new TextEncoder().encode('synthetic team collaboration')
  const additionalData = new Uint8Array([1, 2, 3])
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      offer = yield* owner.host.memberOffer(workspaceId, 'email', 9_000_000_000_000)
      const member = yield* openMember()
      original = yield* member.bootstrap.prepareMemberJoin(offer)
      assert.deepEqual(yield* member.bootstrap.prepareMemberJoin(offer), original)
      assert.equal(
        hex(decodeMemberKeyPackage(original.keyPackageHex).request.userId.toBytes()),
        'bb'.repeat(32)
      )
      assert.ok(Result.isFailure(yield* Effect.result(member.host.open(workspaceId))))
      yield* owner.host.inspectMemberAdmission(workspaceId, original.keyPackageHex)
      admission = yield* owner.host.prepareMemberAdmission(workspaceId, original.keyPackageHex)
      assert.deepEqual(
        yield* owner.host.prepareMemberAdmission(workspaceId, original.keyPackageHex),
        admission
      )
      const changed = JSON.parse(Buffer.from(original.keyPackageHex, 'hex').toString())
      changed.credentialHash = '00'.repeat(32)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            owner.host.prepareMemberAdmission(
              workspaceId,
              Buffer.from(JSON.stringify(changed)).toString('hex')
            )
          )
        )
      )
    })
  )
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const member = yield* openMember()
      assert.deepEqual(yield* member.bootstrap.prepareMemberJoin(offer), original)
      yield* owner.host.open(workspaceId)
      assert.deepEqual(
        yield* owner.host.prepareMemberAdmission(workspaceId, original.keyPackageHex),
        admission
      )
      const records = [
        Buffer.from(prepared.genesisRecordHex, 'hex'),
        Buffer.from(admission.recordHex, 'hex')
      ]
      const pages = [page(records, offer.genesisHash, 0)]
      const bad = [
        { ...pages[0], checkpoint: { ...pages[0].checkpoint, headHash: '00'.repeat(32) } }
      ]
      assert.ok(
        Result.isFailure(yield* Effect.result(member.bootstrap.acceptMemberJoin(workspaceId, bad)))
      )
      assert.ok(Result.isFailure(yield* Effect.result(member.host.open(workspaceId))))
      yield* member.bootstrap.acceptMemberJoin(workspaceId, pages)
      const joined = yield* member.host.open(workspaceId)
      assert.equal(joined.length, 2)
      assert.equal(joined.deviceKind, 'personal')
      assert.equal(joined.hasCurrentKey, false)
      yield* owner.host.ingestLedgerRecords(workspaceId, pages[0])
      const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(offer.genesisHash, 'hex')))
      let view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records,
          checkpoint: { length: 2, head: hashRecordBytes(records[1]) }
        })
      )
      const memberKey = decodeMemberKeyPackage(original.keyPackageHex).request.signingPublicKey
      const memberState = view.inspectState().devices.get(hex(memberKey.toBytes()))
      assert.equal(
        view.inspectState().members.get(hex(memberState.membershipId.toBytes())).role,
        'member'
      )
      const mailbox = yield* makeSqliteKeyMailbox({
        path: join(directory, 'member-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const ownerDevice = yield* owner.custody.openDevice(genesis)
      const ownerPort = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailbox, ownerDevice.publicKey)),
        KeyMailbox
      )
      const memberPort = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailbox, memberKey)),
        KeyMailbox
      )
      yield* owner.host.keyRound(workspaceId, () => ownerPort)
      yield* member.host.keyRound(workspaceId, () => memberPort)
      assert.equal((yield* member.host.status(workspaceId)).hasCurrentKey, true)
      encrypted = yield* owner.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      assert.deepEqual(
        yield* member.host.openContent(workspaceId, {
          room,
          context,
          ...encrypted,
          additionalData
        }),
        plaintext
      )
      const reply = yield* member.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      assert.deepEqual(
        yield* owner.host.openContent(workspaceId, { room, context, ...reply, additionalData }),
        plaintext
      )
      const personalOffer = yield* member.host.personalPairingOffer(workspaceId)
      const additional = yield* openMember(join(directory, 'member-additional'))
      const personalRequest = yield* additional.bootstrap.preparePersonalJoin(personalOffer)
      yield* member.host.previewPersonalAdmission(workspaceId, personalRequest.requestHex)
      const personalAdmission = yield* member.host.preparePersonalAdmission(
        workspaceId,
        personalRequest.requestHex
      )
      const expanded = [...records, Buffer.from(personalAdmission.recordHex, 'hex')]
      const expandedPage = page(expanded, offer.genesisHash, 0)
      yield* additional.bootstrap.acceptPersonalHistory(workspaceId, [expandedPage])
      assert.equal((yield* additional.host.open(workspaceId)).length, 3)
      yield* member.host.ingestLedgerRecords(workspaceId, expandedPage)
      assert.equal(
        yield* member.host.personalInvitation(workspaceId, personalOffer.pairingSessionId),
        null
      )
      view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records: expanded,
          checkpoint: { length: 3, head: hashRecordBytes(expanded[2]) }
        })
      )
      const additionalDevice = yield* additional.custody.openDevice(genesis)
      const additionalPort = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailbox, additionalDevice.publicKey)),
        KeyMailbox
      )
      yield* member.host.keyRound(workspaceId, () => memberPort)
      yield* additional.host.keyRound(workspaceId, () => additionalPort)
      assert.deepEqual(
        yield* additional.host.openContent(workspaceId, {
          room,
          context,
          ...encrypted,
          additionalData
        }),
        plaintext
      )
      yield* owner.host.ingestLedgerRecords(workspaceId, expandedPage)
    })
  )
  await execute(
    Effect.gen(function* () {
      const member = yield* openMember()
      assert.equal((yield* member.host.open(workspaceId)).hasCurrentKey, true)
      assert.deepEqual(
        yield* member.host.openContent(workspaceId, {
          room,
          context,
          ...encrypted,
          additionalData
        }),
        plaintext
      )
      assert.equal(yield* member.bootstrap.pendingMemberJoin(workspaceId), null)
    })
  )
})
for (const installation of ['member', 'personal-history', 'personal-snapshot']) {
  void test(`removed member rejoins with a new invitation and isolated device via ${installation}`, async (t) => {
    const directory = await fixture(t)
    const memberDirectory = join(directory, 'removed-member')
    let currentKey, currentCredential, expectedLength
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const prepared = yield* bind(owner)
        yield* owner.host.open(workspaceId)
        const genesis = Result.getOrThrow(
          Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
        )
        const removed = yield* memberWithHost(memberDirectory)
        const firstOffer = yield* owner.host.memberOffer(workspaceId, 'email', 9_000_000_000_000)
        const firstRequest = yield* removed.bootstrap.prepareMemberJoin(firstOffer)
        yield* owner.host.inspectMemberAdmission(workspaceId, firstRequest.keyPackageHex)
        const firstAdmission = yield* owner.host.prepareMemberAdmission(
          workspaceId,
          firstRequest.keyPackageHex
        )
        const records = [
          Buffer.from(prepared.genesisRecordHex, 'hex'),
          Buffer.from(firstAdmission.recordHex, 'hex')
        ]
        const history = () => page(records, firstOffer.genesisHash, 0)
        yield* removed.bootstrap.acceptMemberJoin(workspaceId, [history()])
        const first = yield* removed.host.open(workspaceId)
        const original = {
          workspaceId,
          genesisHash: first.genesisHash,
          signingPublicKey: first.signingPublicKey,
          credential: yield* removed.bootstrap.deviceCredential(workspaceId)
        }
        yield* owner.host.ingestLedgerRecords(workspaceId, history())
        const remote = () => ({
          staging: () => ({
            stageGroup: () => Effect.die('unexpected rotation'),
            readGroup: () => Effect.die('unexpected rotation'),
            deleteGroup: () => Effect.die('unexpected rotation')
          }),
          mailbox: () => {
            throw new Error('member management must not rotate')
          },
          log: {
            read: () =>
              Effect.sync(() => ({
                records: records.map((record) => new Uint8Array(record)),
                checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
              })),
            appendCas: (_genesis, point, record) =>
              Effect.sync(() => {
                assert.equal(
                  hex(point.head.toBytes()),
                  hex(hashRecordBytes(records.at(-1)).toBytes())
                )
                records.push(new Uint8Array(record))
              })
          },
          history: () => Effect.succeed(history())
        })
        yield* owner.host.manage(
          workspaceId,
          { type: 'removeMember', membershipId: first.membershipId },
          remote
        )
        assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
        assert.equal(yield* removed.bootstrap.recordRemovedWorkspace(original), true)
        const drain = yield* removed.host.beginCloseWorkspace(workspaceId)
        yield* drain
        assert.equal(yield* removed.bootstrap.forgetRemovedWorkspace(original), true)
        const db = new DatabaseSync(join(memberDirectory, 'creations.sqlite'))
        try {
          for (const table of [
            'member_joins',
            'personal_joins',
            'personal_join_histories',
            'retired_personal_joins'
          ])
            assert.equal(
              db
                .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=?`)
                .get(workspaceId).count,
              0
            )
        } finally {
          db.close()
        }
        assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), true)
        assert.equal((yield* Effect.result(removed.custody.openDevice(genesis)))._tag, 'Failure')
        assert.equal(
          (yield* Effect.result(removed.host.open(workspaceId))).failure.code,
          'member_removed'
        )

        const next =
          installation === 'member'
            ? removed
            : yield* memberWithHost(join(directory, 'new-first-device'))
        const nextOffer = yield* owner.host.memberOffer(workspaceId, 'email', 9_000_000_000_001)
        assert.notEqual(nextOffer.token, firstOffer.token)
        const nextRequest = yield* next.bootstrap.prepareMemberJoin(nextOffer)
        const proof = decodeMemberKeyPackage(nextRequest.keyPackageHex)
        assert.notEqual(hex(proof.request.signingPublicKey.toBytes()), original.signingPublicKey)
        assert.notEqual(
          proof.credentialHash,
          decodeMemberKeyPackage(firstRequest.keyPackageHex).credentialHash
        )
        yield* owner.host.inspectMemberAdmission(workspaceId, nextRequest.keyPackageHex)
        const nextAdmission = yield* owner.host.prepareMemberAdmission(
          workspaceId,
          nextRequest.keyPackageHex
        )
        records.push(Buffer.from(nextAdmission.recordHex, 'hex'))
        const badHistory = [
          { ...history(), checkpoint: { ...history().checkpoint, headHash: '00'.repeat(32) } }
        ]
        assert.equal(
          (yield* Effect.result(next.bootstrap.acceptMemberJoin(workspaceId, badHistory)))._tag,
          'Failure'
        )
        assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), true)
        yield* next.bootstrap.acceptMemberJoin(workspaceId, [history()])
        const admitted = yield* next.host.open(workspaceId)
        assert.notEqual(admitted.membershipId, first.membershipId)
        yield* owner.host.ingestLedgerRecords(workspaceId, history())
        // The real management command supplied by #1982 promotes the newly admitted Member.
        yield* owner.host.manage(
          workspaceId,
          { type: 'setRole', membershipId: admitted.membershipId, role: 'admin' },
          remote
        )
        yield* next.host.ingestLedgerRecords(workspaceId, history())
        assert.equal((yield* next.host.status(workspaceId)).memberRole, 'admin')
        if (installation !== 'member') {
          const personalOffer = yield* next.host.personalPairingOffer(workspaceId)
          const personalRequest = yield* removed.bootstrap.preparePersonalJoin(personalOffer)
          assert.notEqual(personalRequest.signingPublicKey, original.signingPublicKey)
          yield* next.host.previewPersonalAdmission(workspaceId, personalRequest.requestHex)
          const personalAdmission = yield* next.host.preparePersonalAdmission(
            workspaceId,
            personalRequest.requestHex
          )
          records.push(Buffer.from(personalAdmission.recordHex, 'hex'))
          yield* next.host.ingestLedgerRecords(workspaceId, history())
          // Preparing a replacement key is insufficient to clear the terminal marker.
          assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), true)
          if (installation === 'personal-history') {
            assert.equal(
              (yield* Effect.result(
                removed.bootstrap.acceptPersonalHistory(workspaceId, badHistory)
              ))._tag,
              'Failure'
            )
            assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), true)
            yield* removed.bootstrap.acceptPersonalHistory(workspaceId, [history()])
          } else {
            const invitation = yield* next.host
              .personalInvitation(workspaceId, personalOffer.pairingSessionId)
              .pipe(Effect.mapError((cause) => new Error('snapshot creation failed', { cause })))
            assert.ok(invitation)
            assert.equal(
              (yield* Effect.result(removed.bootstrap.acceptPersonalJoin(workspaceId, '00')))._tag,
              'Failure'
            )
            assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), true)
            yield* removed.bootstrap
              .acceptPersonalJoin(workspaceId, invitation.invitationHex)
              .pipe(
                Effect.mapError((cause) => new Error('snapshot installation failed', { cause }))
              )
          }
        }
        assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), false)
        const installed = yield* removed.host.open(workspaceId)
        currentKey = installed.signingPublicKey
        currentCredential = yield* removed.bootstrap.deviceCredential(workspaceId)
        expectedLength = records.length
        assert.notEqual(currentKey, original.signingPublicKey)
        assert.notEqual(currentCredential, original.credential)
        assert.equal(yield* removed.bootstrap.forgetRemovedWorkspace(original), false)
        assert.equal((yield* removed.host.status(workspaceId)).signingPublicKey, currentKey)
        yield* removed.host.ingestLedgerRecords(
          workspaceId,
          page(
            records,
            firstOffer.genesisHash,
            installation === 'personal-snapshot' ? records.length : 0
          )
        )
        yield* owner.host.ingestLedgerRecords(workspaceId, history())
        const view = Result.getOrThrow(
          verifyLedger({
            anchor: genesis,
            records,
            checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
          })
        )
        const mailbox = yield* makeSqliteKeyMailbox({
          path: join(directory, 'rejoin-mailbox.sqlite'),
          mode: 'create',
          genesis,
          ledger: () => Effect.succeed(view)
        })
        const ownerDevice = yield* owner.custody.openDevice(genesis)
        const freshDevice = yield* removed.custody.openDevice(genesis)
        const ownerPort = Context.get(
          yield* Layer.build(referenceKeyMailbox(mailbox, ownerDevice.publicKey)),
          KeyMailbox
        )
        const freshPort = Context.get(
          yield* Layer.build(referenceKeyMailbox(mailbox, freshDevice.publicKey)),
          KeyMailbox
        )
        yield* owner.host.keyRound(workspaceId, () => ownerPort)
        yield* removed.host.keyRound(workspaceId, () => freshPort)
        assert.equal((yield* removed.host.status(workspaceId)).hasCurrentKey, true)
      })
    )
    await execute(
      Effect.gen(function* () {
        const reopened = yield* memberWithHost(memberDirectory)
        const status = yield* reopened.host.open(workspaceId)
        assert.equal(status.signingPublicKey, currentKey)
        assert.equal(status.length, expectedLength)
        assert.equal(status.hasCurrentKey, true)
        assert.equal(yield* reopened.bootstrap.deviceCredential(workspaceId), currentCredential)
        if (installation === 'personal-history') {
          const db = new DatabaseSync(join(memberDirectory, 'creations.sqlite'))
          try {
            assert.equal(
              db
                .prepare(
                  'SELECT COUNT(*) AS count FROM personal_join_histories WHERE workspace_id=?'
                )
                .get(workspaceId).count,
              1
            )
            const identity = {
              workspaceId,
              genesisHash: status.genesisHash,
              signingPublicKey: currentKey,
              credential: currentCredential
            }
            yield* reopened.bootstrap.recordRemovedWorkspace(identity)
            const drain = yield* reopened.host.beginCloseWorkspace(workspaceId)
            yield* drain
            yield* reopened.bootstrap.forgetRemovedWorkspace(identity)
            assert.equal(
              db
                .prepare(
                  'SELECT COUNT(*) AS count FROM personal_join_histories WHERE workspace_id=?'
                )
                .get(workspaceId).count,
              0
            )
          } finally {
            db.close()
          }
        }
      })
    )
  })
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

for (const kind of ['update_batch', 'snapshot'])
  void test(`content IPC binding encrypts allowed rooms and isolates a rejected room or corrupt frame (${kind})`, async (t) => {
    const directory = await fixture(t)
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        yield* bind(owner)
        yield* owner.host.open(workspaceId)
        const context = {
          protocol: 'loro-streams-crdt-payload-protection',
          version: 2,
          kind,
          ...(kind === 'snapshot' ? { continuationOffset: 'opaque:100' } : {})
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
            yield* owner.host.openContent(workspaceId, {
              room,
              context,
              ...sealed,
              additionalData
            }),
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
        machineId: 'synthetic-local-machine',
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
      const foreignBinding = yield* signDeviceCredentialBinding({
        genesis,
        pairingSessionId: new Uint8Array(16).fill(0xfe),
        signingPublicKey: machine.publicKey,
        credentialHash,
        signer: machine
      })
      const replayedSession = yield* Effect.result(
        owner.host.stageLocalPairing(workspaceId, {
          ...material,
          bindingSignature: hex(foreignBinding.toBytes())
        })
      )
      assert.ok(Result.isFailure(replayedSession))
      const changedMachine = yield* Effect.result(
        owner.host.stageLocalPairing(workspaceId, {
          ...material,
          machineId: 'another-machine'
        })
      )
      assert.ok(Result.isFailure(changedMachine))
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
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
          machineId: 'synthetic-machine',
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
            machineId: original.material.machineId,
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

for (const source of ['staging', 'not-a-staging-recipient', 'temporary-io'])
  void test(`reopens without a candidate and installs the committed epoch via ${source}`, async (t) => {
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
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, prepared.genesisHashHex, 0)
        )
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
              unavailable ? Effect.fail(new Error(source)) : Effect.succeed(group)
            )
        })
        const missing = yield* Effect.result(
          owner.host.keyRound(workspaceId, () => mailbox, staging)
        )
        assert.equal(
          Result.isFailure(missing) && missing.failure.distribution.failure.reason,
          'missing-key'
        )
        assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, false)
        const afterFailure = yield* owner.host.seal(workspaceId, oldRequest)
        assert.deepEqual(
          yield* owner.host.openContent(workspaceId, { ...oldRequest, ...afterFailure }),
          oldRequest.plaintext
        )
        // A missing mailbox key remains visibly missing across repeated staging failures.
        const retried = yield* Effect.result(
          owner.host.keyRound(workspaceId, () => mailbox, staging)
        )
        assert.equal(
          Result.isFailure(retried) && retried.failure.distribution.failure.reason,
          'missing-key'
        )
        assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, false)
        if (source === 'staging') unavailable = false
        else yield* mailbox.put('01'.repeat(16), group.envelopes[0].frame)
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

for (const damaged of [false, true, 'header'])
  void test(`manual management resumes across full rounds and restart; damaged candidate=${damaged}`, async (t) => {
    const directory = await fixture(t)
    let prepared, records, view, genesis, target
    const groups = new Map(),
      roundIds = [],
      originals = []
    let unavailable = true
    const fullRounds = new Set()
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        prepared = yield* bind(owner)
        records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
        genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex')))
        view = Result.getOrThrow(
          verifyLedger({
            anchor: genesis,
            records,
            checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
          })
        )
        const signer = yield* owner.custody.openDevice(genesis)
        const machine = yield* owner.custody.prepareDevice()
        const command = yield* prepareDeviceAdmission({
          genesis,
          membershipId: view.inspectState().owner,
          signer: machine,
          encryptionPublicKey: machine.enc,
          kind: 'machine',
          machineId: 'synthetic-machine'
        })
        const record = yield* signLedgerRecord(
          Result.getOrThrow(prepareLedgerCommand(view, signer.publicKey, command)),
          signer
        )
        records.push(record)
        view = Result.getOrThrow(
          extendLedger(view, [record], { head: hashRecordBytes(record), length: records.length })
        )
        target = hex(machine.publicKey.toBytes())
        yield* owner.custody.discardDevice(machine)
        yield* owner.host.open(workspaceId)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, prepared.genesisHashHex, 0)
        )
      })
    )
    const { E2eeStagingCapacityError } = await import('./e2ee-cloud-client.mts')
    for (const reopened of [false, true, 'install-retry'])
      await execute(
        Effect.gen(function* () {
          const owner = yield* ownerWithHost(directory)
          yield* owner.host.open(workspaceId)
          const signer = yield* owner.custody.openDevice(genesis)
          const mailboxHost = yield* makeSqliteKeyMailbox({
            path: join(directory, 'management-mailbox.sqlite'),
            mode: existsSync(join(directory, 'management-mailbox.sqlite')) ? 'open' : 'create',
            genesis,
            ledger: () => Effect.succeed(view)
          })
          const mailbox = Context.get(
            yield* Layer.build(referenceKeyMailbox(mailboxHost, signer.publicKey)),
            KeyMailbox
          )
          const ports = () => ({
            history: () => Effect.succeed(page(records, prepared.genesisHashHex, 0)),
            mailbox: () => mailbox,
            log: {
              read: () =>
                Effect.succeed({ records, checkpoint: { head: view.head, length: view.length } }),
              appendCas: (_anchor, expected, record) =>
                Effect.sync(() => {
                  assert.equal(view.head.equals(expected.head), true)
                  view = Result.getOrThrow(
                    extendLedger(view, [record], {
                      head: hashRecordBytes(record),
                      length: view.length + 1
                    })
                  )
                  records = [...records, record]
                })
            },
            staging: (round) => ({
              stageGroup: (group) =>
                Effect.suspend(() => {
                  roundIds.push(round)
                  originals.push(Buffer.from(group.record))
                  if (unavailable) return Effect.fail(new Error('staging-offline'))
                  if (fullRounds.has(round) || fullRounds.size < 2) {
                    fullRounds.add(round)
                    return Effect.fail(new E2eeStagingCapacityError(round, 1))
                  }
                  groups.set(group.recordHash, group)
                  return Effect.void
                }),
              readGroup: (key) => Effect.succeed(groups.get(key.recordHash) ?? null),
              deleteGroup: () => Effect.void
            })
          })
          if (!reopened) {
            assert.equal((yield* owner.host.managementState(workspaceId)).mayRotate, true)
            yield* owner.host.manage(workspaceId, { type: 'revoke', target }, ports)
            assert.equal(view.inspectState().devices.has(target), false)
            assert.equal(view.inspectState().epoch.rotationRequired, true)
            assert.equal(
              Result.isFailure(
                yield* Effect.result(owner.host.manage(workspaceId, { type: 'rotate' }, ports))
              ),
              true
            )
            assert.equal(view.inspectState().epoch.number, 0)
            const request = {
              epoch: 0,
              room: { kind: 'doc', docId: 'still-usable' },
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
            assert.equal((yield* owner.host.managementState(workspaceId)).updatePending, true)
            if (damaged) {
              const key = (yield* owner.host.managementState(workspaceId)).devices.find(
                (entry) => entry.self
              ).key
              const db = new DatabaseSync(
                join(directory, 'workspaces', workspaceId, `epoch-candidates-${key}.sqlite`)
              )
              try {
                if (damaged === 'header')
                  db.prepare('UPDATE epoch_rotation_meta SET publisher=?').run('ff'.repeat(32))
                else {
                  /* Damage is injected only after the publication commits below. */
                }
              } finally {
                db.close()
              }
            }
            unavailable = false
            return
          }
          if (damaged === 'header' && reopened === true) {
            const visible = yield* owner.host.managementState(workspaceId)
            assert.equal(visible.mayRotate, true)
            assert.equal(visible.recoveryIssue, 'candidate-unavailable')
            assert.equal(visible.updatePending, true)
            assert.equal(
              Result.isFailure(
                yield* Effect.result(owner.host.manage(workspaceId, { type: 'rotate' }, ports))
              ),
              true
            )
            const key = visible.devices.find((entry) => entry.self).key
            const db = new DatabaseSync(
              join(directory, 'workspaces', workspaceId, `epoch-candidates-${key}.sqlite`)
            )
            try {
              db.prepare('UPDATE epoch_rotation_meta SET publisher=?').run(key)
            } finally {
              db.close()
            }
          }
          if (reopened === true) {
            // Capacity and installation failures have separate retry paths at the same epoch.
            assert.equal(
              Result.isFailure(
                yield* Effect.result(owner.host.manage(workspaceId, { type: 'rotate' }, ports))
              ),
              true
            )
            const db = new DatabaseSync(
              join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite')
            )
            try {
              db.exec(
                "CREATE TRIGGER fail_rotation_install BEFORE INSERT ON installed_epoch_keys WHEN NEW.epoch=1 BEGIN SELECT RAISE(ABORT,'synthetic SQLITE_BUSY'); END"
              )
              assert.equal(
                Result.isFailure(
                  yield* Effect.result(owner.host.manage(workspaceId, { type: 'rotate' }, ports))
                ),
                true
              )
              assert.equal(view.inspectState().epoch.number, 1)
              assert.equal((yield* owner.host.managementState(workspaceId)).updatePending, true)
              assert.equal((yield* owner.host.status(workspaceId)).writeEpoch, 0)
              if (damaged === true) {
                const key = (yield* owner.host.managementState(workspaceId)).devices.find(
                  (entry) => entry.self
                ).key
                const candidate = new DatabaseSync(
                  join(directory, 'workspaces', workspaceId, `epoch-candidates-${key}.sqlite`)
                )
                try {
                  candidate.exec("UPDATE epoch_rotation_candidates SET blob=x'00'")
                } finally {
                  candidate.close()
                }
              }
            } finally {
              db.exec('DROP TRIGGER fail_rotation_install')
              db.close()
            }
            return
          }
          yield* owner.host.manage(workspaceId, { type: 'rotate' }, ports)
          assert.equal(view.inspectState().epoch.number, 1)
          assert.equal(view.inspectState().epoch.rotationRequired, false)
          assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
          assert.equal((yield* owner.host.managementState(workspaceId)).updatePending, false)
          assert.equal(roundIds[0], roundIds[1])
          assert.equal(new Set(roundIds).size, 3)
          assert.equal(
            originals.every((record) => record.equals(originals[0])),
            true
          )
          assert.equal(
            groups
              .values()
              .next()
              .value.envelopes.some((entry) => entry.recipient === target),
            false
          )
        })
      )
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
for (const commandType of ['revoke', 'removeMember']) {
  void test(`${commandType} bypasses an unstaged candidate but preserves an unknown publication CAS across reopen`, (t) =>
    managementFailureFixture(t, commandType))
}

void test('closing during a manual management ledger read aborts outside account locks and releases the host', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const entered = Promise.withResolvers()
      let aborted = false
      const management = Effect.runPromise(
        Effect.result(
          owner.host.manage(workspaceId, { type: 'rotate' }, (signal) => ({
            history: () =>
              Effect.tryPromise({
                try: () =>
                  new Promise((resolve, reject) => {
                    signal.addEventListener(
                      'abort',
                      () => {
                        aborted = true
                        reject(new Error('synthetic aborted ledger request'))
                      },
                      { once: true }
                    )
                    entered.resolve()
                  }),
                catch: (error) => error
              }),
            log: {
              read: () => Effect.die('refresh must precede submission'),
              appendCas: () => Effect.die('no signing')
            },
            staging: () => ({
              stageGroup: () => Effect.die('no stage'),
              readGroup: () => Effect.succeed(null),
              deleteGroup: () => Effect.void
            }),
            mailbox: () => {
              throw new Error('no key reception')
            }
          }))
        )
      )
      yield* Effect.promise(() =>
        Promise.race([
          entered.promise,
          management.then(() => {
            throw new Error('management failed before the remote boundary')
          })
        ])
      )
      yield* owner.host.closeWorkspace(workspaceId)
      const result = yield* Effect.promise(() => management)
      assert.equal(aborted, true)
      assert.equal(Result.isFailure(result), true)
      assert.equal((yield* owner.host.open(workspaceId)).hasCurrentKey, true)
    })
  )
})

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
void test('an unreadable installed blob keeps ledger open and is replaced only by a verified mailbox key', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const { owner, mailbox } = yield* maintenanceFixture(directory)
      yield* owner.host.closeWorkspace(workspaceId)
      const db = new DatabaseSync(
        join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite')
      )
      db.prepare('UPDATE installed_epoch_keys SET blob=? WHERE epoch=0').run(
        new Uint8Array([1, 2, 3])
      )
      db.close()
      const status = yield* owner.host.open(workspaceId)
      assert.equal(status.hasCurrentKey, false)
      assert.equal(status.writeEpoch, null)
      assert.equal((yield* owner.host.ledgerView(workspaceId)).status.length, 1)
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
    })
  )
})
void test('a rejected envelope is repaired by digest and the following good envelope installs in the same maintenance call', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const { owner, mailbox, path, frame, device } = yield* maintenanceFixture(directory)
      const bad = frame.slice()
      // Force the hostile frame to sort before the good original, deterministically.
      for (let n = 0; ; n++) {
        new DataView(bad.buffer).setUint32(bad.length - 4, n)
        if (mailboxDigest(bad) < mailboxDigest(frame)) break
      }
      const digest = mailboxDigest(bad)
      const db = new DatabaseSync(path)
      db.prepare('INSERT INTO mailbox_envelopes VALUES(?,?,?,?,?,?)').run(
        0,
        hex(device.publicKey.toBytes()),
        hex(device.publicKey.toBytes()),
        'cd'.repeat(16),
        digest,
        bad
      )
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      assert.equal(db.prepare('SELECT digest FROM mailbox_rejected').get().digest, digest)
      // The independent post-send flush reports the local publication at both repair revisions.
      assert.equal(db.prepare('SELECT count(*) AS n FROM mailbox_reports').get().n, 3)
      assert.equal(db.prepare('SELECT count(*) AS n FROM mailbox_envelopes').get().n, 2)
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
      db.close()
    })
  )
})

void test('finite rounds retain independent delivery cursors past blocked tasks and ACK terminal results without deleting originals', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const { owner, mailbox, device } = yield* maintenanceFixture(directory)
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from((yield* owner.host.status(workspaceId)).genesisHash, 'hex'))
      )
      const delivery = Result.getOrThrow(
        epochDeliveryId({
          genesis,
          epoch: 0,
          sender: device.publicKey,
          recipient: device.publicKey
        })
      )
      const taskId = (revision) =>
        mailboxDigest(
          new TextEncoder().encode(`lody-e2ee/local-distribution-task/v0:${delivery}:${revision}`)
        )
      const last = taskId(0)
      const db = new DatabaseSync(join(directory, 'workspaces', workspaceId, 'distribution.sqlite'))
      const insert = db.prepare("INSERT INTO distribution_tasks VALUES(?,0,?,?,'Pending',0)")
      let count = 0
      for (let revision = 1; count < 501; revision++) {
        const id = taskId(revision)
        if (id >= last) continue
        insert.run(id, hex(device.publicKey.toBytes()), revision)
        count++
      }
      insert.run(last, hex(device.publicKey.toBytes()), 0)
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      assert.equal(
        db.prepare('SELECT phase FROM distribution_tasks WHERE id=?').get(last).phase,
        'Pending'
      )
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      assert.deepEqual(
        { ...db.prepare('SELECT phase,consumed FROM distribution_tasks WHERE id=?').get(last) },
        { phase: 'Observed', consumed: 1 }
      )
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM distribution_tasks WHERE phase='Pending'").get().n,
        501
      )
      db.close()
      const outbox = new DatabaseSync(join(directory, 'workspaces', workspaceId, 'outbox.sqlite'))
      const originals = outbox.prepare('SELECT * FROM epoch_delivery').all()
      assert.equal(originals.length, 1)
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      assert.deepEqual(outbox.prepare('SELECT * FROM epoch_delivery').all(), originals)
      outbox.close()
    })
  )
})

void test('a transient installed-key write failure never rejects the good mailbox envelope and retries after storage recovers', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const { owner, mailbox, path } = yield* maintenanceFixture(directory)
      const local = new DatabaseSync(
        join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite')
      )
      local.prepare('UPDATE installed_epoch_keys SET blob=? WHERE epoch=0').run(new Uint8Array([1]))
      local.exec(
        "CREATE TRIGGER block_replace BEFORE UPDATE ON installed_epoch_keys BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END"
      )
      const failed = yield* Effect.result(owner.host.keyRound(workspaceId, () => mailbox))
      assert.equal(failed.failure.receive.failure.cryptographicRejection, false)
      const remote = new DatabaseSync(path)
      assert.equal(remote.prepare('SELECT count(*) AS n FROM mailbox_rejected').get().n, 0)
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, false)
      local.exec('DROP TRIGGER block_replace')
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
      remote.close()
      local.close()
    })
  )
})

void test('unknown mailbox sender requests verified ledger refresh and retries exact bytes without rejection', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const f = yield* maintenanceFixture(directory)
      const initial = f.view()
      const joining = yield* f.owner.custody.prepareDevice()
      const membershipId = initial
        .inspectState()
        .devices.get(hex(f.device.publicKey.toBytes())).membershipId
      const possession = yield* prepareDeviceAdmission({
        genesis: f.genesis,
        membershipId,
        encryptionPublicKey: joining.enc,
        kind: 'personal',
        signer: joining
      })
      const record = yield* signLedgerRecord(
        Result.getOrThrow(
          prepareLedgerCommand(initial, f.device.publicKey, {
            _tag: 'AdmitDevice',
            kind: 'personal',
            signingPublicKey: joining.publicKey,
            encryptionPublicKey: joining.enc,
            possessionSignature: possession.possessionSignature
          })
        ),
        f.device
      )
      const records = [Buffer.from(f.prepared.genesisRecordHex, 'hex'), record]
      const latest = Result.getOrThrow(
        extendLedger(initial, [record], { head: hashRecordBytes(record), length: 2 })
      )
      const frame = yield* Effect.acquireUseRelease(
        f.keys.read(0),
        (key) =>
          prepareEpochEnvelope({
            context: {
              genesis: f.genesis,
              epoch: 0,
              sender: joining.publicKey,
              recipient: f.device.publicKey
            },
            key,
            signer: joining,
            ledger: () => Effect.succeed(latest)
          }),
        (key) => Effect.sync(() => disposeEpochKey(key))
      )
      f.setView(latest)
      const mailbox = {
        ...f.mailbox,
        fetch: () =>
          Effect.succeed({
            items: [{ sender: hex(joining.publicKey.toBytes()), frame }],
            next: null
          })
      }
      yield* f.owner.host.keyRound(
        workspaceId,
        () => mailbox,
        undefined,
        () => () => Effect.succeed(page(records, f.prepared.genesisHashHex, 0, 2))
      )
      assert.equal((yield* f.owner.host.ledgerView(workspaceId)).status.length, 2)
      const receive = new DatabaseSync(join(directory, 'workspaces', workspaceId, 'receive.sqlite'))
      assert.equal(
        receive.prepare("SELECT count(*) AS n FROM receive_tasks WHERE phase='Reported'").get().n,
        1
      )
      receive.close()
      const backend = new DatabaseSync(f.path)
      assert.equal(backend.prepare('SELECT count(*) AS n FROM mailbox_rejected').get().n, 0)
      backend.close()
      yield* f.owner.custody.discardDevice(joining)
    })
  )
})

void test('desktop reconciliation reaches more than one hundred genuine ledger recipients', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const f = yield* maintenanceFixture(directory)
      let view = f.view()
      const records = [Buffer.from(f.prepared.genesisRecordHex, 'hex')]
      const membershipId = view
        .inspectState()
        .devices.get(hex(f.device.publicKey.toBytes())).membershipId
      for (let index = 0; index < 105; index++) {
        const joining = yield* f.owner.custody.prepareDevice()
        const machineId = `synthetic-recipient-${index}`
        const possession = yield* prepareDeviceAdmission({
          genesis: f.genesis,
          membershipId,
          encryptionPublicKey: joining.enc,
          kind: 'machine',
          machineId,
          signer: joining
        })
        const record = yield* signLedgerRecord(
          Result.getOrThrow(
            prepareLedgerCommand(view, f.device.publicKey, {
              _tag: 'AdmitDevice',
              kind: 'machine',
              machineId,
              signingPublicKey: joining.publicKey,
              encryptionPublicKey: joining.enc,
              possessionSignature: possession.possessionSignature
            })
          ),
          f.device
        )
        records.push(record)
        view = Result.getOrThrow(
          extendLedger(view, [record], { head: hashRecordBytes(record), length: records.length })
        )
        yield* f.owner.custody.discardDevice(joining)
      }
      f.setView(view)
      for (let start = 0; start < records.length; start += 64) {
        yield* f.owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, f.prepared.genesisHashHex, start, Math.min(start + 64, records.length))
        )
      }
      yield* f.owner.host.keyRound(workspaceId, () => f.mailbox)
      const db = new DatabaseSync(f.path)
      assert.equal(
        db.prepare('SELECT count(DISTINCT recipient) AS n FROM mailbox_envelopes').get().n,
        106
      )
      db.close()
      const journal = new DatabaseSync(
        join(directory, 'workspaces', workspaceId, 'distribution.sqlite')
      )
      assert.equal(
        journal
          .prepare(
            "SELECT count(*) AS n FROM distribution_tasks WHERE phase='Observed' AND consumed=1"
          )
          .get().n,
        105
      )
      journal.close()
    })
  )
})

for (const senderHint of ['registered', 'unknown']) {
  for (const laterHonestRow of [false, true]) {
    void test(`sender hint ${senderHint} cannot reject original bytes and later honest row=${laterHonestRow} stays usable`, async (t) => {
      const directory = await fixture(t)
      await execute(
        Effect.gen(function* () {
          const f = yield* maintenanceFixture(directory)
          const joining = yield* f.owner.custody.prepareDevice()
          const unregistered = yield* f.owner.custody.prepareDevice()
          const membershipId = f
            .view()
            .inspectState()
            .devices.get(hex(f.device.publicKey.toBytes())).membershipId
          const admission = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(
                f.view(),
                f.device.publicKey,
                yield* prepareDeviceAdmission({
                  genesis: f.genesis,
                  membershipId,
                  encryptionPublicKey: joining.enc,
                  kind: 'machine',
                  machineId: 'metadata-hint-target',
                  signer: joining
                })
              )
            ),
            f.device
          )
          const records = [Buffer.from(f.prepared.genesisRecordHex, 'hex'), admission]
          f.setView(
            Result.getOrThrow(
              extendLedger(f.view(), [admission], { head: hashRecordBytes(admission), length: 2 })
            )
          )
          yield* f.owner.host.ingestLedgerRecords(
            workspaceId,
            page(records, f.prepared.genesisHashHex, 0)
          )
          const local = new DatabaseSync(
            join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite')
          )
          local
            .prepare('UPDATE installed_epoch_keys SET blob=? WHERE epoch=0')
            .run(new Uint8Array([1]))
          local.close()
          let spoof = true
          const hostile = {
            ...f.mailbox,
            fetch: (epoch, cursor, limit) =>
              f.mailbox.fetch(epoch, cursor, limit).pipe(
                Effect.map((p) => ({
                  ...p,
                  items: spoof
                    ? p.items.flatMap((row) => {
                        const changed = {
                          ...row,
                          sender:
                            senderHint === 'registered'
                              ? hex(joining.publicKey.toBytes())
                              : hex(unregistered.publicKey.toBytes())
                        }
                        return laterHonestRow ? [changed, row] : [changed]
                      })
                    : p.items
                }))
              )
          }
          yield* Effect.result(f.owner.host.keyRound(workspaceId, () => hostile))
          const remote = new DatabaseSync(f.path)
          try {
            assert.equal(
              remote
                .prepare('SELECT count(*) AS n FROM mailbox_rejected WHERE digest=?')
                .get(mailboxDigest(f.frame)).n,
              0,
              'untrusted sender metadata cannot permanently reject the authentic frame digest'
            )
            assert.equal(
              (yield* f.owner.host.status(workspaceId)).hasCurrentKey,
              laterHonestRow,
              'a metadata mismatch must not stop the following honest envelope'
            )
            spoof = false
            yield* f.mailbox.put('ab'.repeat(16), f.frame)
            yield* f.owner.host.keyRound(workspaceId, () => hostile)
            assert.equal((yield* f.owner.host.status(workspaceId)).hasCurrentKey, true)
            assert.equal(
              (yield* f.mailbox.fetch(0, null, 100)).items.some(
                (row) => mailboxDigest(row.frame) === mailboxDigest(f.frame)
              ),
              true
            )
          } finally {
            remote.close()
            yield* f.owner.custody.discardDevice(joining)
            yield* f.owner.custody.discardDevice(unregistered)
          }
        })
      )
    })
  }
}
void test('member controls use ordinary durable records and keep the old epoch available', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      const records = yield* makeRecords(owner.custody, prepared, 2)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
      const remote = () => ({
        staging: () => ({
          stageGroup: () => Effect.die('member commands must not stage a candidate'),
          readGroup: () => Effect.die('member commands must not read a candidate'),
          deleteGroup: () => Effect.die('member commands must not delete a candidate')
        }),
        mailbox: () => {
          throw new Error('member commands must not receive a candidate')
        },
        log: {
          read: () =>
            Effect.sync(() => ({
              records: records.map((x) => new Uint8Array(x)),
              checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
            })),
          appendCas: (_genesis, point, original) =>
            Effect.sync(() => {
              assert.equal(
                hex(point.head.toBytes()),
                hex(hashRecordBytes(records.at(-1)).toBytes())
              )
              records.push(new Uint8Array(original))
            })
        },
        history: () => Effect.succeed(page(records, prepared.genesisHashHex, 0))
      })
      const membershipId = '11'.repeat(16)
      assert.equal(
        yield* owner.host.manage(
          workspaceId,
          { type: 'setRole', membershipId, role: 'admin' },
          remote
        ),
        'Committed'
      )
      assert.equal((yield* owner.host.status(workspaceId)).epoch, 0)
      assert.equal(
        yield* owner.host.manage(
          workspaceId,
          { type: 'setRole', membershipId, role: 'member' },
          remote
        ),
        'Committed'
      )
      assert.equal(
        yield* owner.host.manage(workspaceId, { type: 'removeMember', membershipId }, remote),
        'Committed'
      )
      const status = yield* owner.host.status(workspaceId)
      assert.equal(status.epoch, 0)
      assert.equal(status.rotationRequired, true)
      assert.equal(status.hasCurrentKey, true)
      assert.equal(status.memberRole, 'owner')
      const management = yield* owner.host.managementState(workspaceId)
      assert.equal(management.rotationRequired, true)
      assert.equal(management.mayRotate, true)
      assert.equal(management.updatePending, false)
      const count = records.length
      assert.equal(
        yield* owner.host.manage(workspaceId, { type: 'removeMember', membershipId }, remote),
        'Committed'
      )
      assert.equal(records.length, count)
      assert.deepEqual(
        records
          .slice(-2)
          .map((record) => Result.getOrThrow(decodeRecord(record)).body.operation.type),
        ['declareCapabilities', 'removeMember']
      )
    })
  )
})

void test('member removal reopens its uncertain original and never signs a replacement', async (t) => {
  const directory = await fixture(t)
  let records,
    prepared,
    uncertain,
    blocked = false
  const membershipId = '11'.repeat(16)
  const remote = () => ({
    staging: () => ({
      stageGroup: () => Effect.die('member commands must not stage a candidate'),
      readGroup: () => Effect.die('member commands must not read a candidate'),
      deleteGroup: () => Effect.die('member commands must not delete a candidate')
    }),
    mailbox: () => {
      throw new Error('member commands must not receive a candidate')
    },
    log: {
      read: () =>
        blocked
          ? Effect.fail(new Error('synthetic readback unavailable'))
          : Effect.succeed({
              records: records.map((x) => new Uint8Array(x)),
              checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
            }),
      appendCas: (_genesis, _point, original) =>
        Effect.suspend(() => {
          records.push(new Uint8Array(original))
          if (Result.getOrThrow(decodeRecord(original)).body.operation.type === 'removeMember') {
            uncertain = new Uint8Array(original)
            blocked = true
            return Effect.fail(new Error('synthetic lost ACK'))
          }
          return Effect.void
        })
    },
    history: () =>
      blocked
        ? Effect.fail(new Error('synthetic history unavailable'))
        : Effect.succeed(page(records, prepared.genesisHashHex, 0))
  })
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      prepared = yield* bind(owner)
      records = yield* makeRecords(owner.custody, prepared, 2)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
      assert.equal(
        (yield* Effect.result(
          owner.host.manage(workspaceId, { type: 'removeMember', membershipId }, remote)
        ))._tag,
        'Failure'
      )
    })
  )
  const count = records.length
  blocked = false
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* owner.host.open(workspaceId)
      assert.equal(
        yield* owner.host.manage(workspaceId, { type: 'removeMember', membershipId }, remote),
        'Committed'
      )
      assert.equal(records.length, count)
      assert.deepEqual(records.at(-1), uncertain)
      assert.equal((yield* owner.host.status(workspaceId)).epoch, 0)
      assert.equal((yield* owner.host.status(workspaceId)).rotationRequired, true)
    })
  )
})

// A successful recovery settles the old request, not an unrelated new click.
for (const difference of ['role', 'type', 'membershipId']) {
  void test(`ordinary management recovery compares the full ${difference} intent`, async (t) => {
    const directory = await fixture(t)
    let records,
      prepared,
      original,
      blocked = false
    const firstId = '11'.repeat(16),
      secondId = '22'.repeat(16)
    const before =
      difference === 'membershipId'
        ? { type: 'removeMember', membershipId: firstId }
        : { type: 'setRole', membershipId: firstId, role: 'admin' }
    const after =
      difference === 'role'
        ? { type: 'setRole', membershipId: firstId, role: 'member' }
        : { type: 'removeMember', membershipId: difference === 'membershipId' ? secondId : firstId }
    const remote = () => ({
      staging: () => ({
        stageGroup: () => Effect.die('ordinary commands cannot stage'),
        readGroup: () => Effect.die('ordinary commands cannot read staging'),
        deleteGroup: () => Effect.die('ordinary commands cannot delete staging')
      }),
      mailbox: () => {
        throw new Error('ordinary commands cannot receive')
      },
      history: () =>
        blocked
          ? Effect.fail(new Error('synthetic history unavailable'))
          : Effect.succeed(page(records, prepared.genesisHashHex, 0)),
      log: {
        read: () =>
          blocked
            ? Effect.fail(new Error('synthetic readback unavailable'))
            : Effect.succeed({
                records,
                checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
              }),
        appendCas: (_genesis, point, record) =>
          Effect.suspend(() => {
            assert.equal(point.head.equals(hashRecordBytes(records.at(-1))), true)
            records.push(new Uint8Array(record))
            if (
              !original &&
              Result.getOrThrow(decodeRecord(record)).body.operation.type !== 'declareCapabilities'
            ) {
              original = new Uint8Array(record)
              blocked = true
              return Effect.fail(new Error('synthetic lost ACK'))
            }
            return Effect.void
          })
      }
    })
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        prepared = yield* bind(owner)
        records = yield* makeRecords(owner.custody, prepared, 2)
        if (difference === 'membershipId') {
          const genesis = Result.getOrThrow(
            Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
          )
          const signer = yield* owner.custody.openDevice(genesis),
            joining = yield* owner.custody.prepareDevice()
          const request = yield* prepareJoinRequest({
            genesis,
            requestId: Result.getOrThrow(Bytes.requestId(Buffer.alloc(16, 34))),
            userId: Result.getOrThrow(Bytes.userId(Buffer.alloc(32, 35))),
            encryptionPublicKey: joining.enc,
            expiresAt: null,
            signer: joining
          })
          const view = Result.getOrThrow(
            verifyLedger({
              anchor: genesis,
              records,
              checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
            })
          )
          records.push(
            yield* signLedgerRecord(
              Result.getOrThrow(
                prepareLedgerCommand(view, signer.publicKey, {
                  _tag: 'AdmitMember',
                  membershipId: Result.getOrThrow(Bytes.membershipId(Buffer.from(secondId, 'hex'))),
                  request
                })
              ),
              signer
            )
          )
          yield* owner.custody.discardDevice(joining)
        }
        yield* owner.host.open(workspaceId)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, prepared.genesisHashHex, 0)
        )
        assert.equal(
          Result.isFailure(yield* Effect.result(owner.host.manage(workspaceId, before, remote))),
          true
        )
      })
    )
    const uncertainLength = records.length
    blocked = false
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        yield* owner.host.open(workspaceId)
        assert.equal(yield* owner.host.manage(workspaceId, after, remote), 'Committed')
        assert.ok(records.length > uncertainLength, 'the new intent must commit after old recovery')
        assert.equal(
          records.filter((record) => Buffer.from(record).equals(Buffer.from(original))).length,
          1
        )
        const op = Result.getOrThrow(decodeRecord(records.at(-1))).body.operation
        assert.equal(op.type, after.type)
        assert.equal(hex(op.membershipId.toBytes()), after.membershipId)
        if (after.type === 'setRole') assert.equal(op.role, after.role)
        assert.equal((yield* owner.host.status(workspaceId)).epoch, 0)
      })
    )
  })
}

void test('member operation history releases on workspace close without reentering the account coordinator', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory),
        prepared = yield* bind(owner)
      const records = yield* makeRecords(owner.custody, prepared, 2)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
      const entered = Deferred.makeUnsafe(),
        release = Deferred.makeUnsafe(),
        stopped = Deferred.makeUnsafe()
      const work = yield* Effect.forkChild(
        owner.host.manage(
          workspaceId,
          { type: 'removeMember', membershipId: '11'.repeat(16) },
          (signal) => {
            signal.addEventListener('abort', () => Deferred.doneUnsafe(stopped, Effect.void), {
              once: true
            })
            return {
              staging: () => ({
                stageGroup: () => Effect.die('member commands must not stage a candidate'),
                readGroup: () => Effect.die('member commands must not read a candidate'),
                deleteGroup: () => Effect.die('member commands must not delete a candidate')
              }),
              mailbox: () => {
                throw new Error('member commands must not receive a candidate')
              },
              log: {
                read: () => Effect.die('not reached'),
                appendCas: () => Effect.die('not reached')
              },
              history: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                  return page(records, prepared.genesisHashHex, 0)
                })
            }
          }
        )
      )
      yield* Deferred.await(entered)
      const close = yield* Effect.forkChild(owner.host.closeWorkspace(workspaceId))
      yield* Deferred.await(stopped)
      yield* Deferred.succeed(release, undefined)
      assert.equal(Exit.isFailure(yield* Fiber.await(work)), true)
      yield* Fiber.join(close)
      const reopened = yield* owner.host.open(workspaceId)
      assert.equal(reopened.epoch, 0)
      assert.equal(reopened.rotationRequired, false)
      assert.equal(records.length, 2)
    })
  )
})

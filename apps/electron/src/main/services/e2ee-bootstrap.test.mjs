import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, unlink, link, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Deferred, Effect, Exit, Fiber, Result } from 'effect'
import {
  accountIdFromUserId,
  Bytes,
  decodeRecord,
  hashRecordBytes,
  verifyLedger
} from '@lody/e2ee-core/protocol'
import { makeDesktopE2eeCustody } from '../e2ee-custody.mts'
import { makeDesktopE2eeBootstrap } from './e2ee-bootstrap.mts'

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
const prepare = (directory, input = intent) =>
  execute(
    Effect.gen(function* () {
      return yield* (yield* openOwner(directory)).bootstrap.prepareCreation(input)
    })
  )
function database(directory, work) {
  const db = new DatabaseSync(join(directory, 'creations.sqlite'))
  try {
    return work(db)
  } finally {
    db.close()
  }
}
function stored(directory) {
  return database(directory, (db) => db.prepare('SELECT * FROM creations').get())
}

void test('creation retains real native device keys and epoch0 before returning a verifiable genesis; reopen is exact', async (t) => {
  const directory = await fixture(t)
  const decodedCredentials = []
  const originalFrom = Buffer.from
  t.mock.method(Buffer, 'from', function (...args) {
    const buffer = Reflect.apply(originalFrom, Buffer, args)
    if (args[1] === 'hex' && buffer.length === 32) decodedCredentials.push(buffer)
    return buffer
  })
  const first = await prepare(directory)
  assert.deepEqual(
    Object.keys(first).sort(),
    [...Object.keys(intent), 'genesisRecordHex', 'genesisHashHex', 'deviceCredentialHash'].sort()
  )
  const bytes = Buffer.from(first.genesisRecordHex, 'hex')
  const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(first.genesisHashHex, 'hex')))
  const decoded = Result.getOrThrow(decodeRecord(bytes))
  assert.equal(decoded.body.type, 'genesis')
  assert.equal(
    Result.getOrThrow(
      verifyLedger({
        anchor: genesis,
        records: [bytes],
        checkpoint: { head: hashRecordBytes(bytes), length: 1 }
      })
    ).length,
    1
  )
  await execute(
    Effect.gen(function* () {
      const { custody } = yield* openOwner(directory)
      const device = yield* custody.openDevice(genesis)
      assert.ok(device.publicKey.equals(decoded.body.signer))
      assert.ok(device.enc.equals(decoded.body.encryptionPublicKey))
      assert.equal(device.encryption.privateKey.extractable, false)
    })
  )
  const row = stored(directory)
  assert.equal(row.ready, 1)
  assert.ok(row.epoch_blob instanceof Uint8Array)
  assert.ok(row.epoch_blob.length > 32)
  assert.deepEqual(await prepare(directory), first)
  // Public genesis/signing hashes may also be decoded; only credential hashes
  // match this persisted creation binding. Inspect actual retained allocations.
  for (const buffer of decodedCredentials) {
    const hash = createHash('sha256').update(buffer).digest('hex')
    assert.notEqual(hash, first.deviceCredentialHash, 'decoded credential survived hashing')
  }
})

void test('concurrent calls on one owner reuse one original, and immutable intent conflicts preserve it', async (t) => {
  const directory = await fixture(t)
  const results = await execute(
    Effect.gen(function* () {
      const { bootstrap } = yield* openOwner(directory)
      return yield* Effect.all(
        [bootstrap.prepareCreation(intent), bootstrap.prepareCreation(intent)],
        { concurrency: 'unbounded' }
      )
    })
  )
  assert.deepEqual(results[0], results[1])
  for (const changed of [{ name: 'Another name' }, { slug: 'another-slug' }]) {
    const result = await execute(
      Effect.gen(function* () {
        const { bootstrap } = yield* openOwner(directory)
        return yield* Effect.result(bootstrap.prepareCreation({ ...intent, ...changed }))
      })
    )
    assert.equal(result.failure.code, 'conflict')
  }
  assert.deepEqual(await prepare(directory), results[0])
})

void test('an account cannot open or prepare against another account journal', async (t) => {
  const directory = await fixture(t)
  const original = await prepare(directory)
  const result = await execute(
    Effect.gen(function* () {
      const { custody, bootstrap } = yield* openOwner(directory)
      const wrongRequest = yield* Effect.result(
        bootstrap.prepareCreation({ ...intent, accountId: 'other-account' })
      )
      assert.equal(wrongRequest.failure.code, 'invalid-input')
      return yield* Effect.result(
        makeDesktopE2eeBootstrap({ directory, accountId: 'other-account', custody })
      )
    })
  )
  assert.equal(result.failure.code, 'corrupt')
  assert.deepEqual(await prepare(directory), original)
})

void test('failure after device retention keeps the signed pending record and refuses to invent a missing epoch key', async (t) => {
  const directory = await fixture(t)
  await assert.rejects(
    execute(
      Effect.gen(function* () {
        const { bootstrap } = yield* openOwner(directory, (custody) => ({
          ...custody,
          retainDevice: (...args) =>
            custody
              .retainDevice(...args)
              .pipe(
                Effect.flatMap(() => Effect.fail(new Error('synthetic post-retention failure')))
              )
        }))
        return yield* bootstrap.prepareCreation(intent)
      })
    )
  )
  const pending = stored(directory)
  assert.ok(pending.record instanceof Uint8Array)
  assert.equal(pending.epoch_blob, null)
  assert.equal(pending.ready, 0)
  const filesBefore = await readdir(join(directory, 'custody'))
  const result = await execute(
    Effect.gen(function* () {
      const { bootstrap } = yield* openOwner(directory)
      return yield* Effect.result(bootstrap.prepareCreation(intent))
    })
  )
  assert.equal(result.failure.code, 'incomplete-local')
  assert.deepEqual(stored(directory), pending)
  assert.deepEqual(await readdir(join(directory, 'custody')), filesBefore)
})

void test('an unreadable installed key fails closed and is not replaced during reopen', async (t) => {
  const directory = await fixture(t)
  await prepare(directory)
  const row = stored(directory)
  const damaged = new Uint8Array(row.epoch_blob)
  damaged[damaged.length - 1] ^= 1
  database(directory, (db) => db.prepare('UPDATE creations SET epoch_blob=?').run(damaged))
  const result = await execute(
    Effect.gen(function* () {
      const { bootstrap } = yield* openOwner(directory)
      return yield* Effect.result(bootstrap.prepareCreation(intent))
    })
  )
  assert.equal(result.failure.code, 'corrupt')
  assert.deepEqual(stored(directory).epoch_blob, damaged)
  assert.deepEqual(stored(directory).record, row.record)
})

void test('interrupting a caller retains creation ownership until admitted native work settles', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const entered = yield* Deferred.make()
      const release = yield* Deferred.make()
      const owner = yield* openOwner(directory, (custody) => ({
        ...custody,
        retainDevice: (...args) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(custody.retainDevice(...args))
          )
      }))
      const creating = yield* Effect.forkChild(owner.bootstrap.prepareCreation(intent))
      yield* Deferred.await(entered)
      creating.interruptUnsafe()
      assert.equal(creating.pollUnsafe(), undefined)
      const other = yield* Effect.result(
        Effect.scoped(
          makeDesktopE2eeBootstrap({
            directory,
            accountId: intent.accountId,
            custody: owner.custody
          })
        )
      )
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.await(creating)
      assert.equal(other.failure.code, 'busy')
      assert.ok(Exit.isFailure(result))
      assert.equal(stored(directory).ready, 1)
    })
  )
  assert.ok((await prepare(directory)).genesisRecordHex)
})

void test('hard process exit releases creation ownership and preserves incomplete or ready originals', async (t) => {
  const { runCommand, ProcessSpawnerLive, NodeProcessLive } =
    await import('@lody/shared/node/process')
  for (const stage of ['device-retained', 'ready']) {
    const directory = await fixture(t)
    await execute(openOwner(directory))
    const child = `
      import { createDecipheriv } from 'node:crypto';
      import { join } from 'node:path';
      import { Effect } from 'effect';
      import { makeDesktopE2eeCustody } from ${JSON.stringify(new URL('../e2ee-custody.mts', import.meta.url).href)};
      import { makeDesktopE2eeBootstrap } from ${JSON.stringify(new URL('./e2ee-bootstrap.mts', import.meta.url).href)};
      const directory=process.argv[1], stage=process.argv[2], intent=JSON.parse(process.argv[3]);
      const safeStorage={
        isEncryptionAvailable:()=>true, isAsyncEncryptionAvailable:async()=>true,
        getSelectedStorageBackend:()=>'gnome_libsecret',
        encryptStringAsync:async()=>{throw Error('must reuse the retained KEK')},
        decryptStringAsync:async value=>{
          const c=createDecipheriv('aes-256-gcm',Buffer.alloc(32,86),value.subarray(0,12));
          c.setAuthTag(value.subarray(-16));
          return {result:Buffer.concat([c.update(value.subarray(12,-16)),c.final()]).toString(),shouldReEncrypt:false};
        }
      };
      await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
        const custody=yield* makeDesktopE2eeCustody({directory:join(directory,'custody'),platform:'linux',safeStorage});
        const bootstrap=yield* makeDesktopE2eeBootstrap({directory,accountId:intent.accountId,custody:{
          ...custody,retainDevice:(...args)=>custody.retainDevice(...args).pipe(Effect.tap(()=>Effect.sync(()=>{
            if(stage==='device-retained') process.exit(73);
          })))
        }});
        yield* bootstrap.prepareCreation(intent);
        process.exit(74);
      })));
    `
    const result = await Effect.runPromise(
      runCommand({
        command: process.execPath,
        args: [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          child,
          directory,
          stage,
          JSON.stringify(intent)
        ],
        cwd: new URL('../../../', import.meta.url).pathname,
        env: { ...process.env },
        maxOutputBytes: 65536
      }).pipe(Effect.provide(ProcessSpawnerLive), Effect.provide(NodeProcessLive))
    )
    assert.equal(result.code, stage === 'ready' ? 74 : 73, result.stderr.toString())
    const before = stored(directory)
    assert.ok(before.record instanceof Uint8Array)
    const reopened = await execute(
      Effect.gen(function* () {
        const { bootstrap } = yield* openOwner(directory)
        return yield* Effect.result(bootstrap.prepareCreation(intent))
      })
    )
    if (stage === 'ready')
      assert.equal(reopened.success.genesisRecordHex, Buffer.from(before.record).toString('hex'))
    else assert.equal(reopened.failure.code, 'incomplete-local')
    assert.deepEqual(stored(directory), before)
  }
})

void test('device credentials reopen exactly, stay encrypted, and missing originals never regenerate', async (t) => {
  const directory = await fixture(t)
  const prepared = await prepare(directory)
  const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex')))
  const credential = await execute(
    Effect.gen(function* () {
      const { custody, bootstrap } = yield* openOwner(directory)
      yield* bootstrap.recordCreated({
        workspaceId: 'credential-workspace',
        genesisHash: prepared.genesisHashHex,
        requestId: intent.requestId
      })
      const device = yield* custody.openDevice(genesis)
      const value = yield* bootstrap.deviceCredential('credential-workspace')
      assert.deepEqual(yield* custody.prepareDeviceCredential(genesis, device.publicKey), {
        credential: value,
        credentialHash: prepared.deviceCredentialHash
      })
      return value
    })
  )
  assert.equal(
    createHash('sha256').update(Buffer.from(credential, 'hex')).digest('hex'),
    prepared.deviceCredentialHash
  )
  assert.equal(
    await execute(
      Effect.gen(function* () {
        const { bootstrap } = yield* openOwner(directory)
        return yield* bootstrap.deviceCredential('credential-workspace')
      })
    ),
    credential
  )
  for (const name of await readdir(join(directory, 'custody'))) {
    const bytes = await readFile(join(directory, 'custody', name))
    assert.equal(bytes.includes(Buffer.from(credential, 'hex')), false)
    assert.equal(bytes.includes(Buffer.from(credential)), false)
  }
  await unlink(
    join(
      directory,
      'custody',
      `device-credential-${prepared.genesisHashHex}-${Buffer.from(Result.getOrThrow(decodeRecord(Buffer.from(prepared.genesisRecordHex, 'hex'))).body.signer.toBytes()).toString('hex')}.sealed`
    )
  )
  await assert.rejects(() =>
    execute(
      Effect.gen(function* () {
        const { bootstrap } = yield* openOwner(directory)
        return yield* bootstrap.deviceCredential('credential-workspace')
      })
    )
  )
  await assert.rejects(() => prepare(directory))
})

void test('pre-credential developer creations require recreation instead of generating a credential', async (t) => {
  const directory = await fixture(t)
  const prepared = await prepare(directory)
  const db = new DatabaseSync(join(directory, 'creations.sqlite'))
  db.prepare('DELETE FROM creation_credentials').run()
  db.close()
  await assert.rejects(() => prepare(directory))
  assert.equal(Buffer.from(stored(directory).record).toString('hex'), prepared.genesisRecordHex)
})

void test('one account signs every workspace with its own account ID, without replacing older signed originals', async (t) => {
  const directory = await fixture(t)
  const first = await prepare(directory)
  const second = await prepare(directory, {
    ...intent,
    requestId: 'request-second-012345',
    slug: 'another',
    name: 'Another'
  })
  const firstBody = Result.getOrThrow(decodeRecord(Buffer.from(first.genesisRecordHex, 'hex'))).body
  const secondBody = Result.getOrThrow(
    decodeRecord(Buffer.from(second.genesisRecordHex, 'hex'))
  ).body
  assert.equal(firstBody.type, 'genesis')
  assert.equal(secondBody.type, 'genesis')
  assert.ok(firstBody.userId.equals(secondBody.userId))
  assert.ok(!firstBody.membershipId.equals(secondBody.membershipId))
  assert.notEqual(first.genesisHashHex, second.genesisHashHex)
  assert.equal(Result.getOrThrow(accountIdFromUserId(firstBody.userId)), intent.accountId)
  assert.deepEqual(await prepare(directory), first)
})

void test('an unreserved old identity refusal removes only renderer intent and retains the exact signed host original', async (t) => {
  const { createPreparedE2eeWorkspace } =
    await import('../../../../../packages/components/src/lib/create-e2ee-workspace.ts')
  const { savePendingE2eeWorkspace, readPendingE2eeWorkspace } =
    await import('../../../../../packages/components/src/lib/e2ee-workspace-storage.ts')
  const directory = await fixture(t)
  const original = await prepare(directory)
  const saved = stored(directory)
  const values = new Map()
  const storage = {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => {
      values.clear()
    }
  }
  savePendingE2eeWorkspace(storage, intent)
  const refusal = Object.assign(new Error('synthetic old identity refused before reservation'), {
    data: { code: 'e2ee_account_identity_conflict' }
  })
  const port = {
    prepareCreation: (input) => prepare(directory, input),
    create: async () => {
      throw refusal
    }
  }
  await assert.rejects(
    createPreparedE2eeWorkspace(port, storage, intent),
    (error) => error === refusal
  )
  assert.equal(readPendingE2eeWorkspace(storage, intent.accountId), null)
  assert.deepEqual(stored(directory), saved)
  assert.deepEqual(await prepare(directory), original)
})

for (const image of ['not a SQLite database', 'corrupt SQLite header'])
  void test(`definite bootstrap SQLite damage is recoverable corruption: ${image}`, async (t) => {
    const directory = await fixture(t)
    await prepare(directory)
    const path = join(directory, 'creations.sqlite')
    const bytes = await readFile(path)
    const damaged =
      image === 'not a SQLite database'
        ? Buffer.from('damaged original SQLite image')
        : Buffer.from(bytes)
    if (image === 'corrupt SQLite header') damaged[100] = 0xff
    await writeFile(path, damaged)
    const result = await execute(Effect.result(openOwner(directory)))
    assert.equal(result._tag, 'Failure')
    assert.equal(result.failure.code, 'corrupt')
    assert.deepEqual(await readFile(path), damaged)
  })
void test('authenticated member removal erases only the exact local incarnation and survives reopen', async (t) => {
  const directory = await fixture(t)
  const workspaceId = 'removed-workspace'
  let original
  await execute(
    Effect.gen(function* () {
      const { custody, bootstrap } = yield* openOwner(directory)
      const prepared = yield* bootstrap.prepareCreation(intent)
      yield* bootstrap.recordCreated({ workspaceId, genesisHash: prepared.genesisHashHex })
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const device = yield* custody.openDevice(genesis)
      original = {
        workspaceId,
        genesisHash: prepared.genesisHashHex,
        signingPublicKey: Buffer.from(device.publicKey.toBytes()).toString('hex'),
        credential: yield* bootstrap.deviceCredential(workspaceId)
      }
      // A late result for another signing identity or credential cannot erase this one.
      assert.equal(
        yield* bootstrap.forgetRemovedWorkspace({ ...original, signingPublicKey: '00'.repeat(32) }),
        false
      )
      assert.equal(
        yield* bootstrap.forgetRemovedWorkspace({ ...original, credential: '00'.repeat(32) }),
        false
      )
      assert.ok((yield* custody.openDevice(genesis)).publicKey.equals(device.publicKey))
      assert.equal(yield* bootstrap.forgetRemovedWorkspace(original), true)
      assert.equal((yield* Effect.result(custody.openDevice(genesis)))._tag, 'Failure')
      assert.equal(yield* bootstrap.resumeRemovedWorkspace(workspaceId), true)
      // A fresh identity is distinct. An old terminal marker must spare it.
      const next = yield* custody.createDevice(genesis)
      assert.equal(next.publicKey.equals(device.publicKey), false)
      assert.equal(yield* bootstrap.resumeRemovedWorkspace(workspaceId), false)
      assert.ok((yield* custody.openDevice(genesis)).publicKey.equals(next.publicKey))
    })
  )
  assert.equal(stored(directory), undefined)
  const files = await readdir(join(directory, 'custody'))
  assert.equal(
    files.some((name) => name.includes(original.signingPublicKey)),
    false
  )
  assert.ok(files.includes('kek.safe-storage'))
})

void test('recovery adoption reuses its durable personal join after admission and an interrupted adoption', async (t) => {
  const { envelopeFixture } = await import('../../../../../packages/e2ee-core/test/keys/fixture.ts')
  const { recoveryRestoreTarget } = await import('./e2ee-recovery-vault.mts')
  const f = envelopeFixture()
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const { bootstrap } = yield* openOwner(directory)
      let failOnce = true
      const sessionIds = []
      const target = recoveryRestoreTarget({
        id: 'restore-retry',
        name: 'Restore retry',
        genesisHash: Buffer.from(f.context.genesis.toBytes()).toString('hex'),
        hasIdentity: () => true,
        identity: (pin) => bootstrap.recoveryIdentity(pin),
        append: () => Effect.succeed({ status: 'committed' }),
        history: () =>
          Effect.succeed({ startIndex: 0, recordsHex: [], nextCursor: null, checkpoint: null }),
        mailbox: () => ({ fetch: () => Effect.succeed({ items: [] }) }),
        stagedGroup: () => Effect.succeed(null),
        adopt: (join) =>
          Effect.gen(function* () {
            sessionIds.push(join.pairingSessionId)
            yield* bootstrap.preparePersonalJoin({
              version: 1,
              workspaceId: 'restore-retry',
              genesisHash: Buffer.from(f.context.genesis.toBytes()).toString('hex'),
              genesisRecordHex: join.genesisRecordHex,
              membershipId: join.membershipId,
              endorser: join.endorser,
              pairingSessionId: join.pairingSessionId
            })
            // The real SQLite pin and credential request already exist when installation fails.
            if (failOnce) {
              failOnce = false
              return yield* Effect.fail(new Error('installation interrupted'))
            }
          })
      })
      const anchor = {
        genesis: f.context.genesis,
        membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
        recovery: f.phone.publicKey,
        genesisRecord: f.genesisRecord
      }
      const first = yield* target.connect(anchor)
      yield* first.submitOriginalAsRecovery(
        new Uint8Array(64).fill(4),
        undefined,
        new Uint8Array(32).fill(5)
      )
      assert.equal(Result.isFailure(yield* Effect.result(first.adopt([]))), true)
      // A new connect on the already-admitted path does not submit another admission.
      const second = yield* target.connect(anchor)
      yield* second.adopt([])
      assert.match(sessionIds[0], /^[0-9a-f]{32}$/)
      assert.equal(sessionIds[1], sessionIds[0])
    })
  )
})

for (const scenario of ['rotated-recovery', 'unfinished-join']) {
  void test(`native recovery installs keys after ${scenario} without replacing completed identity`, async (t) => {
    const { envelopeFixture } =
      await import('../../../../../packages/e2ee-core/test/keys/fixture.ts')
    const { createRecoveryVault, wipeRecoveryPackage } =
      await import('../../../../../packages/e2ee-core/src/internal/recovery/vault.ts')
    const { disposeEpochKey } =
      await import('../../../../../packages/e2ee-core/src/internal/foundation/epoch-key.ts')
    const {
      generateRecoveryPackage,
      importRecoveryIdentity,
      prepareDeviceAdmission,
      prepareLedgerCommand,
      signLedgerRecord,
      prepareEpochEnvelope,
      commitEpochKey,
      sealHistoryPacket,
      prepareLedgerRecord,
      accountUserId
    } = await import('@lody/e2ee-core/protocol')
    const { encodeCbor } =
      await import('../../../../../packages/e2ee-core/src/internal/foundation/cbor.ts')
    const { restoreVaultWorkspaces, recoveryRestoreIncomplete } =
      await import('@lody/e2ee-client/recovery-restore')
    const { recoveryRestoreTarget, adoptRecoveredWorkspace } =
      await import('./e2ee-recovery-vault.mts')
    const { makeDesktopE2eeRuntimeHost } = await import('./e2ee-runtime.mts')
    const { sqliteRecoveryVaultLocalStore } = await import('@lody/e2ee-core/adapters/node-sqlite')
    const directory = await fixture(t)
    const ok = Result.getOrThrow
    const hex = (bytes) => Buffer.from(bytes).toString('hex')
    const f = envelopeFixture(0, 100, ok(accountUserId(intent.accountId)).toBytes())
    const records = f.records()
    const view = () =>
      ok(
        verifyLedger({
          anchor: f.context.genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
        })
      )
    const workspaceId = 'recovery-rebind'
    const genesisHash = hex(f.context.genesis.toBytes())
    const membershipId = '0a'.repeat(16)
    const page = () => ({
      workspaceId,
      genesisHash,
      startIndex: 0,
      recordsHex: records.map(hex),
      checkpoint: { length: records.length, headHash: hex(view().head.toBytes()) },
      nextCursor: null,
      position: `p1:${workspaceId}:${records.length}:source:0`
    })
    const entries = new Map()
    let index = null
    const store = {
      putImmutable: (_vault, entry) =>
        Effect.sync(() => {
          entries.set(entry.entryId, entry)
        }),
      readEntry: (_vault, id) => Effect.sync(() => entries.get(id) ?? null),
      readIndex: () => Effect.sync(() => index),
      compareAndSwapIndex: (_vault, _expected, next) =>
        Effect.sync(() => {
          index = next
          return 'Committed'
        }),
      deleteUnreferenced: () => Effect.void
    }
    await execute(
      Effect.gen(function* () {
        const { bootstrap, custody } = yield* openOwner(directory)
        const host = yield* makeDesktopE2eeRuntimeHost({ directory, custody, bootstrap })
        const local = yield* sqliteRecoveryVaultLocalStore({
          path: join(directory, 'recovery.sqlite'),
          mode: 'create-or-open'
        })
        const { vault, recoveryFile } = yield* createRecoveryVault({
          locator: 'native-rebind',
          store,
          local
        })
        recoveryFile.fill(0)
        const next = ok(Bytes.epochKey(new Uint8Array(32).fill(0x72)))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            disposeEpochKey(next)
            disposeEpochKey(f.secret)
          })
        )
        const append = (signer, command) =>
          Effect.gen(function* () {
            records.push(
              yield* signLedgerRecord(
                ok(prepareLedgerCommand(view(), signer.publicKey, command)),
                signer
              )
            )
            view()
          })
        const enroll = (generation) =>
          Effect.gen(function* () {
            const bundle = yield* generateRecoveryPackage({
              genesis: genesisHash,
              membershipId,
              generation,
              trust: {
                source: 'synthetic',
                genesisRecord: f.genesisRecord,
                head: hex(view().head.toBytes()),
                length: view().length
              }
            })
            const identity = yield* importRecoveryIdentity(bundle)
            const reference = yield* vault.upload(bundle)
            wipeRecoveryPackage(bundle)
            if (generation === 0) yield* vault.reserve(reference)
            else yield* vault.replace(reference)
            yield* append(
              f.owner.signer,
              yield* prepareDeviceAdmission({
                genesis: f.context.genesis,
                membershipId: ok(Bytes.membershipId(Buffer.from(membershipId, 'hex'))),
                encryptionPublicKey: identity.encryptionPublicKey,
                signer: identity,
                kind: 'recovery'
              })
            )
            return identity
          })
        const r1 = yield* enroll(0)
        const envelope0 = yield* prepareEpochEnvelope({
          context: { ...f.context, recipient: r1.publicKey },
          key: f.secret,
          signer: f.owner.signer,
          ledger: () => Effect.sync(view)
        })
        const body = ok(
          encodeCbor([
            view().head.toBytes(),
            f.owner.raw,
            [
              7,
              1,
              ok(commitEpochKey(f.context.genesis, 1, next)).toBytes(),
              ok(
                sealHistoryPacket({
                  genesis: f.context.genesis,
                  epoch: 1,
                  currentKey: next,
                  previousKey: f.secret
                })
              )
            ]
          ])
        )
        records.push(yield* signLedgerRecord(ok(prepareLedgerRecord(view(), body)), f.owner.signer))
        let oldPin
        if (scenario === 'unfinished-join') {
          oldPin = {
            version: 1,
            workspaceId,
            genesisHash,
            genesisRecordHex: hex(f.genesisRecord),
            membershipId,
            endorser: hex(f.owner.raw),
            pairingSessionId: '88'.repeat(16)
          }
          yield* bootstrap.preparePersonalJoin(oldPin)
        }
        let currentRecovery = r1,
          latestDelivered = scenario === 'unfinished-join',
          completed = false
        const target = recoveryRestoreTarget({
          id: workspaceId,
          name: 'Recovery rebind',
          genesisHash,
          hasIdentity: () => completed,
          identity: (pin) => bootstrap.recoveryIdentity(pin),
          history: () => Effect.sync(page),
          stagedGroup: () => Effect.succeed(null),
          mailbox: () => ({
            fetch: (epoch) =>
              Effect.gen(function* () {
                if (epoch === 0 && currentRecovery === r1)
                  return { items: [{ sender: hex(f.owner.raw), frame: envelope0 }] }
                if (epoch === 1 && latestDelivered)
                  return {
                    items: [
                      {
                        sender: hex(f.owner.raw),
                        frame: yield* prepareEpochEnvelope({
                          context: {
                            ...f.context,
                            epoch: ok(Bytes.epochNumber(1)),
                            recipient: currentRecovery.publicKey
                          },
                          key: next,
                          signer: f.owner.signer,
                          ledger: () => Effect.sync(view)
                        })
                      }
                    ]
                  }
                return { items: [] }
              })
          }),
          append: (request) =>
            Effect.sync(() => {
              records.push(Buffer.from(request.recordHex, 'hex'))
              view()
              return { status: 'committed' }
            }),
          adopt: (join) =>
            adoptRecoveredWorkspace({ workspaceId, genesisHash, join, bootstrap, host }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  completed = true
                })
              )
            )
        })
        const run = () => restoreVaultWorkspaces({ vault, local, targets: [target] })
        if (scenario === 'unfinished-join') {
          // Without the R-signed on-chain admission, recovery cannot replace the pending pin.
          const refused = yield* Effect.result(
            bootstrap.prepareRecoveryPersonalJoin(
              {
                ...oldPin,
                endorser: hex(r1.publicKey.toBytes()),
                pairingSessionId: '99'.repeat(16)
              },
              [page()]
            )
          )
          assert.equal(Result.isFailure(refused), true)
          assert.deepEqual(
            database(directory, (db) =>
              JSON.parse(
                db.prepare('SELECT pin FROM personal_joins WHERE workspace_id=?').get(workspaceId)
                  .pin
              )
            ),
            oldPin
          )
        }
        const first = yield* run()
        assert.equal(first[0].outcome, 'Committed')
        const initial = yield* host.status(workspaceId)
        assert.equal(initial.hasCurrentKey, scenario === 'unfinished-join')
        if (scenario === 'rotated-recovery') {
          assert.equal(first[0].partialEpochKey, true)
          assert.equal(
            new TextDecoder().decode(yield* local.read(`restore-progress/${workspaceId}`)),
            'partial'
          )
          const origin = yield* bootstrap.creationFor(workspaceId)
          const original = database(directory, (db) => ({
            pin: db.prepare('SELECT pin FROM personal_joins WHERE workspace_id=?').get(workspaceId)
              .pin,
            history: db
              .prepare('SELECT history FROM personal_join_histories WHERE workspace_id=?')
              .get(workspaceId).history
          }))
          currentRecovery = yield* enroll(1)
          yield* append(f.owner.signer, { _tag: 'RevokeDevice', target: r1.publicKey })
          // A completed anchor may never be rebound, even to a valid current R.
          const changed = {
            ...JSON.parse(original.pin),
            endorser: hex(currentRecovery.publicKey.toBytes()),
            pairingSessionId: '99'.repeat(16)
          }
          const immutable = yield* Effect.result(
            bootstrap.prepareRecoveryPersonalJoin(changed, [page()])
          )
          assert.equal(Result.isFailure(immutable), true)
          latestDelivered = true
          const before = records.length
          const repaired = yield* run()
          assert.equal(repaired[0].outcome, 'Committed')
          assert.equal(repaired[0].partialEpochKey, false)
          assert.equal(records.length, before)
          assert.equal((yield* bootstrap.creationFor(workspaceId)).genesisHash, origin.genesisHash)
          const retained = database(directory, (db) => ({
            pin: db.prepare('SELECT pin FROM personal_joins WHERE workspace_id=?').get(workspaceId)
              .pin,
            history: db
              .prepare('SELECT history FROM personal_join_histories WHERE workspace_id=?')
              .get(workspaceId).history
          }))
          assert.deepEqual(retained, original)
        } else {
          const rows = database(directory, (db) => ({
            current: db
              .prepare('SELECT pin FROM personal_joins WHERE workspace_id=?')
              .get(workspaceId).pin,
            retired: db
              .prepare('SELECT pin,request_hex FROM retired_personal_joins WHERE workspace_id=?')
              .get(workspaceId)
          }))
          assert.equal(JSON.parse(rows.current).endorser, hex(r1.publicKey.toBytes()))
          assert.deepEqual(JSON.parse(rows.retired.pin), oldPin)
          assert.ok(rows.retired.request_hex)
          const replay = yield* bootstrap.preparePersonalJoin(JSON.parse(rows.current))
          assert.equal(replay.signingPublicKey, initial.signingPublicKey)
        }
        assert.equal((yield* host.status(workspaceId)).hasCurrentKey, true)
        assert.equal((yield* host.status(workspaceId)).signingPublicKey, initial.signingPublicKey)
        assert.equal(
          new TextDecoder().decode(yield* local.read(`restore-progress/${workspaceId}`)),
          'done'
        )
        assert.equal(yield* recoveryRestoreIncomplete(local, workspaceId), false)
      })
    )
  })
}

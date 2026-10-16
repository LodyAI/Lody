import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { Bytes, decodeRecord, hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol'
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
  const first = await prepare(directory)
  assert.deepEqual(
    Object.keys(first).sort(),
    [...Object.keys(intent), 'genesisRecordHex', 'genesisHashHex'].sort()
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

void test('a lost final response/ready marker resumes from retained originals without resigning', async (t) => {
  const directory = await fixture(t)
  const original = await prepare(directory)
  database(directory, (db) => db.prepare('UPDATE creations SET ready=0').run())
  assert.deepEqual(await prepare(directory), original)
  assert.equal(stored(directory).ready, 1)
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

void test('another owner cannot overtake creation while the native key retention is in flight', async (t) => {
  const directory = await fixture(t)
  const result = await execute(
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
      const created = yield* Fiber.join(creating)
      assert.equal(other.failure.code, 'busy')
      return created
    })
  )
  assert.deepEqual(await prepare(directory), result)
})

void test('invalid requests fail before generating a signed identity', async (t) => {
  const directory = await fixture(t)
  for (const changed of [{ requestId: '../request' }, { slug: '../escape' }, { name: '' }]) {
    const result = await execute(
      Effect.gen(function* () {
        const { bootstrap } = yield* openOwner(directory)
        return yield* Effect.result(bootstrap.prepareCreation({ ...intent, ...changed }))
      })
    )
    assert.equal(result.failure.code, 'invalid-input')
  }
  assert.equal(stored(directory), undefined)
  // Only the wrapped KEK/native mutex may exist; no device has been retained.
  assert.equal(
    (await readdir(join(directory, 'custody'))).some((name) => name.endsWith('.device')),
    false
  )
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

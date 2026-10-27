import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  link,
  writeFile,
  symlink,
  open
} from 'node:fs/promises'
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
    yield* bootstrap.recordAccountIdentity({
      accountId: intent.accountId,
      cryptoUserId: 'aa'.repeat(32)
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
        yield* bootstrap.recordAccountIdentity({accountId:intent.accountId,cryptoUserId:'aa'.repeat(32)});
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
  await unlink(join(directory, 'custody', `device-credential-${prepared.genesisHashHex}.sealed`))
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

void test('D03 fixed identity survives reopen and signs multiple workspaces without replacing older signed originals', async (t) => {
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
  const changed = await execute(
    Effect.gen(function* () {
      const owner = yield* openOwner(directory)
      return yield* Effect.result(
        owner.bootstrap.recordAccountIdentity({
          accountId: intent.accountId,
          cryptoUserId: 'bb'.repeat(32)
        })
      )
    })
  )
  assert.equal(changed.failure.code, 'conflict')
  assert.deepEqual(await prepare(directory), first)
})

void test('D03 no registration fails before signing and succeeds on the next explicit registration without deleting originals', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const custody = yield* makeDesktopE2eeCustody({
        directory: join(directory, 'custody'),
        platform: 'linux',
        safeStorage
      })
      const bootstrap = yield* makeDesktopE2eeBootstrap({
        directory,
        accountId: intent.accountId,
        custody
      })
      assert.equal(yield* bootstrap.creationNeedsAccountIdentity(intent), true)
      const missing = yield* Effect.result(bootstrap.prepareCreation(intent))
      assert.equal(missing.failure.code, 'account-identity-required')
      assert.equal(stored(directory).record, null)
      yield* bootstrap.recordAccountIdentity({
        accountId: intent.accountId,
        cryptoUserId: 'aa'.repeat(32)
      })
      assert.equal(yield* bootstrap.creationNeedsAccountIdentity(intent), false)
      const signed = yield* bootstrap.prepareCreation(intent)
      assert.ok(signed.genesisRecordHex)
    })
  )
})

void test('D03 write-before-publication failure retains old signed originals and the next registration call recovers', async (t) => {
  const directory = await fixture(t)
  const original = await prepare(directory)
  await unlink(join(directory, 'account-identity.json'))
  let failLink = true
  await execute(
    Effect.gen(function* () {
      const custody = yield* makeDesktopE2eeCustody({
        directory: join(directory, 'custody'),
        platform: 'linux',
        safeStorage
      })
      const bootstrap = yield* makeDesktopE2eeBootstrap({
        directory,
        accountId: intent.accountId,
        custody,
        identityFiles: {
          unlink,
          link: async (...args) => {
            if (failLink)
              throw Object.assign(new Error('synthetic publish unavailable'), { code: 'EIO' })
            return link(...args)
          }
        }
      })
      assert.equal(yield* bootstrap.creationNeedsAccountIdentity(intent), false)
      assert.deepEqual(yield* bootstrap.prepareCreation(intent), original)
      const failed = yield* Effect.result(
        bootstrap.recordAccountIdentity({
          accountId: intent.accountId,
          cryptoUserId: 'aa'.repeat(32)
        })
      )
      assert.equal(failed.failure.code, 'storage')
      failLink = false
      yield* bootstrap.recordAccountIdentity({
        accountId: intent.accountId,
        cryptoUserId: 'aa'.repeat(32)
      })
      assert.deepEqual(yield* bootstrap.prepareCreation(intent), original)
    })
  )
  assert.deepEqual(await prepare(directory), original)
})

void test('D03 lost publication acknowledgment and failed auxiliary unlink preserve the valid ID; next access owns cleanup', async (t) => {
  const directory = await fixture(t)
  let cleanupBlocked = true
  await execute(
    Effect.gen(function* () {
      const custody = yield* makeDesktopE2eeCustody({
        directory: join(directory, 'custody'),
        platform: 'linux',
        safeStorage
      })
      const bootstrap = yield* makeDesktopE2eeBootstrap({
        directory,
        accountId: intent.accountId,
        custody,
        identityFiles: {
          link: async (...args) => {
            await link(...args)
            throw new Error('synthetic lost link receipt')
          },
          unlink: async (...args) => {
            if (cleanupBlocked) throw new Error('synthetic cleanup busy')
            return unlink(...args)
          }
        }
      })
      yield* bootstrap.recordAccountIdentity({
        accountId: intent.accountId,
        cryptoUserId: 'aa'.repeat(32)
      })
      assert.equal(
        (yield* Effect.promise(() => readdir(directory))).filter((name) =>
          name.endsWith('.pending')
        ).length,
        1
      )
      // nlink=2 is our own valid published copy and must not poison the next read.
      assert.equal(yield* bootstrap.creationNeedsAccountIdentity(intent), false)
      const prepared = yield* bootstrap.prepareCreation(intent)
      assert.ok(prepared.genesisRecordHex)
      cleanupBlocked = false
      yield* bootstrap.recordAccountIdentity({
        accountId: intent.accountId,
        cryptoUserId: 'aa'.repeat(32)
      })
      assert.equal(
        (yield* Effect.promise(() => readdir(directory))).filter((name) =>
          name.endsWith('.pending')
        ).length,
        0
      )
    })
  )
})

void test('D03 unknown cache and symlink stay untouched and do not enroll or sign', async (t) => {
  for (const state of ['unknown', 'symlink']) {
    const directory = await fixture(t)
    const path = join(directory, 'account-identity.json')
    const foreign = Buffer.from('{"version":99,"opaque":"must remain"}')
    if (state === 'unknown') await writeFile(path, foreign, { mode: 0o600 })
    else {
      await writeFile(join(directory, 'foreign'), foreign, { mode: 0o600 })
      await symlink(join(directory, 'foreign'), path)
    }
    await execute(
      Effect.gen(function* () {
        const custody = yield* makeDesktopE2eeCustody({
          directory: join(directory, 'custody'),
          platform: 'linux',
          safeStorage
        })
        const bootstrap = yield* makeDesktopE2eeBootstrap({
          directory,
          accountId: intent.accountId,
          custody
        })
        assert.ok(
          Result.isFailure(yield* Effect.result(bootstrap.creationNeedsAccountIdentity(intent)))
        )
        assert.ok(
          Result.isFailure(
            yield* Effect.result(
              bootstrap.recordAccountIdentity({
                accountId: intent.accountId,
                cryptoUserId: 'aa'.repeat(32)
              })
            )
          )
        )
      })
    )
    assert.deepEqual(await readFile(path), foreign)
    assert.equal(stored(directory), undefined)
  }
})

void test('D03 concurrent owners retain one ID; busy contenders can retry and conflicting IDs never replace it', async (t) => {
  const directory = await fixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const first = execute(
    Effect.gen(function* () {
      const custody = yield* makeDesktopE2eeCustody({
        directory: join(directory, 'custody'),
        platform: 'linux',
        safeStorage
      })
      const bootstrap = yield* makeDesktopE2eeBootstrap({
        directory,
        accountId: intent.accountId,
        custody,
        identityFiles: {
          unlink,
          link: async (...args) => {
            entered.resolve()
            await release.promise
            return link(...args)
          }
        }
      })
      yield* bootstrap.recordAccountIdentity({
        accountId: intent.accountId,
        cryptoUserId: 'aa'.repeat(32)
      })
    })
  )
  await entered.promise
  try {
    await assert.rejects(execute(openOwner(directory)), (error) => error.code === 'busy')
  } finally {
    release.resolve()
  }
  await first
  await execute(
    Effect.gen(function* () {
      const owner = yield* openOwner(directory)
      assert.equal(yield* owner.bootstrap.creationNeedsAccountIdentity(intent), false)
      const conflict = yield* Effect.result(
        owner.bootstrap.recordAccountIdentity({
          accountId: intent.accountId,
          cryptoUserId: 'bb'.repeat(32)
        })
      )
      assert.equal(conflict.failure.code, 'conflict')
    })
  )
  assert.equal(
    JSON.parse(await readFile(join(directory, 'account-identity.json'), 'utf8')).cryptoUserId,
    'aa'.repeat(32)
  )
})

void test('D03 hard exit before or after atomic publication preserves the first identity and cleanup responsibility', async (t) => {
  const { runCommand, ProcessSpawnerLive, NodeProcessLive } =
    await import('@lody/shared/node/process')
  for (const stage of ['before-publish', 'after-publish']) {
    const directory = await fixture(t)
    const child = `
      import { Effect } from 'effect';
      import { link,unlink } from 'node:fs/promises';
      import { makeDesktopE2eeBootstrap } from ${JSON.stringify(new URL('./e2ee-bootstrap.mts', import.meta.url).href)};
      const directory=process.argv[1],stage=process.argv[2];
      await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
        const bootstrap=yield* makeDesktopE2eeBootstrap({ directory,accountId:'synthetic-account',custody:{},identityFiles:{unlink,link:async(...args)=>{
          if(stage==='after-publish') await link(...args);
          process.exit(stage==='before-publish'?73:74);
        }}});
        yield* bootstrap.recordAccountIdentity({accountId:'synthetic-account',cryptoUserId:'aa'.repeat(32)});
      })));`
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
          stage
        ],
        cwd: new URL('../../../', import.meta.url).pathname,
        env: { ...process.env },
        maxOutputBytes: 65536
      }).pipe(Effect.provide(ProcessSpawnerLive), Effect.provide(NodeProcessLive))
    )
    assert.equal(result.code, stage === 'before-publish' ? 73 : 74, result.stderr.toString())
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.pending')).length, 1)
    const signed = await prepare(directory)
    const body = Result.getOrThrow(decodeRecord(Buffer.from(signed.genesisRecordHex, 'hex'))).body
    assert.equal(Buffer.from(body.userId.toBytes()).toString('hex'), 'aa'.repeat(32))
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.pending')).length, 0)
  }
})

void test('D03 new cache never opens or migrates experimental SQLite originals', async (t) => {
  const directory = await fixture(t)
  const experimental = Buffer.from('unsupported experimental SQLite originals must remain')
  await writeFile(join(directory, 'account-identity.sqlite'), experimental, { mode: 0o600 })
  await writeFile(join(directory, 'account-identity.sqlite-wal'), experimental, { mode: 0o600 })
  await writeFile(join(directory, 'account-identity.sqlite-shm'), experimental, { mode: 0o600 })
  const signed = await prepare(directory)
  assert.ok(signed.genesisRecordHex)
  for (const suffix of ['', '-wal', '-shm'])
    assert.deepEqual(
      await readFile(join(directory, `account-identity.sqlite${suffix}`)),
      experimental
    )
})

void test('D03 identity reads accept normal short reads and failed auxiliary close never poisons scope', async (t) => {
  const directory = await fixture(t)
  await prepare(directory)
  let closeFailures = 2
  let closeAttempts = 0
  let shortReads = 0
  await execute(
    Effect.gen(function* () {
      const bootstrap = yield* makeDesktopE2eeBootstrap({
        directory,
        accountId: intent.accountId,
        custody: {},
        identityFiles: {
          link,
          unlink,
          open: async (...args) => {
            const file = await open(...args)
            return new Proxy(file, {
              get(target, property) {
                if (property === 'read')
                  return async (buffer, offset, length, position) => {
                    shortReads++
                    return target.read(buffer, offset, Math.min(length, 3), position)
                  }
                if (property === 'close')
                  return async () => {
                    closeAttempts++
                    if (closeFailures-- > 0)
                      throw Object.assign(new Error('synthetic close failure'), { code: 'EIO' })
                    return target.close()
                  }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              }
            })
          }
        }
      })
      assert.equal(
        yield* bootstrap.creationNeedsAccountIdentity({
          ...intent,
          requestId: 'new-request-01234567'
        }),
        false
      )
      assert.ok(shortReads > 2)
    })
  )
  // Both read-finally and account-scope cleanup failed. The retained, quiesced
  // descriptor belongs to the process cleanup set; a new owner retries it.
  assert.equal(closeAttempts, 2)
  await execute(
    Effect.gen(function* () {
      const bootstrap = yield* makeDesktopE2eeBootstrap({
        directory,
        accountId: intent.accountId,
        custody: {}
      })
      assert.equal(
        yield* bootstrap.creationNeedsAccountIdentity({
          ...intent,
          requestId: 'new-request-01234567'
        }),
        false
      )
    })
  )
  assert.equal(closeAttempts, 3)
})

void test('D03 invalid identity preserves its primary error alongside failed close and recovers without replacement', async (t) => {
  const directory = await fixture(t)
  await prepare(directory)
  const path = join(directory, 'account-identity.json')
  const original = await readFile(path)
  const unknown = Buffer.from(
    JSON.stringify({ version: 99, accountId: intent.accountId, cryptoUserId: 'aa'.repeat(32) }) +
      '\n'
  )
  await writeFile(path, unknown)
  const closeCause = new Error('synthetic primary companion close failure')
  let failClose = true
  await execute(
    Effect.gen(function* () {
      const bootstrap = yield* makeDesktopE2eeBootstrap({
        directory,
        accountId: intent.accountId,
        custody: {},
        identityFiles: {
          link,
          unlink,
          open: async (...args) => {
            const file = await open(...args)
            return new Proxy(file, {
              get(target, property) {
                if (property === 'close')
                  return async () => {
                    if (failClose) {
                      failClose = false
                      throw closeCause
                    }
                    return target.close()
                  }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              }
            })
          }
        }
      })
      const result = yield* Effect.result(
        bootstrap.creationNeedsAccountIdentity({ ...intent, requestId: 'new-request-01234567' })
      )
      assert.equal(result.failure.code, 'corrupt')
      const { desktopE2eeFailure } = yield* Effect.promise(() => import('./e2ee-diagnostics.mts'))
      const diagnostic = desktopE2eeFailure()
      assert.equal(diagnostic.source, 'bootstrap-storage')
      assert.equal(diagnostic.cause.primary.code, 'corrupt')
      assert.equal(diagnostic.cause.errors[1], closeCause)
      assert.deepEqual(yield* Effect.promise(() => readFile(path)), unknown)
      yield* Effect.promise(() => writeFile(path, original))
      assert.equal(
        yield* bootstrap.creationNeedsAccountIdentity({
          ...intent,
          requestId: 'new-request-01234567'
        }),
        false
      )
    })
  )
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

import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import fileSystem from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context, Effect, Exit, Fiber, Layer, Scope } from 'effect'
import { Bytes, verifySignature } from '@lody/e2ee-core/protocol'
import { signGenesisRecord } from '@lody/e2ee-core/protocol'
import { desktopE2eePorts, makeDesktopE2eeCustody } from './e2ee-custody.mts'
import { CandidateProtector, DeviceIdentity, KeyProtector } from '@lody/e2ee-core/services'

// An authenticated synthetic native boundary, never a real OS keychain claim.
const wrapping = Buffer.alloc(32, 72)
function backend(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    isAsyncEncryptionAvailable: async () => true,
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
    },
    ...overrides
  }
}
const hash = () => Bytes.genesisHash(new Uint8Array(32).fill(11)).success
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lody-e2ee-desktop-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const execute = (work) => Effect.runPromise(Effect.scoped(work))
const installedBody = () => {
  const purpose = Buffer.from('lody-e2ee/local-epoch-key/v1\0')
  const body = Buffer.alloc(purpose.length + 32 * 4 + 4)
  purpose.copy(body)
  body.fill(17, purpose.length, purpose.length + 32)
  body.fill(18, purpose.length + 32, purpose.length + 64)
  body.writeUInt32BE(9, purpose.length + 64)
  body.fill(19, purpose.length + 68, purpose.length + 100)
  body.fill(97, body.length - 32)
  return body
}
const candidateBody = () => {
  const prefix = Buffer.from('lody-e2ee/local-epoch-candidate/v1\0')
  const header = prefix.length + 32 * 6 + 12,
    body = Buffer.alloc(header + 41 + 32)
  prefix.copy(body)
  body.fill(22, prefix.length, prefix.length + 32 * 6)
  body.writeUInt32BE(4, prefix.length + 32 * 6)
  body.writeUInt32BE(9, prefix.length + 32 * 6 + 4)
  body.writeUInt32BE(41, header - 4)
  body.fill(23, header, header + 41)
  body.fill(98, header + 41)
  return body
}
void test('rejects unavailable and basic_text before creating any storage', async (t) => {
  const directory = await fixture(t)
  for (const [changes, code] of [
    [{ isEncryptionAvailable: () => false }, 'unavailable'],
    [{ isAsyncEncryptionAvailable: async () => false }, 'unavailable'],
    [{ getSelectedStorageBackend: () => 'basic_text' }, 'basic-text'],
    [{ getSelectedStorageBackend: () => 'unknown' }, 'unavailable']
  ]) {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.result(
          makeDesktopE2eeCustody({ directory, platform: 'linux', safeStorage: backend(changes) })
        )
      )
    )
    assert.equal(result.failure?.code, code)
    assert.deepEqual(await readdir(directory), [])
  }
})
void test('macOS/Windows do not require the Linux-only backend method', async (t) => {
  for (const platform of ['darwin', 'win32']) {
    const directory = await fixture(t)
    const storage = backend()
    delete storage.getSelectedStorageBackend
    await execute(
      Effect.gen(function* () {
        const owner = yield* makeDesktopE2eeCustody({ directory, platform, safeStorage: storage })
        const sealed = yield* Effect.promise(() => owner.installed.protect(installedBody()))
        assert.deepEqual(
          Buffer.from(yield* Effect.promise(() => owner.installed.unprotect(sealed))),
          installedBody()
        )
      })
    )
  }
})
void test('installed and candidate data authenticate full context and reopen with the first wrapped KEK', async (t) => {
  const directory = await fixture(t)
  const body = installedBody(),
    candidate = candidateBody()
  let encrypted, candidateBlob, originalWrapped
  await execute(
    Effect.gen(function* () {
      const storage = backend()
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: storage
      })
      // Capture once: caller mutation does not replace already selected methods.
      storage.encryptStringAsync = async () => {
        throw new Error('replaced')
      }
      encrypted = yield* Effect.promise(() => owner.installed.protect(body))
      candidateBlob = yield* Effect.promise(() => owner.candidate.protect(candidate))
      assert.notDeepEqual(encrypted, body)
      assert.deepEqual(
        Buffer.from(yield* Effect.promise(() => owner.installed.unprotect(encrypted))),
        body
      )
      const bad = new Uint8Array(encrypted)
      bad[45] ^= 1
      const result = yield* Effect.result(
        Effect.tryPromise({ try: () => owner.installed.unprotect(bad), catch: (e) => e })
      )
      assert.equal(result.failure?.code, 'corrupt')
      const wrongPurpose = yield* Effect.result(
        Effect.tryPromise({ try: () => owner.candidate.unprotect(encrypted), catch: (e) => e })
      )
      assert.equal(wrongPurpose.failure?.code, 'invalid-input')
      originalWrapped = yield* Effect.promise(() => readFile(join(directory, 'kek.safe-storage')))
    })
  )
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend()
      })
      assert.deepEqual(
        Buffer.from(yield* Effect.promise(() => owner.installed.unprotect(encrypted))),
        body
      )
      assert.deepEqual(
        Buffer.from(yield* Effect.promise(() => owner.candidate.unprotect(candidateBlob))),
        candidate
      )
    })
  )
  assert.deepEqual(await readFile(join(directory, 'kek.safe-storage')), originalWrapped)
  assert.equal((await stat(join(directory, 'kek.safe-storage'))).mode & 0o777, 0o600)
  for (const file of await readdir(directory)) {
    const stored = await readFile(join(directory, file))
    assert.equal(stored.includes(body.subarray(-32)), false)
    assert.equal(stored.includes(candidate.subarray(-32)), false)
  }
})
void test('native key rotation rewraps the same KEK and retained protected data still opens', async (t) => {
  const directory = await fixture(t)
  const file = join(directory, 'kek.safe-storage')
  let protectedKey, original
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend()
      })
      protectedKey = yield* Effect.promise(() => owner.installed.protect(installedBody()))
      original = yield* Effect.promise(() => readFile(file))
    })
  )
  const native = backend()
  const decrypt = native.decryptStringAsync
  native.decryptStringAsync = async (value) => ({
    ...(await decrypt(value)),
    shouldReEncrypt: Buffer.from(value).equals(original)
  })
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: native
      })
      assert.deepEqual(
        Buffer.from(yield* Effect.promise(() => owner.installed.unprotect(protectedKey))),
        installedBody()
      )
    })
  )
  const replacement = await readFile(file)
  assert.notDeepEqual(replacement, original, 'shouldReEncrypt must publish a fresh wrapped KEK')
  assert.equal((await decrypt(replacement)).result, (await decrypt(original)).result)
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend()
      })
      assert.deepEqual(
        Buffer.from(yield* Effect.promise(() => owner.installed.unprotect(protectedKey))),
        installedBody()
      )
    })
  )
  assert.deepEqual(await readdir(directory), ['kek.safe-storage', 'kek.safe-storage.rewrap-lock'])
})
void test('failed KEK rewrap preserves the complete previous wrapper and protected keys', async (t) => {
  for (const fault of ['wrap', 'candidate', 'replace', 'readback']) {
    const directory = await fixture(t)
    const file = join(directory, 'kek.safe-storage')
    let protectedKey
    await execute(
      Effect.gen(function* () {
        const owner = yield* makeDesktopE2eeCustody({
          directory,
          platform: 'linux',
          safeStorage: backend()
        })
        protectedKey = yield* Effect.promise(() => owner.installed.protect(installedBody()))
      })
    )
    const original = await readFile(file)
    const storage = backend()
    const encrypt = storage.encryptStringAsync
    const decrypt = storage.decryptStringAsync
    let replacementDecrypts = 0
    storage.encryptStringAsync = async (value) => {
      if (fault === 'wrap') throw new Error('native re-encryption unavailable')
      return encrypt(value)
    }
    storage.decryptStringAsync = async (value) => {
      const opened = await decrypt(value)
      if (Buffer.from(value).equals(original)) return { ...opened, shouldReEncrypt: true }
      replacementDecrypts++
      if (fault === 'candidate') return { result: '0'.repeat(64), shouldReEncrypt: false }
      if (fault === 'readback' && replacementDecrypts === 2)
        throw new Error('native readback failed after publication')
      return opened
    }
    const rename = fileSystem.rename
    if (fault === 'replace') {
      fileSystem.rename = async (from, to) => {
        if (to === file) throw new Error('atomic replacement failed')
        return rename(from, to)
      }
      syncBuiltinESMExports()
    }
    let result
    try {
      result = await execute(
        Effect.result(
          makeDesktopE2eeCustody({ directory, platform: 'linux', safeStorage: storage })
        )
      )
    } finally {
      fileSystem.rename = rename
      syncBuiltinESMExports()
    }
    assert.equal(result.failure?.code, 'rewrap-failed', fault)
    assert.deepEqual(await readFile(file), original, fault)
    assert.deepEqual(
      await readdir(directory),
      ['kek.safe-storage', 'kek.safe-storage.rewrap-lock'],
      fault
    )
    await execute(
      Effect.gen(function* () {
        const owner = yield* makeDesktopE2eeCustody({
          directory,
          platform: 'linux',
          safeStorage: backend()
        })
        assert.deepEqual(
          Buffer.from(yield* Effect.promise(() => owner.installed.unprotect(protectedKey))),
          installedBody(),
          fault
        )
      })
    )
  }
})
void test('a failed rollback leaves an encrypted journal and the next owner recovers automatically', async (t) => {
  const directory = await fixture(t)
  const file = join(directory, 'kek.safe-storage')
  let protectedKey
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend()
      })
      protectedKey = yield* Effect.promise(() => owner.installed.protect(installedBody()))
    })
  )
  const original = await readFile(file)
  const storage = backend(),
    decrypt = storage.decryptStringAsync
  let replacementDecrypts = 0
  storage.decryptStringAsync = async (value) => {
    const opened = await decrypt(value)
    const isOriginal = Buffer.from(value).equals(original)
    if (!isOriginal && ++replacementDecrypts === 2) throw new Error('readback failed')
    return { ...opened, shouldReEncrypt: isOriginal }
  }
  const rename = fileSystem.rename
  let replacements = 0
  fileSystem.rename = async (from, to) => {
    if (to === file && ++replacements === 2) throw new Error('rollback storage unavailable')
    return rename(from, to)
  }
  syncBuiltinESMExports()
  let result
  try {
    result = await execute(
      Effect.result(makeDesktopE2eeCustody({ directory, platform: 'linux', safeStorage: storage }))
    )
  } finally {
    fileSystem.rename = rename
    syncBuiltinESMExports()
  }
  assert.equal(result.failure?.code, 'rewrap-failed')
  const journal = JSON.parse(await readFile(`${file}.rewrap-journal`, 'utf8'))
  assert.deepEqual(Buffer.from(journal.original, 'hex'), original)
  const replacement = await readFile(file)
  assert.notDeepEqual(replacement, original)
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend({
          decryptStringAsync: async (value) => {
            if (Buffer.from(value).equals(original))
              throw new Error('old native wrapping key retired')
            return backend().decryptStringAsync(value)
          }
        })
      })
      assert.deepEqual(
        Buffer.from(yield* Effect.promise(() => owner.installed.unprotect(protectedKey))),
        installedBody()
      )
    })
  )
  assert.deepEqual(
    await readFile(file),
    replacement,
    'a valid published replacement must not be rolled back'
  )
  assert.deepEqual(await readdir(directory), ['kek.safe-storage', 'kek.safe-storage.rewrap-lock'])
})
void test('hard process exit releases the OS mutex and preserves the same KEK before and after replacement', async (t) => {
  const { runCommand, ProcessSpawnerLive, NodeProcessLive } =
    await import('@lody/shared/node/process')
  for (const stage of ['native-wrap', 'journal-published', 'replacement-published']) {
    const directory = await fixture(t)
    const file = join(directory, 'kek.safe-storage')
    let protectedKey
    await execute(
      Effect.gen(function* () {
        const owner = yield* makeDesktopE2eeCustody({
          directory,
          platform: 'linux',
          safeStorage: backend()
        })
        protectedKey = yield* Effect.promise(() => owner.installed.protect(installedBody()))
      })
    )
    const original = await readFile(file)
    const entry = new URL('./e2ee-custody.mts', import.meta.url).href
    const child = `
      import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
      import fileSystem, { readFile } from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { Effect } from 'effect';
      import { makeDesktopE2eeCustody } from ${JSON.stringify(entry)};
      const wrapping = Buffer.alloc(32, 72);
      const backend = ${backend.toString()};
      const file = process.argv[1]+'/kek.safe-storage', stage=process.argv[2];
      const original = await readFile(file), storage = backend();
      const wrap=storage.encryptStringAsync, unwrap=storage.decryptStringAsync;
      let replacementReads=0;
      storage.encryptStringAsync = async value => {
        const result = await wrap(value);
        if(stage==='native-wrap') process.exit(73);
        return result;
      };
      storage.decryptStringAsync = async value => {
        const opened=await unwrap(value), isOriginal=Buffer.from(value).equals(original);
        if(!isOriginal && ++replacementReads===2 && stage==='replacement-published') process.kill(process.pid,'SIGKILL');
        return {...opened,shouldReEncrypt:isOriginal};
      };
      const rename=fileSystem.rename;
      fileSystem.rename=async(from,to)=>{
        const result=await rename(from,to);
        if(to===file+'.rewrap-journal' && stage==='journal-published') process.exit(73);
        return result;
      };
      syncBuiltinESMExports();
      await Effect.runPromise(Effect.scoped(makeDesktopE2eeCustody({directory:process.argv[1],platform:'linux',safeStorage:storage})));
      throw Error('crash point was not reached');
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
          stage
        ],
        cwd: new URL('../../', import.meta.url).pathname,
        env: { ...process.env },
        maxOutputBytes: 65536
      }).pipe(Effect.provide(ProcessSpawnerLive), Effect.provide(NodeProcessLive))
    )
    if (stage === 'replacement-published')
      assert.equal(result.signal, 'SIGKILL', result.stderr.toString())
    else assert.equal(result.code, 73, `${stage}: ${result.stderr.toString()}`)
    const crashedWrapper = await readFile(file)
    assert.equal(crashedWrapper.equals(original), stage !== 'replacement-published', stage)
    const reopening = await execute(
      Effect.result(
        Effect.gen(function* () {
          const owner = yield* makeDesktopE2eeCustody({
            directory,
            platform: 'linux',
            safeStorage: backend()
          })
          assert.deepEqual(
            Buffer.from(yield* Effect.promise(() => owner.installed.unprotect(protectedKey))),
            installedBody(),
            stage
          )
        })
      )
    )
    assert.equal(
      reopening._tag,
      'Success',
      `${stage}: initialization refused with ${reopening.failure?.code}`
    )
    assert.deepEqual(await readFile(file), crashedWrapper, stage)
    assert.deepEqual(
      await readdir(directory),
      ['kek.safe-storage', 'kek.safe-storage.rewrap-lock'],
      stage
    )
  }
})
void test('a corrupt recovery journal refuses without replacing the retained KEK', async (t) => {
  for (const journal of [
    '{',
    JSON.stringify({ original: '00', replacement: '00' }),
    JSON.stringify({ original: '00', replacement: '00', digest: '0'.repeat(64) })
  ]) {
    const directory = await fixture(t)
    const file = join(directory, 'kek.safe-storage')
    await execute(makeDesktopE2eeCustody({ directory, platform: 'linux', safeStorage: backend() }))
    const original = await readFile(file)
    await writeFile(`${file}.rewrap-journal`, journal, { mode: 0o600 })
    const result = await execute(
      Effect.result(
        makeDesktopE2eeCustody({ directory, platform: 'linux', safeStorage: backend() })
      )
    )
    assert.equal(result.failure?.code, 'rewrap-failed')
    assert.deepEqual(await readFile(file), original)
    assert.equal(await readFile(`${file}.rewrap-journal`, 'utf8'), journal)
  }
})
void test('a competing KEK rewrap refuses safely while the first native replacement is pending', async (t) => {
  const directory = await fixture(t)
  const file = join(directory, 'kek.safe-storage')
  await execute(makeDesktopE2eeCustody({ directory, platform: 'linux', safeStorage: backend() }))
  const original = await readFile(file)
  const storage = backend()
  const encrypt = storage.encryptStringAsync,
    decrypt = storage.decryptStringAsync
  let release, began
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    began = resolve
  })
  t.after(() => release())
  storage.encryptStringAsync = async (value) => {
    began()
    await gate
    return encrypt(value)
  }
  storage.decryptStringAsync = async (value) => ({
    ...(await decrypt(value)),
    shouldReEncrypt: Buffer.from(value).equals(original)
  })
  const first = execute(
    makeDesktopE2eeCustody({ directory, platform: 'linux', safeStorage: storage })
  )
  try {
    await started
    const second = await execute(
      Effect.result(makeDesktopE2eeCustody({ directory, platform: 'linux', safeStorage: storage }))
    )
    assert.equal(second.failure?.code, 'rewrap-failed')
    assert.deepEqual(await readFile(file), original)
  } finally {
    release()
    await first
  }
  assert.notDeepEqual(await readFile(file), original)
  assert.deepEqual(await readdir(directory), ['kek.safe-storage', 'kek.safe-storage.rewrap-lock'])
})
void test('Scope close retains native KEK rewrap until it settles and then refuses new work', async (t) => {
  const directory = await fixture(t)
  const file = join(directory, 'kek.safe-storage')
  await execute(makeDesktopE2eeCustody({ directory, platform: 'linux', safeStorage: backend() }))
  const original = await readFile(file)
  const storage = backend()
  const encrypt = storage.encryptStringAsync,
    decrypt = storage.decryptStringAsync
  let release, began, closeBegan
  let nativeSettled = false,
    releasedEarly = false,
    replacementDecrypts = 0
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    began = resolve
  })
  const closeStarted = new Promise((resolve) => {
    closeBegan = resolve
  })
  t.after(() => release())
  storage.encryptStringAsync = async (value) => {
    const encoded = await encrypt(value)
    began()
    await gate
    return encoded
  }
  storage.decryptStringAsync = async (value) => {
    const opened = await decrypt(value)
    const isOriginal = Buffer.from(value).equals(original)
    if (!isOriginal && ++replacementDecrypts === 2) nativeSettled = true
    return { ...opened, shouldReEncrypt: isOriginal }
  }
  await execute(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          releasedEarly = !nativeSettled
        })
      )
      yield* Effect.addFinalizer(() => {
        release()
        return Scope.close(scope, Exit.void)
      })
      try {
        const opening = yield* makeDesktopE2eeCustody({
          directory,
          platform: 'linux',
          safeStorage: storage
        }).pipe(Effect.provideService(Scope.Scope, scope), Effect.forkChild)
        yield* Effect.promise(() => started)
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => closeBegan())
        )
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
        yield* Effect.promise(() => closeStarted)
        release()
        const owner = yield* Fiber.join(opening)
        yield* Fiber.join(closing)
        assert.equal(
          releasedEarly,
          false,
          'owner must not release before native KEK readback settles'
        )
        const denied = yield* Effect.result(
          Effect.tryPromise({
            try: () => owner.installed.protect(installedBody()),
            catch: (cause) => cause
          })
        )
        assert.equal(denied.failure?.code, 'closed')
      } finally {
        release()
      }
    })
  )
  assert.notDeepEqual(await readFile(file), original)
  assert.deepEqual(await readdir(directory), ['kek.safe-storage', 'kek.safe-storage.rewrap-lock'])
})
void test('opaque personal/machine identity persists; native keys are nonextractable; recovery cannot persist', async (t) => {
  const directory = await fixture(t)
  const challenge = new Uint8Array([1, 3, 5, 7])
  let original, encryption
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend()
      })
      const device = yield* owner.createDevice(hash())
      original = device.publicKey.toBytes()
      encryption = device.enc.toBytes()
      const signature = yield* device.sign(challenge)
      assert.equal(verifySignature(original, challenge, signature.toBytes())._tag, 'Success')
      assert.equal(device.encryption.privateKey.extractable, false)
      const same = yield* owner.createDevice(hash())
      assert.deepEqual(same.publicKey.toBytes(), original)
      const machine = yield* owner.createDevice(hash(), 'machine')
      assert.notDeepEqual(machine.publicKey.toBytes(), original)
      const denied = yield* Effect.result(owner.createDevice(hash(), 'recovery'))
      assert.equal(denied.failure?.code, 'invalid-input')
    })
  )
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend()
      })
      const device = yield* owner.openDevice(hash())
      assert.deepEqual(device.publicKey.toBytes(), original)
      assert.deepEqual(device.enc.toBytes(), encryption)
      assert.equal(
        verifySignature(original, challenge, (yield* device.sign(challenge)).toBytes())._tag,
        'Success'
      )
    })
  )
  for (const file of await readdir(directory)) {
    const value = await readFile(join(directory, file))
    assert.equal(
      value.includes(
        Buffer.from([0x30, 0x2e, 0x02, 0x01, 0, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70])
      ),
      false
    )
  }
})
void test('corrupted wrapper fails closed without replacing it; corrupted device AAD is refused', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend()
      })
      yield* owner.createDevice(hash())
    })
  )
  const device = (await readdir(directory)).find((value) => value.endsWith('.device'))
  const raw = await readFile(join(directory, device))
  raw[48] ^= 1
  await writeFile(join(directory, device), raw)
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend()
      })
      const denied = yield* Effect.result(owner.openDevice(hash()))
      assert.equal(denied.failure?.code, 'corrupt')
    })
  )
  const wrapped = await readFile(join(directory, 'kek.safe-storage'))
  wrapped[wrapped.length - 1] ^= 1
  await writeFile(join(directory, 'kek.safe-storage'), wrapped)
  const denied = await Effect.runPromise(
    Effect.scoped(
      Effect.result(
        makeDesktopE2eeCustody({ directory, platform: 'linux', safeStorage: backend() })
      )
    )
  )
  assert.equal(denied._tag, 'Failure')
  assert.deepEqual(await readFile(join(directory, 'kek.safe-storage')), wrapped)
})
void test('Scope waits actual native identity generation before clearing the KEK and refuses late work', async (t) => {
  const directory = await fixture(t)
  const subtle = crypto.subtle
  const original = subtle.generateKey.bind(subtle)
  let started, release
  const began = new Promise((resolve) => {
    started = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  subtle.generateKey = async (...args) => {
    const value = await original(...args)
    started()
    await gate
    return value
  }
  t.after(() => {
    subtle.generateKey = original
    release()
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      try {
        const scope = yield* Scope.make()
        const owner = yield* makeDesktopE2eeCustody({
          directory,
          platform: 'linux',
          safeStorage: backend()
        }).pipe(Effect.provideService(Scope.Scope, scope))
        const creation = yield* owner.createDevice(hash()).pipe(Effect.forkChild)
        yield* Effect.promise(() => began)
        yield* owner.stop()
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
        const closed = yield* Effect.result(owner.createDevice(hash()))
        assert.equal(closed.failure?.code, 'closed')
        assert.equal(
          closing.pollUnsafe(),
          undefined,
          'custody must not release while native key generation is unsettled'
        )
        release()
        const completed = yield* Fiber.await(creation)
        assert.equal(
          Exit.isSuccess(completed),
          true,
          'active native operation must complete before KEK release'
        )
        yield* Fiber.join(closing)
        const late = yield* Effect.result(owner.openDevice(hash()))
        assert.equal(late.failure?.code, 'closed')
      } finally {
        release()
      }
    })
  )
})
void test('another OS process reopens encrypted identity and epoch data without plaintext secret files', async (t) => {
  const directory = await fixture(t)
  let publicKey, kekHex, genesisHex
  const exported = []
  const subtle = crypto.subtle,
    originalExport = subtle.exportKey.bind(subtle)
  subtle.exportKey = async (...args) => {
    const value = await originalExport(...args)
    if (args[0] === 'pkcs8') exported.push(Buffer.from(value))
    return value
  }
  t.after(() => {
    subtle.exportKey = originalExport
    for (const value of exported) value.fill(0)
  })
  const storage = backend()
  const originalWrap = storage.encryptStringAsync
  storage.encryptStringAsync = async (value) => {
    kekHex = value
    return originalWrap(value)
  }
  const body = installedBody()
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: storage
      })
      const unused = yield* owner.prepareDevice()
      yield* owner.discardDevice(unused)
      assert.equal((yield* Effect.result(unused.sign(new Uint8Array([1]))))._tag, 'Failure')
      assert.deepEqual(
        (yield* Effect.promise(() => readdir(directory))).filter((name) =>
          name.endsWith('.device')
        ),
        []
      )
      const prepared = yield* owner.prepareDevice()
      const created = yield* signGenesisRecord({
        signer: prepared,
        encryptionPublicKey: prepared.enc,
        userId: Bytes.userId(new Uint8Array(32).fill(31)).success,
        membershipId: Bytes.membershipId(new Uint8Array(16).fill(32)).success,
        initialKey: Bytes.epochKey(new Uint8Array(32).fill(33)).success
      })
      genesisHex = Buffer.from(created.genesis.toBytes()).toString('hex')
      const retained = yield* owner.retainDevice(created.genesis, prepared)
      publicKey = retained.publicKey.toBytes()
      assert.deepEqual(
        (yield* owner.retainDevice(created.genesis, prepared)).publicKey.toBytes(),
        publicKey
      )
      assert.equal((yield* Effect.result(prepared.sign(new Uint8Array([1]))))._tag, 'Failure')
      const prefix = Buffer.from('lody-e2ee/local-epoch-key/v1\0')
      body.set(created.genesis.toBytes(), prefix.length)
      body.set(publicKey, prefix.length + 32)
      const encrypted = yield* Effect.promise(() => owner.installed.protect(body))
      yield* Effect.promise(() =>
        writeFile(join(directory, 'epoch.blob'), encrypted, { mode: 0o600 })
      )
    })
  )
  const { runCommandOk, ProcessSpawnerLive, NodeProcessLive } =
    await import('@lody/shared/node/process')
  const entry = new URL('./e2ee-custody.mts', import.meta.url).href
  const child = `
    import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
    import { readFile } from 'node:fs/promises';
    import { Effect } from 'effect';
    import { Bytes } from '@lody/e2ee-core/protocol';
    import { makeDesktopE2eeCustody } from ${JSON.stringify(entry)};
    const native = {
      isEncryptionAvailable: () => true, isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptStringAsync: async () => { throw Error('must not create a second KEK'); },
      decryptStringAsync: async value => {
        const c = createDecipheriv('aes-256-gcm', Buffer.alloc(32,72), value.subarray(0,12));
        c.setAuthTag(value.subarray(-16));
        return {result: Buffer.concat([c.update(value.subarray(12,-16)),c.final()]).toString(),shouldReEncrypt:false};
      }
    };
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const owner = yield* makeDesktopE2eeCustody({ directory: process.argv[1], platform:'linux', safeStorage:native });
      const device = yield* owner.openDevice(Bytes.genesisHash(new Uint8Array(Buffer.from(process.argv[2],'hex'))).success);
      const blob = yield* Effect.promise(() => readFile(process.argv[1]+'/epoch.blob'));
      const opened = yield* Effect.promise(() => owner.installed.unprotect(blob));
      try {return {pid:process.pid,key:Buffer.from(device.publicKey.toBytes()).toString('hex'),signature:Buffer.from((yield*device.sign(new Uint8Array([1,2,3]))).toBytes()).toString('hex'),digest:createHash('sha256').update(opened).digest('hex')};}
      finally{opened.fill(0)}
    })));
    console.log(JSON.stringify(result));
  `
  const loader = import.meta.resolve('tsx')
  const result = await Effect.runPromise(
    runCommandOk({
      command: process.execPath,
      args: ['--import', loader, '--input-type=module', '-e', child, directory, genesisHex],
      cwd: new URL('../../', import.meta.url).pathname,
      env: { ...process.env },
      maxOutputBytes: 65536
    }).pipe(Effect.provide(ProcessSpawnerLive), Effect.provide(NodeProcessLive))
  )
  const response = JSON.parse(result.stdout.toString().trim())
  assert.notEqual(response.pid, process.pid)
  assert.equal(response.key, Buffer.from(publicKey).toString('hex'))
  assert.equal(
    verifySignature(publicKey, new Uint8Array([1, 2, 3]), Buffer.from(response.signature, 'hex'))
      ._tag,
    'Success'
  )
  const { createHash } = await import('node:crypto')
  assert.equal(response.digest, createHash('sha256').update(body).digest('hex'))
  assert.ok(exported.length >= 2)
  for (const name of await readdir(directory)) {
    const value = await readFile(join(directory, name))
    assert.equal(value.includes(Buffer.from(kekHex)), false)
    assert.equal(value.includes(Buffer.from(kekHex, 'hex')), false)
    assert.equal(value.includes(body.subarray(-32)), false)
    for (const privateKey of exported) assert.equal(value.includes(privateKey), false)
  }
})

void test('recovers a journaled replacement after a crash when only the old native wrapper retired', async (t) => {
  const directory = await fixture(t)
  const file = join(directory, 'kek.safe-storage')
  let protectedKey
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend()
      })
      protectedKey = yield* Effect.promise(() => owner.installed.protect(installedBody()))
    })
  )
  const original = await readFile(file)
  const { runCommand, ProcessSpawnerLive, NodeProcessLive } =
    await import('@lody/shared/node/process')
  const entry = new URL('./e2ee-custody.mts', import.meta.url).href
  const child = `
    import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
    import fileSystem, { readFile } from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { Effect } from 'effect';
    import { makeDesktopE2eeCustody } from ${JSON.stringify(entry)};
    const wrapping = Buffer.alloc(32,72), backend = ${backend.toString()};
    const file=process.argv[1]+'/kek.safe-storage', original=await readFile(file), storage=backend();
    const unwrap=storage.decryptStringAsync;
    storage.decryptStringAsync=async value=>({...await unwrap(value),shouldReEncrypt:Buffer.from(value).equals(original)});
    const rename=fileSystem.rename;
    fileSystem.rename=async(from,to)=>{
      const result=await rename(from,to);
      if(to===file+'.rewrap-journal') process.exit(73);
      return result;
    };
    syncBuiltinESMExports();
    await Effect.runPromise(Effect.scoped(makeDesktopE2eeCustody({directory:process.argv[1],platform:'linux',safeStorage:storage})));
    throw Error('crash point was not reached');
  `
  const ended = await Effect.runPromise(
    runCommand({
      command: process.execPath,
      args: ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', child, directory],
      cwd: new URL('../../', import.meta.url).pathname,
      env: { ...process.env },
      maxOutputBytes: 65536
    }).pipe(Effect.provide(ProcessSpawnerLive), Effect.provide(NodeProcessLive))
  )
  assert.equal(ended.code, 73, ended.stderr.toString())
  assert.deepEqual(await readFile(file), original)
  const journal = JSON.parse(await readFile(file + '.rewrap-journal', 'utf8'))
  assert.notDeepEqual(Buffer.from(journal.replacement, 'hex'), original)
  const native = backend(),
    unwrap = native.decryptStringAsync
  native.decryptStringAsync = async (value) => {
    if (Buffer.from(value).equals(original)) throw Error('old wrapping key permanently retired')
    return unwrap(value)
  }
  const recovery = await execute(
    Effect.result(
      Effect.gen(function* () {
        const owner = yield* makeDesktopE2eeCustody({
          directory,
          platform: 'linux',
          safeStorage: native
        })
        assert.deepEqual(
          Buffer.from(yield* Effect.promise(() => owner.installed.unprotect(protectedKey))),
          installedBody()
        )
      })
    )
  )
  assert.equal(
    recovery._tag,
    'Success',
    `must recover valid journal replacement: ${recovery.failure?.code}`
  )
  assert.deepEqual(await readFile(file), Buffer.from(journal.replacement, 'hex'))
  assert.deepEqual(await readdir(directory), ['kek.safe-storage', 'kek.safe-storage.rewrap-lock'])
})

void test('desktop ports keep installed and candidate protection apart and sign as the opened device', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* makeDesktopE2eeCustody({
        directory,
        platform: 'linux',
        safeStorage: backend()
      })
      const device = yield* owner.createDevice(hash(), 'personal')
      const ports = yield* Layer.build(desktopE2eePorts(owner, device))
      const installed = Context.get(ports, KeyProtector),
        candidate = Context.get(ports, CandidateProtector),
        identity = Context.get(ports, DeviceIdentity)
      const sealed = yield* installed.protect(installedBody())
      assert.deepEqual(Buffer.from(yield* installed.unprotect(sealed)), installedBody())
      // The candidate capability authenticates a different purpose context.
      assert.equal((yield* Effect.result(candidate.unprotect(sealed)))._tag, 'Failure')
      const message = new Uint8Array([1, 2, 3])
      const signature = yield* identity.signer.sign(message)
      assert.equal(
        verifySignature(device.publicKey.toBytes(), message, signature.toBytes())._tag,
        'Success'
      )
      assert.equal(identity.encryptionKeyPair, device.encryption)
    })
  )
})

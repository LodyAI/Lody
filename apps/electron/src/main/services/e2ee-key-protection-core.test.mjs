import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLocalEpochProtection,
  createLocalUserProtection
} from './e2ee-key-protection-core.ts'

void test('device service bundles its source-only workspace dependency with the real main configuration', async () => {
  const { resolveConfig } = await import('electron-vite')
  const { build } = await import('vite')
  const { config } = await resolveConfig({ mode: 'oss' }, 'build', 'oss')
  const entry = new URL('./e2ee-device-service.ts', import.meta.url).pathname
  const results = await build({
    ...config.main,
    configFile: false,
    logLevel: 'silent',
    build: {
      ...config.main.build,
      write: false,
      lib: { entry, formats: ['es'] },
      rollupOptions: { input: entry }
    }
  })
  const chunks = [results]
    .flat()
    .flatMap((result) => result.output)
    .filter((item) => item.type === 'chunk')
  assert.ok(
    chunks.some((chunk) =>
      Object.keys(chunk.modules).some((id) => id.endsWith('/e2ee-core/src/node-device-store.ts'))
    )
  )
  for (const chunk of chunks) {
    assert.ok(!chunk.imports.some((id) => id.startsWith('@lody/e2ee-core')))
    assert.ok(!chunk.dynamicImports.some((id) => id.startsWith('@lody/e2ee-core')))
  }
})

void test('bundled user service creates and reloads a public identity through real SQLite', async () => {
  const { resolveConfig } = await import('electron-vite')
  const { build } = await import('vite')
  const { config } = await resolveConfig({ mode: 'oss' }, 'build', 'oss')
  const entry = new URL('./e2ee-user-service.ts', import.meta.url).pathname
  const result = await build({
    ...config.main,
    configFile: false,
    logLevel: 'silent',
    build: {
      ...config.main.build,
      write: false,
      lib: { entry, formats: ['es'] },
      rollupOptions: { input: entry }
    }
  })
  const chunks = [result]
    .flat()
    .flatMap((item) => item.output)
    .filter((item) => item.type === 'chunk')
  assert.equal(chunks.length, 1)
  const chunk = chunks[0]
  assert.ok(
    Object.keys(chunk.modules).some((id) => id.endsWith('/e2ee-core/src/node-user-store.ts'))
  )
  assert.ok(!chunk.imports.some((id) => id.startsWith('@lody/e2ee-core')))
  const { E2eeUserService } = await import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
  )
  const directory = await mkdtemp(join(tmpdir(), 'lody-user-bundle-'))
  try {
    const { runtime, state } = fixture()
    const options = {
      enabled: true,
      directory,
      authOrigin: 'https://auth.example.test',
      account: async () => ({ userId: 'synthetic-user', assertCurrent() {} }),
      protection: createLocalUserProtection(runtime)
    }
    const identity = await new E2eeUserService(options).create()
    assert.deepEqual(Object.keys(identity).sort(), [
      'encryptionPublicKey',
      'fingerprint',
      'signingPublicKey'
    ])
    assert.equal(identity.fingerprint.length, 64)
    assert.deepEqual(await new E2eeUserService(options).load(), identity)
    state.available = false
    await assert.rejects(new E2eeUserService(options).load(), /secure-key-storage-unavailable/)
    state.available = true
    assert.deepEqual(await new E2eeUserService(options).load(), identity)
    await assert.rejects(new E2eeUserService(options).create(), /user-identity-exists/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const secret = Buffer.alloc(32, 73) // Synthetic fixture, not a production key.
const genesis = 'ab'.repeat(32)
const commitment = createHash('sha256')
  .update('lody-epoch-secret/v1\0')
  .update(Buffer.from(genesis, 'hex'))
  .update(secret)
  .digest('hex')
const context = { genesis, epoch: 3, commitment }

function fixture() {
  // Real authenticated encryption simulates OS wrapping for deterministic policy
  // tests. This is NOT a test of Keychain/DPAPI or a change to the E2EE wire suite.
  const wrappingKey = randomBytes(32)
  const state = { ready: true, plaintext: false, available: true, backend: 'gnome_libsecret' }
  const storage = {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => state.backend,
    encryptString(text) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce)
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), body])
    },
    decryptString(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', wrappingKey, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
  const runtime = {
    safeStorage: storage,
    platform: 'linux',
    isReady: () => state.ready,
    isPlaintextAuthEnabled: () => state.plaintext
  }
  return { state, storage, runtime, protector: createLocalEpochProtection(runtime) }
}

void test('wrapped key survives a fresh adapter, checks context and returns independent copies', () => {
  const { protector, runtime } = fixture()
  const wrapped = protector.seal(context, secret)
  const reopened = createLocalEpochProtection(runtime)
  assert.deepEqual(reopened.open(context, wrapped), new Uint8Array(secret))
  const copy = reopened.open(context, wrapped)
  copy.fill(0)
  assert.deepEqual(reopened.open(context, wrapped), new Uint8Array(secret))
  for (const wrong of [
    { ...context, epoch: 4 },
    { ...context, genesis: 'cd'.repeat(32) },
    { ...context, commitment: '00'.repeat(32) }
  ]) {
    assert.throws(() => reopened.open(wrong, wrapped), /local-epoch-context-mismatch/)
  }
})

void test('unsafe backend, login plaintext switch and lost availability deny both directions', () => {
  for (const change of [
    { ready: false },
    { plaintext: true },
    { available: false },
    { backend: 'basic_text' },
    { backend: 'unknown' },
    { backend: 'future_unreviewed' }
  ]) {
    const { state, protector } = fixture()
    const wrapped = protector.seal(context, secret)
    Object.assign(state, change)
    assert.throws(() => protector.seal(context, secret), /secure-key-storage-unavailable/)
    assert.throws(() => protector.open(context, wrapped), /secure-key-storage-unavailable/)
  }
  for (const platform of ['darwin', 'win32']) {
    const { runtime, state } = fixture()
    runtime.platform = platform
    state.backend = 'unknown' // Linux-only backend must not gate macOS or Windows.
    const protector = createLocalEpochProtection(runtime)
    assert.deepEqual(
      protector.open(context, protector.seal(context, secret)),
      new Uint8Array(secret)
    )
  }
})

void test('later monkey-patching cannot turn a constructed protector into plaintext storage', () => {
  for (const method of [
    'encryptString',
    'decryptString',
    'isEncryptionAvailable',
    'getSelectedStorageBackend'
  ]) {
    const { storage, protector } = fixture()
    const wrapped = protector.seal(context, secret)
    storage[method] = () => {
      throw new Error('should never reach substituted backend')
    }
    assert.throws(() => protector.seal(context, secret), /secure-key-storage-unavailable/)
    assert.throws(() => protector.open(context, wrapped), /secure-key-storage-unavailable/)
  }
})

void test('bad key, malformed plaintext and wrong commitment never return a usable key', () => {
  const { storage, protector } = fixture()
  assert.throws(() => protector.seal(context, Buffer.alloc(32)), /local-epoch-key-mismatch/)
  assert.throws(
    () => protector.seal({ ...context, epoch: -1 }, secret),
    /invalid-local-epoch-context/
  )
  const row = ['lody-local-epoch/v1', genesis, '3', commitment, secret.toString('hex')]
  for (const malformed of [
    'not json',
    ' '.repeat(513),
    JSON.stringify([...row, 'extra']),
    JSON.stringify(row, null, 2),
    JSON.stringify(['lody-local-epoch/v2', ...row.slice(1)])
  ]) {
    assert.throws(
      () => protector.open(context, storage.encryptString(malformed)),
      /invalid-local-epoch-key|local-epoch-context-mismatch/
    )
  }
  row[4] = '00'.repeat(32)
  assert.throws(
    () => protector.open(context, storage.encryptString(JSON.stringify(row))),
    /local-epoch-key-mismatch/
  )
  assert.throws(() => protector.open(context, Buffer.alloc(4097)), /invalid-wrapped-epoch-key/)
  const corrupted = protector.seal(context, secret)
  corrupted[corrupted.length - 1] ^= 1
  assert.throws(
    () => protector.open(context, corrupted),
    /^Error: secure-key-storage-decrypt-failed$/
  )
})

void test('provider failures are sanitized and never trigger another storage mode', () => {
  const { runtime, storage } = fixture()
  storage.encryptString = () => {
    throw new Error('sensitive provider detail')
  }
  storage.decryptString = () => {
    throw new Error('sensitive provider detail')
  }
  const protector = createLocalEpochProtection(runtime)
  assert.throws(() => protector.seal(context, secret), /^Error: secure-key-storage-encrypt-failed$/)
  assert.throws(
    () => protector.open(context, Buffer.from('x')),
    /^Error: secure-key-storage-decrypt-failed$/
  )
})

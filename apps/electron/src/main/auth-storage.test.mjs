import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Conf from 'conf'
import {
  backupAuthStorageFile,
  createRecoveringAuthStorage,
  openAuthStorageBackend
} from './auth-storage.ts'

// Synthetic stand-in for safeStorage: only ciphertext produced under the
// current key decrypts; anything else throws like a replaced OS key does.
const CURRENT_KEY = 'current-key:'
const encrypt = (text, key = CURRENT_KEY) => Buffer.from(`${key}${text}`).toString('base64')

function fixture(t, { ready = true, available = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lody-auth-storage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'config.json')
  const open = () =>
    openAuthStorageBackend(() => new Conf({ cwd: dir, projectName: 'lody-test' }), {
      path,
      backup: backupAuthStorageFile
    })
  const storage = (conf, recoveries = []) =>
    createRecoveringAuthStorage(
      {
        path,
        get: (key) => conf.get(key, null),
        set: (key, value) => conf.set(key, value),
        delete: (key) => conf.delete(key)
      },
      {
        encryptedKeys: ['better-auth.cookie', 'better-auth.local_cache'],
        cipher: {
          isReady: () => ready,
          isEncryptionAvailable: () => available,
          decryptString: (buffer) => {
            const text = buffer.toString('utf8')
            if (!text.startsWith(CURRENT_KEY))
              throw new Error('Error while decrypting the ciphertext')
            return text.slice(CURRENT_KEY.length)
          }
        },
        backup: (source) => backupAuthStorageFile(source),
        onRecovered: (recovery) => recoveries.push(recovery)
      }
    )
  return { dir, path, open, storage }
}

void test('an undecryptable stored cookie is backed up and dropped instead of blocking sign-in', async (t) => {
  const { dir, path, open, storage } = fixture(t)
  const { store } = open()
  const foreign = encrypt('{"better-auth.session_token":{}}', 'replaced-key:')
  store.set('better-auth.cookie', foreign)
  store.set('better-auth_cookie', 'cross-domain plaintext')
  const original = readFileSync(path, 'utf8')
  const recoveries = []
  const auth = storage(store, recoveries)

  assert.equal(auth.getItem('better-auth.cookie'), null)
  assert.equal(recoveries.length, 1)
  assert.equal(recoveries[0].key, 'better-auth.cookie')
  assert.equal(readFileSync(recoveries[0].backupPath, 'utf8'), original)
  // Durable on disk: a restarted app no longer sees the foreign value.
  assert.equal(open().store.get('better-auth.cookie', null), null)
  assert.equal(auth.getItem('better-auth_cookie'), 'cross-domain plaintext')

  // New credentials written under the current key are kept.
  const fresh = encrypt('{}')
  auth.setItem('better-auth.cookie', fresh)
  assert.equal(auth.getItem('better-auth.cookie'), fresh)
  assert.equal(recoveries.length, 1)
  assert.equal(readdirSync(dir).filter((name) => name.endsWith('.bak')).length, 1)
})

void test('a value is never dropped while the keychain cannot answer', async (t) => {
  for (const options of [{ ready: false }, { available: false }]) {
    const { open, storage } = fixture(t, options)
    const { store } = open()
    const value = encrypt('{}', 'maybe-readable-later:')
    store.set('better-auth.cookie', value)
    const recoveries = []
    assert.equal(storage(store, recoveries).getItem('better-auth.cookie'), value)
    assert.deepEqual(recoveries, [])
  }
})

void test('an unparsable auth store is moved aside and reopened empty', async (t) => {
  const { path, open, storage } = fixture(t)
  writeFileSync(path, '{"better-auth": {"cookie": "trunc')
  const opened = open()
  assert.ok(opened.error)
  assert.equal(readFileSync(opened.backupPath, 'utf8'), '{"better-auth": {"cookie": "trunc')
  assert.equal(storage(opened.store).getItem('better-auth.cookie'), null)
  assert.equal(opened.store.size, 0)
})

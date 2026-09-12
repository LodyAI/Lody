import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface LocalEpochContext {
  readonly genesis: string
  readonly epoch: number
  readonly commitment: string
}

const FORMAT = 'lody-local-epoch/v1'
const MAX_WRAPPED_BYTES = 4096
const LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

function requireValid(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

function contextFields(context: LocalEpochContext): [string, string, string, string] {
  requireValid(
    typeof context.genesis === 'string' &&
      /^[0-9a-f]{64}$/.test(context.genesis) &&
      typeof context.commitment === 'string' &&
      /^[0-9a-f]{64}$/.test(context.commitment) &&
      Number.isSafeInteger(context.epoch) &&
      context.epoch >= 0,
    'invalid-local-epoch-context'
  )
  return [FORMAT, context.genesis, String(context.epoch), context.commitment]
}

function checkKey(fields: readonly [string, string, string, string], key: Uint8Array): void {
  requireValid(key instanceof Uint8Array && key.length === 32, 'invalid-local-epoch-key')
  const commitment = createHash('sha256')
    .update('lody-epoch-secret/v1\0')
    .update(Buffer.from(fields[1], 'hex'))
    .update(key)
    .digest('hex')
  requireValid(commitment === fields[3], 'local-epoch-key-mismatch')
}

/** Main-process only. This wraps bytes; it does not persist, authorize or publish an epoch. */
interface ProtectionRuntime {
  readonly safeStorage: SafeStoragePort
  readonly platform: string
  isReady(): boolean
  isPlaintextAuthEnabled(): boolean
}

function guardedStorage(runtime: ProtectionRuntime) {
  const storage = runtime.safeStorage
  const encrypt = storage.encryptString
  const decrypt = storage.decryptString
  const available = storage.isEncryptionAvailable
  const backend = storage.getSelectedStorageBackend

  function assertAvailable(): void {
    // Auth's development hook monkey-patches the shared safeStorage singleton.
    // Refuse it even in an unpackaged app; never inherit its plaintext fallback.
    let supported = false
    try {
      supported =
        runtime.isReady() &&
        !runtime.isPlaintextAuthEnabled() &&
        storage.encryptString === encrypt &&
        storage.decryptString === decrypt &&
        storage.isEncryptionAvailable === available &&
        storage.getSelectedStorageBackend === backend &&
        (runtime.platform === 'darwin' ||
          runtime.platform === 'win32' ||
          (runtime.platform === 'linux' && LINUX_BACKENDS.has(backend.call(storage)))) &&
        available.call(storage)
    } catch {
      /* OS errors must not leak paths, decrypted values or provider messages. */
    }
    requireValid(supported, 'secure-key-storage-unavailable')
  }

  return { storage, encrypt, decrypt, assertAvailable }
}

export function createLocalEpochProtection(runtime: ProtectionRuntime) {
  const { storage, encrypt, decrypt, assertAvailable } = guardedStorage(runtime)

  return {
    seal(context: LocalEpochContext, secret: Uint8Array): Buffer {
      assertAvailable()
      const fields = contextFields(context)
      checkKey(fields, secret)
      const copy = Buffer.from(secret)
      let text: string
      try {
        text = JSON.stringify([...fields, copy.toString('hex')])
      } finally {
        copy.fill(0)
      }
      let wrapped: Buffer
      try {
        wrapped = encrypt.call(storage, text)
      } catch {
        throw new Error('secure-key-storage-encrypt-failed')
      }
      assertAvailable()
      requireValid(
        Buffer.isBuffer(wrapped) && wrapped.length > 0 && wrapped.length <= MAX_WRAPPED_BYTES,
        'invalid-wrapped-epoch-key'
      )
      return Buffer.from(wrapped)
    },
    open(context: LocalEpochContext, wrapped: Uint8Array): Uint8Array {
      assertAvailable()
      const fields = contextFields(context)
      requireValid(
        wrapped instanceof Uint8Array && wrapped.length > 0 && wrapped.length <= MAX_WRAPPED_BYTES,
        'invalid-wrapped-epoch-key'
      )
      let text: string
      try {
        text = decrypt.call(storage, Buffer.from(wrapped))
      } catch {
        throw new Error('secure-key-storage-decrypt-failed')
      }
      assertAvailable()
      requireValid(typeof text === 'string' && text.length <= 512, 'invalid-local-epoch-key')
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error('invalid-local-epoch-key')
      }
      requireValid(
        Array.isArray(value) &&
          value.length === 5 &&
          typeof value[4] === 'string' &&
          /^[0-9a-f]{64}$/.test(value[4]) &&
          text === JSON.stringify([...fields, value[4]]),
        'local-epoch-context-mismatch'
      )
      const key = Buffer.from(value[4], 'hex')
      try {
        checkKey(fields, key)
        return new Uint8Array(key)
      } finally {
        key.fill(0)
      }
    }
  }
}

/** Device bundles only; no implicit persistence or plaintext fallback. */
export function createLocalDeviceProtection(runtime: ProtectionRuntime) {
  return createLocalIdentityProtection(runtime, 'lody-local-device/v1')
}

/** Separate wrapping domain: user recovery secrets must never be mistaken for device bundles. */
export function createLocalUserProtection(runtime: ProtectionRuntime) {
  return createLocalIdentityProtection(runtime, 'lody-local-user/v1')
}

function createLocalIdentityProtection(runtime: ProtectionRuntime, domain: string) {
  const { storage, encrypt, decrypt, assertAvailable } = guardedStorage(runtime)
  function binding(value: string) {
    requireValid(
      typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
      'invalid-device-binding'
    )
  }
  return {
    seal(accountBinding: string, plaintext: Uint8Array): Uint8Array {
      binding(accountBinding)
      assertAvailable()
      requireValid(
        plaintext instanceof Uint8Array && plaintext.length > 0 && plaintext.length <= 2048,
        'invalid-device-bundle'
      )
      const copy = Buffer.from(plaintext)
      let text: string
      try {
        text = JSON.stringify([domain, accountBinding, copy.toString('hex')])
      } finally {
        copy.fill(0)
      }
      let wrapped: Buffer
      try {
        wrapped = encrypt.call(storage, text)
      } catch {
        throw new Error('secure-key-storage-encrypt-failed')
      }
      assertAvailable()
      requireValid(
        Buffer.isBuffer(wrapped) && wrapped.length > 0 && wrapped.length <= 8192,
        'invalid-wrapped-device'
      )
      return new Uint8Array(wrapped)
    },
    open(accountBinding: string, wrapped: Uint8Array): Uint8Array {
      binding(accountBinding)
      assertAvailable()
      requireValid(
        wrapped instanceof Uint8Array && wrapped.length > 0 && wrapped.length <= 8192,
        'invalid-wrapped-device'
      )
      let text: string
      try {
        text = decrypt.call(storage, Buffer.from(wrapped))
      } catch {
        throw new Error('secure-key-storage-decrypt-failed')
      }
      assertAvailable()
      requireValid(typeof text === 'string' && text.length <= 4300, 'invalid-device-bundle')
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error('invalid-device-bundle')
      }
      requireValid(
        Array.isArray(value) &&
          value.length === 3 &&
          typeof value[2] === 'string' &&
          /^(?:[0-9a-f]{2}){1,2048}$/.test(value[2]) &&
          text === JSON.stringify([domain, accountBinding, value[2]]),
        'device-binding-mismatch'
      )
      return new Uint8Array(Buffer.from(value[2], 'hex'))
    }
  }
}

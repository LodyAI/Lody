import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { copyFileSync, renameSync } from 'node:fs'

// The desktop auth store (`userData/config.json`) only caches Better Auth
// credentials; the durable identity lives on the server. A value in it that can
// never be read again must not block sign-in, so it is backed up and dropped.

export type AuthStorageBackend = {
  readonly path: string
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
  delete: (key: string) => void
}

export type AuthStorageCipher = {
  isReady: () => boolean
  isEncryptionAvailable: () => boolean
  decryptString: (encrypted: Buffer) => string
}

export type AuthStorageRecovery = {
  key: string
  backupPath: string | null
  error: unknown
}

type Dependencies = {
  // Values written by @better-auth/electron through safeStorage (base64 ciphertext).
  encryptedKeys: readonly string[]
  cipher: AuthStorageCipher
  backup: (path: string) => string | null
  onRecovered: (recovery: AuthStorageRecovery) => void
}

export type AuthStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: unknown) => void
}

export function createRecoveringAuthStorage(
  backend: AuthStorageBackend,
  { encryptedKeys, cipher, backup, onRecovered }: Dependencies
): AuthStorage {
  const verified = new Map<string, string>()
  return {
    getItem: (key) => {
      const value = backend.get(key)
      if (typeof value !== 'string') return null
      if (!encryptedKeys.includes(key) || verified.get(key) === value) return value
      // Before app readiness or without an OS keychain, a failed decrypt says
      // nothing about the ciphertext; it may become readable again later.
      if (!cipher.isReady() || !cipher.isEncryptionAvailable()) return value
      try {
        cipher.decryptString(Buffer.from(value, 'base64'))
        verified.set(key, value)
        return value
      } catch (error) {
        // The OS key that encrypted this value is gone (for example a replaced
        // Windows `Local State` key or a profile moved to another machine).
        // Every request would otherwise throw before reaching the network.
        const backupPath = backup(backend.path)
        backend.delete(key)
        verified.delete(key)
        onRecovered({ key, backupPath, error })
        return null
      }
    },
    setItem: (key, value) => {
      verified.delete(key)
      backend.set(key, value)
    }
  }
}

// Opens the store; an unparsable file is moved aside instead of aborting startup.
export function openAuthStorageBackend<T>(
  open: () => T,
  { path, backup }: { path: string; backup: (path: string, move: boolean) => string | null }
): { store: T; backupPath: string | null; error: unknown } {
  try {
    return { store: open(), backupPath: null, error: null }
  } catch (error) {
    const backupPath = backup(path, true)
    return { store: open(), backupPath, error }
  }
}

// Keeps the unreadable original next to the store for support diagnosis.
export function backupAuthStorageFile(path: string, move = false, now = new Date()): string | null {
  const backupPath = `${path}.unreadable-${now.toISOString().replace(/[:.]/g, '-')}.bak`
  try {
    if (move) renameSync(path, backupPath)
    else copyFileSync(path, backupPath)
    return backupPath
  } catch (error) {
    console.warn(`[Auth] Failed to back up ${path}`, error)
    return null
  }
}

// E2EE local-directory selection only. This is never a cloud credential or a
// ledger permission, and deliberately has no clock-based expiry.
const OFFLINE_IDENTITY_KEY = 'lody-e2ee.offline-identity'
export type OfflineAuthIdentityStore = Pick<AuthStorageBackend, 'get' | 'set' | 'delete'>
export function makeOfflineAuthIdentityCache(store: OfflineAuthIdentityStore) {
  const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
  return {
    remember(token: string, userId: string): void {
      if (!token || !userId) return
      store.set(OFFLINE_IDENTITY_KEY, { tokenHash: tokenHash(token), userId })
    },
    read(token: string | null): string | null {
      if (!token) return null
      const value = store.get(OFFLINE_IDENTITY_KEY)
      if (typeof value !== 'object' || value === null) return null
      const record = value as { tokenHash?: unknown; userId?: unknown }
      return record.tokenHash === tokenHash(token) &&
        typeof record.userId === 'string' &&
        record.userId.length > 0
        ? record.userId
        : null
    },
    clear(): void {
      store.delete(OFFLINE_IDENTITY_KEY)
    }
  }
}

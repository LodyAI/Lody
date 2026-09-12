import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SqliteUserIdentityStore, type LocalUserProtection } from '@lody/e2ee-core/node-user-store'
import {
  createRecoveryFile,
  parseRecoveryFile,
  openRecoveryBackup,
  restoreUserIdentity
} from '@lody/e2ee-core'

import type { DeviceAccountLease } from './e2ee-device-service'

/** Main-owned account and paths only. No signing/decryption or private-key IPC. */
export class E2eeUserService {
  private readonly accountOperations = new Map<string, Promise<void>>()
  constructor(
    private readonly options: {
      enabled: boolean
      directory: string
      authOrigin: string
      account(): Promise<DeviceAccountLease>
      protection: LocalUserProtection
    }
  ) {}

  create() {
    return this.access(true)
  }
  load() {
    return this.access(false)
  }

  /** Discover only the public locator. Secret bytes never leave the main process. */
  async selectRecoveryBackup(select: (assertCurrent: () => void) => Promise<Uint8Array | null>) {
    return this.withStore(async (_store, account) => {
      const file = await select(() => account.assertCurrent())
      try {
        account.assertCurrent()
        if (file === null) return null
        const parsed = parseRecoveryFile(file)
        parsed.key.fill(0)
        return { accountId: account.userId, backupId: parsed.backupId }
      } finally {
        file?.fill(0)
      }
    })
  }

  /** Explicit import into an empty account-bound store. A cloud descriptor is
   * untrusted until authenticated by the reselected recovery file and key pairs.
   * This restores a user identity only, not devices or membership. */
  async restoreRecoveryBackup(
    backup: {
      accountId: string
      backupId: string
      identity: string
      revision: number
      ciphertext: Uint8Array
    },
    select: (assertCurrent: () => void) => Promise<Uint8Array | null>
  ) {
    if (
      !Number.isSafeInteger(backup.revision) ||
      backup.revision < 0 ||
      !/^[0-9a-f]{32}$/.test(backup.backupId) ||
      !/^[0-9a-f]{64}$/.test(backup.identity) ||
      !(backup.ciphertext instanceof Uint8Array) ||
      backup.ciphertext.length === 0 ||
      backup.ciphertext.length > 2346
    )
      throw new Error('invalid-recovery-backup')
    const expected = { ...backup, ciphertext: new Uint8Array(backup.ciphertext) }
    return this.withStore(async (store, account) => {
      if (expected.accountId !== account.userId) throw new Error('recovery-account-mismatch')
      const file = await select(() => account.assertCurrent())
      try {
        account.assertCurrent()
        if (file === null) return null
        const parsed = parseRecoveryFile(file)
        parsed.key.fill(0)
        if (parsed.backupId !== expected.backupId) throw new Error('recovery-file-mismatch')
        const identity = await store.recover(file, expected, expected.ciphertext)
        account.assertCurrent()
        return { accountId: account.userId, fingerprint: identity.fingerprint }
      } finally {
        file?.fill(0)
      }
    })
  }

  /** Main-only save callback. Never sends file secrets or paths through IPC. */
  async exportRecoveryBackup(
    revision: number,
    save: (file: Uint8Array, backupId: string, assertCurrent: () => void) => Promise<boolean>
  ) {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('invalid-recovery-revision')
    return this.withStore(async (store, account) => {
      const identity = await store.load()
      account.assertCurrent()
      const file = createRecoveryFile()
      try {
        const parsed = parseRecoveryFile(file)
        parsed.key.fill(0)
        const saved = await save(file, parsed.backupId, () => account.assertCurrent())
        account.assertCurrent()
        if (!saved) return null
        const context = { identity: identity.fingerprint, revision }
        const ciphertext = await store.sealBackup(file, context)
        account.assertCurrent()
        return { accountId: account.userId, backupId: parsed.backupId, ...context, ciphertext }
      } finally {
        file.fill(0)
      }
    })
  }

  private async serial<T>(binding: string, work: () => Promise<T>): Promise<T> {
    const previous = this.accountOperations.get(binding)
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    this.accountOperations.set(binding, pending)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.accountOperations.get(binding) === pending) this.accountOperations.delete(binding)
    }
  }

  /** Verifies a reselected secret against the existing local identity, without
   * installing keys or asserting that the supplied ciphertext came from the cloud. */
  async verifyRecoveryBackup(
    revision: number,
    ciphertext: Uint8Array,
    select: (assertCurrent: () => void) => Promise<Uint8Array | null>
  ) {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('invalid-recovery-revision')
    if (!(ciphertext instanceof Uint8Array) || ciphertext.length === 0 || ciphertext.length > 2346)
      throw new Error('invalid-recovery-backup')
    const frame = new Uint8Array(ciphertext)
    return this.withStore(async (store, account) => {
      const identity = await store.load()
      account.assertCurrent()
      const file = await select(() => account.assertCurrent())
      try {
        account.assertCurrent()
        if (file === null) return null
        const parsed = parseRecoveryFile(file)
        parsed.key.fill(0)
        const context = { identity: identity.fingerprint, revision }
        const material = openRecoveryBackup(file, context, frame)
        try {
          await restoreUserIdentity(material, identity.fingerprint)
          account.assertCurrent()
          return { backupId: parsed.backupId, ...context }
        } finally {
          material.fill(0)
        }
      } finally {
        file?.fill(0)
      }
    })
  }

  private async withStore<T>(
    work: (store: SqliteUserIdentityStore, account: DeviceAccountLease) => Promise<T>
  ) {
    if (!this.options.enabled) throw new Error('e2ee-user-unavailable')
    const account = await this.options.account()
    if (
      typeof account.userId !== 'string' ||
      account.userId.length === 0 ||
      account.userId.length > 256
    )
      throw new Error('e2ee-account-required')
    const binding = createHash('sha256')
      .update(JSON.stringify(['lody-user-account/v1', this.options.authOrigin, account.userId]))
      .digest('hex')
    return this.serial(binding, async () => {
      account.assertCurrent()
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
      account.assertCurrent()
      const store = new SqliteUserIdentityStore(
        join(this.options.directory, `${binding}.sqlite`),
        binding,
        this.options.protection
      )
      return await work(store, account)
    })
  }

  private async access(create: boolean) {
    return this.withStore(async (store, account) => {
      const identity = await (create ? store.create() : store.load())
      const signingPublicKey = Buffer.from(
        await crypto.subtle.exportKey('raw', identity.signing.publicKey)
      ).toString('hex')
      const encryptionPublicKey = Buffer.from(
        await crypto.subtle.exportKey('raw', identity.encryption.publicKey)
      ).toString('hex')
      account.assertCurrent()
      return { fingerprint: identity.fingerprint, signingPublicKey, encryptionPublicKey }
    })
  }
}

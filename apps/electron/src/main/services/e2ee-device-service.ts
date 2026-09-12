import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SqliteDeviceIdentityStore,
  type LocalDeviceProtection
} from '@lody/e2ee-core/node-device-store'

export interface DeviceAccountLease {
  readonly userId: string
  assertCurrent(): void
}

/** Main-owned account and paths only. No signing/decryption or private-key IPC. */
export class E2eeDeviceService {
  private readonly accountOperations = new Map<string, Promise<void>>()
  constructor(
    private readonly options: {
      enabled: boolean
      directory: string
      authOrigin: string
      account(): Promise<DeviceAccountLease>
      protection: LocalDeviceProtection
    }
  ) {}

  create() {
    return this.access(true)
  }
  load() {
    return this.access(false)
  }

  initialize() {
    return this.access('initialize')
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

  private async access(create: boolean | 'initialize') {
    if (!this.options.enabled) throw new Error('e2ee-device-unavailable')
    const account = await this.options.account()
    if (
      typeof account.userId !== 'string' ||
      account.userId.length === 0 ||
      account.userId.length > 256
    )
      throw new Error('e2ee-account-required')
    const binding = createHash('sha256')
      .update(JSON.stringify(['lody-device-account/v1', this.options.authOrigin, account.userId]))
      .digest('hex')
    return this.serial(binding, async () => {
      account.assertCurrent()
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
      account.assertCurrent()
      const store = new SqliteDeviceIdentityStore(
        join(this.options.directory, `${binding}.sqlite`),
        binding,
        this.options.protection
      )
      const identity = await (create === 'initialize'
        ? store.load().catch(async (error: unknown) => {
            if (!(error instanceof Error) || error.message !== 'device-identity-missing')
              throw error
            account.assertCurrent()
            try {
              return await store.create()
            } catch (createError) {
              // Another window may have created it after our read. Never overwrite it.
              if (
                !(createError instanceof Error) ||
                createError.message !== 'device-identity-exists'
              )
                throw createError
              return await store.load()
            }
          })
        : create
          ? store.create()
          : store.load())
      const signingPublicKey = Buffer.from(
        await crypto.subtle.exportKey('raw', identity.signing.publicKey)
      ).toString('hex')
      const encryptionPublicKey = Buffer.from(
        await crypto.subtle.exportKey('raw', identity.encryption.publicKey)
      ).toString('hex')
      account.assertCurrent()
      return { deviceId: identity.id, signingPublicKey, encryptionPublicKey }
    })
  }
}

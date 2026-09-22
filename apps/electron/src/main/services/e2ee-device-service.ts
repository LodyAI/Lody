import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { DeviceIdentityStore, StorageError } from '@lody/e2ee-core/effect'
import { nodeDeviceIdentityLayer } from '@lody/e2ee-core/effect/platform-node'
import type { LocalDeviceProtection } from '@lody/e2ee-core/node-device-store'

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
      const layer = nodeDeviceIdentityLayer({
        path: join(this.options.directory, `${binding}.sqlite`),
        binding,
        protection: this.options.protection
      })
      const identity = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* DeviceIdentityStore
          if (create === 'initialize') {
            return yield* store.load.pipe(
              Effect.catchIf(
                (error): error is StorageError =>
                  error instanceof StorageError && error.reason === 'missing',
                () => {
                  account.assertCurrent()
                  return store.create.pipe(
                    Effect.catchIf(
                      (error): error is StorageError =>
                        error instanceof StorageError && error.reason === 'exists',
                      () => store.load
                    )
                  )
                }
              )
            )
          }
          return yield* (create ? store.create : store.load)
        }).pipe(Effect.provide(layer))
      )
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

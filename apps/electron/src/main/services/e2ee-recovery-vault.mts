import { RecoveryVaults } from '@lody/e2ee-core'
import { sqliteRecoveryVaultLocalStore } from '@lody/e2ee-core/adapters/node-sqlite'
import { RecoveryVaultLocalStore, RecoveryVaultStore } from '@lody/e2ee-core/services'
import { randomUUID } from 'node:crypto'
import { open, rename, rm, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Effect, Layer } from 'effect'

/** Default-off gate for the post-MVP recovery vault. Proposal: specs/e2ee/recovery-vault.md. */
export const RECOVERY_VAULT_ENV = 'LODY_E2EE_RECOVERY_VAULT'
export const recoveryVaultEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env[RECOVERY_VAULT_ENV] === 'on'

/** A canonical vault-v1 file is about 150 bytes; anything larger is not one. */
export const MAX_RECOVERY_FILE_BYTES = 4096

const publicCodes = new Set([
  'invalid-input',
  'exists',
  'authentication',
  'rollback',
  'storage',
  'missing',
  'random-unavailable'
])
/** Only stable, non-secret reason codes cross IPC; storage/backend detail stays in main. */
export function recoveryVaultFailure(error: unknown): Error {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (publicCodes.has(code)) return new Error(`e2ee_recovery_${code}`)
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    if (error._tag === 'BackendError') return new Error('e2ee_recovery_unavailable')
    if (error._tag === 'LocalStoreError') return new Error('e2ee_recovery_storage')
  }
  return new Error('e2ee_recovery_failed')
}

/**
 * Replace `path` atomically. The temporary is created exclusively at 0600 beside the
 * target, so the material is never readable at a target's older mode, and a failed
 * write leaves any existing file untouched. `write` is a seam for failure tests.
 */
export async function saveRecoveryFile(
  path: string,
  file: Uint8Array,
  options: { readonly write?: (handle: FileHandle, file: Uint8Array) => Promise<unknown> } = {}
) {
  const temporary = join(dirname(path), `.lody-recovery-${randomUUID()}.tmp`)
  const write = options.write ?? ((handle, bytes) => handle.writeFile(bytes))
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await write(handle, file)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

interface RecoveryVaultIo {
  /** Absolute account-scoped journal file; holds pins and intents, never secrets. */
  readonly journalPath: string
  /** Opaque ciphertext storage; login gates retrieval only. */
  readonly store: RecoveryVaultStore['Service']
}
const vaults = (io: RecoveryVaultIo) =>
  RecoveryVaults.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RecoveryVaultStore, io.store),
        Layer.effect(
          RecoveryVaultLocalStore,
          sqliteRecoveryVaultLocalStore({ path: io.journalPath, mode: 'create-or-open' })
        )
      )
    )
  )

/**
 * Create the account vault and prove the saved file reopens it. One account has
 * one vault, so an existing vault stops this before anything is written. `persist`
 * writes the file and returns the bytes actually read back from disk; it runs before
 * any upload, because a vault without a saved file would block every later attempt,
 * and the vault is reopened from those bytes, never from the in-memory copy. If the
 * upload then fails, the saved file opens nothing. Every file copy owned here is wiped.
 */
export const createAccountRecoveryVault = (
  io: RecoveryVaultIo & {
    readonly locator: string
    readonly exists: Effect.Effect<boolean, unknown>
    readonly persist: (file: Uint8Array) => Effect.Effect<Uint8Array, unknown>
  }
) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (yield* io.exists) return yield* Effect.fail({ code: 'exists' })
      const service = yield* RecoveryVaults
      let saved: Uint8Array = new Uint8Array()
      return yield* Effect.gen(function* () {
        const created = yield* service.create({
          locator: io.locator,
          persistFile: (file) =>
            io.persist(new Uint8Array(file)).pipe(
              Effect.flatMap((read) => {
                saved = read
                return read.length === file.length && read.every((byte, i) => byte === file[i])
                  ? Effect.void
                  : Effect.fail({ code: 'storage' })
              })
            )
        })
        created.recoveryFile.fill(0)
        const reopened = yield* service.open({ recoveryFile: new Uint8Array(saved) })
        if (reopened.vaultId !== created.vault.vaultId)
          return yield* Effect.fail({ code: 'authentication' })
        yield* reopened.readIndex()
        return { vaultId: reopened.vaultId }
      }).pipe(Effect.ensuring(Effect.sync(() => saved.fill(0))))
    }).pipe(Effect.provide(vaults(io)))
  )

/**
 * Open a vault from a user-supplied recovery file and authenticate its index.
 * This proves the file and the service ciphertext still unlock together; it does
 * not restore a workspace, confirm a trust anchor or admit a device.
 */
export const inspectRecoveryFile = (io: RecoveryVaultIo & { readonly file: Uint8Array }) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Uint8Array(io.file)),
    (file) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (file.length === 0 || file.length > MAX_RECOVERY_FILE_BYTES)
            return yield* Effect.fail({ code: 'invalid-input' })
          const vault = yield* (yield* RecoveryVaults).open({ recoveryFile: file })
          const index = yield* vault.readIndex()
          return {
            vaultId: vault.vaultId,
            workspaces: index.value.entries.filter((entry) => !entry.retired).length
          }
        }).pipe(Effect.provide(vaults(io)))
      ),
    (file) => Effect.sync(() => file.fill(0))
  )

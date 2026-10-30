import { RecoveryVaults } from '@lody/e2ee-core'
import { sqliteRecoveryVaultLocalStore } from '@lody/e2ee-core/adapters/node-sqlite'
import { RecoveryVaultLocalStore, RecoveryVaultStore } from '@lody/e2ee-core/services'
import { Effect, Layer } from 'effect'

/** Default-off gate for the post-MVP recovery vault. Proposal: specs/e2ee/recovery-vault.md. */
export const RECOVERY_VAULT_ENV = 'LODY_E2EE_RECOVERY_VAULT'
export const recoveryVaultEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env[RECOVERY_VAULT_ENV] === '1'

/** A canonical vault-v1 file is about 150 bytes; anything larger is not one. */
export const MAX_RECOVERY_FILE_BYTES = 4096

const publicCodes = new Set([
  'invalid-input',
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
 * Create the account vault and prove the saved file reopens it. `persist`
 * writes the file and returns the bytes actually read back from disk; the vault
 * is reopened from those bytes, never from the in-memory copy. If saving fails
 * after upload, the unreferenced vault ciphertext stays on the service but
 * nothing can open it. Every file copy owned here is wiped before returning.
 */
export const createAccountRecoveryVault = (
  io: RecoveryVaultIo & {
    readonly locator: string
    readonly persist: (file: Uint8Array) => Effect.Effect<Uint8Array, unknown>
  }
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* RecoveryVaults
      const created = yield* service.create({ locator: io.locator })
      return yield* Effect.acquireUseRelease(
        Effect.succeed(created.recoveryFile),
        (file) =>
          Effect.acquireUseRelease(
            io.persist(new Uint8Array(file)),
            (saved) =>
              Effect.gen(function* () {
                if (saved.length !== file.length || saved.some((byte, i) => byte !== file[i]))
                  return yield* Effect.fail({ code: 'storage' })
                const reopened = yield* service.open({ recoveryFile: new Uint8Array(saved) })
                if (reopened.vaultId !== created.vault.vaultId)
                  return yield* Effect.fail({ code: 'authentication' })
                yield* reopened.readIndex()
                return { vaultId: reopened.vaultId }
              }),
            (saved) => Effect.sync(() => saved.fill(0))
          ),
        (file) => Effect.sync(() => file.fill(0))
      )
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

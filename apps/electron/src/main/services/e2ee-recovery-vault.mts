import {
  Bytes,
  makeWorkspaceRecovery,
  RecoveryVaults,
  type EpochStagedGroup,
  type RecoveryVault,
  type WorkspaceRecoveryInput
} from '@lody/e2ee-core'
import {
  getCommittedEpochStagingKey,
  hashRecordBytes,
  parseRecoveryFile,
  type DeviceSigner
} from '@lody/e2ee-core/protocol'
import {
  listVaultWorkspaces,
  prepareVaultRestore,
  recoveryLedger,
  type RecoveryHistoryPage,
  type VaultRestoreAnchor,
  type VaultRestorePorts
} from '@lody/e2ee-client/recovery-restore'
import {
  abandonVaultReplacement,
  planVaultReplacement,
  recoveryFetchEnvelope,
  recoverySubmitOriginal,
  replaceAccountVault,
  type VaultReplacementWorkspace
} from '@lody/e2ee-client/vault-replacement'
import { sqliteRecoveryVaultLocalStore } from '@lody/e2ee-core/adapters/node-sqlite'
import { RecoveryVaultLocalStore, RecoveryVaultStore } from '@lody/e2ee-core/services'
import { randomUUID } from 'node:crypto'
import { open, rename, rm, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Effect, Exit, Layer, Result, type Scope } from 'effect'

/** Default-off gate for the post-MVP recovery vault. Proposal: specs/e2ee/recovery-vault.md. */
export const RECOVERY_VAULT_ENV = 'LODY_E2EE_RECOVERY_VAULT'
export const recoveryVaultEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env[RECOVERY_VAULT_ENV] === 'on'

/** A canonical vault-v1 file is about 150 bytes; anything larger is not one. */
export const MAX_RECOVERY_FILE_BYTES = 4096

const publicCodes = new Set([
  'invalid-input',
  'exists',
  'replacing',
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
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(RecoveryVaultStore, io.store),
        Layer.effect(
          RecoveryVaultLocalStore,
          sqliteRecoveryVaultLocalStore({ path: io.journalPath, mode: 'create-or-open' })
        )
      )
    )
  )

/** Save a new vault's file, then upload it. `beforeUpload` runs with the saved file. */
const createVaultWithSavedFile = (
  io: RecoveryVaultIo & {
    readonly locator: string
    readonly persist: (file: Uint8Array) => Effect.Effect<Uint8Array, unknown>
    readonly beforeUpload?: (file: Uint8Array) => Effect.Effect<void, unknown>
  }
) =>
  Effect.gen(function* () {
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
            }),
            Effect.flatMap(() => io.beforeUpload?.(saved) ?? Effect.void)
          )
      })
      created.recoveryFile.fill(0)
      const reopened = yield* service.open({ recoveryFile: new Uint8Array(saved) })
      if (reopened.vaultId !== created.vault.vaultId)
        return yield* Effect.fail({ code: 'authentication' })
      yield* reopened.readIndex()
      return { vaultId: reopened.vaultId }
    }).pipe(Effect.ensuring(Effect.sync(() => saved.fill(0))))
  })

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
      return yield* createVaultWithSavedFile(io)
    }).pipe(Effect.provide(vaults(io)))
  )

/** The service's replacement bookkeeping. It never decides trust. */
export interface RecoveryVaultReplacement {
  readonly state: () => Effect.Effect<
    { readonly current: string | null; readonly replacing: string | null },
    unknown
  >
  readonly reserve: (vaultId: string) => Effect.Effect<void, unknown>
  readonly finish: (oldVaultId: string, newVaultId: string) => Effect.Effect<void, unknown>
  readonly abandon: (vaultId: string) => Effect.Effect<void, unknown>
}

/**
 * Start a whole-vault replacement: save a new file, reserve its vault, then upload.
 * The service binds a vault at its first write, so the reservation comes first, and
 * the old vault stays current throughout.
 */
export const beginAccountVaultReplacement = (
  io: RecoveryVaultIo & {
    readonly locator: string
    readonly replacement: RecoveryVaultReplacement
    readonly persist: (file: Uint8Array) => Effect.Effect<Uint8Array, unknown>
  }
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* io.replacement.state()
      if (!state.current) return yield* Effect.fail({ code: 'missing' })
      if (state.replacing) return yield* Effect.fail({ code: 'replacing' })
      return yield* createVaultWithSavedFile({
        ...io,
        beforeUpload: (file) =>
          Effect.try({
            try: () => {
              const parsed = parseRecoveryFile(file)
              parsed.unlock.fill(0)
              return parsed.vaultId
            },
            catch: () => ({ code: 'invalid-input' })
          }).pipe(Effect.flatMap(io.replacement.reserve))
      })
    }).pipe(Effect.provide(vaults(io)))
  )

/** What a replacement would cover, and whether one is already running. */
export const recoveryReplacementPlan = (io: {
  readonly replacement: Pick<RecoveryVaultReplacement, 'state'>
  readonly accountWorkspaces: Effect.Effect<
    readonly { readonly id: string; readonly name: string }[],
    unknown
  >
  readonly hasIdentity: (workspaceId: string) => Effect.Effect<boolean, unknown>
}) =>
  Effect.gen(function* () {
    const state = yield* io.replacement.state()
    const workspaces = yield* io.accountWorkspaces
    return {
      replaceable: state.current !== null,
      replacing: state.replacing !== null,
      ...planVaultReplacement(
        workspaces,
        new Set(
          yield* Effect.filter(
            workspaces.map((row) => row.id),
            io.hasIdentity
          )
        )
      )
    }
  })

/** One workspace this device acts on: its service ports and the host's recovery owner. */
export interface RecoveryWorkspaceTarget {
  readonly id: string
  readonly name: string
  readonly append: (request: {
    readonly workspaceId: string
    readonly requestId: string
    readonly recordHex: string
    readonly credentialHash?: string
    readonly signerCredential?: string
  }) => Effect.Effect<{ readonly status: 'committed' | 'conflict' }, unknown>
  readonly refresh: () => Effect.Effect<void, unknown>
  readonly mailbox: Parameters<typeof recoveryFetchEnvelope>[0]['mailbox']
  readonly deliver: () => Effect.Effect<void, unknown>
  readonly staged?: Parameters<typeof recoveryFetchEnvelope>[0]['staged']
  readonly owner: (ports: {
    readonly vault: RecoveryVault
    readonly local: RecoveryVaultLocalStore['Service']
    readonly submitOriginal: WorkspaceRecoveryInput['submitOriginal']
    readonly fetchCurrentEnvelope: WorkspaceRecoveryInput['fetchCurrentEnvelope']
  }) => Effect.Effect<Omit<VaultReplacementWorkspace, 'name'>, unknown, Scope.Scope>
  readonly abandonOwner: (ports: {
    readonly vaultId: string
    readonly local: RecoveryVaultLocalStore['Service']
    readonly submitOriginal: WorkspaceRecoveryInput['submitOriginal']
  }) => Effect.Effect<
    {
      readonly revokeOwnRecoveryDevice: () => Effect.Effect<{ readonly outcome: string }, unknown>
    },
    unknown,
    Scope.Scope
  >
}

const submitFor = (target: RecoveryWorkspaceTarget) =>
  recoverySubmitOriginal({
    append: (request) => target.append({ workspaceId: target.id, ...request }),
    refresh: target.refresh
  })

/**
 * Finish a replacement from its new file: each workspace passes a real envelope test,
 * then old Rs are revoked, then the new vault becomes current. Rerunning resumes.
 */
export const continueAccountVaultReplacement = (
  io: RecoveryVaultIo & {
    readonly file: Uint8Array
    readonly compromised: boolean
    readonly replacement: RecoveryVaultReplacement
    readonly workspaces: readonly RecoveryWorkspaceTarget[]
  }
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { current, replacing } = yield* io.replacement.state()
      if (!current || !replacing) return yield* Effect.fail({ code: 'missing' })
      const vault = yield* (yield* RecoveryVaults).open({ recoveryFile: new Uint8Array(io.file) })
      if (vault.vaultId !== replacing) return yield* Effect.fail({ code: 'authentication' })
      const local = yield* RecoveryVaultLocalStore
      const workspaces: VaultReplacementWorkspace[] = []
      for (const target of io.workspaces)
        workspaces.push({
          name: target.name,
          ...(yield* target.owner({
            vault,
            local,
            submitOriginal: submitFor(target),
            fetchCurrentEnvelope: recoveryFetchEnvelope(target)
          }))
        })
      return yield* replaceAccountVault({
        workspaces,
        compromised: io.compromised,
        finish: () => io.replacement.finish(current, replacing)
      })
    }).pipe(Effect.provide(vaults(io)))
  )

/**
 * Give up an unfinished replacement. This works without the new file: each workspace's
 * journal names the new R, which is revoked before the vault retires.
 */
export const abandonAccountVaultReplacement = (
  io: RecoveryVaultIo & {
    readonly replacement: RecoveryVaultReplacement
    readonly workspaces: readonly RecoveryWorkspaceTarget[]
  }
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { replacing } = yield* io.replacement.state()
      if (!replacing) return { outcome: 'None' as const }
      const local = yield* RecoveryVaultLocalStore
      const workspaces: {
        readonly name: string
        readonly revokeOwnRecoveryDevice: () => Effect.Effect<{ readonly outcome: string }, unknown>
      }[] = []
      for (const target of io.workspaces)
        workspaces.push({
          name: target.name,
          ...(yield* target.abandonOwner({
            vaultId: replacing,
            local,
            submitOriginal: submitFor(target)
          }))
        })
      return yield* abandonVaultReplacement({
        workspaces,
        abandon: () => io.replacement.abandon(replacing)
      })
    }).pipe(Effect.provide(vaults(io)))
  )

/** Set up recovery for one workspace from the account's recovery file. */
export const setupWorkspaceRecovery = (
  io: RecoveryVaultIo & {
    readonly file: Uint8Array
    readonly replacement: Pick<RecoveryVaultReplacement, 'state'>
    readonly target: RecoveryWorkspaceTarget
  }
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const vault = yield* (yield* RecoveryVaults).open({ recoveryFile: new Uint8Array(io.file) })
      const { current } = yield* io.replacement.state()
      if (vault.vaultId !== current) return yield* Effect.fail({ code: 'authentication' })
      const owner = yield* io.target.owner({
        vault,
        local: yield* RecoveryVaultLocalStore,
        submitOriginal: submitFor(io.target),
        fetchCurrentEnvelope: recoveryFetchEnvelope(io.target)
      })
      const result = yield* owner.setup()
      return { outcome: result.outcome, recoverable: result.status.recoverable }
    }).pipe(Effect.provide(vaults(io)))
  )

/** Hold epoch keys read through R only until the new device installs them. */
export const memoryEpochKeys = () => {
  const keys = new Map<number, Bytes.EpochKey>()
  return {
    entries: () => [...keys.entries()],
    saveAndReload: (epoch: number, key: Bytes.EpochKey) =>
      Effect.sync(() => {
        keys.set(epoch, key)
      }),
    read: (epoch: number) => {
      const key = keys.get(epoch)
      return key ? Effect.succeed(key) : Effect.fail({ code: 'missing' })
    }
  }
}

/** One workspace a recovery file can restore onto this device. */
export interface RecoveryRestoreTarget {
  readonly id: string
  readonly name: string
  readonly genesisHash: string
  /** Connect only once the authenticated package names the workspace. */
  readonly connect: (anchor: VaultRestoreAnchor) => Effect.Effect<
    VaultRestorePorts & {
      readonly personal: VaultRestorePorts['personalSigner'] & {
        readonly encryptionPublicKey: Bytes.EncryptionPublicKey
      }
      readonly adopt: (
        recovered: readonly (readonly [number, Bytes.EpochKey])[]
      ) => Effect.Effect<void, unknown>
      readonly recovered: () => readonly (readonly [number, Bytes.EpochKey])[]
    },
    unknown,
    Scope.Scope
  >
}

/** A complete history read, for replay from the package's genesis. */
const readAllHistory = <P extends RecoveryHistoryPage>(
  history: (cursor?: string) => Effect.Effect<P, unknown>
) =>
  Effect.gen(function* () {
    const pages: P[] = []
    let cursor: string | undefined
    for (let page = 0; page < 256; page++) {
      const next = yield* history(cursor)
      pages.push(next)
      if (!next.nextCursor) return pages
      cursor = next.nextCursor
    }
    return yield* Effect.fail({ code: 'storage' })
  })

/** Build a restore target from the service and this device's identity store. */
export const recoveryRestoreTarget = <P extends RecoveryHistoryPage>(input: {
  readonly id: string
  readonly name: string
  readonly genesisHash: string
  readonly append: RecoveryWorkspaceTarget['append']
  readonly history: (cursor?: string) => Effect.Effect<P, unknown>
  readonly mailbox: RecoveryWorkspaceTarget['mailbox']
  readonly stagedGroup: (
    credential: string,
    key: Result.Result.Success<ReturnType<typeof getCommittedEpochStagingKey>>
  ) => Effect.Effect<EpochStagedGroup | null, unknown>
  readonly identity: (pin: {
    readonly genesisHash: string
    readonly genesisRecordHex: string
    readonly membershipId: string
  }) => Effect.Effect<
    {
      readonly device: DeviceSigner & { readonly enc: Bytes.EncryptionPublicKey }
      readonly credentialHash: string
    },
    unknown
  >
  readonly adopt: (join: {
    readonly genesisRecordHex: string
    readonly membershipId: string
    readonly endorser: string
    readonly pairingSessionId: string
    readonly pages: readonly P[]
    readonly recovered: readonly (readonly [number, Bytes.EpochKey])[]
  }) => Effect.Effect<void, unknown>
}): RecoveryRestoreTarget => ({
  id: input.id,
  name: input.name,
  genesisHash: input.genesisHash,
  connect: (anchor) =>
    Effect.gen(function* () {
      const hexOf = (value: Uint8Array) => Buffer.from(value).toString('hex')
      const genesisRecordHex = hexOf(anchor.genesisRecord)
      const membershipId = hexOf(anchor.membershipId.toBytes())
      const { device, credentialHash } = yield* input.identity({
        genesisHash: input.genesisHash,
        genesisRecordHex,
        membershipId
      })
      const keys = memoryEpochKeys()
      const ledger = recoveryLedger({
        genesis: anchor.genesis,
        pages: () => readAllHistory(input.history)
      })
      let admission = ''
      return {
        personalSigner: device,
        personal: { ...device, encryptionPublicKey: device.enc },
        ledger,
        installed: keys,
        fetchCurrentEnvelope: recoveryFetchEnvelope({
          mailbox: input.mailbox,
          // No device of this user is left to deliver; R's own envelope must already exist.
          deliver: () => Effect.void,
          staged: (credential, epoch) =>
            Effect.flatMap(ledger(), (view) => {
              const key = getCommittedEpochStagingKey(view, epoch)
              return Result.isSuccess(key)
                ? input.stagedGroup(credential, key.success)
                : Effect.succeed(null)
            })
        }),
        submitOriginalAsRecovery: (record, _identity, credential) =>
          Effect.gen(function* () {
            admission = hexOf(hashRecordBytes(record).toBytes())
            const reply = yield* input.append({
              workspaceId: input.id,
              requestId: admission,
              recordHex: hexOf(record),
              credentialHash,
              signerCredential: hexOf(credential)
            })
            credential.fill(0)
            return {
              outcome: reply.status === 'committed' ? 'Committed' : 'Conflict',
              record: new Uint8Array(record)
            } as const
          }),
        acquirePersonal: () => Effect.fail({ code: 'invalid-input' }),
        recovered: keys.entries,
        adopt: (recovered) =>
          Effect.flatMap(readAllHistory(input.history), (pages) =>
            input.adopt({
              genesisRecordHex,
              membershipId,
              endorser: hexOf(anchor.recovery.toBytes()),
              pairingSessionId: admission.slice(0, 32),
              pages,
              recovered
            })
          )
      }
    })
})

/**
 * Restore every workspace the file covers and this account can name. The genesis comes
 * only from the authenticated package; ledger, checkpoint and key commitment are core's
 * checks. One workspace's failure never stops the others.
 */
export const restoreAccountWorkspaces = (
  io: RecoveryVaultIo & {
    readonly file: Uint8Array
    readonly workspaces: readonly RecoveryRestoreTarget[]
  }
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const vault = yield* (yield* RecoveryVaults).open({ recoveryFile: new Uint8Array(io.file) })
      const local = yield* RecoveryVaultLocalStore
      const results: { readonly name: string; readonly outcome: string }[] = []
      for (const reference of yield* listVaultWorkspaces(vault)) {
        const target = io.workspaces.find((row) => row.genesisHash === reference.genesis)
        if (!target) continue
        const attempt = Effect.scoped(
          Effect.gen(function* () {
            let connected: Effect.Success<ReturnType<RecoveryRestoreTarget['connect']>> | undefined
            const plan = yield* prepareVaultRestore({
              vault,
              local,
              reference,
              ports: (anchor) =>
                target.connect(anchor).pipe(
                  Effect.tap((ports) =>
                    Effect.sync(() => {
                      connected = ports
                    })
                  )
                )
            })
            const workflow = yield* makeWorkspaceRecovery(plan.workflow)
            const result = yield* workflow.restoreFromRecovery({
              personal: connected!.personal,
              submitOriginalAsRecovery: plan.submitOriginalAsRecovery
            })
            if (result.outcome === 'Committed') yield* connected!.adopt(connected!.recovered())
            return result.outcome as string
          })
        )
        const exit = yield* Effect.exit(attempt)
        results.push({
          name: target.name,
          outcome: Exit.isSuccess(exit) ? exit.value : 'Failed'
        })
      }
      return results
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

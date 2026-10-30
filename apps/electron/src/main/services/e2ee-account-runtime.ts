import { z } from 'zod'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { rename, lstat, writeFile } from 'node:fs/promises'
import {
  archiveE2eeIdentity,
  leaseE2eeIdentity,
  completedE2eeIdentityReset
} from '@lody/shared/node/e2ee-identity'
import { app } from 'electron'
import { Effect, Exit, Scope, Semaphore, Deferred } from 'effect'
import { makeElectronE2eeCustody } from '../e2ee-custody-electron'
import { makeDesktopE2eeBootstrap, type DesktopE2eeCreationIntent } from './e2ee-bootstrap.mjs'
import type { E2eeCloudClient } from './e2ee-cloud-client.mjs'
import type { makeDesktopE2eeRuntimeHost } from './e2ee-runtime.mjs'
import { getIpcServiceDeps } from '../ipc/ipc-service-deps'

// Lazy application boundary. Plain workspaces never create a Scope or touch custody.
const serial = Semaphore.makeUnsafe(1)
const accountFailure = (code: string) =>
  Object.assign(
    new Error(
      code === 'restart-required'
        ? 'e2ee_restart-required: Restart Lody to finish releasing encrypted resources.'
        : `e2ee_${code}`
    ),
    { code }
  )
type Account = {
  accountId: string
  directory: string
  scope: Scope.Closeable
  bootstrap: Effect.Success<ReturnType<typeof makeDesktopE2eeBootstrap>>
  host: Effect.Success<ReturnType<typeof makeDesktopE2eeRuntimeHost>>
  cloud?: E2eeCloudClient
  closeFailed?: boolean
  readers: Map<string, Map<number, number>>
}
const CreationReceipt = z
  .object({
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    genesisHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
const owners = new Map<string, Account>()
const removing = new Map<string, Deferred.Deferred<boolean, unknown>>()
const accountDirectory = (accountId: string) =>
  join(
    app.getPath('userData'),
    'e2ee-bootstrap',
    createHash('sha256').update(accountId).digest('hex')
  )
type IdentityLocation = string | { requestId: string }
function identityDirectory(accountId: string, location?: IdentityLocation) {
  const root = accountDirectory(accountId)
  if (typeof location === 'string') {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(location)) throw accountFailure('invalid-input')
    return join(root, 'identities', location)
  }
  if (location) {
    if (!location.requestId || location.requestId.length > 256)
      throw accountFailure('invalid-input')
    const pending = join(
      root,
      'pending',
      createHash('sha256').update(location.requestId).digest('hex')
    )
    try {
      const receipt = CreationReceipt.parse(
        JSON.parse(readFileSync(`${pending}.workspace.json`, 'utf8'))
      )
      if (
        typeof receipt.workspaceId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.workspaceId)
      )
        throw accountFailure('corrupt')
      const target = join(root, 'identities', receipt.workspaceId)
      if (!existsSync(target) && !existsSync(pending)) throw accountFailure('identity-lost')
      return existsSync(target) ? target : pending
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return pending
  }
  return join(root, 'control')
}
let quitting = false
let observingIdentity = false
function observeIdentity() {
  if (observingIdentity) return
  const auth = getIpcServiceDeps().authService
  if (typeof auth.subscribeCachedSessionIdentity !== 'function') return
  observingIdentity = true
  auth.subscribeCachedSessionIdentity(() => {
    const captured = [...owners.values()]
    if (captured.every((owner) => auth.getCachedSessionIdentity().userId === owner.accountId))
      return
    // The synchronous identity check fences new calls immediately. Resource
    // release queues behind admitted native work, without awaiting auth I/O.
    void Effect.runPromise(
      Effect.uninterruptible(
        serial.withPermit(
          Effect.suspend(() =>
            Effect.forEach(
              captured.filter((owner) => owners.get(owner.directory) === owner),
              (owner) => Effect.exit(closeOwner(owner))
            ).pipe(
              Effect.flatMap((results) =>
                results.some(Exit.isFailure)
                  ? Effect.fail(accountFailure('cleanup_failed'))
                  : Effect.void
              )
            )
          )
        )
      )
    ).catch(() => {
      console.warn('[E2EE] Account cleanup pending', { code: 'e2ee_cleanup_failed' })
    })
  })
}
const closeOwner = Effect.fnUntraced(function* (owner: Account) {
  // Scope.close cannot retry a failed one-shot finalizer. Retain this owner's fence.
  if (owner.closeFailed) return yield* Effect.fail(accountFailure('restart-required'))
  const closed = yield* Effect.exit(Scope.close(owner.scope, Exit.void))
  if (Exit.isFailure(closed)) {
    owner.closeFailed = true
    return yield* Effect.fail(accountFailure('restart-required'))
  }
  owners.delete(owner.directory)
  return undefined
})
const closeCurrent = Effect.gen(function* () {
  const results = yield* Effect.forEach([...owners.values()], (owner) =>
    Effect.exit(closeOwner(owner))
  )
  if (results.some(Exit.isFailure)) return yield* Effect.fail(accountFailure('restart-required'))
  return undefined
})

/** Entry boundary; account and resources remain locked until the native operation settles. */
export function withDesktopE2eeAccount<A>(
  work: (owner: Account) => Effect.Effect<A, unknown>,
  location?: IdentityLocation,
  create = true
): Promise<A> {
  observeIdentity()
  return Effect.runPromise(
    Effect.uninterruptible(
      serial.withPermit(
        Effect.gen(function* () {
          if (quitting) return yield* Effect.fail(accountFailure('closed'))
          // Resolve trusted identity synchronously: no network can hold this resource lock.
          const auth = getIpcServiceDeps().authService
          const identity = auth.getCachedSessionIdentity()
          if (!identity.userId) {
            yield* closeCurrent
            return yield* Effect.fail(accountFailure('account_unavailable'))
          }
          if ([...owners.values()].some((owner) => owner.accountId !== identity.userId))
            yield* closeCurrent
          const accountId = identity.userId
          const directory = identityDirectory(accountId, location)
          if (removing.has(directory)) return yield* Effect.fail(accountFailure('member_removed'))
          if (!create)
            yield* Effect.tryPromise({
              try: () => lstat(directory),
              catch: (error) =>
                accountFailure(
                  (error as NodeJS.ErrnoException).code === 'ENOENT'
                    ? 'missing-binding'
                    : 'permissions'
                )
            })
          let current = owners.get(directory)
          if (!current) {
            const scope = yield* Scope.make()
            const opened = yield* Effect.exit(
              Effect.gen(function* () {
                yield* leaseE2eeIdentity(accountDirectory(accountId))
                yield* leaseE2eeIdentity(directory)
                const custody = yield* makeElectronE2eeCustody(join(directory, 'custody')).pipe(
                  Effect.mapError((error) =>
                    error.code === 'unavailable' || error.code === 'basic-text'
                      ? accountFailure('custody_unavailable')
                      : error
                  )
                )
                const bootstrap = yield* makeDesktopE2eeBootstrap({ directory, accountId, custody })
                const runtime = yield* Effect.promise(() => import('./e2ee-runtime.mjs'))
                const host = yield* runtime.makeDesktopE2eeRuntimeHost({
                  directory,
                  custody,
                  bootstrap
                })
                return {
                  accountId,
                  directory,
                  scope,
                  bootstrap,
                  host,
                  readers: new Map<string, Map<number, number>>()
                }
              }).pipe(Scope.provide(scope))
            )
            if (Exit.isFailure(opened)) {
              yield* Scope.close(scope, Exit.void)
              return yield* Effect.failCause(opened.cause)
            }
            current = opened.value
            owners.set(directory, current)
          }
          // Native open may yield while auth changes. Never hand the old account to work.
          const latest = auth.getCachedSessionIdentity()
          if (latest.userId !== identity.userId || latest.generation !== identity.generation) {
            yield* closeCurrent
            return yield* Effect.fail(accountFailure('account_unavailable'))
          }
          if (current.closeFailed) return yield* Effect.fail(accountFailure('restart-required'))
          return yield* work(current)
        })
      )
    )
  ).catch((error: unknown) => {
    throw publicE2eeFailure(error)
  })
}

/** Passive metadata only: never acquire a lease or construct an absent owner. */
export function inspectDesktopE2eeCachedState(
  accountId: string,
  workspaceId: string,
  machineId: string
) {
  return Effect.runPromise(
    serial.withPermit(
      Effect.gen(function* () {
        if (quitting) return yield* Effect.fail(accountFailure('closed'))
        const auth = getIpcServiceDeps().authService
        const identity = auth.getCachedSessionIdentity()
        if (!identity.userId || identity.userId !== accountId)
          return yield* Effect.fail(accountFailure('account_mismatch'))
        const owner = owners.get(identityDirectory(accountId, workspaceId))
        if (owner?.closeFailed) return yield* Effect.fail(accountFailure('restart-required'))
        const state = owner
          ? yield* owner.host.inspectCachedState(workspaceId, machineId)
          : {
              workspaceId,
              machineId,
              entryPresent: false,
              cachedPolicies: 0,
              cachedExecutionGrants: 0
            }
        const latest = auth.getCachedSessionIdentity()
        if (latest.userId !== accountId || latest.generation !== identity.generation)
          return yield* Effect.fail(accountFailure('account_mismatch'))
        return {
          ...state,
          accountId,
          ownerPresent: Boolean(owner),
          activeContentReaders: [...(owner?.readers.get(workspaceId)?.values() ?? [])].reduce(
            (sum, count) => sum + count,
            0
          )
        }
      })
    )
  ).catch((error: unknown) => {
    throw publicE2eeFailure(error)
  })
}

/** Quit/logout await actual in-flight native operations before releasing stores. */
export function closeDesktopE2eeAccount(options?: {
  quit?: boolean
  signOut?: () => Promise<void>
}): Promise<void> {
  if (options?.quit) quitting = true
  return Effect.runPromise(
    Effect.uninterruptible(
      serial.withPermit(
        Effect.gen(function* () {
          const closed = yield* Effect.exit(closeCurrent)
          if (options?.signOut) {
            if (Exit.isFailure(closed))
              console.warn('[E2EE] Account cleanup failed', { code: 'e2ee_cleanup_failed' })
            yield* Effect.tryPromise({
              try: options.signOut,
              catch: () => new Error('e2ee_signout_failed')
            })
          } else if (Exit.isFailure(closed)) {
            return yield* Effect.fail(accountFailure('restart-required'))
          }
          return undefined
        })
      )
    )
  )
}

/** A destroyed renderer cannot retain a workspace or submit further requests. */
export function releaseDesktopE2eeReader(senderId: number): void {
  const detach = serial.withPermit(
    Effect.gen(function* () {
      const cleanup: Effect.Effect<void, unknown>[] = []
      for (const current of owners.values()) {
        for (const [workspaceId, readers] of current.readers) {
          readers.delete(senderId)
          if (readers.size === 0) {
            cleanup.push(yield* current.host.beginCloseWorkspace(workspaceId))
            current.readers.delete(workspaceId)
          }
        }
      }
      return cleanup
    })
  )
  void Effect.runPromise(
    Effect.uninterruptible(
      Effect.flatMap(detach, (cleanup) =>
        Effect.forEach(cleanup, (work) => Effect.exit(work), { concurrency: 'unbounded' }).pipe(
          Effect.tap((results) =>
            Effect.sync(() => {
              if (results.some(Exit.isFailure))
                console.warn('[E2EE] Reader cleanup pending', { code: 'e2ee_cleanup_failed' })
            })
          )
        )
      )
    )
  ).catch(() => {
    console.warn('[E2EE] Reader cleanup pending', { code: 'e2ee_cleanup_failed' })
  })
}

/** The quit barrier can leave the application open; failed owners stay fenced. */
export function resumeDesktopE2eeAccount(): void {
  quitting = false
}

/** Acquire the narrow account client locally, then release the native lock
 * before auth refresh, HTTP or mailbox work starts. Logout owns its Scope. */
export async function desktopE2eeCloudClient(): Promise<{
  accountId: string
  client: E2eeCloudClient
}> {
  return withDesktopE2eeAccount((owner) =>
    Effect.gen(function* () {
      if (!owner.cloud) {
        const { makeE2eeCloudClient } = yield* Effect.promise(
          () => import('./e2ee-cloud-client.mjs')
        )
        owner.cloud = yield* makeE2eeCloudClient({
          platformKind: 'cloud',
          deploymentUrl: import.meta.env.VITE_CONVEX_DEPLOY_URL ?? '',
          convexToken: () => getIpcServiceDeps().authService.convexToken()
        }).pipe(Scope.provide(owner.scope))
      }
      return { accountId: owner.accountId, client: owner.cloud }
    })
  )
}

/** New signatures need the account-global public ID; old originals and existing
 * workspaces remain local. No network work is admitted under the account lock. */
export async function prepareDesktopE2eeCreation(input: DesktopE2eeCreationIntent) {
  const auth = getIpcServiceDeps().authService
  const identity = auth.getCachedSessionIdentity()
  const needsIdentity = await withDesktopE2eeAccount(
    (owner) =>
      Effect.gen(function* () {
        if (owner.accountId !== input.accountId)
          return yield* Effect.fail(new Error('e2ee_account_mismatch'))
        const receiptPath =
          join(
            accountDirectory(input.accountId),
            'pending',
            createHash('sha256').update(input.requestId).digest('hex')
          ) + '.workspace.json'
        let published: { workspaceId: string; genesisHash: string } | undefined
        try {
          published = CreationReceipt.parse(JSON.parse(readFileSync(receiptPath, 'utf8')))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            return yield* Effect.fail(accountFailure('corrupt'))
        }
        if (published) {
          const receipt = published
          const origin = yield* owner.bootstrap
            .creationFor(receipt.workspaceId)
            .pipe(Effect.mapError(() => accountFailure('identity-lost')))
          if (origin.genesisHash !== receipt.genesisHash)
            return yield* Effect.fail(accountFailure('identity-lost'))
        }
        return yield* owner.bootstrap.creationNeedsAccountIdentity(input)
      }),
    { requestId: input.requestId }
  )
  if (needsIdentity) {
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== input.accountId) throw new Error('e2ee_account_mismatch')
    const registered = await Effect.runPromise(cloud.client.accountIdentity())
    await withDesktopE2eeAccount(
      (owner) => {
        const latest = auth.getCachedSessionIdentity()
        return owner.accountId === input.accountId &&
          registered.accountId === input.accountId &&
          latest.userId === identity.userId &&
          latest.generation === identity.generation
          ? owner.bootstrap.recordAccountIdentity(registered)
          : Effect.fail(new Error('e2ee_account_mismatch'))
      },
      { requestId: input.requestId }
    )
  }
  return withDesktopE2eeAccount(
    (owner) => {
      const latest = auth.getCachedSessionIdentity()
      return owner.accountId === input.accountId &&
        latest.userId === identity.userId &&
        latest.generation === identity.generation
        ? owner.bootstrap.prepareCreation(input)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    },
    { requestId: input.requestId }
  )
}

/** Archive one isolated workspace, or all local encrypted identities for the
 * current account. Neither operation needs to decrypt the broken KEK. */
export function resetDesktopE2eeIdentity(input: { workspaceId?: string; resetId: string }) {
  const auth = getIpcServiceDeps().authService
  const { userId: accountId, generation } = auth.getCachedSessionIdentity()
  const { workspaceId, resetId } = input
  const checkConfirmation = Effect.sync(() => {
    const current = auth.getCachedSessionIdentity()
    if (!accountId || current.userId !== accountId || current.generation !== generation)
      throw accountFailure('account_unavailable')
  })
  return Effect.runPromise(
    Effect.uninterruptible(
      serial.withPermit(
        Effect.scoped(
          Effect.gen(function* () {
            if (quitting) return yield* Effect.fail(accountFailure('closed'))
            yield* checkConfirmation
            if (!accountId) return yield* Effect.fail(accountFailure('account_unavailable'))
            const directory = workspaceId
              ? identityDirectory(accountId, workspaceId)
              : accountDirectory(accountId)
            const receipts = join(
              app.getPath('userData'),
              'e2ee-reset-receipts',
              createHash('sha256').update(accountId).digest('hex')
            )
            const previous = yield* completedE2eeIdentityReset(directory, resetId, receipts)
            yield* checkConfirmation
            if (previous) return previous
            if (workspaceId) {
              const owner = owners.get(directory)
              if (owner) yield* closeOwner(owner)
            } else yield* closeCurrent
            yield* checkConfirmation
            if (workspaceId) yield* leaseE2eeIdentity(accountDirectory(accountId))
            yield* leaseE2eeIdentity(directory, true)
            yield* checkConfirmation
            return {
              archive: yield* archiveE2eeIdentity(directory, Date.now(), resetId, receipts)
            }
          })
        )
      )
    )
  ).catch((error) => {
    throw publicE2eeFailure(error)
  })
}

/** Terminal receipt comes only from credential-authenticated removal. Close the
 * isolated workspace owner, then take the existing exclusive identity lease;
 * another process or a failed release cannot be bypassed by automatic deletion. */
export function cleanupRemovedDesktopWorkspace(input: {
  accountId: string
  workspaceId: string
}): Promise<boolean> {
  const { workspaceId } = input
  return Effect.runPromise(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const plan = yield* serial.withPermit(
          Effect.gen(function* () {
            const accountId = getIpcServiceDeps().authService.getCachedSessionIdentity().userId
            if (!accountId || accountId !== input.accountId)
              return yield* Effect.fail(accountFailure('account_unavailable'))
            const directory = identityDirectory(accountId, workspaceId)
            const pending = removing.get(directory)
            if (pending) return { kind: 'pending' as const, directory, pending }
            const owner = owners.get(directory)
            if (owner) {
              if (!(yield* owner.bootstrap.hasRemovedWorkspace(workspaceId))) return null
            } else {
              const exists = yield* Effect.tryPromise({
                try: async () => {
                  try {
                    await lstat(directory)
                    return true
                  } catch (cause) {
                    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
                    throw cause
                  }
                },
                catch: () => accountFailure('storage')
              })
              if (!exists) return null
            }
            const done = Deferred.makeUnsafe<boolean, unknown>()
            removing.set(directory, done)
            return { kind: 'owner' as const, directory, owner, done }
          })
        )
        if (!plan) return false
        if (plan.kind === 'pending') return yield* Deferred.await(plan.pending)
        const result = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              // Only this directory is fenced; release/deletion never holds the global account lock.
              if (plan.owner) yield* closeOwner(plan.owner)
              yield* leaseE2eeIdentity(accountDirectory(input.accountId))
              yield* leaseE2eeIdentity(plan.directory, true)
              if (
                getIpcServiceDeps().authService.getCachedSessionIdentity().userId !==
                input.accountId
              )
                return yield* Effect.fail(accountFailure('account_unavailable'))
              const custody = yield* makeElectronE2eeCustody(join(plan.directory, 'custody'))
              const bootstrap = yield* makeDesktopE2eeBootstrap({
                directory: plan.directory,
                accountId: input.accountId,
                custody
              })
              return yield* bootstrap.resumeRemovedWorkspace(workspaceId)
            })
          )
        )
        yield* serial.withPermit(
          Effect.gen(function* () {
            if (removing.get(plan.directory) === plan.done) removing.delete(plan.directory)
            yield* Deferred.done(plan.done, result)
          })
        )
        return yield* result
      })
    )
  ).catch((error) => {
    throw publicE2eeFailure(error)
  })
}

/** Move a complete pending creation to its workspace after durable server
 * publication. No key rewrap/copy or shared account custody is involved. */
export async function recordDesktopE2eeCreated(input: {
  workspaceId: string
  genesisHash: string
  requestId?: string
}) {
  const accountId = getIpcServiceDeps().authService.getCachedSessionIdentity().userId
  if (!accountId) throw accountFailure('account_unavailable')
  const target = identityDirectory(accountId, input.workspaceId)
  const exists = await lstat(target).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    }
  )
  if (!exists && !input.requestId) throw accountFailure('missing-binding')
  if (!exists && input.requestId) {
    await withDesktopE2eeAccount((owner) => owner.bootstrap.recordCreated(input), {
      requestId: input.requestId
    })
    await Effect.runPromise(
      Effect.uninterruptible(
        serial.withPermit(
          Effect.scoped(
            Effect.gen(function* () {
              if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== accountId)
                return yield* Effect.fail(accountFailure('account_unavailable'))
              const source = join(
                accountDirectory(accountId),
                'pending',
                createHash('sha256')
                  .update(input.requestId ?? '')
                  .digest('hex')
              )
              const owner = owners.get(source)
              if (owner) yield* closeOwner(owner)
              yield* leaseE2eeIdentity(source, true)
              yield* leaseE2eeIdentity(target, true)
              yield* Effect.tryPromise({
                try: async () => {
                  const receipt = `${source}.workspace.json`
                  try {
                    await writeFile(
                      receipt,
                      JSON.stringify({
                        workspaceId: input.workspaceId,
                        genesisHash: input.genesisHash
                      }),
                      { flag: 'wx', mode: 0o600 }
                    )
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                    if (
                      CreationReceipt.parse(JSON.parse(readFileSync(receipt, 'utf8')))
                        .workspaceId !== input.workspaceId
                    )
                      throw accountFailure('conflict')
                  }
                  await rename(source, target)
                },
                catch: () => accountFailure('storage')
              })
              return undefined
            })
          )
        )
      )
    )
  }
  return withDesktopE2eeAccount((owner) => owner.bootstrap.recordCreated(input), input.workspaceId)
}

function publicE2eeFailure(error: unknown): Error {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const allowed = new Set([
    'identity-busy',
    'permissions',
    'identity-lost',
    'account_unavailable',
    'custody_unavailable',
    'missing-binding',
    'member_removed',
    'conflict',
    'local-evidence-conflict',
    'snapshot-history-required',
    'closed',
    'corrupt',
    'invalid-input',
    'storage',
    'invalid-ledger',
    'machine_not_owned',
    'machine_not_shared',
    'sharing_conflict',
    'sharing_unavailable',
    'sharing_invalid',
    'sharing_storage',
    'rotation_candidate_unavailable',
    'management_unauthorized',
    'management_operator_required',
    'management_retry',
    'restart-required',
    'local-history-recovery-required',
    'trusted-pin-unavailable'
  ])
  if (code === 'restart-required') return accountFailure(code)
  return new Error(
    typeof code === 'string' && allowed.has(code) ? `e2ee_${code}` : 'e2ee_host_operation_failed'
  )
}

/** The workspace host owns native admission/drain. Execute a captured operation
 * outside the account lock, retaining the originating account fence. */
export async function runDesktopE2eeOperation<A>(
  accountId: string,
  work: Effect.Effect<A, unknown>
): Promise<A> {
  const assertAccount = () => {
    if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== accountId)
      throw new Error('e2ee_account_mismatch')
  }
  assertAccount()
  const result = await Effect.runPromise(work).catch((error) => {
    throw publicE2eeFailure(error)
  })
  assertAccount()
  return result
}

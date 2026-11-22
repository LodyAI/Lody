import { withE2eeTestClock } from '@lody/shared/node/e2ee-clock'
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
import { rememberDesktopE2eeFailure } from './e2ee-diagnostics.mjs'
import { E2eeDeviceRevokedError, E2eeMemberRemovedError } from './e2ee-cloud-errors.mjs'

// Lazy application boundary. Plain workspaces never create a Scope or touch custody.
// Locking: a directory turn holds one shared account permit, then only its identity
// directory's lock, so independent workspaces run concurrently. Account-wide
// transitions (account switch, close/quit/logout, identity cleanup, account reset)
// take every permit: they drain admitted turns and fence later ones. `gate` keeps
// that order, because a smaller later `take` may overtake a larger waiting one.
// Nesting is only barrier -> directory locks (sorted); nothing waits on the
// barrier while holding a directory lock, and work must not re-enter this boundary.
const ACCOUNT_PERMITS = 2 ** 30
const gate = Semaphore.makeUnsafe(1)
const permits = Semaphore.makeUnsafe(ACCOUNT_PERMITS)
const holdAccount =
  (count: number) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    // Waiting stays interruptible, as with `withPermit`; once taken, release is guaranteed.
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(restore(gate.withPermit(permits.take(count))), () =>
        restore(effect).pipe(Effect.ensuring(permits.release(count)))
      )
    )
const accountTurn = holdAccount(1)
const accountTransition = holdAccount(ACCOUNT_PERMITS)
// Entries exist only while a turn holds or awaits the directory.
const directoryLocks = new Map<string, { lock: Semaphore.Semaphore; users: number }>()
const withDirectory = <A, E>(directory: string, effect: Effect.Effect<A, E>) =>
  Effect.suspend(() => {
    const entry = directoryLocks.get(directory) ?? { lock: Semaphore.makeUnsafe(1), users: 0 }
    directoryLocks.set(directory, entry)
    entry.users++
    return entry.lock.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (--entry.users === 0 && directoryLocks.get(directory) === entry)
            directoryLocks.delete(directory)
        })
      )
    )
  })
/** Locks several directories in a deterministic order. */
const withDirectories = <A, E>(directories: readonly string[], effect: Effect.Effect<A, E>) =>
  [...new Set(directories)]
    .sort()
    .reduceRight<Effect.Effect<A, E>>((inner, directory) => withDirectory(directory, inner), effect)
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
  /** Login generation the owner was opened under. */
  generation: number
  directory: string
  scope: Scope.Closeable
  bootstrap: Effect.Success<ReturnType<typeof makeDesktopE2eeBootstrap>>
  host: Effect.Success<ReturnType<typeof makeDesktopE2eeRuntimeHost>>
  cloud?: E2eeCloudClient
  closeFailed?: boolean
  readers: Map<string, Map<number, number>>
  fenceLoss: (
    workspaceId: string,
    reason: 'member_removed' | 'device_revoked',
    generation: number
  ) => RemovalFence
}
type RemovalFence = {
  owner: Account
  workspaceId: string
  reason: 'member_removed' | 'device_revoked'
  generation: number
  completed: boolean
  failure?: unknown
}
// Main-owned loss fences outlive a failed or slow cleanup; only verified erase
// releases one. Never use a waiter deadline to admit a successor on this directory.
const lossFences = new Map<string, RemovalFence>()
function fenceLoss(
  owner: Account,
  workspaceId: string,
  reason: RemovalFence['reason'],
  generation: number
): RemovalFence {
  const identity = getIpcServiceDeps().authService.getCachedSessionIdentity()
  const existing = lossFences.get(owner.directory)
  if (identity.userId !== owner.accountId || identity.generation !== generation)
    throw accountFailure('account_mismatch')
  if (existing?.owner === owner) return existing
  if (
    owners.get(owner.directory) !== owner ||
    owner.scope.state._tag === 'Closed' ||
    owner.closeFailed ||
    identityDirectory(owner.accountId, workspaceId) !== owner.directory
  )
    throw accountFailure('host_operation_failed')
  const fence: RemovalFence = { owner, workspaceId, reason, generation, completed: false }
  lossFences.set(owner.directory, fence)
  return fence
}
const CreationReceipt = z
  .object({
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    genesisHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
const owners = new Map<string, Account>()
const removing = new Map<string, Deferred.Deferred<boolean, unknown>>()
// Reason reported while an identity directory is fenced for terminal cleanup.
const removingReasons = new Map<string, 'member_removed' | 'device_revoked'>()
const accountDirectory = (accountId: string) =>
  join(
    app.getPath('userData'),
    'e2ee-bootstrap',
    createHash('sha256').update(accountId).digest('hex')
  )
/** The account-wide pairing journal; it holds no secret and no private key. */
export const desktopAccountPairingDatabase = (accountId: string) =>
  join(accountDirectory(accountId), 'account-pairing.sqlite')
/** Whether this device has a completed identity for the workspace. An unfinished restore
 * leaves a directory behind, so the directory alone does not count. */
export const desktopE2eeHasWorkspaceIdentity = async (accountId: string, workspaceId: string) => {
  if (!existsSync(identityDirectory(accountId, workspaceId))) return false
  return withDesktopE2eeAccount(
    (owner) =>
      owner.bootstrap.creationFor(workspaceId).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      ),
    workspaceId,
    false
  )
}
/** Account-scoped recovery-vault journal (pins and intents only, never secrets). */
export const desktopE2eeRecoveryJournalPath = (accountId: string) =>
  join(accountDirectory(accountId), 'recovery-vault.sqlite')
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
        accountTransition(
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
const closeOwners = (stale: (owner: Account) => boolean) =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach([...owners.values()].filter(stale), (owner) =>
      Effect.exit(closeOwner(owner))
    )
    if (results.some(Exit.isFailure)) return yield* Effect.fail(accountFailure('restart-required'))
    return undefined
  })
const closeCurrent = closeOwners(() => true)

type IrohPreparation =
  | {
      readonly config: NonNullable<
        ReturnType<(typeof import('./e2ee-iroh-config'))['desktopIrohConfig']>
      >
      readonly native: NonNullable<ReturnType<(typeof import('./e2ee-iroh.mjs'))['loadIrohNative']>>
      readonly proxyUrl: string | undefined
    }
  | undefined
/** Only cloud builds that carry relays load the iroh route at all. */
function irohRouted() {
  return import.meta.env.VITE_LODY_PLATFORM === 'cloud' && !!import.meta.env.VITE_IROH_RELAYS
}
/**
 * The iroh route for a cold account open. It loads modules and asks the system proxy
 * (PAC/WPAD may stall), so callers run it before taking the account permit: a slow
 * lookup must never hold every other workspace's E2EE operations.
 */
async function prepareIroh(): Promise<IrohPreparation> {
  if (!irohRouted()) return undefined
  const configModule = await import('./e2ee-iroh-config')
  const config = configModule.desktopIrohConfig({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    env: import.meta.env
  })
  if (!config) return undefined
  const native = (await import('./e2ee-iroh.mjs')).loadIrohNative(config.file)
  if (!native) return undefined
  // Relays need the same proxy the embedded CLI receives: the inherited
  // environment first, else the system proxy for the first relay URL.
  const inherited = configModule.proxyUrlFromEnv(process.env)
  if (inherited) return { config, native, proxyUrl: inherited }
  const { resolveSystemProxyEnv } = await import('./system-proxy-env')
  const proxyUrl = configModule.proxyUrlFromEnv(
    await resolveSystemProxyEnv(config.relays.urls.slice(0, 1)).catch(() => ({}))
  )
  return { config, native, proxyUrl }
}
/** Whether this call may construct an owner: a hint read without the permit. */
function mayOpenCold(location: IdentityLocation | undefined) {
  if (quitting || !irohRouted()) return false
  const userId = getIpcServiceDeps().authService.getCachedSessionIdentity().userId
  if (!userId) return false
  try {
    return !owners.has(identityDirectory(userId, location))
  } catch {
    return false
  }
}

/** Entry boundary; account and resources remain locked until the native operation settles. */
export function withDesktopE2eeAccount<A>(
  work: (owner: Account) => Effect.Effect<A, unknown>,
  location?: IdentityLocation,
  create = true,
  retiring?: RemovalFence
): Promise<A> {
  observeIdentity()
  // Settled before the permit; the permit-held open below only reuses its answer.
  const iroh: Promise<Exit.Exit<IrohPreparation, unknown>> | undefined = mayOpenCold(location)
    ? prepareIroh().then(Exit.succeed, (error: unknown) => Exit.die(error))
    : undefined
  // Without a cold iroh open the call is admitted synchronously, as before.
  if (!iroh) return runAccountOperation(work, location, create, retiring, undefined)
  return iroh.then((prepared) => runAccountOperation(work, location, create, retiring, prepared))
}

function runAccountOperation<A>(
  work: (owner: Account) => Effect.Effect<A, unknown>,
  location: IdentityLocation | undefined,
  create: boolean,
  retiring: RemovalFence | undefined,
  prepared: Exit.Exit<IrohPreparation, unknown> | undefined
): Promise<A> {
  const auth = getIpcServiceDeps().authService
  const foreignOwner = (userId: string) =>
    [...owners.values()].some((owner) => owner.accountId !== userId)
  type Step = { done: A } | { transition: 'switch' | 'unavailable' } | { retry: true }
  const turn = accountTurn(
    Effect.gen(function* () {
      if (quitting) return yield* Effect.fail(accountFailure('closed'))
      // Resolve trusted identity synchronously: no network can hold this resource lock.
      const identity = auth.getCachedSessionIdentity()
      if (!identity.userId) {
        if (owners.size === 0) return yield* Effect.fail(accountFailure('account_unavailable'))
        return { transition: 'unavailable' } as Step
      }
      // Closing another account's owners is account-wide: leave this turn and drain.
      if (foreignOwner(identity.userId)) return { transition: 'switch' } as Step
      const accountId = identity.userId
      const directory = identityDirectory(accountId, location)
      return yield* withDirectory(
        directory,
        Effect.gen(function* () {
          // Identity or a pending -> workspace rename may change while this turn waits.
          const fresh = auth.getCachedSessionIdentity()
          if (
            fresh.userId !== accountId ||
            fresh.generation !== identity.generation ||
            identityDirectory(accountId, location) !== directory
          )
            return { retry: true } as Step
          const loss = lossFences.get(directory)
          if (loss && loss !== retiring) return yield* Effect.fail(accountFailure(loss.reason))
          if (
            retiring &&
            (loss !== retiring ||
              retiring.owner !== owners.get(directory) ||
              identity.generation !== retiring.generation)
          )
            return yield* Effect.fail(accountFailure('account_mismatch'))
          if (removing.has(directory))
            return yield* Effect.fail(
              accountFailure(removingReasons.get(directory) ?? 'member_removed')
            )
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
                // Normally prepared before the permit. A cold open the hint did not
                // foresee (an owner closed meanwhile) prepares here, still bounded.
                const iroh = prepared ? yield* prepared : yield* Effect.promise(() => prepareIroh())
                const host = yield* runtime.makeDesktopE2eeRuntimeHost({
                  directory,
                  custody,
                  bootstrap,
                  ...(iroh
                    ? {
                        iroh: {
                          native: iroh.native,
                          relays: iroh.config.relays,
                          ...(iroh.proxyUrl ? { proxyUrl: iroh.proxyUrl } : {})
                        }
                      }
                    : {})
                })
                const owned: Account = {
                  accountId,
                  generation: identity.generation,
                  directory,
                  scope,
                  bootstrap,
                  host,
                  readers: new Map<string, Map<number, number>>(),
                  fenceLoss: (workspaceId, reason, generation) =>
                    fenceLoss(owned, workspaceId, reason, generation)
                }
                return owned
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
          if (latest.userId !== identity.userId || latest.generation !== identity.generation)
            return { transition: 'unavailable' } as Step
          if (current.closeFailed) return yield* Effect.fail(accountFailure('restart-required'))
          return { done: yield* work(current) } as Step
        })
      )
    })
  )
  const attempt = (): Effect.Effect<A, unknown> =>
    Effect.flatMap(turn, (step) => {
      if ('done' in step) return Effect.succeed(step.done)
      if ('retry' in step) return attempt()
      // Account-wide close runs after this turn released its permit; it drains the rest.
      return accountTransition(
        Effect.suspend(() => {
          const { userId, generation } = auth.getCachedSessionIdentity()
          if (!userId) return closeCurrent
          // A stale turn closes only owners of another account or an older login; a
          // turn of the current login may already have opened its own workspace.
          if (step.transition === 'unavailable')
            return closeOwners(
              (owner) => owner.accountId !== userId || owner.generation !== generation
            )
          return foreignOwner(userId) ? closeCurrent : Effect.void
        })
      ).pipe(
        Effect.andThen(
          step.transition === 'unavailable'
            ? Effect.fail(accountFailure('account_unavailable'))
            : Effect.suspend(attempt)
        )
      )
    })
  return Effect.runPromise(Effect.uninterruptible(attempt()).pipe(withE2eeTestClock)).catch(
    (error: unknown) => {
      rememberDesktopE2eeFailure('account-operation', error)
      throw publicE2eeFailure(error)
    }
  )
}

/** Passive metadata only: never acquire a lease or construct an absent owner. */
export function inspectDesktopE2eeCachedState(
  accountId: string,
  workspaceId: string,
  machineId: string
) {
  return Effect.runPromise(
    accountTurn(
      Effect.gen(function* () {
        if (quitting) return yield* Effect.fail(accountFailure('closed'))
        const auth = getIpcServiceDeps().authService
        const identity = auth.getCachedSessionIdentity()
        if (!identity.userId || identity.userId !== accountId)
          return yield* Effect.fail(accountFailure('account_mismatch'))
        const directory = identityDirectory(accountId, workspaceId)
        return yield* withDirectory(
          directory,
          Effect.gen(function* () {
            const owner = owners.get(directory)
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
      })
    )
  ).catch((error: unknown) => {
    throw publicE2eeFailure(error)
  })
}

/** E2E evidence only: one renderer's registered reader acquisitions. Synchronous,
 * so it never waits on or takes the account lock, opens an owner or touches custody. */
export function countDesktopE2eeReaders(
  accountId: string,
  workspaceId: string,
  senderId: number
): number {
  const owner = owners.get(identityDirectory(accountId, workspaceId))
  return owner?.accountId === accountId ? (owner.readers.get(workspaceId)?.get(senderId) ?? 0) : 0
}

/** Quit/logout await actual in-flight native operations before releasing stores. */
export function closeDesktopE2eeAccount(options?: {
  quit?: boolean
  signOut?: () => Promise<void>
}): Promise<void> {
  if (options?.quit) quitting = true
  return Effect.runPromise(
    Effect.uninterruptible(
      accountTransition(
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
  // Readers are mutated only by turns on their owner's directory. Include busy
  // directories so a cold open admitted before this release is drained, as before.
  const detach = accountTurn(
    Effect.suspend(() =>
      Effect.forEach(new Set([...owners.keys(), ...directoryLocks.keys()]), (directory) =>
        withDirectory(
          directory,
          Effect.gen(function* () {
            const cleanup: Effect.Effect<void, unknown>[] = []
            const current = owners.get(directory)
            if (!current) return cleanup
            for (const [workspaceId, readers] of current.readers) {
              readers.delete(senderId)
              if (readers.size === 0) {
                cleanup.push(yield* current.host.beginCloseWorkspace(workspaceId))
                current.readers.delete(workspaceId)
              }
            }
            return cleanup
          })
        )
      ).pipe(Effect.map((cleanups) => cleanups.flat()))
    )
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
          // The request's signal reaches the sign-in request itself: quitting or a host stop
          // must not wait on a slow auth server, and no token request outlives it.
          convexToken: (signal) => getIpcServiceDeps().authService.convexToken(undefined, signal)
        }).pipe(Scope.provide(owner.scope))
      }
      return { accountId: owner.accountId, client: owner.cloud }
    })
  )
}

/** Signing and retrying a creation stay local; the account lock admits no network work. */
export async function prepareDesktopE2eeCreation(input: DesktopE2eeCreationIntent) {
  const auth = getIpcServiceDeps().authService
  const identity = auth.getCachedSessionIdentity()
  await withDesktopE2eeAccount(
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
      }),
    { requestId: input.requestId }
  )
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
  const reset = Effect.scoped(
    Effect.gen(function* () {
      if (quitting) return yield* Effect.fail(accountFailure('closed'))
      yield* checkConfirmation
      if (!accountId) return yield* Effect.fail(accountFailure('account_unavailable'))
      const directory = workspaceId
        ? identityDirectory(accountId, workspaceId)
        : accountDirectory(accountId)
      const lost = [...lossFences.values()].find((fence) =>
        workspaceId ? fence.owner.directory === directory : fence.owner.accountId === accountId
      )
      if (lost) return yield* Effect.fail(accountFailure(lost.reason))
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
  // A workspace reset locks only its directory; an account reset drains every turn.
  return Effect.runPromise(
    Effect.uninterruptible(
      workspaceId
        ? accountTurn(
            Effect.suspend(() =>
              withDirectory(identityDirectory(accountId ?? '', workspaceId), reset)
            )
          )
        : accountTransition(reset)
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
  /** The exact authenticated reason the caller observed; it only labels the fence. */
  reason?: 'member_removed' | 'device_revoked'
}): Promise<boolean> {
  const { workspaceId } = input
  return Effect.runPromise(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const plan = yield* accountTurn(
          Effect.gen(function* () {
            const accountId = getIpcServiceDeps().authService.getCachedSessionIdentity().userId
            if (!accountId || accountId !== input.accountId)
              return yield* Effect.fail(accountFailure('account_unavailable'))
            const directory = identityDirectory(accountId, workspaceId)
            return yield* withDirectory(
              directory,
              Effect.gen(function* () {
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
                removingReasons.set(directory, input.reason ?? 'member_removed')
                return { kind: 'owner' as const, directory, owner, done }
              })
            )
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
        yield* accountTurn(
          withDirectory(
            plan.directory,
            Effect.gen(function* () {
              const loss = lossFences.get(plan.directory)
              if (loss) {
                if (Exit.isSuccess(result) && result.value === true) {
                  loss.completed = true
                  lossFences.delete(plan.directory)
                } else if (Exit.isFailure(result)) loss.failure = result.cause
              }
              if (removing.get(plan.directory) === plan.done) {
                removing.delete(plan.directory)
                removingReasons.delete(plan.directory)
              }
              yield* Deferred.done(plan.done, result)
            })
          )
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
    const source = join(
      accountDirectory(accountId),
      'pending',
      createHash('sha256').update(input.requestId).digest('hex')
    )
    await Effect.runPromise(
      Effect.uninterruptible(
        accountTurn(
          withDirectories(
            [source, target],
            Effect.scoped(
              Effect.gen(function* () {
                if (getIpcServiceDeps().authService.getCachedSessionIdentity().userId !== accountId)
                  return yield* Effect.fail(accountFailure('account_unavailable'))
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
    )
  }
  return withDesktopE2eeAccount((owner) => owner.bootstrap.recordCreated(input), input.workspaceId)
}

/**
 * The typed, credential-authenticated cloud results carry `reason: 'unauthorized'`, not a
 * `code`. Classify them before the generic projection, or every caller past this boundary
 * sees `e2ee_host_operation_failed` and can never record the loss.
 */
const publicAccessLosses = new WeakMap<Error, 'member_removed' | 'device_revoked'>()
function typedAccessLoss(error: unknown): 'member_removed' | 'device_revoked' | null {
  let current = error
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (current instanceof E2eeMemberRemovedError) return 'member_removed'
    if (current instanceof E2eeDeviceRevokedError) return 'device_revoked'
    current = (current as { cause?: unknown }).cause
  }
  return null
}
/** Only a loss this boundary projected from a typed cloud result; never a matching message. */
export function publicAccessLoss(error: unknown): 'member_removed' | 'device_revoked' | null {
  return error instanceof Error ? (publicAccessLosses.get(error) ?? null) : null
}

function publicE2eeFailure(error: unknown): Error {
  const loss = typedAccessLoss(error)
  if (loss) {
    const projected = new Error(`e2ee_${loss}`)
    publicAccessLosses.set(projected, loss)
    return projected
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'device_revoked') {
    const projected = new Error('e2ee_device_revoked')
    publicAccessLosses.set(projected, 'device_revoked')
    return projected
  }
  if (code === 'member_removed') {
    const projected = new Error('e2ee_member_removed')
    publicAccessLosses.set(projected, 'member_removed')
    return projected
  }
  const allowed = new Set([
    'identity-busy',
    'permissions',
    'identity-lost',
    'account_unavailable',
    'custody_unavailable',
    'missing-binding',
    'pairing-tampered',
    'pairing-expired',
    'pairing-used',
    'member_removed',
    'member_invitation_invalid',
    'member_invitation_endorser_ineligible',
    'member_invitation_expired',
    'member_invitation_mismatch',
    'member_invitation_used',
    'device_revoked',
    'conflict',
    'local-evidence-conflict',
    'snapshot-history-required',
    'key-update-required',
    'key-pending',
    'closed',
    'corrupt',
    'invalid-input',
    'pairing_key_revoked',
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
  const result = await Effect.runPromise(withE2eeTestClock(work)).catch((error) => {
    rememberDesktopE2eeFailure('runtime-operation', error)
    throw publicE2eeFailure(error)
  })
  assertAccount()
  return result
}

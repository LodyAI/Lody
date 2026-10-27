import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { Effect, Exit, Scope, Semaphore } from 'effect'
import { makeElectronE2eeCustody } from '../e2ee-custody-electron'
import { makeDesktopE2eeBootstrap, type DesktopE2eeCreationIntent } from './e2ee-bootstrap.mjs'
import type { E2eeCloudClient } from './e2ee-cloud-client.mjs'
import type { makeDesktopE2eeRuntimeHost } from './e2ee-runtime.mjs'
import { getIpcServiceDeps } from '../ipc/ipc-service-deps'

// Lazy application boundary. Plain workspaces never create a Scope or touch custody.
const serial = Semaphore.makeUnsafe(1)
const accountFailure = (code: string) => Object.assign(new Error(`e2ee_${code}`), { code })
type Account = {
  accountId: string
  scope: Scope.Closeable
  bootstrap: Effect.Success<ReturnType<typeof makeDesktopE2eeBootstrap>>
  host: Effect.Success<ReturnType<typeof makeDesktopE2eeRuntimeHost>>
  cloud?: E2eeCloudClient
  closeFailed?: boolean
  readers: Map<string, Map<number, number>>
}
let current: Account | undefined
let quitting = false
let observingIdentity = false
function observeIdentity() {
  if (observingIdentity) return
  const auth = getIpcServiceDeps().authService
  if (typeof auth.subscribeCachedSessionIdentity !== 'function') return
  observingIdentity = true
  auth.subscribeCachedSessionIdentity(() => {
    const owner = current
    if (!owner || auth.getCachedSessionIdentity().userId === owner.accountId) return
    // The synchronous identity check fences new calls immediately. Resource
    // release queues behind admitted native work, without awaiting auth I/O.
    void Effect.runPromise(
      Effect.uninterruptible(
        serial.withPermit(Effect.suspend(() => (current === owner ? closeCurrent : Effect.void)))
      )
    ).catch(() => {
      console.warn('[E2EE] Account cleanup pending', { code: 'e2ee_cleanup_failed' })
    })
  })
}
const closeCurrent = Effect.gen(function* () {
  if (!current) return undefined
  const owner = current
  // Scope.close is idempotent even after a failed finalizer. Preserve that failure:
  // another close must not silently authorize a replacement owner.
  if (owner.closeFailed) return yield* Effect.fail(new Error('e2ee_cleanup_failed'))
  const closed = yield* Effect.exit(Scope.close(owner.scope, Exit.void))
  if (Exit.isFailure(closed)) {
    owner.closeFailed = true
    return yield* Effect.fail(new Error('e2ee_cleanup_failed'))
  }
  current = undefined
  return undefined
})

/** Entry boundary; account and resources remain locked until the native operation settles. */
export function withDesktopE2eeAccount<A>(
  work: (owner: Account) => Effect.Effect<A, unknown>
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
          if (current && current.accountId !== identity.userId) yield* closeCurrent
          if (!current) {
            const accountId = identity.userId
            const directory = join(
              app.getPath('userData'),
              'e2ee-bootstrap',
              createHash('sha256').update(accountId).digest('hex')
            )
            const scope = yield* Scope.make()
            const opened = yield* Effect.exit(
              Effect.gen(function* () {
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
          }
          // Native open may yield while auth changes. Never hand the old account to work.
          const latest = auth.getCachedSessionIdentity()
          if (latest.userId !== identity.userId || latest.generation !== identity.generation) {
            yield* closeCurrent
            return yield* Effect.fail(accountFailure('account_unavailable'))
          }
          if (current.closeFailed) return yield* Effect.fail(new Error('e2ee_cleanup_failed'))
          return yield* work(current)
        })
      )
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
            return yield* Effect.fail(new Error('e2ee_cleanup_failed'))
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
  const needsIdentity = await withDesktopE2eeAccount((owner) =>
    owner.accountId === input.accountId
      ? owner.bootstrap.creationNeedsAccountIdentity(input)
      : Effect.fail(new Error('e2ee_account_mismatch'))
  )
  if (needsIdentity) {
    const cloud = await desktopE2eeCloudClient()
    if (cloud.accountId !== input.accountId) throw new Error('e2ee_account_mismatch')
    const registered = await Effect.runPromise(cloud.client.accountIdentity())
    await withDesktopE2eeAccount((owner) => {
      const latest = auth.getCachedSessionIdentity()
      return owner.accountId === input.accountId &&
        registered.accountId === input.accountId &&
        latest.userId === identity.userId &&
        latest.generation === identity.generation
        ? owner.bootstrap.recordAccountIdentity(registered)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    })
  }
  return withDesktopE2eeAccount((owner) => {
    const latest = auth.getCachedSessionIdentity()
    return owner.accountId === input.accountId &&
      latest.userId === identity.userId &&
      latest.generation === identity.generation
      ? owner.bootstrap.prepareCreation(input)
      : Effect.fail(new Error('e2ee_account_mismatch'))
  })
}

function publicE2eeFailure(error: unknown): Error {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const allowed = new Set([
    'account_unavailable',
    'custody_unavailable',
    'missing-binding',
    'conflict',
    'local-evidence-conflict',
    'closed',
    'corrupt',
    'invalid-input',
    'storage',
    'invalid-ledger',
    'rotation_candidate_unavailable',
    'management_unauthorized',
    'management_operator_required',
    'management_retry'
  ])
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

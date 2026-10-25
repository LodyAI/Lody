import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { Effect, Exit, Scope, Semaphore } from 'effect'
import { makeElectronE2eeCustody } from '../e2ee-custody-electron'
import { makeDesktopE2eeBootstrap } from './e2ee-bootstrap.mjs'
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
  closeFailed?: boolean
  readers: Map<string, Map<number, number>>
}
let current: Account | undefined
let quitting = false
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
      'invalid-ledger'
    ])
    throw new Error(
      typeof code === 'string' && allowed.has(code) ? `e2ee_${code}` : 'e2ee_host_operation_failed'
    )
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
  void Effect.runPromise(
    Effect.uninterruptible(
      serial.withPermit(
        Effect.gen(function* () {
          if (!current) return
          for (const [workspaceId, readers] of current.readers) {
            readers.delete(senderId)
            if (readers.size === 0) {
              yield* current.host.closeWorkspace(workspaceId)
              current.readers.delete(workspaceId)
            }
          }
        })
      )
    )
  ).catch(() => undefined)
}

/** The quit barrier can leave the application open; failed owners stay fenced. */
export function resumeDesktopE2eeAccount(): void {
  quitting = false
}

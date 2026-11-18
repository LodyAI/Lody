import { Cause, Context, Effect, Exit, Layer, Semaphore } from 'effect'
import type { ChildProcessSpawner } from 'effect/process'
import {
  runCommandOk,
  processLayer,
  ProcessReleaseFailed,
  squashProcessFailure,
  type ProcessFacadeOptions
} from '@lody/shared/node/process'
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime'
import {
  nativeWorkspaceCatalogMigrationInputSchema,
  nativeWorkspaceCatalogMigrationReceiptSchema,
  type NativeWorkspaceCatalogMigrationInput
} from '@lody/shared/native-workspace-catalog-migration'
import {
  rendererWfBindingSchema,
  rendererWfBindingKey,
  type RendererWfBinding
} from '@lody/shared/renderer-room-migration'
import {
  readNativeWorkspaceFlockOwner,
  assertPublishedNativeWorkspaceFlockStorage
} from './native-workspace-routing'
import type { RendererWorkspaceFlockMigrationMainLegacy } from './renderer-workspace-flock-migration'

type Pause = { stop(): Promise<void>; release(options?: { resume?: boolean }): void }
export type NativeWorkspaceCatalogMigrationOptions = {
  dataRoot: string
  renderer(): RendererWorkspaceFlockMigrationMainLegacy
  acquirePause(): Pause
  ensureData(binding: RendererWfBinding): Promise<void>
  launch(): { executable: string; entry: string }
  helperTimeoutMs?: number
  workflowTimeoutMs?: number
  cleanupTimeoutMs?: number
}
export type NativeWorkspaceCatalogMigrationResult = {
  owner: 'native'
  receipt?: ReturnType<typeof nativeWorkspaceCatalogMigrationReceiptSchema.parse>
}
type Api = {
  migrate(
    binding: RendererWfBinding
  ): Effect.Effect<
    NativeWorkspaceCatalogMigrationResult,
    unknown,
    ChildProcessSpawner.ChildProcessSpawner
  >
  recover: Effect.Effect<void, unknown>
  close: Effect.Effect<void, unknown>
}
export class NativeWorkspaceCatalogMigration extends Context.Service<
  NativeWorkspaceCatalogMigration,
  Api
>()('lody/electron/NativeWorkspaceCatalogMigration') {}
const processReleases = (cause: Cause.Cause<unknown>) =>
  cause.reasons.flatMap((reason) =>
    Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed
      ? [reason.defect]
      : []
  )

/** Foreign Promise tracking is solely at the existing CLI/main I/O boundary. */
const makeMigration = Effect.fnUntraced(function* (
  options: NativeWorkspaceCatalogMigrationOptions
) {
  const semaphore = yield* Semaphore.make(1)
  const cleanupMs = options.cleanupTimeoutMs ?? 5_000
  const helperMs = options.helperTimeoutMs ?? 45_000
  const workflowMs = options.workflowTimeoutMs ?? 60_000
  if ([cleanupMs, helperMs, workflowMs].some((value) => !Number.isFinite(value) || value <= 0))
    return yield* Effect.fail(new Error('Invalid native migration deadline'))
  let closed = false
  let identity: string | undefined
  let pause: Pause | undefined
  const pendingIo = new Set<Promise<void>>()
  const releases = new Set<ProcessReleaseFailed>()
  let retainedCause: Cause.Cause<unknown> | undefined
  const io = <A>(work: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: (signal) => {
        const raw = work(signal)
        const settled = raw.then(
          () => undefined,
          () => undefined
        )
        pendingIo.add(settled)
        void settled.then(() => pendingIo.delete(settled))
        return raw
      },
      catch: (cause) => cause
    })
  const sync = <A>(work: () => A) => Effect.try({ try: work, catch: (cause) => cause })
  const recoverRaw = Effect.fnUntraced(function* () {
    for (const release of [...releases]) {
      yield* release.retryTermination()
      releases.delete(release)
    }
    if (pendingIo.size)
      yield* Effect.tryPromise({
        try: () => Promise.all([...pendingIo]).then(() => undefined),
        catch: (cause) => cause
      }).pipe(Effect.interruptible, Effect.timeout(cleanupMs))
  })
  const recover = () =>
    recoverRaw().pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(retainedCause ? Cause.combine(retainedCause, cause) : cause)
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          retainedCause = undefined
        })
      )
    )
  const close = semaphore.withPermits(1)(
    Effect.gen(function* () {
      closed = true
      yield* recover()
      if (pause) {
        // All helper/port work is gone. Quit releases only this admission lease;
        // an external/active daemon is still owned by its existing CLI owner.
        yield* sync(() => pause!.release({ resume: false }))
        pause = undefined
      }
    })
  )
  yield* Effect.addFinalizer(() => close.pipe(Effect.orDie))
  const migrate = Effect.fnUntraced(function* (bindingInput: RendererWfBinding) {
    return yield* semaphore.withPermits(1)(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (closed) return yield* Effect.fail(new Error('Native migration owner is closed'))
          yield* restore(recover())
          const result = yield* restore(
            Effect.gen(function* () {
              const binding = yield* sync(() => rendererWfBindingSchema.parse(bindingInput))
              const key = rendererWfBindingKey(binding)
              if (identity && identity !== key)
                return yield* Effect.fail(
                  new Error('Native migration identity changed; close the previous owner first')
                )
              identity = key
              const renderer = yield* sync(options.renderer)
              const alreadyNative = yield* sync(() => {
                if (
                  renderer.status(binding).owner !== 'native' ||
                  readNativeWorkspaceFlockOwner(options.dataRoot, binding) !== 'native'
                )
                  return false
                assertPublishedNativeWorkspaceFlockStorage(options.dataRoot, binding)
                return true
              })
              if (alreadyNative) {
                if (pause) {
                  yield* sync(() => pause!.release())
                  pause = undefined
                }
                return { owner: 'native' as const }
              }
              // Platform/format/packaging preflight cannot freeze an otherwise healthy
              // legacy UI. It opens only the independent host, never authors WF.
              yield* io(() => options.ensureData(binding))
              if (!pause) pause = yield* sync(options.acquirePause)
              yield* io(() => pause!.stop())
              const frozen = yield* io((signal) => renderer.freeze(binding, signal))
              const input: NativeWorkspaceCatalogMigrationInput = yield* sync(() =>
                nativeWorkspaceCatalogMigrationInputSchema.parse({
                  version: 1,
                  accountId: binding.accountId,
                  workspaceId: binding.workspaceId,
                  dataRoot: options.dataRoot,
                  revision: frozen.revision,
                  sources: frozen.sources.map((source) => ({
                    sourceId: source.sourceId,
                    snapshotBase64: Buffer.from(source.snapshot).toString('base64')
                  }))
                })
              )
              const launch = yield* sync(options.launch)
              const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
              for (const name of ['PATH', 'HOME', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'])
                if (process.env[name]) env[name] = process.env[name]
              const output = yield* runCommandOk({
                command: launch.executable,
                args: [launch.entry],
                env,
                input: JSON.stringify(input),
                timeout: helperMs,
                maxOutputBytes: 8 * 1024
              })
              const receipt = yield* sync(() =>
                nativeWorkspaceCatalogMigrationReceiptSchema.parse(
                  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.stdout))
                )
              )
              yield* sync(() => renderer.assertFrozen(binding, frozen.revision))
              yield* io(() => renderer.complete(binding, frozen.revision))
              yield* sync(() => pause!.release())
              pause = undefined
              return { owner: 'native' as const, receipt }
            }).pipe(Effect.timeout(workflowMs), Effect.exit)
          )
          if (Exit.isFailure(result)) {
            retainedCause = result.cause
            for (const release of processReleases(result.cause)) releases.add(release)
          }
          return yield* result
        })
      )
    )
  })
  return { migrate, recover: semaphore.withPermits(1)(recover()), close } satisfies Api
})
export const nativeWorkspaceCatalogMigrationLayer = (
  options: NativeWorkspaceCatalogMigrationOptions
) => Layer.effect(NativeWorkspaceCatalogMigration, makeMigration(options))

export class NativeWorkspaceCatalogMigrationFailure extends Error {
  constructor(
    readonly effectCause: Cause.Cause<unknown>,
    readonly retryCleanup: () => Promise<void>
  ) {
    super('Native workspace catalog migration failed', { cause: squashProcessFailure(effectCause) })
  }
}
/** @deprecated Main Promise composition; delete once ready/quit consume the native application Layer. */
export class NativeWorkspaceCatalogMigrationLegacy {
  private readonly application
  private core: Api | undefined
  private inflight: Promise<NativeWorkspaceCatalogMigrationResult> | undefined
  private inflightBinding: string | undefined
  private abort: AbortController | undefined
  private closing: Promise<void> | undefined
  private closed = false
  private released = false
  constructor(
    options: NativeWorkspaceCatalogMigrationOptions,
    private readonly platform: ProcessFacadeOptions = {}
  ) {
    this.application = makeApplicationRuntime(
      nativeWorkspaceCatalogMigrationLayer(options).pipe(
        Layer.provideMerge(processLayer(platform))
      ),
      {
        project: (cause) =>
          new NativeWorkspaceCatalogMigrationFailure(cause, () => this.retryCleanup()),
        recover: (cause) => (this.core ? this.core.close : Effect.failCause(cause))
      }
    )
  }
  private failure(cause: Cause.Cause<unknown>) {
    return new NativeWorkspaceCatalogMigrationFailure(cause, () => this.retryCleanup())
  }
  private async selected(): Promise<Api> {
    if (this.core) return this.core
    const selected = await this.application.runtime.runPromiseExit(NativeWorkspaceCatalogMigration)
    if (Exit.isFailure(selected)) throw this.failure(selected.cause)
    return (this.core = selected.value)
  }
  migrate(binding: RendererWfBinding): Promise<NativeWorkspaceCatalogMigrationResult> {
    if (this.closed) return Promise.reject(new Error('Native migration owner is closed'))
    if (this.inflight)
      return this.inflightBinding === rendererWfBindingKey(binding)
        ? this.inflight
        : Promise.reject(new Error('Another native workspace migration is active'))
    this.abort = new AbortController()
    const signal = this.platform.signal
      ? AbortSignal.any([this.abort.signal, this.platform.signal])
      : this.abort.signal
    const operation = (async () => {
      const core = await this.selected()
      if (this.closed) throw new Error('Native migration owner is closed')
      const result = await this.application.runtime.runPromiseExit(core.migrate(binding), {
        signal
      })
      if (Exit.isFailure(result)) throw this.failure(result.cause)
      return result.value
    })()
    this.inflight = operation
    this.inflightBinding = rendererWfBindingKey(binding)
    void operation
      .finally(() => {
        if (this.inflight === operation) {
          this.inflight = undefined
          this.inflightBinding = undefined
          this.abort = undefined
        }
      })
      .catch(() => {})
    return operation
  }
  async retryCleanup(): Promise<void> {
    if (this.released) return
    const core = await this.selected()
    const result = await this.application.runtime.runPromiseExit(core.recover)
    if (Exit.isFailure(result)) throw this.failure(result.cause)
  }
  close(): Promise<void> {
    this.closed = true
    this.abort?.abort(new Error('Native migration owner closing'))
    if (this.closing) return this.closing
    if (this.released) return Promise.resolve()
    const operation = (async () => {
      if (this.inflight) await Promise.allSettled([this.inflight])
      const core = await this.selected()
      const result = await this.application.runtime.runPromiseExit(core.close)
      if (Exit.isFailure(result)) throw this.failure(result.cause)
      await this.application.closeLegacy()
      this.released = true
    })()
    this.closing = operation
    void operation
      .finally(() => {
        if (this.closing === operation) this.closing = undefined
      })
      .catch(() => {})
    return operation
  }
  isReleased() {
    return this.released
  }
}

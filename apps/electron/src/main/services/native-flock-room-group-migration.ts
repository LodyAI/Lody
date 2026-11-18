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
  nativeMachineCatalogMigrationInputSchema,
  nativeMachineCatalogMigrationReceiptSchema
} from '@lody/shared/native-machine-catalog-migration'
import {
  nativeWorkspaceMetaMigrationInputSchema,
  nativeWorkspaceMetaMigrationReceiptSchema
} from '@lody/shared/native-workspace-meta-migration'
import {
  nativeScheduleRegistryMigrationInputSchema,
  nativeScheduleRegistryMigrationReceiptSchema
} from '@lody/shared/native-schedule-registry-migration'
import {
  rendererFlockGroupSchema,
  rendererFlockGroupKey,
  type RendererFlockGroup
} from '@lody/shared/renderer-flock-room-group'
import {
  readNativeWorkspaceMetaOwner,
  assertPublishedNativeWorkspaceMetaStorage,
  readNativeWorkspaceFlockOwner,
  assertPublishedNativeWorkspaceFlockStorage
} from './native-workspace-routing'
import type { RendererFlockRoomGroupMigrationMainLegacy } from './renderer-flock-room-group-migration'

type Pause = { stop(): Promise<void>; release(options?: { resume?: boolean }): void }
export type NativeFlockRoomGroupMigrationOptions = {
  domain: 'machine' | 'schedule' | 'meta'
  dataRoot: string
  renderer(): RendererFlockRoomGroupMigrationMainLegacy
  acquirePause(): Pause
  ensureData(binding: RendererFlockGroup): Promise<void>
  launch(): { executable: string; entry: string }
  helperTimeoutMs?: number
  workflowTimeoutMs?: number
  cleanupTimeoutMs?: number
}
export type NativeFlockRoomGroupMigrationResult = {
  owner: 'native'
  receipt?:
    | ReturnType<typeof nativeMachineCatalogMigrationReceiptSchema.parse>
    | ReturnType<typeof nativeScheduleRegistryMigrationReceiptSchema.parse>
    | ReturnType<typeof nativeWorkspaceMetaMigrationReceiptSchema.parse>
}
type Api = {
  migrate(
    binding: RendererFlockGroup
  ): Effect.Effect<
    NativeFlockRoomGroupMigrationResult,
    unknown,
    ChildProcessSpawner.ChildProcessSpawner
  >
  recover: Effect.Effect<void, unknown>
  close: Effect.Effect<void, unknown>
}
export class NativeFlockRoomGroupMigration extends Context.Service<
  NativeFlockRoomGroupMigration,
  Api
>()('lody/electron/NativeFlockRoomGroupMigration') {}
const helperEnvironment = () => {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of ['PATH', 'HOME', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'])
    if (process.env[name]) env[name] = process.env[name]
  return env
}
const processReleases = (cause: Cause.Cause<unknown>) =>
  cause.reasons.flatMap((reason) =>
    Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed
      ? [reason.defect]
      : []
  )

/** Foreign Promise tracking is solely at the existing CLI/main I/O boundary. */
const makeMigration = Effect.fnUntraced(function* (options: NativeFlockRoomGroupMigrationOptions) {
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
  const migrate = Effect.fnUntraced(function* (bindingInput: RendererFlockGroup) {
    return yield* semaphore.withPermits(1)(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (closed) return yield* Effect.fail(new Error('Native migration owner is closed'))
          yield* restore(recover())
          const result = yield* restore(
            Effect.gen(function* () {
              const binding = yield* sync(() => {
                const parsed = rendererFlockGroupSchema.parse(bindingInput)
                if (parsed.domain !== options.domain)
                  throw new Error('Migration domain does not match the trusted owner')
                return parsed
              })
              const key = rendererFlockGroupKey(binding)
              if (identity && identity !== key)
                return yield* Effect.fail(
                  new Error('Native migration identity changed; close the previous owner first')
                )
              identity = key
              const renderer = yield* sync(options.renderer)
              const alreadyNative = yield* sync(() => {
                if (
                  rendererFlockGroupKey(renderer.group) !== key ||
                  renderer.status().owner !== 'native'
                )
                  return false
                for (const roomId of binding.roomIds) {
                  const room = {
                    accountId: binding.accountId,
                    workspaceId: binding.workspaceId,
                    roomId,
                    contentMode: 'plaintext' as const
                  }
                  const owner =
                    options.domain === 'meta'
                      ? readNativeWorkspaceMetaOwner(options.dataRoot, room)
                      : readNativeWorkspaceFlockOwner(options.dataRoot, room)
                  if (owner !== 'native') return false
                  if (options.domain === 'meta')
                    assertPublishedNativeWorkspaceMetaStorage(options.dataRoot, room)
                  else assertPublishedNativeWorkspaceFlockStorage(options.dataRoot, room)
                }
                return true
              })
              if (alreadyNative) {
                if (pause) {
                  yield* sync(() => pause!.release())
                  pause = undefined
                }
                return { owner: 'native' as const }
              }
              if (options.domain === 'meta') {
                const launch = yield* sync(options.launch)
                const output = yield* runCommandOk({
                  command: launch.executable,
                  args: [launch.entry, '--inspect-external-metadata-capability'],
                  env: helperEnvironment(),
                  timeout: helperMs,
                  maxOutputBytes: 8192
                })
                yield* sync(() => {
                  const value: unknown = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(output.stdout)
                  )
                  if (
                    !value ||
                    typeof value !== 'object' ||
                    Array.isArray(value) ||
                    Object.keys(value).length !== 2 ||
                    !('capability' in value) ||
                    value.capability !== 'loro-external-metadata-v1' ||
                    !('available' in value) ||
                    value.available !== true
                  )
                    throw new Error('Verified external metadata SDK capability is unavailable')
                })
              }
              if (options.domain === 'machine' && renderer.status().owner === 'legacy') {
                const launch = yield* sync(options.launch)
                const input = yield* sync(() =>
                  nativeMachineCatalogMigrationInputSchema.parse({
                    version: 1,
                    dataRoot: options.dataRoot,
                    group: binding,
                    revision: 'preflight',
                    sources: []
                  })
                )
                // This read-only child belongs to the same Scope/process owner as
                // the authoring helper: even a failed termination remains retryable.
                const output = yield* runCommandOk({
                  command: launch.executable,
                  args: [launch.entry, '--inspect-local-machine-catalog'],
                  env: helperEnvironment(),
                  input: JSON.stringify(input),
                  timeout: helperMs,
                  maxOutputBytes: 8192
                })
                yield* sync(() => {
                  const value: unknown = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(output.stdout)
                  )
                  if (
                    !value ||
                    typeof value !== 'object' ||
                    !('otherMachineOwners' in value) ||
                    !Array.isArray(value.otherMachineOwners) ||
                    value.otherMachineOwners.length
                  )
                    throw new Error('MF first batch requires a complete single-machine inventory')
                })
              }
              // Platform/format/packaging preflight cannot freeze an otherwise healthy
              // legacy UI. It opens only the independent host, never authors MF.
              yield* io(() => options.ensureData(binding))
              if (!pause) pause = yield* sync(options.acquirePause)
              yield* io(() => pause!.stop())
              const frozen = yield* io((signal) => renderer.freeze(signal))
              const input = yield* sync(() =>
                options.domain === 'machine'
                  ? nativeMachineCatalogMigrationInputSchema.parse({
                      version: 1,
                      group: binding,
                      dataRoot: options.dataRoot,
                      revision: frozen.revision,
                      sources: frozen.windows.flatMap((window) =>
                        window.inventory[0]!.sources.map((source) => ({
                          sourceId: `window:${window.windowId}:${window.registrationId}:${source.sourceId}`,
                          metaSnapshotBase64: Buffer.from(source.metaSnapshot!).toString('base64'),
                          rooms: window.inventory.map((room) => {
                            const exact = room.sources.find(
                              (value) =>
                                value.sourceId === source.sourceId && value.dbName === source.dbName
                            )
                            if (!exact) throw new Error('Incomplete all-window MF source set')
                            return {
                              roomId: room.roomId,
                              snapshotBase64: Buffer.from(exact.snapshot).toString('base64')
                            }
                          })
                        }))
                      )
                    })
                  : (options.domain === 'meta'
                      ? nativeWorkspaceMetaMigrationInputSchema
                      : nativeScheduleRegistryMigrationInputSchema
                    ).parse({
                      version: 1,
                      group: binding,
                      dataRoot: options.dataRoot,
                      revision: frozen.revision,
                      sources: frozen.windows.flatMap((window) =>
                        window.inventory[0]!.sources.map((source) => ({
                          sourceId: `window:${window.windowId}:${window.registrationId}:${source.sourceId}`,
                          present: source.present,
                          snapshotBase64: Buffer.from(source.snapshot).toString('base64')
                        }))
                      )
                    })
              )
              const launch = yield* sync(options.launch)
              const output = yield* runCommandOk({
                command: launch.executable,
                args: [launch.entry],
                env: helperEnvironment(),
                input: JSON.stringify(input),
                timeout: helperMs,
                maxOutputBytes: 8 * 1024
              })
              const receipt = yield* sync(() =>
                (options.domain === 'machine'
                  ? nativeMachineCatalogMigrationReceiptSchema
                  : options.domain === 'meta'
                    ? nativeWorkspaceMetaMigrationReceiptSchema
                    : nativeScheduleRegistryMigrationReceiptSchema
                ).parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.stdout)))
              )
              yield* sync(() => renderer.assertFrozen(frozen.revision))
              yield* io(() => renderer.complete(frozen.revision))
              yield* sync(() => pause!.release())
              pause = undefined
              return { owner: 'native' as const, receipt }
            }).pipe(Effect.timeout(workflowMs), Effect.exit)
          )
          if (Exit.isFailure(result)) {
            // A rejected read-only preflight has not frozen any producer or
            // launched an authoring helper. Restore that exact pause lease.
            const legacy = yield* sync(() => {
              const renderer = options.renderer()
              return (
                renderer.status().owner === 'legacy' &&
                renderer.group.roomIds.every(
                  (roomId) =>
                    (options.domain === 'meta'
                      ? readNativeWorkspaceMetaOwner
                      : readNativeWorkspaceFlockOwner)(options.dataRoot, {
                      accountId: renderer.group.accountId,
                      workspaceId: renderer.group.workspaceId,
                      roomId,
                      contentMode: 'plaintext'
                    }) === 'legacy'
                )
              )
            })
            if (
              legacy &&
              pause &&
              pendingIo.size === 0 &&
              processReleases(result.cause).length === 0
            ) {
              yield* sync(() => pause!.release())
              pause = undefined
            }
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
export const nativeFlockRoomGroupMigrationLayer = (options: NativeFlockRoomGroupMigrationOptions) =>
  Layer.effect(NativeFlockRoomGroupMigration, makeMigration(options))

export class NativeFlockRoomGroupMigrationFailure extends Error {
  constructor(
    readonly effectCause: Cause.Cause<unknown>,
    readonly retryCleanup: () => Promise<void>
  ) {
    super('Native Flock room group migration failed', { cause: squashProcessFailure(effectCause) })
  }
}
/** @deprecated Main Promise composition; delete once ready/quit consume the native application Layer. */
export class NativeFlockRoomGroupMigrationLegacy {
  private readonly application
  private core: Api | undefined
  private inflight: Promise<NativeFlockRoomGroupMigrationResult> | undefined
  private inflightBinding: string | undefined
  private abort: AbortController | undefined
  private closing: Promise<void> | undefined
  private closed = false
  private released = false
  constructor(
    options: NativeFlockRoomGroupMigrationOptions,
    private readonly platform: ProcessFacadeOptions = {}
  ) {
    this.application = makeApplicationRuntime(
      nativeFlockRoomGroupMigrationLayer(options).pipe(Layer.provideMerge(processLayer(platform))),
      {
        project: (cause) =>
          new NativeFlockRoomGroupMigrationFailure(cause, () => this.retryCleanup()),
        recover: (cause) => (this.core ? this.core.close : Effect.failCause(cause))
      }
    )
  }
  private failure(cause: Cause.Cause<unknown>) {
    return new NativeFlockRoomGroupMigrationFailure(cause, () => this.retryCleanup())
  }
  private async selected(): Promise<Api> {
    if (this.core) return this.core
    const selected = await this.application.runtime.runPromiseExit(NativeFlockRoomGroupMigration)
    if (Exit.isFailure(selected)) throw this.failure(selected.cause)
    return (this.core = selected.value)
  }
  migrate(binding: RendererFlockGroup): Promise<NativeFlockRoomGroupMigrationResult> {
    if (this.closed) return Promise.reject(new Error('Native migration owner is closed'))
    if (this.inflight)
      return this.inflightBinding === rendererFlockGroupKey(binding)
        ? this.inflight
        : Promise.reject(new Error('Another native machine migration is active'))
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
    this.inflightBinding = rendererFlockGroupKey(binding)
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

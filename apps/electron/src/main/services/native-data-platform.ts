import { Effect } from 'effect'
import type { LocalNativeFileIndexSource } from '@lody/shared/local-loro-data-plane-server'
import type { RepoClient, RoomKey, SyncReport } from '@loro-dev/loro-repo-client'
import type { IndependentRepoLeaseInfo } from '@lody/shared/node/native-repo-independent-legacy'

/** Trusted Node composition only; never imported by renderer or IPC contracts. */
export type DesktopNativeDataContext = {
  readonly platform: 'local' | 'cloud'
  readonly auth: {
    getCachedSessionIdentity(): { userId: string | null; generation: number }
    subscribeCachedSessionIdentity(listener: () => void): () => void
    getSessionToken(): Promise<string | null>
    convexToken(options: undefined, signal: AbortSignal): Promise<unknown>
  }
  readonly deploymentUrl: string
  readonly authSiteUrl: string
  readonly dataRoot: string
  readonly launch: { readonly executable: string; readonly entry: string }
  readonly requiredSdkArtifactId: string
}
export type DesktopNativeWorkspaceSelection = {
  readonly expectedAccountId: string
  readonly workspaceId: string
  readonly contentMode: 'plaintext'
  /** Main domain authorization and whole-room migration decide this exact set.
   * Factory availability and a renderer-supplied room list grant no authority. */
  readonly rooms: readonly RoomKey[]
  readonly remoteId: string
}
export type DesktopNativeWorkspaceGrant = {
  assertCurrent(): void
  borrowNodeClient(): Promise<{
    readonly client: RepoClient
    readonly info: IndependentRepoLeaseInfo
    readonly generation: string
    assertCurrent(): void
    close(): Promise<void>
  }>
  /** One actual room receipt, never aggregate remote health as authority. */
  syncRoom(
    room: RoomKey,
    signal?: AbortSignal
  ): Promise<{ readonly room: RoomKey; isCurrent(): Promise<boolean> }>
  syncRound(): Promise<SyncReport>
  reconnect(): Promise<void>
  close(): Promise<void>
  retryCleanup(): Promise<void>
}
export type DesktopNativeFileIndexReader = {
  readonly workspaceId: string
  readonly generation: string
  readonly source: LocalNativeFileIndexSource
  assertCurrent(): void
  close(): Promise<void>
}
export type DesktopNativeDataPlatform = {
  openWorkspace(
    selection: DesktopNativeWorkspaceSelection,
    signal: AbortSignal
  ): Promise<DesktopNativeWorkspaceGrant>
  openFileIndexReader?(
    selection: { readonly expectedAccountId: string; readonly workspaceId: string },
    signal: AbortSignal
  ): Promise<DesktopNativeFileIndexReader | null>
  close(): Promise<void>
}
/** Pure synchronous installation; network work belongs to openWorkspace. */
export type DesktopNativeDataPlatformFactory = (
  context: DesktopNativeDataContext
) => DesktopNativeDataPlatform
let installed: DesktopNativeDataInstallationLegacy | undefined
let bootFactory: DesktopNativeDataPlatformFactory | undefined
export class DesktopNativeDataReleaseFailed extends Error {
  constructor(
    readonly owner: DesktopNativeDataInstallationLegacy,
    override readonly cause: unknown
  ) {
    super('Desktop native data cleanup remains unconfirmed')
  }
}
/** @deprecated Promise application composition until application owns this Scope.
 * One boot installation retains every original late grant and failed cleanup. */
export class DesktopNativeDataInstallationLegacy {
  private closed = false
  private closing: Promise<void> | undefined
  private readonly controller = new AbortController()
  private readonly platforms = new Set<DesktopNativeDataPlatform>()
  private readonly grants = new Set<DesktopNativeWorkspaceGrant>()
  private readonly readers = new Set<DesktopNativeFileIndexReader>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly releases = new Map<
    { close(): Promise<void> },
    { promise: Promise<void>; failed: boolean; after: Set<() => void> }
  >()
  private release(owner: { close(): Promise<void> }, after: () => void): Promise<void> {
    const prior = this.releases.get(owner)
    if (prior && !prior.failed) {
      prior.after.add(after)
      return prior.promise
    }
    const receipt = { promise: Promise.resolve(), failed: false, after: new Set([after]) }
    receipt.promise = Promise.resolve()
      .then(() => owner.close())
      .then(
        () => {
          for (const done of receipt.after) done()
          if (this.releases.get(owner) === receipt) this.releases.delete(owner)
        },
        (error) => {
          receipt.failed = true
          throw error
        }
      )
    this.releases.set(owner, receipt)
    void receipt.promise.catch(() => {})
    return receipt.promise
  }
  constructor(private readonly factory: DesktopNativeDataPlatformFactory) {}
  resolve(
    context: DesktopNativeDataContext
  ): Pick<DesktopNativeDataPlatform, 'openWorkspace' | 'openFileIndexReader'> {
    if (this.closed) throw new Error('Desktop native data installation retired')
    const platform = this.factory(context)
    this.platforms.add(platform)
    const openReader = platform.openFileIndexReader?.bind(platform)
    return {
      ...(openReader
        ? {
            openFileIndexReader: (
              selection: { expectedAccountId: string; workspaceId: string },
              signal: AbortSignal
            ) => {
              if (this.closed)
                return Promise.reject(new Error('Desktop native data installation retired'))
              const captured = { ...selection }
              let operation: Promise<DesktopNativeFileIndexReader | null>
              operation = (async () => {
                const reader = await openReader(
                  captured,
                  AbortSignal.any([signal, this.controller.signal])
                )
                if (!reader) return null
                this.readers.add(reader)
                const release = () => this.release(reader, () => this.readers.delete(reader))
                if (this.closed || signal.aborted) {
                  try {
                    await release()
                  } catch (error) {
                    throw new DesktopNativeDataReleaseFailed(this, error)
                  }
                  throw new Error('Desktop native data reader retired during admission')
                }
                const check = () => {
                  if (this.closed) throw new Error('Desktop native data installation retired')
                  reader.assertCurrent()
                }
                return {
                  workspaceId: reader.workspaceId,
                  generation: reader.generation,
                  assertCurrent: check,
                  source: {
                    subscribe: (
                      owner: string,
                      listener: Parameters<LocalNativeFileIndexSource['subscribe']>[1]
                    ) => {
                      check()
                      return reader.source.subscribe(owner, listener)
                    }
                  },
                  close: release
                }
              })().finally(() => this.pending.delete(operation))
              this.pending.add(operation)
              return operation
            }
          }
        : {}),
      openWorkspace: (selection, signal) => {
        if (this.closed)
          return Promise.reject(new Error('Desktop native data installation retired'))
        const captured = { ...selection, rooms: selection.rooms.map((room) => ({ ...room })) }
        let operation: Promise<DesktopNativeWorkspaceGrant>
        operation = (async () => {
          const grant = await platform.openWorkspace(
            captured,
            AbortSignal.any([signal, this.controller.signal])
          )
          this.grants.add(grant)
          if (this.closed) {
            try {
              await this.release(grant, () => this.grants.delete(grant))
            } catch (error) {
              throw new DesktopNativeDataReleaseFailed(this, error)
            }
            throw new Error('Desktop native data installation retired')
          }
          return grant
        })().finally(() => this.pending.delete(operation))
        this.pending.add(operation)
        return operation
      }
    }
  }
  close(): Promise<void> {
    this.closed = true
    this.controller.abort()
    if (this.closing) return this.closing
    const workflow = Effect.gen({ self: this }, function* () {
      // Timeout ends only the waiter; pending opens stay owned and late grants
      // are fenced above. Retry joins those same operations, never reopens them.
      yield* Effect.promise(() => Promise.allSettled([...this.pending])).pipe(
        Effect.timeout('5 seconds')
      )
      const results = yield* Effect.promise(() =>
        Promise.allSettled([
          ...[...this.readers].map((reader) =>
            this.release(reader, () => this.readers.delete(reader))
          ),
          ...[...this.grants].map((grant) => this.release(grant, () => this.grants.delete(grant))),
          ...[...this.platforms].map((platform) =>
            this.release(platform, () => this.platforms.delete(platform))
          )
        ])
      ).pipe(Effect.timeout('5 seconds'))
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length)
        return yield* Effect.fail(
          new AggregateError(failures, 'Desktop native original owners failed release')
        )
      if (installed === this) installed = undefined
    })
    const attempt = Effect.runPromiseExit(workflow).then((exit) => {
      if (exit._tag === 'Failure') throw new DesktopNativeDataReleaseFailed(this, exit.cause)
    })
    this.closing = attempt
    void attempt
      .finally(() => {
        if (this.closing === attempt) this.closing = undefined
      })
      .catch(() => {})
    return attempt
  }
  async retryCleanup() {
    await this.close()
  }
}
/** A second boot owner cannot replace an installation before actual release. */
export function installDesktopNativeDataPlatformFactoryLegacy(
  factory: DesktopNativeDataPlatformFactory
) {
  if (installed) throw new Error('Desktop native data installation already owned')
  const owner = new DesktopNativeDataInstallationLegacy(factory)
  installed = owner
  bootFactory = factory
  return owner
}
/** Default null; local composition never invokes even an installed Cloud factory. */
export function resolveDesktopNativeDataPlatformLegacy(context: DesktopNativeDataContext) {
  if (context.platform === 'local') return null
  return installed?.resolve(context) ?? null
}

/** Installation presence is not workspace permission or SDK capability. */
export function hasDesktopNativeDataPlatformLegacy(): boolean {
  return installed !== undefined
}
/** Main quit boundary; failed cleanup keeps the exact installation for retry. */
export async function closeInstalledDesktopNativeDataPlatformLegacy(): Promise<void> {
  const owner = installed
  if (owner) await owner.close()
}

/** Rebuild only the original boot provider after its old owners really closed.
 * A failed/unknown release remains installed and prevents replacement. */
export async function recoverInstalledDesktopNativeDataPlatformLegacy() {
  const originalFactory = bootFactory
  const originalOwner = installed
  if (originalOwner) await originalOwner.retryCleanup()
  if (installed) throw new Error('Desktop native data original cleanup remains owned')
  return originalFactory
    ? installDesktopNativeDataPlatformFactoryLegacy(originalFactory)
    : undefined
}

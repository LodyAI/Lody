import { randomUUID } from 'node:crypto'
import type { RepoClient } from '@loro-dev/loro-repo-client'
import type { WorkspaceId } from '@lody/shared'
import { createNativeWorkspaceMeta } from '@lody/shared/node/native-workspace-meta'
import type { NativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility'

type Meta = ReturnType<typeof createNativeWorkspaceMeta>
export type NativeWorkspaceMetaMainGrant = {
  readonly binding: { accountId: string; workspaceId: WorkspaceId }
  readonly generation: string
  readonly client: RepoClient
  readonly sdkCompatibility: NativeRepoSdkCompatibility
  readonly sdkArtifactId: string
  assertCurrent(): void
}
type Owned = {
  grant: NativeWorkspaceMetaMainGrant
  backend: Meta & {
    readonly owner: 'native'
    readonly binding: NativeWorkspaceMetaMainGrant['binding']
  }
  ready: boolean
}
/** Trusted main-only Meta port shared by Session and metadata domain services.
 * The app data lease owns the SDK connection; this facade releases only its
 * subscriptions and never returns its complete metadata to a renderer. */
export class NativeWorkspaceMetaOwnerLegacy {
  private closed = false
  private current: Owned | undefined
  private opening: Promise<Owned> | undefined
  private binding: string | undefined
  constructor(
    private readonly options: {
      acquire(): Promise<NativeWorkspaceMetaMainGrant>
      closeTimeoutMs?: number
    }
  ) {}
  private check(owner: Owned) {
    if (this.closed || this.current !== owner || owner.grant.client.connectionState !== 'connected')
      throw new Error('Native Meta generation retired')
    owner.grant.assertCurrent()
  }
  async get(): Promise<Owned['backend']> {
    if (this.closed) throw new Error('Native Meta owner is closed')
    if (this.opening) return (await this.opening).backend
    if (this.current) {
      try {
        this.check(this.current)
        if (this.current.ready && !this.current.backend.isWriteBlocked())
          return this.current.backend
      } catch {
        // Replacement below first confirms release of this original owner.
      }
    }
    if (!this.opening) {
      this.opening = (async () => {
        if (this.current) {
          const previous = this.current
          await previous.backend.close()
          if (this.current === previous) this.current = undefined
        }
        if (this.closed) throw new Error('Native Meta owner is closed')
        const grant = await this.options.acquire()
        grant.assertCurrent()
        const binding = JSON.stringify([grant.binding.accountId, grant.binding.workspaceId])
        if (this.binding && this.binding !== binding)
          throw new Error('Native Meta identity changed')
        this.binding = binding
        // Retain before starting any asynchronous observation/read.
        const owned: Owned = {
          grant,
          backend: undefined as unknown as Owned['backend'],
          ready: false
        }
        owned.backend = Object.assign(
          createNativeWorkspaceMeta({
            ...grant,
            generation: JSON.stringify([grant.generation, randomUUID()]),
            assertCurrent: () => this.check(owned),
            closeTimeoutMs: this.options.closeTimeoutMs
          }),
          { owner: 'native' as const, binding: grant.binding }
        )
        this.current = owned
        if (this.closed) throw new Error('Native Meta acquisition retired')
        await owned.backend.externalMetadata.read()
        this.check(owned)
        owned.ready = true
        return owned
      })().finally(() => {
        this.opening = undefined
      })
    }
    return (await this.opening).backend
  }
  async close(): Promise<void> {
    this.closed = true
    const opened = this.opening
    // Even an acquisition that rejects can have installed the original owner.
    await opened?.catch(() => {})
    if (this.current) {
      await this.current.backend.close()
      this.current = undefined
    }
  }
}

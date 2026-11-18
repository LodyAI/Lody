import { randomUUID } from 'node:crypto'
import { createNativeWorkspaceCatalogOwner } from '@lody/shared/node/native-workspace-catalog'
import {
  WorkspaceCatalogError,
  type WorkspaceCatalogUpdate,
  type WorkspaceCatalogObservation
} from '@lody/shared'
import {
  parseWorkspaceCatalogIpcCommand,
  type WorkspaceCatalogIpcEvent
} from '@lody/shared/workspace-catalog-ipc'
import type { RendererWfBinding } from '@lody/shared/renderer-room-migration'
import { rendererWfBindingKey } from '@lody/shared/renderer-room-migration'
import {
  readNativeWorkspaceFlockOwner,
  assertPublishedNativeWorkspaceFlockStorage
} from './native-workspace-routing'
import type { LocalNativeRepoLeaseServiceLegacy } from './local-native-repo-lease'
import type { RendererWorkspaceFlockMigrationMainLegacy } from './renderer-workspace-flock-migration'

type Slot = {
  windowId: number
  registrationId: string
  requestId: string
  leaseId: string
  closing: boolean
  acquisition?: Promise<void>
  observation?: WorkspaceCatalogObservation
  release?: Promise<void>
}
type Options = {
  dataRoot: string
  lease(): Pick<LocalNativeRepoLeaseServiceLegacy, 'client'> | null
  migration(): RendererWorkspaceFlockMigrationMainLegacy | null
  send(windowId: number, event: WorkspaceCatalogIpcEvent): void
}
/** Fixed local wf domain only; raw rows, SDK clients, credentials and exact Role grants stay in Node. */
export class NativeWorkspaceCatalogMainLegacy {
  private readonly options: Options
  private closed = false
  private readonly owners = new Map<string, ReturnType<typeof createNativeWorkspaceCatalogOwner>>()
  private readonly slots = new Map<string, Slot>()
  constructor(options: Options) {
    this.options = options
  }
  private check(windowId: number, registrationId: string, binding: RendererWfBinding): void {
    if (this.closed)
      throw new WorkspaceCatalogError('restart_required', 'Native catalog service closed')
    const migration = this.options.migration()
    if (!migration) throw new Error('Native catalog registration owner unavailable')
    migration.assertRegistration(windowId, registrationId, binding)
    if (
      migration.status(binding).owner !== 'native' ||
      readNativeWorkspaceFlockOwner(this.options.dataRoot, binding) !== 'native'
    )
      throw new Error('Native workspace catalog is not the committed room owner')
    assertPublishedNativeWorkspaceFlockStorage(this.options.dataRoot, binding)
  }
  private select(windowId: number, registrationId: string, binding: RendererWfBinding) {
    this.check(windowId, registrationId, binding)
    const key = JSON.stringify([windowId, registrationId, rendererWfBindingKey(binding)])
    let owner = this.owners.get(key)
    if (!owner) {
      if (this.owners.size >= 64)
        throw new WorkspaceCatalogError(
          'cleanup_unconfirmed',
          'Native catalog owner capacity is exhausted'
        )
      owner = createNativeWorkspaceCatalogOwner({
        namespace: binding.workspaceId,
        binding: {
          accountId: binding.accountId,
          workspaceId: binding.workspaceId as import('@lody/shared').WorkspaceId
        },
        getClient: async () => {
          this.check(windowId, registrationId, binding)
          const lease = this.options.lease()
          if (!lease) throw new Error('Native data host unavailable')
          const client = await lease.client(binding)
          this.check(windowId, registrationId, binding)
          return client
        },
        authorize: () => {
          try {
            this.check(windowId, registrationId, binding)
            return true
          } catch {
            return false
          }
        },
        // Local OSS data, not a remote authoritative/sync receipt. No exact Role lookup grant.
        authority: {
          current: () => {
            try {
              this.check(windowId, registrationId, binding)
              return true
            } catch {
              return false
            }
          },
          subscribe: () => () => {}
        },
        confirmUpload: async () => {
          this.check(windowId, registrationId, binding)
        }
      })
      this.owners.set(key, owner)
    }
    return owner
  }
  async read(windowId: number, registrationId: string, binding: RendererWfBinding) {
    return this.select(windowId, registrationId, binding).read({
      accountId: binding.accountId,
      workspaceId: binding.workspaceId as import('@lody/shared').WorkspaceId
    })
  }
  async execute(
    windowId: number,
    registrationId: string,
    binding: RendererWfBinding,
    payload: unknown
  ) {
    const owner = this.select(windowId, registrationId, binding)
    const command = parseWorkspaceCatalogIpcCommand(payload)
    if (command.kind === 'reconcile-role-schema') return { changed: false }
    return owner.execute(
      {
        accountId: binding.accountId,
        workspaceId: binding.workspaceId as import('@lody/shared').WorkspaceId
      },
      command
    )
  }
  async upload(windowId: number, registrationId: string, binding: RendererWfBinding) {
    await this.select(windowId, registrationId, binding).upload({
      accountId: binding.accountId,
      workspaceId: binding.workspaceId as import('@lody/shared').WorkspaceId
    })
  }
  observe(
    windowId: number,
    registrationId: string,
    binding: RendererWfBinding,
    requestId: string
  ): Promise<{ leaseId: string }> {
    const owner = this.select(windowId, registrationId, binding)
    const key = JSON.stringify([windowId, registrationId, requestId])
    const existing = this.slots.get(key)
    if (existing) {
      if (existing.closing) return Promise.reject(new Error('Catalog observation is retiring'))
      return existing.acquisition!.then(() => ({ leaseId: existing.leaseId }))
    }
    if ([...this.slots.values()].filter((slot) => slot.windowId === windowId).length >= 64)
      return Promise.reject(new Error('Catalog observation capacity exceeded'))
    const slot: Slot = {
      windowId,
      registrationId,
      requestId,
      leaseId: randomUUID(),
      closing: false
    }
    this.slots.set(key, slot)
    const publish = (update: WorkspaceCatalogUpdate) => {
      if (slot.closing || this.closed) return
      this.check(windowId, registrationId, binding)
      this.options.send(windowId, {
        registrationId,
        requestId,
        leaseId: slot.leaseId,
        type: 'snapshot',
        update
      })
    }
    slot.acquisition = (async () => {
      try {
        slot.observation = await owner.observe(
          {
            accountId: binding.accountId,
            workspaceId: binding.workspaceId as import('@lody/shared').WorkspaceId
          },
          publish,
          () => {
            if (!slot.closing && !this.closed)
              try {
                this.options.send(windowId, {
                  registrationId,
                  requestId,
                  leaseId: slot.leaseId,
                  type: 'error',
                  code: 'restart_required'
                })
              } catch {
                // A retired frame cannot receive the error. Its retained
                // slot still owns actual SDK cleanup and is retried on quit.
                void this.release(key, slot).catch(() => {})
              }
          }
        )
        if (slot.closing) await slot.observation.close()
      } catch (cause) {
        // The shared owner retains failed SDK cleanup; do not discard its owner.
        if (!slot.observation) this.slots.delete(key)
        throw cause
      }
    })()
    return slot.acquisition.then(() => ({ leaseId: slot.leaseId }))
  }
  private release(key: string, slot: Slot): Promise<void> {
    slot.closing = true
    if (slot.release) return slot.release
    const operation = (async () => {
      try {
        await slot.acquisition
      } catch {}
      await slot.observation?.close()
      if (this.slots.get(key) === slot) this.slots.delete(key)
    })()
    slot.release = operation
    void operation.catch(() => {
      if (slot.release === operation) slot.release = undefined
    })
    return operation
  }
  async unsubscribe(
    windowId: number,
    registrationId: string,
    requestId: string,
    leaseId: string
  ): Promise<void> {
    const key = JSON.stringify([windowId, registrationId, requestId])
    const slot = this.slots.get(key)
    if (!slot || slot.leaseId !== leaseId) return
    await this.release(key, slot)
  }
  async retire(windowId: number, registrationId?: string): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.slots]
        .filter(
          ([, slot]) =>
            slot.windowId === windowId &&
            (!registrationId || slot.registrationId === registrationId)
        )
        .map(([key, slot]) => this.release(key, slot)),
      ...[...this.owners]
        .filter(([key]) => {
          const value = JSON.parse(key)
          return value[0] === windowId && (!registrationId || value[1] === registrationId)
        })
        .map(async ([key, owner]) => {
          await owner.close()
          this.owners.delete(key)
        })
    ])
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length) throw new AggregateError(errors, 'Native catalog window release failed')
  }
  async close(): Promise<void> {
    this.closed = true
    const windows = new Set([...this.slots.values()].map((slot) => slot.windowId))
    for (const key of this.owners.keys()) windows.add(JSON.parse(key)[0])
    const results = await Promise.allSettled([...windows].map((id) => this.retire(id)))
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length) throw new AggregateError(errors, 'Native catalog owner release failed')
  }
}

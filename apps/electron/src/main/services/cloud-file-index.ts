import { waitForCleanup } from '../utils'
import { randomUUID } from 'node:crypto'
import {
  CloudFileIndexIpcError,
  cloudFileIndexEventSchema,
  parseCloudFileIndexInput,
  type CloudFileIndexEvent,
  type CloudFileIndexRequest,
  type CloudFileIndexRelease,
  type CloudFileIndexObserved
} from '@lody/shared/cloud-file-index-ipc'
import type { LocalNativeFileIndexSource } from '@lody/shared/local-loro-data-plane-server'

export type CloudFileIndexMainGrant = {
  readonly workspaceId: string
  readonly generation: string
  readonly source: LocalNativeFileIndexSource
  assertCurrent(): void
  /** Releases this borrowed source only; must never retire the workspace/host. */
  release(): Promise<void>
}
type Slot = {
  windowId: number
  request: CloudFileIndexRequest
  leaseId: string
  retiring: boolean
  grant?: CloudFileIndexMainGrant
  observer?: { release(): Promise<void> }
  opening: Promise<CloudFileIndexObserved>
  closing?: Promise<void>
}
/** Read-only ordinary Cloud projection. The composition supplies authenticated,
 * workspace-bound authority; this facade owns only per-request observation borrows. */
export class CloudFileIndexMainLegacy {
  private closed = false
  private readonly slots = new Map<string, Slot>()
  private readonly retiringWindows = new Set<number>()
  private readonly retirements = new Map<number, Promise<void>>()
  private readonly canceled = new Map<number, Set<string>>()
  constructor(
    private readonly options: {
      acquire(windowId: number, workspaceId: string): Promise<CloudFileIndexMainGrant | null>
      send(windowId: number, event: CloudFileIndexEvent): void
      cleanupTimeoutMs?: number
    }
  ) {}
  private send(windowId: number, event: CloudFileIndexEvent): void {
    try {
      this.options.send(windowId, event)
    } catch {
      /* A retired view cannot break a shared source. */
    }
  }
  private key(windowId: number, requestId: string): string {
    return JSON.stringify([windowId, requestId])
  }
  private check(slot: Slot): void {
    if (
      this.closed ||
      this.retiringWindows.has(slot.windowId) ||
      slot.retiring ||
      this.canceled.get(slot.windowId)?.has(slot.request.requestId)
    )
      throw new CloudFileIndexIpcError('restart_required')
    slot.grant?.assertCurrent()
  }
  private bounded<T>(work: Promise<T>): Promise<T> {
    return waitForCleanup(
      work,
      this.options.cleanupTimeoutMs ?? 10000,
      () => new CloudFileIndexIpcError('cleanup_unconfirmed')
    )
  }
  private async cleanup(slot: Slot): Promise<void> {
    if (slot.closing) return slot.closing
    slot.retiring = true
    slot.closing = (async () => {
      if (slot.observer) {
        await slot.observer.release()
        slot.observer = undefined
      }
      if (slot.grant) {
        await slot.grant.release()
        slot.grant = undefined
      }
      if (this.slots.get(this.key(slot.windowId, slot.request.requestId)) === slot)
        this.slots.delete(this.key(slot.windowId, slot.request.requestId))
    })().finally(() => {
      slot.closing = undefined
    })
    return slot.closing
  }
  async observe(windowId: number, request: CloudFileIndexRequest): Promise<CloudFileIndexObserved> {
    if (
      this.closed ||
      this.retiringWindows.has(windowId) ||
      this.canceled.get(windowId)?.has(request.requestId)
    )
      throw new CloudFileIndexIpcError('restart_required')
    const key = this.key(windowId, request.requestId)
    const prior = this.slots.get(key)
    if (prior) {
      if (
        prior.request.workspaceId !== request.workspaceId ||
        prior.request.ownerSessionId !== request.ownerSessionId
      )
        throw new CloudFileIndexIpcError('invalid_request')
      this.check(prior)
      return prior.opening
    }
    const active = [...this.slots.values()].filter((s) => s.windowId === windowId)
    // Reserve one tombstone for every live acquisition before it can outlive a
    // frame. Never evict an old cancellation to admit a stale replay.
    const known = new Set(this.canceled.get(windowId))
    for (const slot of active) known.add(slot.request.requestId)
    if (active.length >= 64 || known.size >= 256) throw new CloudFileIndexIpcError('unavailable')
    const slot: Slot = {
      windowId,
      request,
      leaseId: randomUUID(),
      retiring: false,
      opening: undefined as unknown as Promise<CloudFileIndexObserved>
    }
    this.slots.set(key, slot)
    slot.opening = (async () => {
      try {
        slot.grant = (await this.options.acquire(windowId, request.workspaceId)) ?? undefined
        this.check(slot)
        if (!slot.grant) {
          await this.cleanup(slot)
          return { backend: 'legacy' as const }
        }
        if (slot.grant.workspaceId !== request.workspaceId)
          throw new CloudFileIndexIpcError('access_denied')
        const grant = slot.grant
        slot.observer =
          (await grant.source.subscribe(request.ownerSessionId, (state) => {
            try {
              this.check(slot)
            } catch {
              if (!slot.retiring)
                this.send(windowId, {
                  ...request,
                  leaseId: slot.leaseId,
                  generation: grant.generation,
                  state: { status: 'error', code: 'access_denied' }
                })
              return
            }
            try {
              this.send(
                windowId,
                parseCloudFileIndexInput(cloudFileIndexEventSchema, {
                  ...request,
                  leaseId: slot.leaseId,
                  generation: grant.generation,
                  state: state.status === 'error' ? { status: 'error', code: 'unavailable' } : state
                })
              )
            } catch {
              this.send(windowId, {
                ...request,
                leaseId: slot.leaseId,
                generation: grant.generation,
                state: { status: 'error', code: 'unavailable' }
              })
            }
          })) ?? undefined
        this.check(slot)
        if (!slot.observer) {
          await this.cleanup(slot)
          return { backend: 'legacy' as const }
        }
        return {
          ...request,
          backend: 'native' as const,
          leaseId: slot.leaseId,
          generation: grant.generation
        }
      } catch (error) {
        try {
          await this.cleanup(slot)
        } catch {
          throw new CloudFileIndexIpcError('cleanup_unconfirmed')
        }
        throw error instanceof CloudFileIndexIpcError ? error : new CloudFileIndexIpcError()
      }
    })()
    return slot.opening
  }
  async cancel(windowId: number, request: CloudFileIndexRequest): Promise<{ canceled: true }> {
    let canceled = this.canceled.get(windowId)
    if (!canceled) {
      canceled = new Set()
      this.canceled.set(windowId, canceled)
    }
    const known = new Set(canceled)
    for (const slot of this.slots.values())
      if (slot.windowId === windowId) known.add(slot.request.requestId)
    if (!known.has(request.requestId) && known.size >= 256)
      throw new CloudFileIndexIpcError('unavailable')
    canceled.add(request.requestId)
    const slot = this.slots.get(this.key(windowId, request.requestId))
    if (slot) {
      if (
        slot.request.workspaceId !== request.workspaceId ||
        slot.request.ownerSessionId !== request.ownerSessionId
      )
        throw new CloudFileIndexIpcError('invalid_request')
      slot.retiring = true
      await this.bounded(slot.opening.catch(() => undefined).then(() => this.cleanup(slot)))
    }
    return { canceled: true }
  }
  async unobserve(windowId: number, request: CloudFileIndexRelease): Promise<{ released: true }> {
    const slot = this.slots.get(this.key(windowId, request.requestId))
    if (!slot) return { released: true }
    if (
      slot.request.workspaceId !== request.workspaceId ||
      slot.request.ownerSessionId !== request.ownerSessionId ||
      slot.leaseId !== request.leaseId ||
      slot.grant?.generation !== request.generation
    )
      throw new CloudFileIndexIpcError('access_denied')
    await this.bounded(this.cleanup(slot))
    return { released: true }
  }
  retire(windowId: number): Promise<void> {
    const current = this.retirements.get(windowId)
    if (current) return current
    this.retiringWindows.add(windowId)
    const slots = [...this.slots.values()].filter((slot) => slot.windowId === windowId)
    const canceled = this.canceled.get(windowId) ?? new Set<string>()
    this.canceled.set(windowId, canceled)
    for (const slot of slots) {
      canceled.add(slot.request.requestId)
      if (slot.grant)
        this.send(windowId, {
          ...slot.request,
          leaseId: slot.leaseId,
          generation: slot.grant.generation,
          state: { status: 'error', code: 'access_denied' }
        })
      slot.retiring = true
    }
    const work = (async () => {
      const results = await Promise.allSettled(
        slots.map((slot) =>
          this.bounded(slot.opening.catch(() => undefined).then(() => this.cleanup(slot)))
        )
      )
      if (results.some((result) => result.status === 'rejected'))
        throw new CloudFileIndexIpcError('cleanup_unconfirmed')
      this.retiringWindows.delete(windowId)
      // Old request IDs stay fenced after reload. Another retire caller shares
      // this exact work and cannot clear the next frame's cancellation state.
    })().finally(() => {
      if (this.retirements.get(windowId) === work) this.retirements.delete(windowId)
    })
    this.retirements.set(windowId, work)
    return work
  }
  async close(): Promise<void> {
    this.closed = true
    const windows = new Set([...this.slots.values()].map((slot) => slot.windowId))
    const results = await Promise.allSettled([...windows].map((windowId) => this.retire(windowId)))
    if (results.some((result) => result.status === 'rejected'))
      throw new CloudFileIndexIpcError('cleanup_unconfirmed')
    this.canceled.clear()
  }
}

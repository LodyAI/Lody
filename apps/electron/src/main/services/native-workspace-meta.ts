import { waitForCleanup } from '../utils'
import { randomUUID } from 'node:crypto'
import type {
  createNativeWorkspaceMeta,
  NativeWorkspaceMetaCommand,
  NativeWorkspaceMetaSnapshot
} from '@lody/shared/node/native-workspace-meta'
import {
  WorkspaceMetaIpcError,
  workspaceMetaErrorCode,
  workspaceMetaCommandSchema,
  projectWorkspaceMetaPublicSnapshot,
  type WorkspaceMetaScope,
  type WorkspaceMetaEvent,
  type WorkspaceMetaPublicCommand
} from '@lody/shared/native-workspace-meta-ipc'
type Metadata = ReturnType<typeof createNativeWorkspaceMeta>
export type NativeWorkspaceMetaMainGrant = {
  readonly generation: string
  readonly binding: { readonly accountId: string; readonly workspaceId: string }
  readonly actorId: string
  readonly machineId: string
  readonly metadata: Metadata
  /** Trusted Node creation driver runs before a new Session Meta commit. */
  createSession?(
    command: Extract<WorkspaceMetaPublicCommand, { kind: 'upsert-doc' }>,
    authorize: (snapshot: NativeWorkspaceMetaSnapshot) => void
  ): Promise<{ outcome: 'committed'; snapshot: NativeWorkspaceMetaSnapshot }>
  allowsFlock(id: string): boolean
  assertCurrent(): void
}
type Owner = {
  windowId: number
  registrationId: string
  grant: NativeWorkspaceMetaMainGrant
  retired: boolean
  pending: Set<Promise<unknown>>
}
type Slot = {
  windowId: number
  scope: WorkspaceMetaScope
  leaseId: string
  closing: boolean
  opening?: Promise<{
    generation: string
    leaseId: string
    snapshot: ReturnType<typeof projectWorkspaceMetaPublicSnapshot>
  }>
  stop?: () => void
  release?: Promise<void>
}
/** Frame-owned requests and virtual observers; the physical Meta owner stays borrowed. */
export class NativeWorkspaceMetaMainLegacy {
  private closed = false
  private readonly owners = new Map<string, Owner>()
  private readonly selecting = new Map<
    string,
    { windowId: number; registrationId: string; retired: boolean; work: Promise<Owner> }
  >()
  private readonly slots = new Map<string, Slot>()
  private readonly canceled = new Map<string, { windowId: number; registrationId: string }>()
  constructor(
    private readonly options: {
      acquire(windowId: number, registrationId: string): Promise<NativeWorkspaceMetaMainGrant>
      send(windowId: number, event: WorkspaceMetaEvent): void
      closeTimeoutMs?: number
    }
  ) {}
  private key(windowId: number, scope: WorkspaceMetaScope) {
    return JSON.stringify([windowId, scope.registrationId, scope.requestId])
  }
  private check(owner: Owner) {
    if (this.closed || owner.retired) throw new WorkspaceMetaIpcError('restart_required')
    owner.grant.assertCurrent()
  }
  private snapshot(owner: Owner, value: unknown) {
    this.check(owner)
    return projectWorkspaceMetaPublicSnapshot(value, (id) => owner.grant.allowsFlock(id))
  }
  private select(windowId: number, registrationId: string): Promise<Owner> {
    if (this.closed) return Promise.reject(new WorkspaceMetaIpcError('restart_required'))
    const key = JSON.stringify([windowId, registrationId]),
      prior = this.owners.get(key)
    if (prior) {
      this.check(prior)
      return Promise.resolve(prior)
    }
    const pending = this.selecting.get(key)
    if (pending)
      return pending.retired
        ? Promise.reject(new WorkspaceMetaIpcError('restart_required'))
        : pending.work
    const attempt = {
      windowId,
      registrationId,
      retired: false,
      work: undefined as unknown as Promise<Owner>
    }
    attempt.work = (async () => {
      const grant = await this.options.acquire(windowId, registrationId)
      grant.assertCurrent()
      if (this.closed || attempt.retired) throw new WorkspaceMetaIpcError('restart_required')
      if (
        !grant.generation ||
        !grant.actorId ||
        !grant.machineId ||
        grant.metadata.binding.accountId !== grant.binding.accountId ||
        grant.metadata.binding.workspaceId !== grant.binding.workspaceId
      )
        throw new WorkspaceMetaIpcError('access_denied')
      if (this.owners.size >= 128) throw new WorkspaceMetaIpcError('unavailable')
      const owner: Owner = { windowId, registrationId, grant, retired: false, pending: new Set() }
      this.owners.set(key, owner)
      return owner
    })().finally(() => {
      if (this.selecting.get(key) === attempt) this.selecting.delete(key)
    })
    this.selecting.set(key, attempt)
    return attempt.work
  }
  private async safely<A>(work: () => Promise<A>): Promise<A> {
    try {
      return await work()
    } catch (error) {
      throw new WorkspaceMetaIpcError(workspaceMetaErrorCode(error))
    }
  }
  private own<A>(owner: Owner, operation: () => Promise<A>): Promise<A> {
    this.check(owner)
    const work = operation()
    owner.pending.add(work)
    void work.finally(() => owner.pending.delete(work)).catch(() => {})
    return work
  }
  private bounded<A>(work: Promise<A>): Promise<A> {
    return waitForCleanup(
      work,
      this.options.closeTimeoutMs ?? 10000,
      () => new WorkspaceMetaIpcError('cleanup_unconfirmed')
    )
  }
  read(windowId: number, scope: WorkspaceMetaScope) {
    return this.safely(async () => {
      const owner = await this.select(windowId, scope.registrationId)
      return this.own(owner, async () => ({
        generation: owner.grant.generation,
        snapshot: this.snapshot(owner, await owner.grant.metadata.externalMetadata.read())
      }))
    })
  }
  private authorize(
    owner: Owner,
    command: WorkspaceMetaPublicCommand,
    snapshot: NativeWorkspaceMetaSnapshot
  ) {
    this.check(owner)
    if ('flockDocId' in command) {
      if (!owner.grant.allowsFlock(command.flockDocId))
        throw new WorkspaceMetaIpcError('access_denied')
      return
    }
    const session = command.docId.startsWith('session-') && command.docId.length > 8,
      schedule = command.docId.startsWith('schedule-') && command.docId.length > 9,
      preview = command.docId.startsWith('preview-comment-') && command.docId.length > 16
    if (!session && !schedule && !preview) throw new WorkspaceMetaIpcError('access_denied')
    if (
      preview &&
      !snapshot.docs.some(
        (row) =>
          row.docId === `session-${command.docId.slice(16)}` &&
          (!row.deleted || command.kind === 'delete-doc' || command.kind === 'purge-doc')
      )
    )
      throw new WorkspaceMetaIpcError('access_denied')
    if (command.kind !== 'upsert-doc') return
    if ((schedule || preview) && Object.keys(command.patch).length)
      throw new WorkspaceMetaIpcError('access_denied')
    const current = snapshot.docs.find((row) => row.docId === command.docId)?.meta,
      patch = command.patch as Record<string, unknown>
    if (patch.id !== undefined && patch.id !== command.docId.slice(session ? 8 : 9))
      throw new WorkspaceMetaIpcError('access_denied')
    if (patch.userId !== undefined && patch.userId !== owner.grant.actorId)
      throw new WorkspaceMetaIpcError('access_denied')
    if (
      patch.machineId !== undefined &&
      patch.machineId !== (current?.machineId ?? owner.grant.machineId)
    )
      throw new WorkspaceMetaIpcError('access_denied')
    if (
      current?.historyBackend !== undefined &&
      patch.historyBackend !== undefined &&
      patch.historyBackend !== current.historyBackend
    )
      throw new WorkspaceMetaIpcError('access_denied')
    if (
      current?.userId !== undefined &&
      patch.userId !== undefined &&
      patch.userId !== current.userId
    )
      throw new WorkspaceMetaIpcError('access_denied')
  }
  commit(windowId: number, scope: WorkspaceMetaScope, value: unknown, expectedGeneration: string) {
    return this.safely(async () => {
      let admitted = false
      try {
        const command = workspaceMetaCommandSchema.parse(value),
          owner = await this.select(windowId, scope.registrationId)
        this.check(owner)
        if (expectedGeneration !== owner.grant.generation)
          throw new WorkspaceMetaIpcError('restart_required')
        const before = await owner.grant.metadata.externalMetadata.read()
        this.authorize(owner, command, before)
        this.check(owner)
        admitted = true
        return await this.own(owner, async () => {
          const creating =
            command.kind === 'upsert-doc' &&
            command.docId.startsWith('session-') &&
            !before.docs.some((row) => row.docId === command.docId)
          const receipt =
            creating && owner.grant.createSession
              ? await owner.grant.createSession(command, (snapshot) =>
                  this.authorize(owner, command, snapshot)
                )
              : await owner.grant.metadata.commitAuthorized(
                  command as NativeWorkspaceMetaCommand,
                  (snapshot) => this.authorize(owner, command, snapshot)
                )
          return {
            generation: owner.grant.generation,
            outcome: 'committed' as const,
            snapshot: this.snapshot(owner, receipt.snapshot)
          }
        })
      } catch (error) {
        if (error instanceof WorkspaceMetaIpcError && error.code === 'not_committed') throw error
        throw new WorkspaceMetaIpcError(admitted ? 'operation_failed' : 'not_committed')
      }
    })
  }
  flush(windowId: number, scope: WorkspaceMetaScope, expectedGeneration: string) {
    return this.safely(async () => {
      const owner = await this.select(windowId, scope.registrationId)
      this.check(owner)
      if (expectedGeneration !== owner.grant.generation)
        throw new WorkspaceMetaIpcError('restart_required')
      return this.own(owner, async () => {
        const receipt = await owner.grant.metadata.externalMetadata.flush()
        return {
          generation: owner.grant.generation,
          outcome: 'committed' as const,
          snapshot: this.snapshot(owner, receipt.snapshot)
        }
      })
    })
  }
  observe(windowId: number, scope: WorkspaceMetaScope) {
    return this.safely(async () => {
      const key = this.key(windowId, scope)
      if (this.closed || this.canceled.has(key)) throw new WorkspaceMetaIpcError('restart_required')
      const prior = this.slots.get(key)
      if (prior) {
        if (prior.closing) throw new WorkspaceMetaIpcError('cleanup_unconfirmed')
        return prior.opening!
      }
      if (this.slots.size >= 256) throw new WorkspaceMetaIpcError('unavailable')
      const slot: Slot = { windowId, scope: { ...scope }, leaseId: randomUUID(), closing: false }
      this.slots.set(key, slot)
      slot.opening = (async () => {
        const owner = await this.select(windowId, scope.registrationId)
        this.check(owner)
        if (slot.closing || this.canceled.has(key))
          throw new WorkspaceMetaIpcError('restart_required')
        const opened = await owner.grant.metadata.externalMetadata.open((update) => {
          if (slot.closing || this.slots.get(key) !== slot) return
          try {
            this.options.send(windowId, {
              ...scope,
              leaseId: slot.leaseId,
              generation: owner.grant.generation,
              by: update.by,
              snapshot: this.snapshot(owner, update.snapshot)
            })
          } catch {}
        })
        slot.stop = opened.unsubscribe
        if (slot.closing || this.canceled.has(key)) {
          slot.stop()
          slot.stop = undefined
          throw new WorkspaceMetaIpcError('restart_required')
        }
        return {
          generation: owner.grant.generation,
          leaseId: slot.leaseId,
          snapshot: this.snapshot(owner, opened.snapshot)
        }
      })()
      return slot.opening
    })
  }
  private releaseSlot(key: string, slot: Slot): Promise<void> {
    slot.closing = true
    if (slot.release) return this.bounded(slot.release)
    slot.release = (async () => {
      await slot.opening?.catch(() => undefined)
      slot.stop?.()
      slot.stop = undefined
      if (this.slots.get(key) === slot) this.slots.delete(key)
    })().finally(() => {
      slot.release = undefined
    })
    return this.bounded(slot.release)
  }
  unobserve(windowId: number, scope: WorkspaceMetaScope, leaseId: string) {
    return this.safely(async () => {
      const key = this.key(windowId, scope),
        slot = this.slots.get(key)
      if (!slot) return { released: true as const }
      if (slot.leaseId !== leaseId) throw new WorkspaceMetaIpcError('access_denied')
      await this.releaseSlot(key, slot)
      return { released: true as const }
    })
  }
  cancelObservation(windowId: number, scope: WorkspaceMetaScope) {
    return this.safely(async () => {
      const key = this.key(windowId, scope)
      if (!this.canceled.has(key)) {
        if ([...this.canceled.values()].filter((item) => item.windowId === windowId).length >= 256)
          throw new WorkspaceMetaIpcError('cleanup_unconfirmed')
        this.canceled.set(key, { windowId, registrationId: scope.registrationId })
      }
      const slot = this.slots.get(key)
      if (slot) await this.releaseSlot(key, slot)
      return { canceled: true as const }
    })
  }
  async retire(windowId: number, registrationId?: string) {
    const matches = (item: { windowId: number; registrationId: string }) =>
      item.windowId === windowId && (!registrationId || item.registrationId === registrationId)
    const work: Promise<unknown>[] = []
    for (const attempt of this.selecting.values())
      if (matches(attempt)) {
        attempt.retired = true
        work.push(this.bounded(attempt.work.catch(() => undefined)))
      }
    for (const owner of this.owners.values())
      if (matches(owner)) {
        owner.retired = true
        work.push(this.bounded(Promise.allSettled([...owner.pending])))
      }
    for (const [key, slot] of this.slots)
      if (matches({ windowId: slot.windowId, registrationId: slot.scope.registrationId }))
        work.push(this.releaseSlot(key, slot))
    const results = await Promise.allSettled(work)
    if (results.some((result) => result.status === 'rejected'))
      throw new WorkspaceMetaIpcError('cleanup_unconfirmed')
    for (const [key, owner] of this.owners) if (matches(owner)) this.owners.delete(key)
    for (const [key, intent] of this.canceled) if (matches(intent)) this.canceled.delete(key)
  }
  async close() {
    this.closed = true
    const windows = new Set(
      [...this.owners.values(), ...this.selecting.values()].map((owner) => owner.windowId)
    )
    for (const slot of this.slots.values()) windows.add(slot.windowId)
    const results = await Promise.allSettled([...windows].map((window) => this.retire(window)))
    if (results.some((result) => result.status === 'rejected'))
      throw new WorkspaceMetaIpcError('cleanup_unconfirmed')
  }
}

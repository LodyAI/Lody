import { randomUUID } from 'node:crypto'
import {
  createNativeMachineCatalog,
  NativeMachineCatalogCleanupError,
  type NativeMachineCatalogOptions
} from '@lody/shared/node/native-machine-catalog'
import {
  MachineCatalogIpcError,
  machineCatalogIpcErrorCode,
  parseMachineCatalogIpcCommand,
  parseMachineCatalogIpcEditor,
  parseMachineCatalogIpcSnapshot,
  type MachineCatalogIpcEvent
} from '@lody/shared/machine-catalog-ipc'
import type { AgentConfigId } from '@lody/shared'

type Catalog = ReturnType<typeof createNativeMachineCatalog>
export type NativeMachineCatalogMainGrant = {
  /** Main-owned registration/room/engine generation; never supplied by renderer. */
  readonly generation: string
  readonly options: NativeMachineCatalogOptions
  /** Recheck the exact product frame, whole-room route/storage and SDK generation. */
  assertCurrent(): void
}
type Owner = {
  readonly windowId: number
  readonly registrationId: string
  readonly machineId: string
  readonly grant: NativeMachineCatalogMainGrant
  readonly catalog: Catalog
  readonly state: { retiring: boolean }
}
type Observation = Awaited<ReturnType<Catalog['observe']>>
type Slot = {
  readonly owner: Owner
  readonly requestId: string
  readonly leaseId: string
  closing: boolean
  acquisition?: Promise<void>
  observation?: Observation
  failedCleanup?: () => Promise<void>
  release?: Promise<void>
}
type Options = {
  /** Trusted composition derives account/workspace and permits only an exactly
   * selected MF room. It must verify registration, physical storage and current
   * ownership before returning a grant. Construction alone enables no product IPC. */
  acquire(
    windowId: number,
    registrationId: string,
    machineId: string
  ): Promise<NativeMachineCatalogMainGrant>
  send(windowId: number, event: MachineCatalogIpcEvent): void
}

/** Main's bounded domain bridge. Private launch/runtime/provider storage ports
 * are absent; all outward values pass the finite credential-free DTO parser. */
export class NativeMachineCatalogMainLegacy {
  private closed = false
  private readonly owners = new Map<string, Owner>()
  private readonly slots = new Map<string, Slot>()
  // Only unknown/canceled admissions need a tombstone. It belongs to this
  // registered window and is removed only after confirmed registration retirement.
  private readonly canceled = new Map<string, { windowId: number; registrationId: string }>()
  private readonly observing = new Set<{
    windowId: number
    registrationId: string
    work: Promise<{ leaseId: string }>
  }>()
  private readonly selecting = new Map<
    string,
    {
      windowId: number
      registrationId: string
      retired: boolean
      work: Promise<Owner>
    }
  >()
  constructor(private readonly options: Options) {}

  private check(owner: Owner): void {
    if (this.closed || owner.state.retiring) throw new MachineCatalogIpcError('restart_required')
    owner.grant.assertCurrent()
    if (owner.grant.options.client.connectionState !== 'connected')
      throw new MachineCatalogIpcError('restart_required')
  }
  private select(windowId: number, registrationId: string, machineId: string): Promise<Owner> {
    const key = JSON.stringify([windowId, registrationId, machineId])
    const pending = this.selecting.get(key)
    if (pending)
      return pending.retired
        ? Promise.reject(new MachineCatalogIpcError('restart_required'))
        : pending.work
    const attempt = {
      windowId,
      registrationId,
      retired: false,
      work: undefined as unknown as Promise<Owner>
    }
    attempt.work = this.open(windowId, registrationId, machineId, () => {
      if (attempt.retired || this.closed) throw new MachineCatalogIpcError('restart_required')
    }).finally(() => {
      if (this.selecting.get(key) === attempt) this.selecting.delete(key)
    })
    this.selecting.set(key, attempt)
    return attempt.work
  }
  private async open(
    windowId: number,
    registrationId: string,
    machineId: string,
    assertAcquisition: () => void
  ): Promise<Owner> {
    if (this.closed) throw new MachineCatalogIpcError('restart_required')
    const grant = await this.options.acquire(windowId, registrationId, machineId)
    assertAcquisition()
    grant.assertCurrent()
    if (this.closed || grant.options.binding.machineId !== machineId)
      throw new MachineCatalogIpcError('restart_required')
    const key = JSON.stringify([windowId, registrationId, machineId])
    const existing = this.owners.get(key)
    if (existing) {
      if (
        existing.grant.generation !== grant.generation ||
        existing.grant.options.client !== grant.options.client ||
        existing.grant.options.binding.accountId !== grant.options.binding.accountId ||
        existing.grant.options.binding.workspaceId !== grant.options.binding.workspaceId
      ) {
        await this.releaseOwner(key, existing)
        assertAcquisition()
      } else {
        this.check(existing)
        return existing
      }
    }
    if (this.owners.size >= 64) throw new MachineCatalogIpcError('cleanup_unconfirmed')
    const state = { retiring: false }
    const owner: Owner = {
      windowId,
      registrationId,
      machineId,
      grant,
      state,
      catalog: createNativeMachineCatalog({
        ...grant.options,
        authorize: (operation, command) => {
          // A live frame losing its transport needs a fresh owner, not a
          // synthetic permission revocation. Preserve a real grant denial.
          grant.assertCurrent()
          if (this.closed || state.retiring || grant.options.client.connectionState !== 'connected')
            throw new MachineCatalogIpcError('restart_required')
          return grant.options.authorize(operation, command)
        }
      })
    }
    this.owners.set(key, owner)
    this.check(owner)
    return owner
  }
  private async run<A>(work: () => Promise<A>): Promise<A> {
    try {
      return await work()
    } catch (error) {
      throw new MachineCatalogIpcError(machineCatalogIpcErrorCode(error))
    }
  }
  private async request<A>(owner: Owner, work: () => Promise<A>): Promise<A> {
    this.check(owner)
    try {
      const result = await work()
      this.check(owner)
      return result
    } catch (error) {
      // A failed in-flight SDK call may carry only a generic socket error.
      // Recheck trusted authority and connection before choosing its public code.
      this.check(owner)
      throw error
    }
  }
  read(windowId: number, registrationId: string, machineId: string) {
    return this.run(async () => {
      const owner = await this.select(windowId, registrationId, machineId)
      const projection = await this.request(owner, () =>
        owner.catalog.read(owner.grant.options.binding)
      )
      return this.snapshot(
        owner,
        projection,
        owner.grant.options.authority.current()?.synced === true
      )
    })
  }
  private snapshot(owner: Owner, projection: unknown, synced: boolean) {
    return parseMachineCatalogIpcSnapshot({
      machineId: owner.machineId,
      generation: owner.grant.generation,
      synced,
      projection
    })
  }
  private checkGeneration(owner: Owner, expectedGeneration: string): void {
    this.check(owner)
    if (owner.grant.generation !== expectedGeneration)
      throw new MachineCatalogIpcError('restart_required')
  }
  beginAgentConfigEdit(
    windowId: number,
    registrationId: string,
    machineId: string,
    id: string,
    expectedGeneration: string
  ) {
    return this.run(async () => {
      const owner = await this.select(windowId, registrationId, machineId)
      this.checkGeneration(owner, expectedGeneration)
      const editor = await this.request(owner, () =>
        owner.catalog.beginAgentConfigEdit(owner.grant.options.binding, id as AgentConfigId)
      )
      return { generation: owner.grant.generation, editor: parseMachineCatalogIpcEditor(editor) }
    })
  }
  execute(
    windowId: number,
    registrationId: string,
    machineId: string,
    payload: unknown,
    expectedGeneration: string
  ) {
    return this.run(async () => {
      const command = parseMachineCatalogIpcCommand(payload, machineId)
      const owner = await this.select(windowId, registrationId, machineId)
      this.checkGeneration(owner, expectedGeneration)
      const result = await this.request(owner, () =>
        owner.catalog.execute(owner.grant.options.binding, command)
      )
      return {
        generation: owner.grant.generation,
        changed: result.changed,
        ...(result.association ? { association: result.association } : {}),
        ...(result.project ? { project: result.project } : {})
      }
    })
  }
  upload(windowId: number, registrationId: string, machineId: string, expectedGeneration: string) {
    return this.run(async () => {
      const owner = await this.select(windowId, registrationId, machineId)
      this.checkGeneration(owner, expectedGeneration)
      await this.request(owner, () => owner.catalog.upload(owner.grant.options.binding))
      return { generation: owner.grant.generation }
    })
  }
  observe(
    windowId: number,
    registrationId: string,
    machineId: string,
    requestId: string
  ): Promise<{ leaseId: string }> {
    const key = JSON.stringify([windowId, registrationId, machineId, requestId])
    if (this.canceled.has(key))
      return Promise.reject(new MachineCatalogIpcError('restart_required'))
    const attempt = {
      windowId,
      registrationId,
      work: undefined as unknown as Promise<{ leaseId: string }>
    }
    attempt.work = this.openObservation(
      windowId,
      registrationId,
      machineId,
      requestId,
      key
    ).finally(() => {
      this.observing.delete(attempt)
    })
    this.observing.add(attempt)
    return attempt.work
  }
  private openObservation(
    windowId: number,
    registrationId: string,
    machineId: string,
    requestId: string,
    key: string
  ) {
    return this.run(async () => {
      if (this.canceled.has(key)) throw new MachineCatalogIpcError('restart_required')
      const owner = await this.select(windowId, registrationId, machineId)
      if (this.canceled.has(key)) throw new MachineCatalogIpcError('restart_required')
      const existing = this.slots.get(key)
      if (existing) {
        if (existing.closing) throw new MachineCatalogIpcError('cleanup_unconfirmed')
        await existing.acquisition
        this.check(existing.owner)
        return { leaseId: existing.leaseId }
      }
      if ([...this.slots.values()].filter((slot) => slot.owner.windowId === windowId).length >= 64)
        throw new MachineCatalogIpcError('cleanup_unconfirmed')
      const slot: Slot = { owner, requestId, leaseId: randomUUID(), closing: false }
      this.slots.set(key, slot)
      const envelope = { registrationId, machineId, requestId, leaseId: slot.leaseId }
      slot.acquisition = (async () => {
        try {
          slot.observation = await owner.catalog.observe(
            owner.grant.options.binding,
            (update) => {
              if (slot.closing || this.closed) return
              this.check(owner)
              this.options.send(windowId, {
                ...envelope,
                type: 'snapshot',
                snapshot: this.snapshot(owner, update.projection, update.synced)
              })
            },
            (error) => {
              if (slot.closing || this.closed) return
              try {
                this.options.send(windowId, {
                  ...envelope,
                  type: 'error',
                  code: machineCatalogIpcErrorCode(error)
                })
              } catch {
                // The frame cannot receive the failure. Retire its local
                // observer now; the retained slot still owns any failed ACK.
                void this.releaseSlot(key, slot).catch(() => {})
              }
            }
          )
          if (slot.closing) {
            await slot.observation.close()
            if (this.slots.get(key) === slot) this.slots.delete(key)
            throw new MachineCatalogIpcError('restart_required')
          }
        } catch (cause) {
          // A failed partial acquisition can still own an unconfirmed native
          // unsubscribe. Retain its original exact cleanup closure in this slot.
          if (cause instanceof NativeMachineCatalogCleanupError)
            slot.failedCleanup = () => cause.retryCleanup()
          else {
            if (!slot.observation && this.slots.get(key) === slot) this.slots.delete(key)
            this.check(owner)
          }
          throw cause
        }
      })()
      await slot.acquisition
      this.check(owner)
      return { leaseId: slot.leaseId }
    })
  }
  private releaseSlot(key: string, slot: Slot): Promise<void> {
    slot.closing = true
    slot.observation?.retire()
    if (slot.release) return slot.release
    const operation = (async () => {
      try {
        await slot.acquisition
      } catch {}
      if (slot.observation) await slot.observation.close()
      else if (slot.failedCleanup) await slot.failedCleanup()
      if (this.slots.get(key) === slot) this.slots.delete(key)
    })()
    slot.release = operation
    void operation.catch(() => {
      if (slot.release === operation) slot.release = undefined
    })
    return operation
  }
  unsubscribe(
    windowId: number,
    registrationId: string,
    machineId: string,
    requestId: string,
    leaseId: string
  ) {
    return this.run(async () => {
      const key = JSON.stringify([windowId, registrationId, machineId, requestId])
      const slot = this.slots.get(key)
      if (slot?.leaseId === leaseId) await this.releaseSlot(key, slot)
    })
  }
  cancelObservation(
    windowId: number,
    registrationId: string,
    machineId: string,
    requestId: string
  ) {
    return this.run(async () => {
      const key = JSON.stringify([windowId, registrationId, machineId, requestId])
      if (!this.canceled.has(key)) {
        if (
          [...this.canceled.values()].filter((value) => value.windowId === windowId).length >= 256
        )
          throw new MachineCatalogIpcError('cleanup_unconfirmed')
        // Fence before any asynchronous grant lookup. A later observe of this
        // exact logical request remains rejected for this registration lifetime.
        this.canceled.set(key, { windowId, registrationId })
      }
      const slot = this.slots.get(key)
      if (slot) await this.releaseSlot(key, slot)
      else await this.select(windowId, registrationId, machineId)
      return { canceled: true as const }
    })
  }
  private async releaseOwner(key: string, owner: Owner): Promise<void> {
    owner.state.retiring = true
    owner.catalog.retire()
    const results = await Promise.allSettled([
      ...[...this.slots.entries()]
        .filter(([, slot]) => slot.owner === owner)
        .map(([slotKey, slot]) => this.releaseSlot(slotKey, slot)),
      owner.catalog.close()
    ])
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new NativeMachineCatalogCleanupError(
        failures.map((result) => result.reason),
        () => this.releaseOwner(key, owner)
      )
    if (this.owners.get(key) === owner) this.owners.delete(key)
  }
  /** The caller revokes its trusted registration first; pending grants are also
   * fenced locally so a late SDK acquisition cannot recreate this owner. */
  async retire(windowId: number, registrationId?: string): Promise<void> {
    const pending = [...this.selecting.values()].filter(
      (attempt) =>
        attempt.windowId === windowId &&
        (registrationId === undefined || attempt.registrationId === registrationId)
    )
    for (const attempt of pending) attempt.retired = true
    for (const owner of this.owners.values()) {
      if (
        owner.windowId === windowId &&
        (registrationId === undefined || owner.registrationId === registrationId)
      ) {
        owner.state.retiring = true
        owner.catalog.retire()
      }
    }
    await Promise.allSettled([
      ...pending.map((attempt) => attempt.work),
      ...[...this.observing.values()]
        .filter(
          (attempt) =>
            attempt.windowId === windowId &&
            (registrationId === undefined || attempt.registrationId === registrationId)
        )
        .map((attempt) => attempt.work)
    ])
    const results = await Promise.allSettled(
      [...this.owners.entries()]
        .filter(
          ([, owner]) =>
            owner.windowId === windowId &&
            (registrationId === undefined || owner.registrationId === registrationId)
        )
        .map(([key, owner]) => this.releaseOwner(key, owner))
    )
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new NativeMachineCatalogCleanupError(
        failures.map((result) => result.reason),
        () => this.retire(windowId, registrationId)
      )
    for (const [key, context] of this.canceled)
      if (
        context.windowId === windowId &&
        (registrationId === undefined || context.registrationId === registrationId)
      )
        this.canceled.delete(key)
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([
      ...[...this.selecting.values()].map((attempt) => attempt.work),
      ...[...this.observing.values()].map((attempt) => attempt.work)
    ])
    const results = await Promise.allSettled(
      [...this.owners.entries()].map(([key, owner]) => this.releaseOwner(key, owner))
    )
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new NativeMachineCatalogCleanupError(
        failures.map((result) => result.reason),
        () => this.close()
      )
    this.canceled.clear()
  }
}

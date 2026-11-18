import { waitForCleanup } from '../utils'
import { randomUUID } from 'node:crypto'
import type { RepoClient } from '@loro-dev/loro-repo-client'
import {
  createNativeScheduleRegistry,
  NativeScheduleRegistryCleanupError,
  type NativeScheduleRegistryOptions
} from '@lody/shared/node/native-schedule-registry'
import {
  ScheduleRegistryIpcError,
  assertScheduleRegistryIpcWriteAuthority,
  scheduleRegistryIpcErrorCode,
  parseScheduleRegistryIpcCommand,
  parseScheduleRegistryIpcSnapshot,
  type ScheduleRegistryIpcEvent
} from '@lody/shared/schedule-registry-ipc'
type Registry = ReturnType<typeof createNativeScheduleRegistry>
export type NativeScheduleRegistryMainGrant = {
  readonly generation: string
  readonly actorId: string
  readonly machineId: string
  readonly client: RepoClient
  readonly options: Omit<
    NativeScheduleRegistryOptions,
    'getClient' | 'assertAccess' | 'authorizeCommand'
  >
  /** Exact frame registration, SR physical owner, account and SDK generation. */
  assertCurrent(): void
}
type Owner = {
  windowId: number
  registrationId: string
  grant: NativeScheduleRegistryMainGrant
  registry: Registry
  retiring: boolean
}
type Slot = {
  owner: Owner
  requestId: string
  leaseId: string
  closing: boolean
  acquisition?: Promise<void>
  observation?: Awaited<ReturnType<Registry['observe']>>
  failedCleanup?: () => Promise<void>
  release?: Promise<void>
}
/** Narrow trusted Node SR bridge. No raw rows, SDK, remote auth, runtime/prune
 * mutation or renderer-selected identity crosses its public boundary. */
export class NativeScheduleRegistryMainLegacy {
  private closed = false
  private readonly owners = new Map<string, Owner>()
  private readonly slots = new Map<string, Slot>()
  private readonly canceled = new Map<string, { windowId: number; registrationId: string }>()
  private readonly selecting = new Map<
    string,
    { windowId: number; registrationId: string; retired: boolean; work: Promise<Owner> }
  >()
  private readonly observing = new Set<{
    windowId: number
    registrationId: string
    work: Promise<{ leaseId: string }>
  }>()
  constructor(
    private readonly options: {
      acquire(windowId: number, registrationId: string): Promise<NativeScheduleRegistryMainGrant>
      send(windowId: number, event: ScheduleRegistryIpcEvent): void
      closeTimeoutMs?: number
    }
  ) {}
  private bounded<A>(work: Promise<A>, retry: () => Promise<void>): Promise<A> {
    return waitForCleanup(
      work,
      this.options.closeTimeoutMs ?? 10000,
      () => new NativeScheduleRegistryCleanupError([], retry)
    )
  }
  private check(owner: Owner): void {
    if (this.closed || owner.retiring || owner.grant.client.connectionState !== 'connected')
      throw new ScheduleRegistryIpcError('restart_required')
    owner.grant.assertCurrent()
  }
  private async safely<A>(work: () => Promise<A>): Promise<A> {
    try {
      return await work()
    } catch (error) {
      throw new ScheduleRegistryIpcError(scheduleRegistryIpcErrorCode(error))
    }
  }
  private select(windowId: number, registrationId: string): Promise<Owner> {
    const key = JSON.stringify([windowId, registrationId])
    const current = this.selecting.get(key)
    if (current)
      return current.retired
        ? Promise.reject(new ScheduleRegistryIpcError('restart_required'))
        : current.work
    const attempt = {
      windowId,
      registrationId,
      retired: false,
      work: undefined as unknown as Promise<Owner>
    }
    attempt.work = this.open(windowId, registrationId, () => {
      if (this.closed || attempt.retired) throw new ScheduleRegistryIpcError('restart_required')
    }).finally(() => {
      if (this.selecting.get(key) === attempt) this.selecting.delete(key)
    })
    this.selecting.set(key, attempt)
    return attempt.work
  }
  private async open(
    windowId: number,
    registrationId: string,
    checkAcquisition: () => void
  ): Promise<Owner> {
    if (this.closed) throw new ScheduleRegistryIpcError('restart_required')
    const grant = await this.options.acquire(windowId, registrationId)
    checkAcquisition()
    grant.assertCurrent()
    if (!grant.actorId || !grant.machineId || grant.client.connectionState !== 'connected')
      throw new ScheduleRegistryIpcError('restart_required')
    const key = JSON.stringify([windowId, registrationId]),
      previous = this.owners.get(key)
    if (previous) {
      if (
        previous.grant.generation === grant.generation &&
        previous.grant.client === grant.client &&
        previous.grant.actorId === grant.actorId &&
        previous.grant.machineId === grant.machineId &&
        previous.grant.options.namespace === grant.options.namespace &&
        previous.grant.options.workspaceId === grant.options.workspaceId
      ) {
        this.check(previous)
        return previous
      }
      await this.releaseOwner(key, previous)
      checkAcquisition()
    }
    if (this.owners.size >= 64) throw new ScheduleRegistryIpcError('cleanup_unconfirmed')
    const owner = {
      windowId,
      registrationId,
      grant,
      retiring: false,
      registry: undefined as unknown as Registry
    }
    owner.registry = createNativeScheduleRegistry({
      ...grant.options,
      getClient: async () => {
        this.check(owner)
        return grant.client
      },
      assertAccess: () => this.check(owner),
      authorizeCommand: (command, rows) => {
        this.check(owner)
        assertScheduleRegistryIpcWriteAuthority(command, rows, grant.actorId, grant.machineId)
      }
    })
    this.owners.set(key, owner)
    this.check(owner)
    return owner
  }
  private async request<A>(owner: Owner, work: () => Promise<A>): Promise<A> {
    this.check(owner)
    try {
      const result = await work()
      this.check(owner)
      return result
    } catch (error) {
      this.check(owner)
      throw error
    }
  }
  private generation(owner: Owner, expected: string) {
    this.check(owner)
    if (owner.grant.generation !== expected) throw new ScheduleRegistryIpcError('restart_required')
  }
  private snapshot(owner: Owner, state: unknown) {
    this.check(owner)
    return parseScheduleRegistryIpcSnapshot({
      generation: owner.grant.generation,
      workspaceId: owner.grant.options.workspaceId,
      state
    })
  }
  read(windowId: number, registrationId: string) {
    return this.safely(async () => {
      const owner = await this.select(windowId, registrationId)
      return this.snapshot(owner, await this.request(owner, () => owner.registry.read()))
    })
  }
  execute(windowId: number, registrationId: string, payload: unknown, expectedGeneration: string) {
    return this.safely(async () => {
      const owner = await this.select(windowId, registrationId)
      this.generation(owner, expectedGeneration)
      const command = parseScheduleRegistryIpcCommand(
        payload,
        owner.grant.actorId,
        owner.grant.machineId
      )
      const result = await this.request(owner, () => owner.registry.execute(command))
      return { generation: owner.grant.generation, changed: result.changed }
    })
  }
  flush(windowId: number, registrationId: string, expectedGeneration: string) {
    return this.safely(async () => {
      const owner = await this.select(windowId, registrationId)
      this.generation(owner, expectedGeneration)
      await this.request(owner, () => owner.registry.flush())
      return { generation: owner.grant.generation }
    })
  }
  observe(
    windowId: number,
    registrationId: string,
    requestId: string
  ): Promise<{ leaseId: string }> {
    const key = JSON.stringify([windowId, registrationId, requestId])
    if (this.canceled.has(key))
      return Promise.reject(new ScheduleRegistryIpcError('restart_required'))
    const attempt = {
      windowId,
      registrationId,
      work: undefined as unknown as Promise<{ leaseId: string }>
    }
    attempt.work = this.safely(async () => {
      const owner = await this.select(windowId, registrationId)
      if (this.canceled.has(key)) throw new ScheduleRegistryIpcError('restart_required')
      const existing = this.slots.get(key)
      if (existing) {
        if (existing.closing) throw new ScheduleRegistryIpcError('cleanup_unconfirmed')
        await existing.acquisition
        this.check(existing.owner)
        return { leaseId: existing.leaseId }
      }
      if ([...this.slots.values()].filter((slot) => slot.owner.windowId === windowId).length >= 64)
        throw new ScheduleRegistryIpcError('cleanup_unconfirmed')
      const slot: Slot = { owner, requestId, leaseId: randomUUID(), closing: false }
      this.slots.set(key, slot)
      const envelope = { registrationId, requestId, leaseId: slot.leaseId }
      slot.acquisition = (async () => {
        try {
          slot.observation = await owner.registry.observe(
            (state) => {
              if (slot.closing || this.closed) return
              this.check(owner)
              this.options.send(windowId, {
                ...envelope,
                type: 'snapshot',
                snapshot: this.snapshot(owner, state)
              })
            },
            (error) => {
              if (slot.closing || this.closed) return
              try {
                this.options.send(windowId, {
                  ...envelope,
                  type: 'error',
                  code: scheduleRegistryIpcErrorCode(error)
                })
              } catch {
                void this.releaseSlot(key, slot).catch(() => {})
              }
            }
          )
          if (slot.closing) {
            await slot.observation.close()
            if (this.slots.get(key) === slot) this.slots.delete(key)
            throw new ScheduleRegistryIpcError('restart_required')
          }
        } catch (error) {
          if (error instanceof NativeScheduleRegistryCleanupError)
            slot.failedCleanup = () => error.retryCleanup()
          else {
            if (!slot.observation && this.slots.get(key) === slot) this.slots.delete(key)
            this.check(owner)
          }
          throw error
        }
      })()
      await slot.acquisition
      this.check(owner)
      return { leaseId: slot.leaseId }
    }).finally(() => this.observing.delete(attempt))
    this.observing.add(attempt)
    return attempt.work
  }
  private releaseSlot(key: string, slot: Slot): Promise<void> {
    slot.closing = true
    if (slot.release) return slot.release
    const work = (async () => {
      await slot.acquisition?.catch(() => {})
      if (slot.observation) await slot.observation.close()
      else await slot.failedCleanup?.()
      if (this.slots.get(key) === slot) this.slots.delete(key)
    })()
    slot.release = work
    void work.catch(() => {
      if (slot.release === work) slot.release = undefined
    })
    return work
  }
  unsubscribe(windowId: number, registrationId: string, requestId: string, leaseId: string) {
    return this.safely(async () => {
      const key = JSON.stringify([windowId, registrationId, requestId]),
        slot = this.slots.get(key)
      if (slot?.leaseId === leaseId) await this.releaseSlot(key, slot)
    })
  }
  cancelObservation(windowId: number, registrationId: string, requestId: string) {
    return this.safely(async () => {
      const key = JSON.stringify([windowId, registrationId, requestId])
      if (!this.canceled.has(key)) {
        if (
          [...this.canceled.values()].filter((value) => value.windowId === windowId).length >= 256
        )
          throw new ScheduleRegistryIpcError('cleanup_unconfirmed')
        this.canceled.set(key, { windowId, registrationId })
      }
      const slot = this.slots.get(key)
      if (slot) await this.releaseSlot(key, slot)
      else await this.select(windowId, registrationId)
      return { canceled: true as const }
    })
  }
  private async releaseOwner(key: string, owner: Owner): Promise<void> {
    for (const slot of this.slots.values())
      if (slot.owner === owner && !slot.closing) {
        try {
          this.options.send(owner.windowId, {
            registrationId: owner.registrationId,
            requestId: slot.requestId,
            leaseId: slot.leaseId,
            type: 'error',
            code: 'restart_required'
          })
        } catch {
          /* Closing frames cannot skip cleanup. */
        }
      }
    owner.retiring = true
    owner.registry.retire()
    const results = await Promise.allSettled(
      [...this.slots.entries()]
        .filter(([, slot]) => slot.owner === owner)
        .map(([key, slot]) => this.releaseSlot(key, slot))
        .concat([owner.registry.close()])
    )
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length)
      throw new NativeScheduleRegistryCleanupError(errors, () => this.releaseOwner(key, owner))
    if (this.owners.get(key) === owner) this.owners.delete(key)
  }
  async retire(windowId: number, registrationId?: string): Promise<void> {
    const match = (owner: { windowId: number; registrationId: string }) =>
      owner.windowId === windowId &&
      (registrationId === undefined || owner.registrationId === registrationId)
    const attempts = [...this.selecting.values()].filter(match)
    for (const attempt of attempts) attempt.retired = true
    for (const owner of this.owners.values())
      if (match(owner)) {
        owner.retiring = true
        owner.registry.retire()
      }
    await this.bounded(
      Promise.allSettled([
        ...attempts.map((attempt) => attempt.work),
        ...[...this.observing].filter(match).map((attempt) => attempt.work)
      ]),
      () => this.retire(windowId, registrationId)
    )
    const results = await Promise.allSettled(
      [...this.owners.entries()]
        .filter(([, owner]) => match(owner))
        .map(([key, owner]) => this.releaseOwner(key, owner))
    )
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length)
      throw new NativeScheduleRegistryCleanupError(errors, () =>
        this.retire(windowId, registrationId)
      )
    for (const [key, request] of this.canceled) if (match(request)) this.canceled.delete(key)
  }
  async close(): Promise<void> {
    this.closed = true
    for (const attempt of this.selecting.values()) attempt.retired = true
    for (const owner of this.owners.values()) {
      owner.retiring = true
      owner.registry.retire()
    }
    await this.bounded(
      Promise.allSettled([...this.selecting.values()].map((attempt) => attempt.work)),
      () => this.close()
    )
    await this.bounded(Promise.allSettled([...this.observing].map((attempt) => attempt.work)), () =>
      this.close()
    )
    const results = await Promise.allSettled(
      [...this.owners.entries()].map(([key, owner]) => this.releaseOwner(key, owner))
    )
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length) throw new NativeScheduleRegistryCleanupError(errors, () => this.close())
    this.canceled.clear()
  }
}

import { waitForCleanup } from '../utils'
import { randomUUID } from 'node:crypto'
import type { SessionId } from '@lody/shared'
import type {
  NativeSessionDomainPort,
  NativeSessionEvent,
  NativeSessionScope,
  NativeSessionReadReply,
  NativeSessionObserveReply
} from '@lody/shared/native-session-domain'
import {
  NativeSessionIpcError,
  nativeSessionIpcErrorCode,
  parseNativeSessionCommand,
  parseNativeSessionRead
} from '@lody/shared/native-session-ipc'

export type NativeSessionMainGrant = {
  readonly generation: string
  readonly domain: NativeSessionDomainPort
  /** Rechecks trusted frame, selected body/Meta owner and actual engine generation. */
  assertCurrent(): void
  /** Releases only this grant's lease, never a borrowed shared engine. */
  release(): Promise<void>
}
type Owner = {
  windowId: number
  registrationId: string
  sessionId: SessionId
  retired: boolean
  opening: Promise<NativeSessionMainGrant>
  grant?: NativeSessionMainGrant
  failedAcquisitionCleanup?: () => Promise<void>
  pending: Set<Promise<unknown>>
  releasing?: Promise<void>
}
type Slot = {
  owner: Owner
  scope: NativeSessionScope
  leaseId: string
  retired: boolean
  observation?: ReturnType<NativeSessionDomainPort['observe']>
  opening?: Promise<NativeSessionObserveReply>
  releasing?: Promise<void>
}
/** Deprecated Promise boundary for product IPC. The shared Session kernel owns
 * body subscriptions and writes; this facade owns frame grants and virtual
 * observations. Unknown release retains the original grant for the next retry. */
export class NativeSessionMainLegacy {
  private closed = false
  private readonly owners = new Map<string, Owner>()
  private readonly slots = new Map<string, Slot>()
  private readonly canceled = new Map<string, { windowId: number; registrationId: string }>()
  constructor(
    private readonly options: {
      acquire(
        windowId: number,
        registrationId: string,
        sessionId: SessionId
      ): Promise<NativeSessionMainGrant>
      send(windowId: number, event: NativeSessionEvent): void
      /** Authenticated registration plus passive route/physical-owner checks;
       * never infer legacy from a failed native-body acquisition. */
      route?(
        windowId: number,
        registrationId: string,
        sessionId: SessionId
      ): Promise<{ owner: 'legacy' | 'frozen' | 'native' }>
      retireSnapshots?(windowId: number, registrationId?: string): void
      closeSnapshots?(): void
      closeTimeoutMs?: number
    }
  ) {}
  route(windowId: number, scope: NativeSessionScope) {
    return this.safely(async () => {
      if (this.closed || !this.options.route) throw new NativeSessionIpcError('unavailable')
      const route = await this.options.route(windowId, scope.registrationId, scope.sessionId)
      if (this.closed || !route || !['legacy', 'frozen', 'native'].includes(route.owner))
        throw new NativeSessionIpcError('restart_required')
      return { owner: route.owner }
    })
  }
  private key(windowId: number, registrationId: string, sessionId: string) {
    return JSON.stringify([windowId, registrationId, sessionId])
  }
  private slotKey(windowId: number, scope: NativeSessionScope) {
    return JSON.stringify([windowId, scope.registrationId, scope.sessionId, scope.requestId])
  }
  private check(owner: Owner) {
    if (this.closed || owner.retired || !owner.grant)
      throw new NativeSessionIpcError('restart_required')
    try {
      owner.grant.assertCurrent()
      owner.grant.domain.assertCurrent()
    } catch {
      throw new NativeSessionIpcError('restart_required')
    }
    if (owner.grant.generation !== owner.grant.domain.generation)
      throw new NativeSessionIpcError('restart_required')
  }
  private async safely<A>(work: () => Promise<A>): Promise<A> {
    try {
      return await work()
    } catch (error) {
      throw new NativeSessionIpcError(nativeSessionIpcErrorCode(error))
    }
  }
  private bounded<A>(work: Promise<A>): Promise<A> {
    return waitForCleanup(
      work,
      this.options.closeTimeoutMs ?? 10000,
      () => new NativeSessionIpcError('cleanup_unconfirmed')
    )
  }
  private async select(windowId: number, scope: NativeSessionScope): Promise<Owner> {
    if (this.closed) throw new NativeSessionIpcError('restart_required')
    const key = this.key(windowId, scope.registrationId, scope.sessionId)
    let owner = this.owners.get(key)
    if (!owner) {
      if (this.owners.size >= 128) throw new NativeSessionIpcError('cleanup_unconfirmed')
      owner = {
        windowId,
        registrationId: scope.registrationId,
        sessionId: scope.sessionId as SessionId,
        retired: false,
        opening: undefined as unknown as Promise<NativeSessionMainGrant>,
        pending: new Set()
      }
      this.owners.set(key, owner)
      const current = owner
      // Store ownership before invoking foreign asynchronous acquisition.
      current.opening = Promise.resolve()
        .then(() => this.options.acquire(windowId, scope.registrationId, current.sessionId))
        .then((grant) => {
          current.grant = grant
          return grant
        })
    }
    try {
      await owner.opening
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'retryCleanup' in error &&
        typeof error.retryCleanup === 'function'
      ) {
        const cleanup = error.retryCleanup.bind(error)
        owner.failedAcquisitionCleanup = () => Promise.resolve(cleanup())
      } else if (!owner.grant && this.owners.get(key) === owner) this.owners.delete(key)
      throw error
    }
    this.check(owner)
    return owner
  }
  private async request<A>(owner: Owner, work: () => Promise<A>): Promise<A> {
    this.check(owner)
    const pending = Promise.resolve().then(() => {
      this.check(owner)
      return work()
    })
    owner.pending.add(pending)
    try {
      const result = await pending
      this.check(owner)
      return result
    } finally {
      owner.pending.delete(pending)
    }
  }
  private generation(owner: Owner, expected?: string) {
    this.check(owner)
    if (expected !== undefined && expected !== owner.grant!.generation)
      throw new NativeSessionIpcError('restart_required')
  }
  read(
    windowId: number,
    scope: NativeSessionScope,
    query: unknown,
    expectedGeneration?: string
  ): Promise<NativeSessionReadReply> {
    let phase: 'parse' | 'acquire' | 'generation' | 'read' = 'parse'
    let kind = 'unparsed'
    return this.safely(async () => {
      try {
        const parsed = parseNativeSessionRead(query)
        kind = parsed.kind
        phase = 'acquire'
        const owner = await this.select(windowId, scope)
        phase = 'generation'
        this.generation(owner, expectedGeneration)
        phase = 'read'
        const result = await this.request(owner, () =>
          owner.grant!.domain.read(parsed, expectedGeneration)
        )
        return { generation: owner.grant!.generation, result }
      } catch (error) {
        const name =
          error instanceof Error &&
          [
            'Error',
            'TypeError',
            'RangeError',
            'SyntaxError',
            'ZodError',
            'RepoError',
            'RepoRpcError',
            'NativeSessionReaderUnavailable',
            'NativeSessionIpcError'
          ].includes(error.name)
            ? error.name
            : 'OtherError'
        const rawCode =
          error && typeof error === 'object' && 'code' in error ? error.code : undefined
        const code =
          typeof rawCode === 'string' &&
          [
            'access_denied',
            'restart_required',
            'cleanup_unconfirmed',
            'precondition_failed',
            'room_not_found',
            'invalid_patch',
            'invalid_schema',
            'SQLITE_BUSY',
            'SQLITE_LOCKED',
            'ERR_SQLITE_ERROR',
            'storage',
            'protocol',
            'invalid_query',
            'budget_exceeded'
          ].includes(rawCode)
            ? rawCode
            : 'unknown'
        // node:sqlite uses ERR_SQLITE_ERROR plus numeric errcode, not a
        // SQLITE_BUSY string. The readonly projection may retain it as cause.
        let sqlite: 'busy' | 'locked' | 'none' = 'none'
        let cause: unknown = error
        for (let depth = 0; depth < 3 && cause && typeof cause === 'object'; depth++) {
          const value = 'errcode' in cause ? cause.errcode : undefined
          if (typeof value === 'number' && (value & 0xff) === 5) sqlite = 'busy'
          if (typeof value === 'number' && (value & 0xff) === 6) sqlite = 'locked'
          cause = 'cause' in cause ? cause.cause : undefined
        }
        console.warn('Native Session main read failed', { phase, kind, name, code, sqlite })
        throw error
      }
    })
  }
  execute(
    windowId: number,
    scope: NativeSessionScope,
    command: unknown,
    expectedGeneration: string
  ): Promise<NativeSessionReadReply> {
    return this.safely(async () => {
      const parsed = parseNativeSessionCommand(command)
      const owner = await this.select(windowId, scope)
      this.generation(owner, expectedGeneration)
      const result = await this.request(owner, () =>
        owner.grant!.domain.execute(parsed, expectedGeneration)
      )
      return { generation: owner.grant!.generation, result }
    })
  }
  observe(windowId: number, scope: NativeSessionScope): Promise<NativeSessionObserveReply> {
    return this.safely(async () => {
      const key = this.slotKey(windowId, scope)
      if (this.canceled.has(key)) throw new NativeSessionIpcError('restart_required')
      const previous = this.slots.get(key)
      if (previous) {
        if (previous.retired) throw new NativeSessionIpcError('cleanup_unconfirmed')
        return previous.opening!
      }
      const owner = await this.select(windowId, scope)
      // Another concurrent observer may have passed select while acquiring the same owner.
      if (this.canceled.has(key)) throw new NativeSessionIpcError('restart_required')
      const concurrent = this.slots.get(key)
      if (concurrent) return concurrent.opening!
      if (this.slots.size >= 256) throw new NativeSessionIpcError('cleanup_unconfirmed')
      const slot: Slot = { owner, scope, leaseId: randomUUID(), retired: false }
      this.slots.set(key, slot)
      slot.opening = this.request(owner, async () => {
        const emit = (event: Parameters<Parameters<NativeSessionDomainPort['observe']>[0]>[0]) => {
          if (slot.retired) return
          try {
            this.check(owner)
            this.options.send(windowId, {
              ...scope,
              ...event,
              generation: owner.grant!.generation,
              leaseId: slot.leaseId
            })
          } catch (error) {
            slot.retired = true
            // Original virtual observation remains owned until explicit retirement.
            try {
              slot.observation?.close()
            } catch {}
          }
        }
        slot.observation = owner.grant!.domain.observe(emit, () => {
          if (slot.retired) return
          slot.retired = true
          try {
            this.options.send(windowId, {
              ...scope,
              kind: 'error',
              code: 'restart_required',
              generation: owner.grant!.generation,
              leaseId: slot.leaseId
            })
          } catch {}
        })
        const [initial, control] = await Promise.all([
          slot.observation.initial,
          slot.observation.control
        ])
        if (slot.retired) throw new NativeSessionIpcError('restart_required')
        return { generation: owner.grant!.generation, leaseId: slot.leaseId, initial, control }
      })
      try {
        return await slot.opening
      } catch (error) {
        slot.retired = true
        try {
          await this.releaseSlot(key, slot)
        } catch {}
        throw error
      }
    })
  }
  private releaseSlot(key: string, slot: Slot): Promise<void> {
    slot.retired = true
    if (slot.releasing) return slot.releasing
    const work = Promise.resolve().then(async () => {
      // Stop callback delivery immediately; initial reads remain owned below.
      slot.observation?.close()
      await slot.opening?.catch(() => {})
      slot.observation?.close()
      if (this.slots.get(key) === slot) this.slots.delete(key)
    })
    slot.releasing = work
    void work
      .finally(() => {
        if (slot.releasing === work) slot.releasing = undefined
      })
      .catch(() => {})
    return work
  }
  private rememberCancel(windowId: number, scope: NativeSessionScope) {
    const key = this.slotKey(windowId, scope)
    if (!this.canceled.has(key) && this.canceled.size >= 512)
      throw new NativeSessionIpcError('cleanup_unconfirmed')
    this.canceled.set(key, { windowId, registrationId: scope.registrationId })
    return key
  }
  unobserve(windowId: number, scope: NativeSessionScope, leaseId: string) {
    return this.safely(async () => {
      const key = this.slotKey(windowId, scope),
        slot = this.slots.get(key)
      if (slot && slot.leaseId !== leaseId) throw new NativeSessionIpcError('access_denied')
      if (slot) await this.bounded(this.releaseSlot(key, slot))
      await this.releaseIdleOwner(windowId, scope)
      return { released: true as const }
    })
  }
  cancelObservation(windowId: number, scope: NativeSessionScope) {
    return this.safely(async () => {
      const key = this.rememberCancel(windowId, scope),
        slot = this.slots.get(key)
      if (slot) await this.bounded(this.releaseSlot(key, slot))
      await this.releaseIdleOwner(windowId, scope)
      return { canceled: true as const }
    })
  }
  private async releaseIdleOwner(windowId: number, scope: NativeSessionScope) {
    const key = this.key(windowId, scope.registrationId, scope.sessionId)
    const owner = this.owners.get(key)
    if (owner && ![...this.slots.values()].some((slot) => slot.owner === owner))
      await this.bounded(this.releaseOwner(key, owner))
  }
  private releaseOwner(key: string, owner: Owner): Promise<void> {
    owner.retired = true
    if (owner.releasing) return owner.releasing
    const work = Promise.resolve().then(async () => {
      // A late successful acquisition is still released by this original owner.
      try {
        await owner.opening
      } catch (error) {
        if (
          !owner.failedAcquisitionCleanup &&
          error &&
          typeof error === 'object' &&
          'retryCleanup' in error &&
          typeof error.retryCleanup === 'function'
        ) {
          const cleanup = error.retryCleanup.bind(error)
          owner.failedAcquisitionCleanup = () => Promise.resolve(cleanup())
        }
        if (owner.failedAcquisitionCleanup) await owner.failedAcquisitionCleanup()
        if (this.owners.get(key) === owner) this.owners.delete(key)
        return
      }
      const slots = [...this.slots].filter(([, slot]) => slot.owner === owner)
      const settled = await Promise.allSettled(
        slots.map(([key, slot]) => this.releaseSlot(key, slot))
      )
      await Promise.allSettled([...owner.pending])
      const failures = settled.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      if (failures.length) throw new NativeSessionIpcError('cleanup_unconfirmed')
      owner.grant!.domain.close()
      await owner.grant!.release()
      if (this.owners.get(key) === owner) this.owners.delete(key)
    })
    owner.releasing = work
    void work
      .finally(() => {
        if (owner.releasing === work) owner.releasing = undefined
      })
      .catch(() => {})
    return work
  }
  async retire(windowId: number, registrationId?: string) {
    this.options.retireSnapshots?.(windowId, registrationId)
    const owners = [...this.owners].filter(
      ([, owner]) =>
        owner.windowId === windowId &&
        (registrationId === undefined || owner.registrationId === registrationId)
    )
    for (const [, owner] of owners) owner.retired = true
    const results = await Promise.allSettled(
      owners.map(([key, owner]) => this.bounded(this.releaseOwner(key, owner)))
    )
    if (results.some((result) => result.status === 'rejected'))
      throw new NativeSessionIpcError('cleanup_unconfirmed')
    for (const [key, value] of this.canceled)
      if (
        value.windowId === windowId &&
        (registrationId === undefined || value.registrationId === registrationId)
      )
        this.canceled.delete(key)
  }
  async close() {
    this.closed = true
    this.options.closeSnapshots?.()
    for (const windowId of new Set([...this.owners.values()].map((owner) => owner.windowId)))
      this.options.retireSnapshots?.(windowId)
    const results = await Promise.allSettled(
      [...this.owners].map(([key, owner]) => this.bounded(this.releaseOwner(key, owner)))
    )
    if (results.some((result) => result.status === 'rejected'))
      throw new NativeSessionIpcError('cleanup_unconfirmed')
    this.canceled.clear()
  }
}

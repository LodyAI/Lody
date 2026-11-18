import { waitForCleanup } from '../utils'
import { randomUUID } from 'node:crypto'
import {
  NativeDocumentDomainIpcError,
  nativeDocumentDomainRequestSchema,
  nativeDocumentDomainExecuteSchema,
  nativeDocumentDomainReleaseSchema,
  parseNativeDocumentDomainInput,
  projectNativeDocumentDomainSnapshot,
  type NativeDocumentDomainRequest,
  type NativeDocumentDomainTarget,
  type NativeDocumentDomainEvent
} from '@lody/shared/native-document-domain-ipc'
import type { createNativePreviewComments } from '@lody/shared/node/native-preview-comments'
import {
  assertNativeScheduleDefinitionLocalAuthority,
  type NativeScheduleDefinitionAuthorization,
  type createNativeScheduleDefinition
} from '@lody/shared/node/native-schedule-definition'
import type { SessionId } from '@lody/shared'

type Observation = { close(): Promise<void>; retryCleanup(): Promise<void> }
export type NativeDocumentDomainMainGrant = {
  readonly generation: string
  readonly actorId: string
  assertCurrent(): void
} & (
  | {
      readonly domain: 'preview_comments'
      readonly port: ReturnType<typeof createNativePreviewComments>
    }
  | {
      readonly domain: 'schedule_definition'
      readonly machineId: string
      readonly authorizeSchedule?: NativeScheduleDefinitionAuthorization
      readonly port: ReturnType<typeof createNativeScheduleDefinition>
    }
)
type Slot = {
  readonly windowId: number
  readonly request: NativeDocumentDomainRequest
  readonly leaseId: string
  canceled: boolean
  work?: Promise<void>
  observation?: Observation
  failedCleanup?: () => Promise<void>
  releasing?: Promise<void>
}
/** Main-only finite definition bridge. The application derives binding, Meta
 * authority and a previously migrated whole room before granting this port. */
export class NativeDocumentDomainsMainLegacy {
  private closed = false
  private readonly slots = new Map<string, Slot>()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly canceled = new Map<string, { windowId: number; registrationId: string }>()
  constructor(
    private readonly options: {
      route?(
        windowId: number,
        registrationId: string,
        target: NativeDocumentDomainTarget
      ): Promise<'legacy' | 'frozen' | 'native'>
      acquire(
        windowId: number,
        registrationId: string,
        target: NativeDocumentDomainTarget
      ): Promise<NativeDocumentDomainMainGrant>
      send(windowId: number, event: NativeDocumentDomainEvent): void
    }
  ) {}
  private key(windowId: number, request: NativeDocumentDomainRequest) {
    return JSON.stringify([windowId, request.registrationId, request.requestId, request.target])
  }
  private check(grant: NativeDocumentDomainMainGrant, request: NativeDocumentDomainRequest) {
    if (this.closed || grant.domain !== request.target.domain)
      throw new NativeDocumentDomainIpcError('restart_required')
    grant.assertCurrent()
  }
  private safe<A>(work: () => Promise<A>, cleanup = false): Promise<A> {
    if (this.closed && !cleanup)
      return Promise.reject(new NativeDocumentDomainIpcError('restart_required'))
    const pending = Promise.resolve()
      .then(work)
      .catch((error) => {
        if (error instanceof NativeDocumentDomainIpcError) throw error
        throw new NativeDocumentDomainIpcError('unavailable')
      })
    this.jobs.add(pending)
    void pending.finally(() => this.jobs.delete(pending)).catch(() => {})
    return pending
  }

  route(windowId: number, input: unknown) {
    return this.safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainRequestSchema, input)
      if (!this.options.route) throw new NativeDocumentDomainIpcError('unavailable')
      const owner = await this.options.route(windowId, request.registrationId, request.target)
      if (this.closed || !['legacy', 'frozen', 'native'].includes(owner))
        throw new NativeDocumentDomainIpcError('restart_required')
      return { owner }
    })
  }
  read(windowId: number, input: unknown) {
    return this.safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainRequestSchema, input)
      const grant = await this.options.acquire(windowId, request.registrationId, request.target)
      this.check(grant, request)
      const value = await grant.port.read()
      this.check(grant, request)
      return projectNativeDocumentDomainSnapshot(request.target, grant.generation, value)
    })
  }
  execute(windowId: number, input: unknown) {
    return this.safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainExecuteSchema, input)
      const grant = await this.options.acquire(windowId, request.registrationId, request.target)
      this.check(grant, request)
      if (request.expectedGeneration !== grant.generation)
        throw new NativeDocumentDomainIpcError('restart_required')
      const command = request.command
      const authorizeSchedule: NativeScheduleDefinitionAuthorization = (input) => {
        this.check(grant, request)
        if (grant.domain !== 'schedule_definition')
          throw new NativeDocumentDomainIpcError('access_denied')
        if (grant.authorizeSchedule) {
          grant.authorizeSchedule(input)
          return
        }
        try {
          assertNativeScheduleDefinitionLocalAuthority(input, grant.actorId, grant.machineId)
        } catch {
          throw new NativeDocumentDomainIpcError('access_denied')
        }
      }
      let changed = true
      let saved: ReturnType<typeof projectNativeDocumentDomainSnapshot> | undefined
      if (grant.domain === 'preview_comments' && command.kind === 'preview-mutate') {
        if (
          (command.mutation.kind === 'create' &&
            command.mutation.comment.authorId !== grant.actorId) ||
          (command.mutation.kind === 'resolve' && command.mutation.resolvedBy !== grant.actorId)
        )
          throw new NativeDocumentDomainIpcError('access_denied')
        changed =
          (await grant.port.mutatePreviewVisualComments(
            request.target.id as SessionId,
            command.mutation
          )) > 0
      } else if (grant.domain === 'schedule_definition' && command.kind === 'schedule-save') {
        const { kind: _, ...args } = command
        const document = await grant.port.save(
          {
            ...args,
            scheduleId: request.target.id,
            actorId: grant.actorId
          },
          authorizeSchedule
        )
        saved = projectNativeDocumentDomainSnapshot(request.target, grant.generation, document)
      } else if (grant.domain === 'schedule_definition' && command.kind === 'schedule-enabled') {
        const { kind: _, ...args } = command
        await grant.port.setEnabled(
          {
            ...args,
            scheduleId: request.target.id,
            actorId: grant.actorId
          },
          authorizeSchedule
        )
      } else throw new NativeDocumentDomainIpcError('invalid_request')
      this.check(grant, request)
      // A failure after this point is an unknown mutation receipt. No retry or replay.
      return { generation: grant.generation, changed, ...(saved ? { snapshot: saved } : {}) }
    })
  }
  private release(slot: Slot): Promise<void> {
    slot.canceled = true
    if (!slot.releasing) {
      const raw = (async () => {
        await slot.work?.catch(() => undefined)
        if (slot.failedCleanup) {
          await slot.failedCleanup()
          slot.failedCleanup = undefined
        }
        if (slot.observation) await slot.observation.close()
        this.slots.delete(this.key(slot.windowId, slot.request))
      })()
      slot.releasing = raw
      void raw.catch(() => {
        if (slot.releasing === raw) slot.releasing = undefined
      })
    }
    const work = slot.releasing
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new NativeDocumentDomainIpcError('cleanup_unconfirmed')),
        10_000
      )
      work.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        () => {
          clearTimeout(timer)
          reject(new NativeDocumentDomainIpcError('cleanup_unconfirmed'))
        }
      )
    })
  }

  observe(windowId: number, input: unknown) {
    return this.safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainRequestSchema, input)
      const key = this.key(windowId, request)
      if (this.closed || this.canceled.has(key))
        throw new NativeDocumentDomainIpcError('access_denied')
      if (this.slots.has(key) || this.slots.size >= 64)
        throw new NativeDocumentDomainIpcError('cleanup_unconfirmed')
      const slot: Slot = { windowId, request, leaseId: randomUUID(), canceled: false }
      this.slots.set(key, slot)
      slot.work = (async () => {
        const grant = await this.options.acquire(windowId, request.registrationId, request.target)
        this.check(grant, request)
        if (slot.canceled) return
        const send = (event: NativeDocumentDomainEvent['event']) => {
          if (!slot.canceled && !this.closed)
            this.options.send(windowId, { ...request, leaseId: slot.leaseId, event })
        }
        const publish = (value: Parameters<typeof projectNativeDocumentDomainSnapshot>[2]) => {
          if (slot.canceled) return
          try {
            this.check(grant, request)
            send({
              kind: 'snapshot',
              snapshot: projectNativeDocumentDomainSnapshot(request.target, grant.generation, value)
            })
          } catch {
            send({ kind: 'error', code: 'restart_required' })
            slot.canceled = true
            void this.release(slot).catch(() => {})
          }
        }
        try {
          slot.observation = await grant.port.observe(publish, () => {
            send({ kind: 'error', code: 'restart_required' })
            slot.canceled = true
            void this.release(slot).catch(() => {})
          })
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'retryCleanup' in error &&
            typeof error.retryCleanup === 'function'
          )
            slot.failedCleanup = () =>
              Promise.resolve(
                Reflect.apply(error.retryCleanup as (...args: never[]) => unknown, error, [])
              ) as Promise<void>
          throw error
        }
        if (slot.canceled || this.closed) await slot.observation.close()
      })()
      try {
        await slot.work
        if (slot.canceled || this.closed) {
          await this.release(slot)
          throw new NativeDocumentDomainIpcError('access_denied')
        }
        return { leaseId: slot.leaseId }
      } catch (error) {
        // Keep uncertain acquisition/close ownership; callers can cancel/retire.
        if (!slot.observation && !slot.failedCleanup) this.slots.delete(key)
        throw error
      }
    })
  }
  unsubscribe(windowId: number, input: unknown) {
    return this.safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainReleaseSchema, input)
      const slot = this.slots.get(this.key(windowId, request))
      if (slot && slot.leaseId !== request.leaseId)
        throw new NativeDocumentDomainIpcError('access_denied')
      if (slot) await this.release(slot)
    }, true)
  }
  cancel(windowId: number, input: unknown) {
    return this.safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainRequestSchema, input)
      const key = this.key(windowId, request)
      if (
        !this.canceled.has(key) &&
        [...this.canceled.values()].filter((entry) => entry.windowId === windowId).length >= 256
      )
        throw new NativeDocumentDomainIpcError('cleanup_unconfirmed')
      this.canceled.set(key, { windowId, registrationId: request.registrationId })
      const slot = this.slots.get(key)
      if (slot) {
        slot.canceled = true
        await this.release(slot)
      }
      // The durable-in-this-registration fence blocks any later admission, and
      // an existing exact request has confirmed release before this receipt.
      return { canceled: true as const }
    }, true)
  }
  async retire(windowId: number, registrationId: string) {
    const selected = [...this.slots.values()].filter(
      (slot) => slot.windowId === windowId && slot.request.registrationId === registrationId
    )
    const results = await Promise.allSettled(selected.map((slot) => this.release(slot)))
    if (results.some((result) => result.status === 'rejected'))
      throw new NativeDocumentDomainIpcError('cleanup_unconfirmed')
    for (const [key, value] of this.canceled)
      if (value.windowId === windowId && value.registrationId === registrationId)
        this.canceled.delete(key)
  }
  async close() {
    this.closed = true
    const drain = async () => {
      const results = await Promise.allSettled(
        [...this.slots.values()].map((slot) => this.release(slot))
      )
      await Promise.allSettled([...this.jobs])
      if (results.some((result) => result.status === 'rejected'))
        throw new NativeDocumentDomainIpcError('cleanup_unconfirmed')
    }
    await waitForCleanup(
      drain(),
      10_000,
      () => new NativeDocumentDomainIpcError('cleanup_unconfirmed')
    )
    this.canceled.clear()
  }
  retryCleanup() {
    return this.close()
  }
}

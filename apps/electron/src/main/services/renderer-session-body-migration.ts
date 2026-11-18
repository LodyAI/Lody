import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  rendererSessionBodyAckSchema,
  rendererSessionBodyBindingSchema,
  type RendererSessionBodyBinding,
  type RendererSessionBodyRegistration,
  type RendererSessionBodyRequest,
  type RendererSessionBodyAck,
  type RendererSessionBodySource
} from '@lody/shared/renderer-session-body-migration'
type Participant = { windowId: number; registrationId: string; ready: boolean }
export type RendererSessionBodyEnumeration = {
  sessionId: string
  participants: readonly { windowId: number; registrationId: string }[]
  databases: readonly { sourceId: string; dbName: string }[]
}
type Pending = {
  participant: Participant
  request: RendererSessionBodyRequest
  finish(ack?: RendererSessionBodyAck, error?: unknown): void
}
export type FrozenRendererSessionBodyReceipt = {
  binding: RendererSessionBodyBinding
  sessionId: string
  revision: string
  sources: readonly RendererSessionBodySource[]
  participants: readonly { windowId: number; registrationId: string }[]
}
/** Exact per-document all-window freeze; no workspace/daemon-wide pause. The
 * Session route journal must be fenced before calling freezeAndCapture. */
export class RendererSessionBodyMigrationMainLegacy {
  readonly binding: RendererSessionBodyBinding
  private readonly db: DatabaseSync
  private readonly bindingKey: string
  private readonly participants = new Map<number, Participant>()
  private readonly pending = new Map<string, Pending>()
  private readonly inventories = new Map<string, RendererSessionBodyEnumeration>()
  private readonly witnesses = new Map<string, FrozenRendererSessionBodyReceipt>()
  private readonly jobs = new Map<string, Promise<FrozenRendererSessionBodyReceipt>>()
  private closed = false
  constructor(
    private readonly options: {
      binding: RendererSessionBodyBinding
      databasePath: string
      admit(windowId: number, registrationId: string): void
      registeredWindowIds(): readonly number[]
      send(windowId: number, request: RendererSessionBodyRequest): void | Promise<void>
      readCommittedOwner(sessionId: string): 'legacy' | 'frozen' | 'native'
      timeoutMs?: number
    }
  ) {
    this.binding = Object.freeze(rendererSessionBodyBindingSchema.parse(options.binding))
    this.bindingKey = JSON.stringify(this.binding)
    this.db = new DatabaseSync(options.databasePath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA synchronous=FULL')
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS renderer_session_body_fences(binding TEXT NOT NULL,session_id TEXT NOT NULL,revision TEXT NOT NULL,owner TEXT NOT NULL CHECK(owner IN ('frozen','native')),PRIMARY KEY(binding,session_id)) WITHOUT ROWID"
    )
  }
  private check() {
    if (this.closed) throw new Error('Session migration controller retired')
  }
  private rooms() {
    return this.db
      .prepare(
        'SELECT session_id AS sessionId,revision,owner FROM renderer_session_body_fences WHERE binding=?'
      )
      .all(this.bindingKey) as RendererSessionBodyRegistration['rooms']
  }
  register(windowId: number, registrationId: string): RendererSessionBodyRegistration {
    this.check()
    this.options.admit(windowId, registrationId)
    const previous = this.participants.get(windowId)
    if (previous && previous.registrationId !== registrationId)
      throw new Error('Previous Session migration registration requires retirement')
    if (!previous) this.participants.set(windowId, { windowId, registrationId, ready: false })
    return { binding: this.binding, registrationId, rooms: this.rooms() }
  }
  ready(windowId: number, registrationId: string) {
    this.check()
    this.options.admit(windowId, registrationId)
    const participant = this.participants.get(windowId)
    if (!participant || participant.registrationId !== registrationId)
      throw new Error('Unknown Session migration registration')
    participant.ready = true
    return { ready: true as const }
  }
  acknowledge(windowId: number, input: unknown) {
    this.check()
    const ack = rendererSessionBodyAckSchema.parse(input)
    this.options.admit(windowId, ack.registrationId)
    const pending = this.pending.get(ack.requestId)
    if (
      !pending ||
      pending.participant.windowId !== windowId ||
      pending.participant.registrationId !== ack.registrationId ||
      !isDeepStrictEqual(
        { ...ack, failure: undefined, sources: undefined, databases: undefined },
        { ...pending.request, failure: undefined, sources: undefined, databases: undefined }
      )
    )
      throw new Error('Foreign Session capture acknowledgement')
    pending.finish(ack)
  }
  private exactParticipants() {
    this.check()
    const ids = [...new Set(this.options.registeredWindowIds())].sort((a, b) => a - b),
      participants = [...this.participants.values()].sort((a, b) => a.windowId - b.windowId)
    if (
      !participants.length ||
      ids.length !== participants.length ||
      ids.some((id, index) => participants[index]?.windowId !== id) ||
      participants.some((p) => !p.ready)
    )
      throw new Error('Every current workspace window must bind the Session freeze gate')
    for (const participant of participants)
      this.options.admit(participant.windowId, participant.registrationId)
    return participants
  }
  private unchanged(participants: readonly Participant[]) {
    const current = this.exactParticipants()
    if (
      current.length !== participants.length ||
      current.some((participant, index) => participant !== participants[index])
    )
      throw new Error('Session freeze participant inventory changed')
  }
  private request(
    participant: Participant,
    sessionId: string,
    revision: string,
    phase: RendererSessionBodyRequest['phase']
  ): Promise<RendererSessionBodyAck> {
    this.check()
    const request: RendererSessionBodyRequest = {
      binding: this.binding,
      registrationId: participant.registrationId,
      requestId: randomUUID(),
      sessionId,
      revision,
      phase
    }
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(
        () => finish(undefined, new Error('Session freeze acknowledgement remains unconfirmed')),
        this.options.timeoutMs ?? 15000
      )
      const finish = (ack?: RendererSessionBodyAck, error?: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.pending.delete(request.requestId)
        if (error || !ack || ack.failure) reject(error ?? new Error('Session freeze failed'))
        else resolve(ack)
      }
      this.pending.set(request.requestId, { participant, request, finish })
      try {
        void Promise.resolve(this.options.send(participant.windowId, request)).catch((error) =>
          finish(undefined, error)
        )
      } catch (error) {
        finish(undefined, error)
      }
    })
  }
  async enumerate(sessionId: string): Promise<RendererSessionBodyEnumeration> {
    const participants = this.exactParticipants()
    const responses = await Promise.all(
      participants.map((participant) =>
        this.request(participant, sessionId, 'inventory', 'enumerate')
      )
    )
    this.unchanged(participants)
    const prefix = `lody-loro-repo-db-${this.binding.workspaceId}`
    let databases: RendererSessionBodyEnumeration['databases'] | undefined
    for (const response of responses) {
      const current = response.databases!
      if (
        new Set(current.map((source) => source.dbName)).size !== current.length ||
        current.some(
          (source) =>
            (source.dbName !== prefix && !source.dbName.startsWith(`${prefix}:`)) ||
            source.sourceId !== `renderer-idb:loro-doc-layout4:${source.dbName}`
        )
      )
        throw new Error('Foreign Session database enumeration')
      if (databases && !isDeepStrictEqual(databases, current))
        throw new Error('Window Session database enumerations disagree')
      databases = current
    }
    const inventory = {
      sessionId,
      participants: participants.map(({ windowId, registrationId }) => ({
        windowId,
        registrationId
      })),
      databases: databases ?? []
    }
    this.inventories.set(sessionId, inventory)
    return inventory
  }
  freezeAndCapture(sessionId: string, revision: string): Promise<FrozenRendererSessionBodyReceipt> {
    this.check()
    if (!sessionId || !revision) throw new Error('Session freeze identity required')
    const existing = this.rooms().find((row) => row.sessionId === sessionId)
    if (existing && (existing.revision !== revision || existing.owner === 'native'))
      throw new Error('Conflicting Session migration fence')
    const prior = this.jobs.get(sessionId)
    if (prior) return prior
    if (this.options.readCommittedOwner(sessionId) !== 'frozen')
      throw new Error('Durable Session body route must be frozen first')
    this.db
      .prepare(
        "INSERT INTO renderer_session_body_fences(binding,session_id,revision,owner) VALUES(?,?,?,'frozen') ON CONFLICT(binding,session_id) DO NOTHING"
      )
      .run(this.bindingKey, sessionId, revision)
    const participants = this.exactParticipants(),
      planned = this.inventories.get(sessionId)
    if (
      !planned ||
      !isDeepStrictEqual(
        planned.participants,
        participants.map(({ windowId, registrationId }) => ({ windowId, registrationId }))
      )
    )
      throw new Error('Complete Session enumeration must precede durable freeze')
    const work = (async () => {
      await Promise.all(
        participants.map((participant) => this.request(participant, sessionId, revision, 'freeze'))
      )
      this.unchanged(participants)
      const inventories = await Promise.all(
        participants.map((participant) => this.request(participant, sessionId, revision, 'capture'))
      )
      this.unchanged(participants)
      const merged = new Map<string, RendererSessionBodySource>()
      let expectedNames: string | undefined
      for (const inventory of inventories) {
        const sources = inventory.sources!
        if (
          !isDeepStrictEqual(
            sources.map(({ sourceId, dbName }) => ({ sourceId, dbName })),
            planned.databases
          )
        )
          throw new Error('Session database set changed after enumeration')
        const names = JSON.stringify(sources.map((source) => source.dbName).sort())
        if (expectedNames !== undefined && expectedNames !== names)
          throw new Error('Window Session database enumerations disagree')
        expectedNames = names
        for (const source of sources) {
          const prefix = `lody-loro-repo-db-${this.binding.workspaceId}`
          if (
            (source.dbName !== prefix && !source.dbName.startsWith(`${prefix}:`)) ||
            source.sourceId !== `renderer-idb:loro-doc-layout4:${source.dbName}`
          )
            throw new Error('Foreign Session database inventory')
          const previous = merged.get(source.sourceId)
          if (previous && !isDeepStrictEqual(previous, source))
            throw new Error('Window Session binary inventories disagree')
          merged.set(source.sourceId, source)
        }
      }
      const receipt: FrozenRendererSessionBodyReceipt = {
        binding: this.binding,
        sessionId,
        revision,
        sources: [...merged.values()],
        participants: participants.map(({ windowId, registrationId }) => ({
          windowId,
          registrationId
        }))
      }
      this.witnesses.set(sessionId, receipt)
      return receipt
    })().finally(() => {
      if (this.jobs.get(sessionId) === work) this.jobs.delete(sessionId)
    })
    this.jobs.set(sessionId, work)
    return work
  }
  assertFrozen(receipt: FrozenRendererSessionBodyReceipt) {
    this.check()
    if (this.witnesses.get(receipt.sessionId) !== receipt)
      throw new Error('Missing original Session freeze witness')
    const participants = this.exactParticipants()
    if (
      !isDeepStrictEqual(
        participants.map(({ windowId, registrationId }) => ({ windowId, registrationId })),
        receipt.participants
      )
    )
      throw new Error('Session freeze window set changed')
    const row = this.rooms().find((row) => row.sessionId === receipt.sessionId)
    if (row?.revision !== receipt.revision || row.owner !== 'frozen')
      throw new Error('Session freeze witness retired')
  }
  async published(receipt: FrozenRendererSessionBodyReceipt) {
    this.assertFrozen(receipt)
    if (this.options.readCommittedOwner(receipt.sessionId) !== 'native')
      throw new Error('Actual native body publication required')
    this.db
      .prepare(
        "UPDATE renderer_session_body_fences SET owner='native' WHERE binding=? AND session_id=? AND revision=? AND owner='frozen'"
      )
      .run(this.bindingKey, receipt.sessionId, receipt.revision)
    await Promise.all(
      receipt.participants.map((participant) =>
        this.request(
          this.participants.get(participant.windowId)!,
          receipt.sessionId,
          receipt.revision,
          'publish'
        )
      )
    )
  }
  /** Restart/reply-loss reconciliation only. The durable body journal, exact
   * nonce and current all-window registration remain authority; no legacy body
   * is opened and no binary is authored to recreate a lost local witness. */
  async reconcilePublished(sessionId: string, revision: string) {
    this.check()
    if (this.options.readCommittedOwner(sessionId) !== 'native')
      throw new Error('Actual native body publication required')
    const row = this.rooms().find((value) => value.sessionId === sessionId)
    if (!row || row.revision !== revision) throw new Error('Original Session window fence required')
    const participants = this.exactParticipants()
    this.db
      .prepare(
        "UPDATE renderer_session_body_fences SET owner='native' WHERE binding=? AND session_id=? AND revision=?"
      )
      .run(this.bindingKey, sessionId, revision)
    await Promise.all(
      participants.map((participant) => this.request(participant, sessionId, revision, 'publish'))
    )
    this.unchanged(participants)
  }
  retire(windowId: number, registrationId: string) {
    const participant = this.participants.get(windowId)
    if (participant?.registrationId !== registrationId) return
    this.participants.delete(windowId)
    for (const pending of this.pending.values())
      if (pending.participant === participant)
        pending.finish(undefined, new Error('Session migration window retired'))
  }
  windowClosed(windowId: number) {
    const participant = this.participants.get(windowId)
    if (participant) this.retire(windowId, participant.registrationId)
  }
  async close() {
    this.closed = true
    for (const pending of this.pending.values())
      pending.finish(undefined, new Error('Session migration controller retired'))
    await Promise.allSettled([...this.jobs.values()])
    if (this.db.isOpen) this.db.close()
  }
}

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  rendererDocumentDomainAckSchema,
  rendererDocumentDomainBindingSchema,
  rendererDocumentDomainScopeSchema,
  type RendererDocumentDomainBinding,
  type RendererDocumentDomainScope,
  type RendererDocumentDomainRegistration,
  type RendererDocumentDomainRequest,
  type RendererDocumentDomainAck,
  type RendererDocumentDomainSource
} from '@lody/shared/renderer-document-domain-migration'
type Participant = { windowId: number; registrationId: string; ready: boolean }
type Pending = {
  participant: Participant
  request: RendererDocumentDomainRequest
  finish(ack?: RendererDocumentDomainAck, error?: unknown): void
}
export type DocumentDomainEnumeration = {
  scope: RendererDocumentDomainScope
  participants: readonly { windowId: number; registrationId: string }[]
  databases: readonly { sourceId: string; dbName: string }[]
}
export type FrozenRendererDocumentDomainReceipt = {
  binding: RendererDocumentDomainBinding
  metadataGeneration: string
  scope: RendererDocumentDomainScope
  revision: string
  sources: readonly RendererDocumentDomainSource[]
  participants: readonly { windowId: number; registrationId: string }[]
}
/** Independent exact-room all-window proof. Neither a Session-body fence nor
 * the MF/SR whole-Flock freeze can satisfy this controller's acknowledgements. */
export class RendererDocumentDomainMigrationMainLegacy {
  readonly binding: RendererDocumentDomainBinding
  private readonly db: DatabaseSync
  private readonly bindingKey: string
  private readonly participants = new Map<number, Participant>()
  private readonly pending = new Map<string, Pending>()
  private readonly inventories = new Map<string, DocumentDomainEnumeration>()
  private readonly witnesses = new Map<string, FrozenRendererDocumentDomainReceipt>()
  private readonly jobs = new Map<string, Promise<FrozenRendererDocumentDomainReceipt>>()
  private closed = false
  constructor(
    private readonly options: {
      binding: RendererDocumentDomainBinding
      metadataGeneration: string
      databasePath: string
      admit(windowId: number, registrationId: string): void
      registeredWindowIds(): readonly number[]
      send(windowId: number, request: RendererDocumentDomainRequest): void | Promise<void>
      readCommittedOwner(scope: RendererDocumentDomainScope): 'legacy' | 'frozen' | 'native'
      /** Bound to the actual native Meta owner's generation, never a renderer field. */
      assertMetadataCurrent(scope: RendererDocumentDomainScope): void
      authorize(scope: RendererDocumentDomainScope): Promise<void>
      creationEnabled?: boolean
      timeoutMs?: number
    }
  ) {
    this.binding = Object.freeze(rendererDocumentDomainBindingSchema.parse(options.binding))
    this.bindingKey = JSON.stringify(this.binding)
    if (!options.metadataGeneration) throw new Error('Native Meta generation required')
    this.db = new DatabaseSync(options.databasePath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA synchronous=FULL')
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS renderer_document_domain_fences(binding TEXT NOT NULL,room_id TEXT NOT NULL,scope TEXT NOT NULL,revision TEXT NOT NULL,owner TEXT NOT NULL CHECK(owner IN ('frozen','native')),PRIMARY KEY(binding,room_id)) WITHOUT ROWID"
    )
  }
  private check(scope?: RendererDocumentDomainScope) {
    if (this.closed) throw new Error('Document migration controller retired')
    if (scope) this.options.assertMetadataCurrent(scope)
  }
  private rooms() {
    return (
      this.db
        .prepare('SELECT scope,revision,owner FROM renderer_document_domain_fences WHERE binding=?')
        .all(this.bindingKey) as { scope: string; revision: string; owner: 'frozen' | 'native' }[]
    ).map((row) => ({
      ...row,
      scope: rendererDocumentDomainScopeSchema.parse(JSON.parse(row.scope))
    }))
  }
  register(windowId: number, registrationId: string): RendererDocumentDomainRegistration {
    this.check()
    this.options.admit(windowId, registrationId)
    const previous = this.participants.get(windowId)
    if (previous && previous.registrationId !== registrationId)
      throw new Error('Previous document registration requires retirement')
    if (!previous) this.participants.set(windowId, { windowId, registrationId, ready: false })
    return {
      binding: this.binding,
      metadataGeneration: this.options.metadataGeneration,
      registrationId,
      rooms: this.rooms(),
      creationEnabled: this.options.creationEnabled === true
    }
  }
  ready(windowId: number, registrationId: string) {
    this.check()
    this.options.admit(windowId, registrationId)
    const participant = this.participants.get(windowId)
    if (!participant || participant.registrationId !== registrationId)
      throw new Error('Unknown document registration')
    participant.ready = true
    return { ready: true as const }
  }
  acknowledge(windowId: number, input: unknown) {
    this.check()
    const ack = rendererDocumentDomainAckSchema.parse(input)
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
      throw new Error('Foreign document capture acknowledgement')
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
      participants.some((participant) => !participant.ready)
    )
      throw new Error('Every workspace window must bind the document freeze gate')
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
      throw new Error('Document window inventory changed')
  }
  private request(
    participant: Participant,
    scope: RendererDocumentDomainScope,
    revision: string,
    phase: RendererDocumentDomainRequest['phase']
  ): Promise<RendererDocumentDomainAck> {
    this.check(scope)
    const request: RendererDocumentDomainRequest = {
      binding: this.binding,
      metadataGeneration: this.options.metadataGeneration,
      registrationId: participant.registrationId,
      requestId: randomUUID(),
      scope,
      revision,
      phase
    }
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (ack?: RendererDocumentDomainAck, error?: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.pending.delete(request.requestId)
        if (error || !ack || ack.failure) reject(error ?? new Error('Document freeze failed'))
        else resolve(ack)
      }
      const timer = setTimeout(
        () => finish(undefined, new Error('Document freeze acknowledgement unconfirmed')),
        this.options.timeoutMs ?? 15000
      )
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
  async enumerate(input: RendererDocumentDomainScope): Promise<DocumentDomainEnumeration> {
    const scope = rendererDocumentDomainScopeSchema.parse(input)
    this.check(scope)
    await this.options.authorize(scope)
    this.check(scope)
    const participants = this.exactParticipants(),
      responses = await Promise.all(
        participants.map((participant) =>
          this.request(participant, scope, 'inventory', 'enumerate')
        )
      )
    this.unchanged(participants)
    const prefix = `lody-loro-repo-db-${this.binding.workspaceId}`
    let databases: DocumentDomainEnumeration['databases'] | undefined
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
        throw new Error('Foreign document database inventory')
      if (databases && !isDeepStrictEqual(databases, current))
        throw new Error('Window document inventories disagree')
      databases = current
    }
    const inventory = {
      scope,
      participants: participants.map(({ windowId, registrationId }) => ({
        windowId,
        registrationId
      })),
      databases: databases ?? []
    }
    this.inventories.set(scope.roomId, inventory)
    return inventory
  }
  freezeAndCapture(
    input: RendererDocumentDomainScope,
    revision: string
  ): Promise<FrozenRendererDocumentDomainReceipt> {
    const scope = rendererDocumentDomainScopeSchema.parse(input)
    this.check(scope)
    const previous = this.rooms().find((room) => room.scope.roomId === scope.roomId)
    if (
      !revision ||
      (previous &&
        (!isDeepStrictEqual(previous.scope, scope) ||
          previous.revision !== revision ||
          previous.owner === 'native'))
    )
      throw new Error('Conflicting document freeze fence')
    const prior = this.jobs.get(scope.roomId)
    if (prior) return prior
    if (this.options.readCommittedOwner(scope) !== 'frozen')
      throw new Error('Durable exact document route must be frozen first')
    const participants = this.exactParticipants(),
      planned = this.inventories.get(scope.roomId)
    if (
      !planned ||
      !isDeepStrictEqual(planned.scope, scope) ||
      !isDeepStrictEqual(
        planned.participants,
        participants.map(({ windowId, registrationId }) => ({ windowId, registrationId }))
      )
    )
      throw new Error('Complete document enumeration must precede freeze')
    this.db
      .prepare(
        "INSERT INTO renderer_document_domain_fences(binding,room_id,scope,revision,owner) VALUES(?,?,?,?,'frozen') ON CONFLICT(binding,room_id) DO NOTHING"
      )
      .run(this.bindingKey, scope.roomId, JSON.stringify(scope), revision)
    const work = (async () => {
      await Promise.all(
        participants.map((participant) => this.request(participant, scope, revision, 'freeze'))
      )
      this.unchanged(participants)
      this.check(scope)
      const captures = await Promise.all(
        participants.map((participant) => this.request(participant, scope, revision, 'capture'))
      )
      this.unchanged(participants)
      this.check(scope)
      const merged = new Map<string, RendererDocumentDomainSource>()
      for (const capture of captures) {
        if (
          !isDeepStrictEqual(
            capture.sources!.map(({ sourceId, dbName }) => ({ sourceId, dbName })),
            planned.databases
          )
        )
          throw new Error('Document database set changed after enumeration')
        for (const source of capture.sources!) {
          const before = merged.get(source.sourceId)
          if (before && !isDeepStrictEqual(before, source))
            throw new Error('Window document binary sources disagree')
          merged.set(source.sourceId, source)
        }
      }
      const receipt = {
        binding: this.binding,
        metadataGeneration: this.options.metadataGeneration,
        scope,
        revision,
        sources: [...merged.values()],
        participants: participants.map(({ windowId, registrationId }) => ({
          windowId,
          registrationId
        }))
      }
      this.witnesses.set(scope.roomId, receipt)
      return receipt
    })().finally(() => {
      if (this.jobs.get(scope.roomId) === work) this.jobs.delete(scope.roomId)
    })
    this.jobs.set(scope.roomId, work)
    return work
  }
  assertFrozen(receipt: FrozenRendererDocumentDomainReceipt) {
    this.check(receipt.scope)
    if (
      this.witnesses.get(receipt.scope.roomId) !== receipt ||
      receipt.metadataGeneration !== this.options.metadataGeneration
    )
      throw new Error('Original exact document witness required')
    const participants = this.exactParticipants(),
      room = this.rooms().find((row) => row.scope.roomId === receipt.scope.roomId)
    if (
      !isDeepStrictEqual(
        participants.map(({ windowId, registrationId }) => ({ windowId, registrationId })),
        receipt.participants
      ) ||
      room?.revision !== receipt.revision ||
      room.owner !== 'frozen' ||
      !isDeepStrictEqual(room.scope, receipt.scope)
    )
      throw new Error('Document freeze witness retired')
  }
  async published(receipt: FrozenRendererDocumentDomainReceipt) {
    this.assertFrozen(receipt)
    await this.resumeNative(receipt.scope, receipt.revision)
  }
  async resumeNative(scope: RendererDocumentDomainScope, revision: string) {
    this.check(scope)
    await this.options.authorize(scope)
    this.check(scope)
    const stored = this.rooms().find((row) => row.scope.roomId === scope.roomId)
    if (
      !stored ||
      stored.revision !== revision ||
      !isDeepStrictEqual(stored.scope, scope) ||
      this.options.readCommittedOwner(scope) !== 'native'
    )
      throw new Error('Verified native document publication required')
    this.db
      .prepare(
        "UPDATE renderer_document_domain_fences SET owner='native' WHERE binding=? AND room_id=? AND revision=?"
      )
      .run(this.bindingKey, scope.roomId, revision)
    const participants = this.exactParticipants()
    await Promise.all(
      participants.map((participant) => this.request(participant, scope, revision, 'publish'))
    )
    this.unchanged(participants)
  }
  retire(windowId: number, registrationId: string) {
    const participant = this.participants.get(windowId)
    if (participant?.registrationId !== registrationId) return
    this.participants.delete(windowId)
    for (const pending of this.pending.values())
      if (pending.participant === participant)
        pending.finish(undefined, new Error('Document window retired'))
  }
  windowClosed(windowId: number) {
    const participant = this.participants.get(windowId)
    if (participant) this.retire(windowId, participant.registrationId)
  }
  async close() {
    this.closed = true
    for (const pending of this.pending.values())
      pending.finish(undefined, new Error('Document controller retired'))
    await Promise.allSettled([...this.jobs.values()])
    if (this.db.isOpen) this.db.close()
  }
}

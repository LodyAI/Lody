import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  FLOCK_GROUP_MAX_BYTES,
  rendererFlockGroupSchema,
  rendererFlockGroupKey,
  rendererFlockGroupScope,
  rendererFlockGroupOwnerSchema,
  rendererFlockGroupAckSchema,
  rendererFlockGroupInventoryBytes,
  type RendererFlockGroup,
  type RendererFlockGroupOwner,
  type RendererFlockGroupRegistration,
  type RendererFlockGroupRequest,
  type RendererFlockGroupAck,
  type RendererFlockGroupInventory
} from '@lody/shared/renderer-flock-room-group'

type WindowOwner = {
  windowId: number
  registrationId: string
  attemptId: string
  ready: boolean
  senders: Set<() => void>
}
type Pending = {
  owner: WindowOwner
  request: RendererFlockGroupRequest
  finish(ack?: RendererFlockGroupAck, error?: unknown): void
}
export type RendererFlockGroupFrozenReceipt = {
  group: RendererFlockGroup
  revision: string
  windows: Array<{
    windowId: number
    registrationId: string
    inventory: RendererFlockGroupInventory
  }>
}
export class RendererFlockGroupMainReleaseFailed extends Error {
  constructor(
    cause: unknown,
    readonly retryCleanup: () => void
  ) {
    super('Renderer room-group SQLite release remains unconfirmed', { cause })
  }
}

/**
 * Trusted Node composition, not a renderer service. The main selects one exact
 * group before registration. A changed MF set cannot shadow an existing fence.
 * @deprecated Promise IPC boundary; replace when product IPC consumes a native Layer.
 */
export class RendererFlockRoomGroupMigrationMainLegacy {
  readonly group: RendererFlockGroup
  private readonly scope: string
  private readonly key: string
  private readonly roomBinding: string
  private readonly database: Database.Database
  private readonly attempts = new Map<number, string>()
  private readonly windows = new Map<number, WindowOwner>()
  private readonly pending = new Map<string, Pending>()
  private readonly registrationWaiters = new Set<() => void>()
  private witness: { revision: string; participants: WindowOwner[] } | undefined
  private migrating = false
  private closed = false
  private released = false
  constructor(
    private readonly options: {
      group: RendererFlockGroup
      databasePath: string
      registeredWindowIds(): readonly number[]
      send(windowId: number, request: RendererFlockGroupRequest): void | Promise<void>
      /** Must prove every exact selected room's real journal AND physical native storage. */
      readCommittedOwner(group: RendererFlockGroup): Promise<'legacy' | 'frozen' | 'native'>
      publishOwner?(windowId: number, owner: RendererFlockGroupRegistration): void
      timeoutMs?: number
      /** First local MF pilot: reject unsupported foreign owners before freeze. */
      preflight?: boolean
    }
  ) {
    this.group = rendererFlockGroupSchema.parse(options.group)
    Object.freeze(this.group.roomIds)
    Object.freeze(this.group)
    this.key = rendererFlockGroupKey(this.group)
    this.scope = rendererFlockGroupScope(this.group)
    this.roomBinding = JSON.stringify([
      this.group.accountId,
      this.group.workspaceId,
      this.group.contentMode
    ])
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > 120_000)
    )
      throw new Error('Invalid room-group freeze deadline')
    this.database = new Database(options.databasePath)
    try {
      this.database.pragma('journal_mode = WAL')
      this.database.pragma('synchronous = FULL')
      this.database.exec(`CREATE TABLE IF NOT EXISTS renderer_flock_group_owners (
        scope TEXT PRIMARY KEY, group_json TEXT NOT NULL, revision TEXT NOT NULL,
        owner TEXT NOT NULL CHECK(owner IN ('frozen','native'))
      ) WITHOUT ROWID`)
      this.database.exec(`CREATE TABLE IF NOT EXISTS renderer_flock_group_rooms (
        binding TEXT NOT NULL, room_id TEXT NOT NULL, group_scope TEXT NOT NULL,
        PRIMARY KEY(binding,room_id)
      ) WITHOUT ROWID`)
      // Adopt the earlier unpublished domain-scoped format without clearing a
      // frozen/native marker. Markers and per-room claims move atomically.
      this.database.transaction(() => {
        const rows = this.database
          .prepare('SELECT scope,group_json FROM renderer_flock_group_owners')
          .all() as Array<{ scope: string; group_json: string }>
        for (const row of rows) {
          const group = rendererFlockGroupSchema.parse(JSON.parse(row.group_json))
          const scope = rendererFlockGroupScope(group)
          if (scope !== row.scope)
            this.database
              .prepare('UPDATE renderer_flock_group_owners SET scope=? WHERE scope=?')
              .run(scope, row.scope)
          this.claimRooms(group, scope)
        }
      })()
      this.status()
    } catch (cause) {
      this.database.close()
      throw cause
    }
  }
  private check() {
    if (this.closed) throw new Error('Renderer room-group main owner closed')
  }
  /** Call only inside the transaction which writes/adopts its durable marker. */
  private claimRooms(group: RendererFlockGroup, scope: string): void {
    const binding = JSON.stringify([group.accountId, group.workspaceId, group.contentMode])
    for (const roomId of group.roomIds) {
      this.database
        .prepare('INSERT OR IGNORE INTO renderer_flock_group_rooms VALUES (?,?,?)')
        .run(binding, roomId, scope)
      const claim = this.database
        .prepare('SELECT group_scope FROM renderer_flock_group_rooms WHERE binding=? AND room_id=?')
        .get(binding, roomId) as { group_scope: string }
      if (claim.group_scope !== scope)
        throw new Error('Selected room overlaps another migration group')
    }
  }
  status(): RendererFlockGroupOwner {
    this.check()
    const row = this.database
      .prepare('SELECT group_json,revision,owner FROM renderer_flock_group_owners WHERE scope=?')
      .get(this.scope) as
      | { group_json: string; revision: string; owner: 'frozen' | 'native' }
      | undefined
    if (row && row.group_json !== this.key)
      throw new Error(
        'Room group changed; existing maintenance/native ownership requires explicit recovery'
      )
    for (const roomId of this.group.roomIds) {
      const claim = this.database
        .prepare('SELECT group_scope FROM renderer_flock_group_rooms WHERE binding=? AND room_id=?')
        .get(this.roomBinding, roomId) as { group_scope: string } | undefined
      if (claim && claim.group_scope !== this.scope)
        throw new Error('Selected room overlaps another migration group')
      if (Boolean(row) !== Boolean(claim))
        throw new Error('Room group maintenance/claim recovery is required')
    }
    return rendererFlockGroupOwnerSchema.parse({
      group: this.group,
      revision: row?.revision ?? 'legacy-group-v1',
      owner: row?.owner ?? 'legacy'
    })
  }
  async reconcileOwner(): Promise<void> {
    const before = this.status()
    const actual = await this.options.readCommittedOwner(this.group)
    const current = this.status()
    if (current.owner === 'frozen' || current.owner === actual) return
    if (actual === 'legacy') {
      if (current.owner === 'native')
        throw new Error('Native group conflicts with its actual room journal')
      return
    }
    if (current.revision !== before.revision) return
    this.database.transaction(() => {
      this.status()
      this.claimRooms(this.group, this.scope)
      this.database
        .prepare(`INSERT INTO renderer_flock_group_owners VALUES (?,?,?,?)
        ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,owner=excluded.owner`)
        .run(this.scope, this.key, randomUUID(), actual)
    })()
  }
  beginRegistration(windowId: number): string {
    this.check()
    if (!this.options.registeredWindowIds().includes(windowId))
      throw new Error('Unregistered product window')
    if (!this.windows.has(windowId) && (this.migrating || this.witness)) {
      this.witness = undefined
      this.database
        .prepare(
          "UPDATE renderer_flock_group_owners SET revision=? WHERE scope=? AND owner='frozen'"
        )
        .run(randomUUID(), this.scope)
    }
    const attempt = randomUUID()
    this.attempts.set(windowId, attempt)
    return attempt
  }
  register(windowId: number, attemptId: string): RendererFlockGroupRegistration {
    this.check()
    if (
      !this.options.registeredWindowIds().includes(windowId) ||
      this.attempts.get(windowId) !== attemptId
    )
      throw new Error('Room group registration attempt retired')
    const previous = this.windows.get(windowId)
    if (previous?.attemptId === attemptId)
      return { ...this.status(), registrationId: previous.registrationId }
    if (previous) this.retire(windowId, previous.registrationId)
    // Retiring a previous generation may clear its own attempt, never this newer one.
    this.attempts.set(windowId, attemptId)
    const owner = {
      windowId,
      attemptId,
      registrationId: randomUUID(),
      ready: false,
      senders: new Set<() => void>()
    }
    this.windows.set(windowId, owner)
    for (const notify of this.registrationWaiters) notify()
    return { ...this.status(), registrationId: owner.registrationId }
  }
  assertRegistration(windowId: number, registrationId: string): void {
    this.check()
    const owner = this.windows.get(windowId)
    if (
      !owner ||
      owner.registrationId !== registrationId ||
      !this.options.registeredWindowIds().includes(windowId)
    )
      throw new Error('Room group registration retired')
  }
  ready(windowId: number, registrationId: string): RendererFlockGroupOwner {
    this.check()
    const owner = this.windows.get(windowId)
    if (!owner || owner.registrationId !== registrationId)
      throw new Error('Room group registration retired')
    owner.ready = true
    for (const send of owner.senders) send()
    owner.senders.clear()
    return this.status()
  }
  retire(windowId: number, registrationId: string): void {
    const owner = this.windows.get(windowId)
    if (!owner || owner.registrationId !== registrationId) return
    const invalidates = this.migrating || this.witness?.participants.includes(owner)
    this.windows.delete(windowId)
    for (const notify of this.registrationWaiters) notify()
    if (this.attempts.get(windowId) === owner.attemptId) this.attempts.delete(windowId)
    for (const pending of [...this.pending.values()])
      if (pending.owner === owner)
        pending.finish(undefined, new Error('Room group participant retired'))
    if (invalidates) {
      this.witness = undefined
      this.database
        .prepare(
          "UPDATE renderer_flock_group_owners SET revision=? WHERE scope=? AND owner='frozen'"
        )
        .run(randomUUID(), this.scope)
    }
  }
  windowClosed(windowId: number): void {
    this.attempts.delete(windowId)
    const owner = this.windows.get(windowId)
    if (owner) this.retire(windowId, owner.registrationId)
  }
  acceptAck(windowId: number, input: unknown): void {
    this.check()
    const ack = rendererFlockGroupAckSchema.parse(input)
    const owner = this.windows.get(windowId)
    if (!owner || owner.registrationId !== ack.registrationId)
      throw new Error('Room group ACK registration retired')
    const pending = this.pending.get(ack.requestId)
    if (!pending || pending.owner !== owner) {
      for (const current of [...this.pending.values()])
        if (current.owner === owner && current.request.revision === ack.revision)
          current.finish(undefined, new Error('Unknown room group acknowledgement'))
      throw new Error('Unknown room group acknowledgement')
    }
    if (
      rendererFlockGroupKey(ack.group) !== this.key ||
      ack.revision !== pending.request.revision ||
      ack.phase !== pending.request.phase
    ) {
      pending.finish(undefined, new Error('Room group acknowledgement mismatch'))
      throw new Error('Room group acknowledgement mismatch')
    }
    pending.finish(ack, ack.failure ? new Error(`Renderer room group ${ack.failure}`) : undefined)
  }
  private request(
    owner: WindowOwner,
    revision: string,
    phase: 'preflight' | 'freeze' | 'capture',
    signal: AbortSignal
  ): Promise<RendererFlockGroupAck> {
    const request = {
      group: this.group,
      revision,
      phase,
      registrationId: owner.registrationId,
      requestId: randomUUID()
    }
    return new Promise((resolve, reject) => {
      const abort = () =>
        pending.finish(undefined, signal.reason ?? new Error('Room group freeze cancelled'))
      const send = () => {
        if (!this.pending.has(request.requestId)) return
        Promise.resolve()
          .then(() => this.options.send(owner.windowId, request))
          .catch((error) => pending.finish(undefined, error))
      }
      const pending: Pending = {
        owner,
        request,
        finish: (ack, error) => {
          if (!this.pending.delete(request.requestId)) return
          signal.removeEventListener('abort', abort)
          owner.senders.delete(send)
          if (error !== undefined) reject(error)
          else resolve(ack!)
        }
      }
      this.pending.set(request.requestId, pending)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else if (owner.ready) send()
      else owner.senders.add(send)
    })
  }
  private assertParticipants(participants: WindowOwner[]): void {
    this.check()
    const ids = [...new Set(this.options.registeredWindowIds())].sort((a, b) => a - b)
    if (
      JSON.stringify(ids) !==
        JSON.stringify(participants.map((owner) => owner.windowId).sort((a, b) => a - b)) ||
      participants.some((owner) => this.windows.get(owner.windowId) !== owner)
    )
      throw new Error('Room group all-window witness retired or incomplete')
  }
  /** A product window can exist before its renderer finishes registration.
   * Wait for that exact window set before preflight or durable freeze; absence
   * of a registration is not evidence that its persisted source is absent. */
  private registeredParticipants(signal: AbortSignal): Promise<WindowOwner[]> {
    return new Promise((resolve, reject) => {
      const finish = (owners?: WindowOwner[], error?: unknown) => {
        this.registrationWaiters.delete(check)
        signal.removeEventListener('abort', abort)
        if (error !== undefined) reject(error)
        else resolve(owners!)
      }
      const abort = () =>
        finish(undefined, signal.reason ?? new Error('Room group registration canceled'))
      const check = () => {
        try {
          this.check()
          const ids = [...new Set(this.options.registeredWindowIds())]
          if (!ids.length)
            throw new Error('Every product window requires a group startup registration')
          if (ids.every((id) => this.windows.has(id))) {
            finish(ids.map((id) => this.windows.get(id)!))
          } else if (signal.aborted) abort()
        } catch (error) {
          finish(undefined, error)
        }
      }
      this.registrationWaiters.add(check)
      signal.addEventListener('abort', abort, { once: true })
      check()
    })
  }
  async freeze(signal?: AbortSignal): Promise<RendererFlockGroupFrozenReceipt> {
    if (this.migrating || this.status().owner === 'native')
      throw new Error('Room group migration already active or native')
    this.migrating = true
    this.witness = undefined
    const revision = randomUUID()
    const cancellation = new AbortController()
    const combined = AbortSignal.any([
      cancellation.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      ...(signal ? [signal] : [])
    ])
    try {
      await this.registeredParticipants(combined)
      if (this.options.preflight && this.status().owner === 'legacy') {
        const ids = [...new Set(this.options.registeredWindowIds())]
        if (!ids.length || ids.some((id) => !this.windows.has(id)))
          throw new Error('Every product window requires MF preflight registration')
        const participants = ids.map((id) => this.windows.get(id)!)
        this.assertParticipants(participants)
        const preflight = await Promise.all(
          participants.map((owner) =>
            this.request(owner, this.status().revision, 'preflight', combined)
          )
        )
        this.assertParticipants(participants)
        if (preflight.some((ack) => ack.otherMachineOwners?.length))
          throw new Error('MF pilot requires a single-machine local inventory')
        if (combined.aborted) throw combined.reason
      }
      this.database.transaction(() => {
        this.status() // Exact set check in the same transaction, before durable freeze.
        this.claimRooms(this.group, this.scope)
        this.database
          .prepare(`INSERT INTO renderer_flock_group_owners VALUES (?,?,?,'frozen')
          ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,owner='frozen'`)
          .run(this.scope, this.key, revision)
      })()
      const ids = [...new Set(this.options.registeredWindowIds())]
      if (!ids.length || ids.some((id) => !this.windows.has(id)))
        throw new Error('Every product window requires a group startup registration')
      const participants = ids.map((id) => this.windows.get(id)!)
      this.assertParticipants(participants)
      await Promise.all(
        participants.map((owner) => this.request(owner, revision, 'freeze', combined))
      )
      this.assertParticipants(participants)
      const captures = await Promise.all(
        participants.map((owner) => this.request(owner, revision, 'capture', combined))
      )
      this.assertParticipants(participants)
      if (this.status().revision !== revision)
        throw new Error('Room group freeze generation retired')
      const bytes = captures.reduce(
        (total, ack) =>
          total +
          rendererFlockGroupInventoryBytes(ack.inventory!) +
          new TextEncoder().encode(JSON.stringify({ ...ack, inventory: undefined })).length,
        0
      )
      if (bytes > FLOCK_GROUP_MAX_BYTES)
        throw new Error('All-window complete group inventory exceeds byte budget')
      this.witness = { revision, participants }
      return {
        group: this.group,
        revision,
        windows: captures.map((ack, index) => ({
          windowId: participants[index]!.windowId,
          registrationId: ack.registrationId,
          inventory: ack.inventory!
        }))
      }
    } finally {
      cancellation.abort(new Error('Room group freeze attempt ended'))
      this.migrating = false
    }
  }
  assertFrozen(revision: string): void {
    if (
      !this.witness ||
      this.witness.revision !== revision ||
      this.status().owner !== 'frozen' ||
      this.status().revision !== revision
    )
      throw new Error('Room group frozen inventory witness is absent or retired')
    this.assertParticipants(this.witness.participants)
  }
  async complete(revision: string): Promise<void> {
    const before = this.status()
    if (before.revision !== revision) throw new Error('Room group completion revision mismatch')
    if (before.owner !== 'native') this.assertFrozen(revision)
    if ((await this.options.readCommittedOwner(this.group)) !== 'native')
      throw new Error('Whole room group is not durably native')
    this.check()
    if (before.owner !== 'native') {
      this.assertFrozen(revision)
      const changed = this.database
        .prepare(
          "UPDATE renderer_flock_group_owners SET owner='native' WHERE scope=? AND revision=? AND owner='frozen'"
        )
        .run(this.scope, revision)
      if (changed.changes !== 1) throw new Error('Room group publication generation retired')
    }
    this.witness = undefined
    for (const owner of this.windows.values()) {
      try {
        this.options.publishOwner?.(owner.windowId, {
          ...this.status(),
          registrationId: owner.registrationId
        })
      } catch {
        console.error('[Room group] Native owner notification failed')
      }
    }
  }
  close(): void {
    if (this.released) return
    this.closed = true
    for (const notify of this.registrationWaiters) notify()
    for (const pending of [...this.pending.values()])
      pending.finish(undefined, new Error('Room group main owner closed'))
    this.windows.clear()
    this.attempts.clear()
    try {
      if (this.database.open) this.database.close()
      if (this.database.open) throw new Error('Room group SQLite close remains unconfirmed')
      this.released = true
    } catch (cause) {
      throw new RendererFlockGroupMainReleaseFailed(cause, () => this.close())
    }
  }
}

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  rendererWfBindingSchema,
  rendererWfBindingKey,
  rendererWfAckSchema,
  rendererWfOwnerSchema,
  type RendererWfBinding,
  type RendererWfOwner,
  type RendererWfRegistration,
  type RendererWfPublishedOwner,
  type RendererWfRequest,
  type RendererWfAck
} from '@lody/shared/renderer-room-migration'

type WindowOwner = {
  windowId: number
  binding: RendererWfBinding
  generation: string
  attemptId: string
  ready: boolean
  readyWaiters: Set<() => void>
}
type Pending = {
  window: WindowOwner
  request: RendererWfRequest
  resolve: (ack: RendererWfAck) => void
  reject: (cause: unknown) => void
}
type Options = {
  databasePath: string
  /** Exact current registered product windows, including neutral/warming windows. */
  registeredWindowIds(): readonly number[]
  /** ProductWindow IPC only; target must still be this exact registered main frame. */
  send(windowId: number, request: RendererWfRequest): void | Promise<void>
  publishOwner?(windowId: number, owner: RendererWfPublishedOwner): void
  /** Reads the real whole-room engine routing journal, never an aggregate health flag. */
  readCommittedOwner(binding: RendererWfBinding): Promise<'legacy' | 'native' | 'frozen'>
}
export class RendererWfMainReleaseFailed extends Error {
  readonly retryCleanup: () => void
  constructor(cause: unknown, retryCleanup: () => void) {
    super('Renderer WF main SQLite release remains unconfirmed', { cause })
    this.retryCleanup = retryCleanup
  }
}

/** Trusted main composition. No renderer can select paths, accounts or target window ids. */
export class RendererWorkspaceFlockMigrationMainLegacy {
  private readonly options: Options
  private readonly database: Database.Database
  private readonly windows = new Map<number, WindowOwner>()
  private readonly attempts = new Map<number, string>()
  private readonly pending = new Map<string, Pending>()
  private readonly migrating = new Set<string>()
  private readonly captures = new Map<string, { revision: string; participants: WindowOwner[] }>()
  private closed = false
  private released = false
  constructor(options: Options) {
    this.options = options
    this.database = new Database(options.databasePath)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = FULL')
    this.database.exec(`CREATE TABLE IF NOT EXISTS renderer_wf_owners (
      binding TEXT PRIMARY KEY, revision TEXT NOT NULL, owner TEXT NOT NULL
    ) WITHOUT ROWID`)
  }
  status(binding: RendererWfBinding): RendererWfOwner {
    this.check()
    const parsed = rendererWfBindingSchema.parse(binding)
    const row = this.database
      .prepare('SELECT revision, owner FROM renderer_wf_owners WHERE binding = ?')
      .get(rendererWfBindingKey(parsed)) as
      | { revision: string; owner: 'frozen' | 'native' }
      | undefined
    return rendererWfOwnerSchema.parse({
      binding: parsed,
      revision: row?.revision ?? 'legacy-v1',
      owner: row?.owner ?? 'legacy'
    })
  }
  /** Actual journal ownership selects startup; a maintenance receipt can only tighten it. */
  async reconcileOwner(binding: RendererWfBinding): Promise<void> {
    const before = this.status(binding)
    const actual = await this.options.readCommittedOwner(binding)
    this.check()
    const current = this.status(binding)
    if (current.owner === 'frozen') return
    if (current.owner === actual) return
    if (actual === 'legacy') {
      if (current.owner === 'native')
        throw new Error('Native WF ownership conflicts with its durable journal')
      return
    }
    if (current.revision !== before.revision) return
    this.database
      .prepare(`INSERT INTO renderer_wf_owners(binding,revision,owner) VALUES (?,?,?)
      ON CONFLICT(binding) DO UPDATE SET revision=excluded.revision,owner=excluded.owner`)
      .run(rendererWfBindingKey(binding), randomUUID(), actual)
  }
  assertRegistration(windowId: number, registrationId: string, binding: RendererWfBinding): void {
    this.check()
    const owner = this.windows.get(windowId)
    if (
      !owner ||
      !owner.ready ||
      owner.generation !== registrationId ||
      rendererWfBindingKey(owner.binding) !== rendererWfBindingKey(binding)
    )
      throw new Error('Renderer WF registration is absent or retired')
  }
  /** Must complete before that frame creates any legacy WF runtime. */
  beginRegistration(windowId: number): string {
    this.check()
    if (!this.options.registeredWindowIds().includes(windowId))
      throw new Error('Unregistered product window')
    const attemptId = randomUUID()
    this.attempts.set(windowId, attemptId)
    return attemptId
  }
  register(
    windowId: number,
    binding: RendererWfBinding,
    attemptId: string
  ): RendererWfRegistration {
    this.check()
    const parsed = rendererWfBindingSchema.parse(binding)
    if (!this.options.registeredWindowIds().includes(windowId))
      throw new Error('Unregistered product window')
    if (this.attempts.get(windowId) !== attemptId)
      throw new Error('Renderer WF registration attempt retired')
    const previous = this.windows.get(windowId)
    if (previous?.attemptId === attemptId) {
      if (rendererWfBindingKey(previous.binding) !== rendererWfBindingKey(binding))
        throw new Error('Renderer WF registration binding changed')
      return { ...this.status(previous.binding), registrationId: previous.generation }
    }
    if (previous) this.retire(windowId, previous.generation)
    const owner = {
      windowId,
      binding: parsed,
      generation: randomUUID(),
      attemptId,
      ready: false,
      readyWaiters: new Set<() => void>()
    }
    this.windows.set(windowId, owner)
    return { ...this.status(owner.binding), registrationId: owner.generation }
  }
  /** Renderer installs its request listener BEFORE invoking this readiness handshake. */
  ready(windowId: number, registrationId: string): RendererWfOwner {
    this.check()
    const owner = this.windows.get(windowId)
    if (!owner || owner.generation !== registrationId)
      throw new Error('Renderer WF startup registration missing or retired')
    owner.ready = true
    for (const send of owner.readyWaiters) send()
    owner.readyWaiters.clear()
    return this.status(owner.binding)
  }
  /** Call on close, render-process-gone, navigation, binding switch and unregister. */
  windowClosed(windowId: number): void {
    this.attempts.delete(windowId)
    const owner = this.windows.get(windowId)
    if (owner) this.retire(windowId, owner.generation)
  }
  retire(windowId: number, registrationId: string): void {
    const owner = this.windows.get(windowId)
    if (!owner || owner.generation !== registrationId) return
    const key = rendererWfBindingKey(owner.binding)
    const invalidates =
      this.migrating.has(key) || this.captures.get(key)?.participants.includes(owner) === true
    if (invalidates) this.captures.delete(key)
    if (this.attempts.get(windowId) === owner.attemptId) this.attempts.delete(windowId)
    this.windows.delete(windowId)
    for (const [id, pending] of this.pending)
      if (pending.window === owner) {
        this.pending.delete(id)
        pending.reject(new Error('Renderer freeze participant retired before acknowledgement'))
      }
    if (invalidates) {
      // The child helper reads this FULL marker immediately before publication.
      // Retiring a captured frame must invalidate that receipt across processes,
      // not merely remove the in-memory witness used by main.complete.
      this.database
        .prepare("UPDATE renderer_wf_owners SET revision=? WHERE binding=? AND owner='frozen'")
        .run(randomUUID(), key)
    }
  }
  acceptAck(windowId: number, message: unknown): void {
    this.check()
    const ack = rendererWfAckSchema.parse(message)
    const current = this.windows.get(windowId)
    if (!current || current.generation !== ack.registrationId)
      throw new Error('Renderer WF acknowledgement registration retired')
    const pending = this.pending.get(ack.requestId)
    if (
      !pending ||
      pending.window.windowId !== windowId ||
      this.windows.get(windowId) !== pending.window
    ) {
      for (const [id, owned] of this.pending)
        if (owned.window.windowId === windowId && owned.request.revision === ack.revision) {
          this.pending.delete(id)
          owned.reject(new Error('Unknown renderer freeze acknowledgement'))
        }
      throw new Error('Unknown or retired renderer freeze acknowledgement')
    }
    const expected = pending.request
    if (
      ack.revision !== expected.revision ||
      ack.phase !== expected.phase ||
      ack.registrationId !== expected.registrationId ||
      rendererWfBindingKey(ack.binding) !== rendererWfBindingKey(expected.binding) ||
      (!ack.failure &&
        (ack.phase === 'freeze' ? ack.sources !== undefined : ack.sources === undefined))
    ) {
      this.pending.delete(ack.requestId)
      pending.reject(new Error('Renderer freeze acknowledgement mismatch'))
      throw new Error('Renderer freeze acknowledgement mismatch')
    }
    if (ack.failure) {
      this.pending.delete(ack.requestId)
      pending.reject(new Error(`Renderer WF ${ack.failure}`))
      return
    }
    this.pending.delete(ack.requestId)
    pending.resolve(ack)
  }
  private request(
    window: WindowOwner,
    revision: string,
    phase: 'freeze' | 'capture',
    signal?: AbortSignal
  ): Promise<RendererWfAck> {
    const request = {
      binding: window.binding,
      revision,
      phase,
      requestId: randomUUID(),
      registrationId: window.generation
    }
    return new Promise<RendererWfAck>((resolve, reject) => {
      let send: () => void = () => {}
      const finish = (run: () => void) => {
        signal?.removeEventListener('abort', abort)
        window.readyWaiters.delete(send)
        run()
      }
      const abort = () => {
        this.pending.delete(request.requestId)
        finish(() => reject(signal?.reason ?? new Error('Renderer freeze cancelled')))
      }
      this.pending.set(request.requestId, {
        window,
        request,
        resolve: (ack) => finish(() => resolve(ack)),
        reject: (cause) => finish(() => reject(cause))
      })
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      send = () => {
        if (!this.pending.has(request.requestId)) return
        Promise.resolve()
          .then(() => this.options.send(window.windowId, request))
          .catch((cause) => {
            const pending = this.pending.get(request.requestId)
            if (pending) {
              this.pending.delete(request.requestId)
              pending.reject(cause)
            }
          })
      }
      if (window.ready) send()
      else window.readyWaiters.add(send)
    })
  }
  /** Two phases: nobody exports IDB while another registered frame can still write. */
  async freeze(
    binding: RendererWfBinding,
    signal?: AbortSignal
  ): Promise<{ revision: string; sources: NonNullable<RendererWfAck['sources']> }> {
    this.check()
    const parsed = rendererWfBindingSchema.parse(binding)
    const key = rendererWfBindingKey(parsed)
    if (this.migrating.has(key)) throw new Error('Renderer WF migration already active')
    this.migrating.add(key)
    const previous = this.status(parsed)
    if (previous.owner === 'native') {
      this.migrating.delete(key)
      throw new Error('Renderer WF is already native')
    }
    // Each retry has its own receipt epoch even while durable maintenance stays
    // frozen. A slow ACK from an aborted capture cannot cancel the next attempt.
    const revision = randomUUID()
    this.captures.delete(key)
    // Durable before sending even the first request; new frames read frozen.
    try {
      this.database
        .prepare(`INSERT INTO renderer_wf_owners(binding,revision,owner) VALUES (?,?,'frozen')
      ON CONFLICT(binding) DO UPDATE SET revision=excluded.revision,owner='frozen'`)
        .run(key, revision)
    } catch (cause) {
      this.migrating.delete(key)
      throw cause
    }
    const cancellation = new AbortController()
    const cancel = () =>
      cancellation.abort(signal?.reason ?? new Error('Renderer freeze cancelled'))
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    try {
      const registered = this.options.registeredWindowIds()
      if (registered.some((id) => !this.windows.has(id)))
        throw new Error('A product window has no WF startup registration')
      const participants = registered
        .map((id) => this.windows.get(id)!)
        .filter((owner) => rendererWfBindingKey(owner.binding) === key)
      if (!participants.length) throw new Error('No renderer can export the frozen IDB inventory')
      const stillPresent = () => {
        this.check()
        if (
          participants.some(
            (window) =>
              this.windows.get(window.windowId) !== window ||
              !this.options.registeredWindowIds().includes(window.windowId)
          )
        )
          throw new Error('Renderer freeze participant closed or changed generation')
      }
      await Promise.all(
        participants.map((window) => this.request(window, revision, 'freeze', cancellation.signal))
      )
      stillPresent()
      const captured = await this.request(
        participants[0]!,
        revision,
        'capture',
        cancellation.signal
      )
      stillPresent()
      // One designated frame enumerates all historical window databases only
      // after every current frame has drained. Other frames never duplicate export.
      const seen = new Set<string>()
      for (const source of captured.sources!) {
        const prefix = `lody-loro-repo-db-${parsed.workspaceId}`
        if (
          (source.dbName !== prefix && !source.dbName.startsWith(`${prefix}:`)) ||
          source.sourceId !== `renderer-idb:loro-repo@0.25.0:${source.dbName}` ||
          seen.has(source.sourceId)
        )
          throw new Error('Renderer frozen inventory identity mismatch')
        seen.add(source.sourceId)
      }
      this.captures.set(key, { revision, participants })
      return { revision, sources: captured.sources! }
    } finally {
      signal?.removeEventListener('abort', cancel)
      cancellation.abort(new Error('Renderer freeze operation ended'))
      this.migrating.delete(key)
    }
  }
  /** Host publishes the verified room route first. A failed commit retains frozen. */
  async complete(binding: RendererWfBinding, revision: string): Promise<void> {
    const before = this.status(binding)
    if (before.revision !== revision || (before.owner !== 'frozen' && before.owner !== 'native'))
      throw new Error('Renderer freeze completion generation mismatch')
    if (before.owner === 'frozen') this.assertFrozen(binding, revision)
    if ((await this.options.readCommittedOwner(binding)) !== 'native')
      throw new Error('Native WF route is not durably committed')
    this.check()
    if (before.owner === 'frozen') this.assertFrozen(binding, revision)
    const result = this.database
      .prepare(
        "UPDATE renderer_wf_owners SET owner='native' WHERE binding=? AND revision=? AND owner='frozen'"
      )
      .run(rendererWfBindingKey(binding), revision)
    if (result.changes !== 1 && before.owner !== 'native')
      throw new Error('Renderer freeze generation retired before completion')
    this.captures.delete(rendererWfBindingKey(binding))
    for (const window of this.windows.values())
      if (rendererWfBindingKey(window.binding) === rendererWfBindingKey(binding))
        try {
          this.options.publishOwner?.(window.windowId, {
            ...this.status(binding),
            owner: 'native',
            registrationId: window.generation
          })
        } catch {
          // Native ownership is already committed. A closing frame cannot
          // roll it back or prevent another frame learning its new owner.
          console.error('[Workspace catalog] Native owner notification failed')
        }
  }
  /** Recheck directly before the host's whole-group publication barrier. */
  assertFrozen(binding: RendererWfBinding, revision: string): void {
    const proof = this.captures.get(rendererWfBindingKey(binding))
    if (
      !proof ||
      proof.revision !== revision ||
      proof.participants.some(
        (owner) =>
          this.windows.get(owner.windowId) !== owner ||
          !this.options.registeredWindowIds().includes(owner.windowId)
      )
    )
      throw new Error('All-window frozen inventory proof is absent or its participant retired')
  }
  private check(): void {
    if (this.closed) throw new Error('Renderer WF main owner closed')
  }
  close(): void {
    if (this.released) return
    this.closed = true
    for (const pending of this.pending.values())
      pending.reject(new Error('Renderer WF main owner closed'))
    this.pending.clear()
    this.windows.clear()
    this.attempts.clear()
    try {
      if (this.database.open) this.database.close()
      if (this.database.open) throw new Error('Renderer WF SQLite close remains unconfirmed')
      this.released = true
    } catch (cause) {
      throw new RendererWfMainReleaseFailed(cause, () => this.close())
    }
  }
}

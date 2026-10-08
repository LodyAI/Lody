import { hasPendingUserTurnActivation, type SessionId, type SessionMeta } from '@lody/shared';
import type { ObservedSession, SessionObserveEvent, SessionObserver } from './session-observe';

export type WorkspaceObservedSession = {
  observer: Pick<SessionObserver, 'current' | 'refresh' | 'flush'>;
  close(): Promise<void>;
};

const activityKey = (meta: SessionMeta) =>
  JSON.stringify([meta.latestUserMsgId, meta.processingUserMsgId, meta.status?.type]);

const needsHistory = (meta: SessionMeta) =>
  hasPendingUserTurnActivation(meta) ||
  Boolean(meta.processingUserMsgId) ||
  ['running', 'initializing', 'requestPermission'].includes(meta.status?.type ?? '');

export function projectSessionCatalog(meta: SessionMeta): ObservedSession {
  return {
    sessionId: meta.id as SessionId,
    machineId: meta.machineId,
    ...(meta.title ? { title: meta.title } : {}),
    archived: meta.isArchived === true,
    state: 'unknown',
    source: 'metadata',
    freshness: 'synced',
    activeTurns: [],
  };
}

/** One catalog watch feeds bounded room opens; historical idle rooms stay unopened. */
export class WorkspaceSessionObserver {
  private readonly catalog = new Map<SessionId, SessionMeta>();
  private readonly snapshots = new Map<SessionId, ObservedSession>();
  private readonly active = new Map<SessionId, WorkspaceObservedSession>();
  private readonly opening = new Map<SessionId, Promise<void>>();
  private readonly candidates = new Set<SessionId>();
  private readonly admitted = new Map<SessionId, string>();
  private readonly dirty = new Set<SessionId>();
  private readonly retiring = new Set<SessionId>();
  private initialized = false;
  private rescan = false;
  private closed = false;
  private running: Promise<void> | undefined;

  constructor(
    private readonly options: {
      listMetas(): Promise<SessionMeta[]>;
      readMeta(id: SessionId): Promise<SessionMeta | null>;
      open(
        id: SessionId,
        emit: (event: SessionObserveEvent) => Promise<void>
      ): Promise<WorkspaceObservedSession | undefined>;
      emit(event: SessionObserveEvent): Promise<void>;
      onError(error: unknown): void;
      follow: boolean;
    }
  ) {}

  get current(): ObservedSession[] {
    return [...this.snapshots.values()];
  }

  refresh(id?: SessionId): void {
    if (this.closed) return;
    if (id) this.dirty.add(id);
    else this.rescan = true;
    if (this.initialized) this.run();
  }

  async start(): Promise<void> {
    for (const meta of await this.options.listMetas())
      await this.reconcile(meta.id as SessionId, meta, true);
    this.initialized = true;
    // The watch was installed before listing. Re-read identities that changed
    // during the asynchronous enumeration before reporting catalog readiness.
    this.run();
    await this.flushCatalog();
    if (!this.closed) await this.options.emit({ type: 'ready' });
    this.openCandidates();
  }

  async flushCatalog(): Promise<void> {
    while (this.running) await this.running;
  }

  async flush(): Promise<void> {
    await this.flushCatalog();
    while (this.opening.size > 0) {
      await Promise.all(this.opening.values());
      await this.flushCatalog();
    }
    for (const handle of this.active.values()) await handle.observer.flush();
    await this.flushCatalog();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.candidates.clear();
    await this.running;
    await Promise.all(this.opening.values());
    await Promise.all([...this.active.values()].map((handle) => handle.close()));
    this.active.clear();
  }

  private run(): void {
    if (this.running || this.closed) return;
    this.running = (async () => {
      while ((this.dirty.size || this.retiring.size || this.rescan) && !this.closed) {
        if (this.rescan) {
          this.rescan = false;
          for (const meta of await this.options.listMetas()) this.dirty.add(meta.id as SessionId);
          // Recheck known identities too: absence from a partial listing is not deletion.
          for (const id of this.catalog.keys()) this.dirty.add(id);
        }
        const ids = new Set([...this.dirty, ...this.retiring]);
        this.dirty.clear();
        for (const id of ids) {
          if (this.closed) break;
          const meta = await this.options.readMeta(id);
          if (this.closed) break;
          await this.reconcile(id, meta, false);
          if (this.retiring.delete(id)) {
            const handle = this.active.get(id);
            await handle?.observer.flush();
            if (
              handle &&
              handle.observer.current?.state === 'idle' &&
              handle.observer.current.freshness === 'synced'
            ) {
              this.active.delete(id);
              await handle.close();
              if (meta) {
                this.admitted.set(id, activityKey(meta));
                const userTurnId = handle.observer.current.latestTurn?.userTurnId;
                if (
                  (meta.latestUserMsgId && meta.latestUserMsgId !== userTurnId) ||
                  (meta.processingUserMsgId && meta.processingUserMsgId !== userTurnId)
                )
                  this.candidates.add(id);
              }
            }
          }
        }
      }
    })()
      .catch((error: unknown) => {
        this.closed = true;
        this.options.onError(error);
      })
      .finally(() => {
        this.running = undefined;
        if (!this.closed && (this.dirty.size || this.retiring.size || this.rescan)) this.run();
        this.openCandidates();
      });
  }

  private async reconcile(
    id: SessionId,
    meta: SessionMeta | null,
    initial: boolean
  ): Promise<void> {
    if (meta === null) {
      if (!this.catalog.has(id)) return;
      this.catalog.delete(id);
      this.snapshots.delete(id);
      this.admitted.delete(id);
      this.candidates.delete(id);
      const handle = this.active.get(id);
      this.active.delete(id);
      await handle?.close();
      await this.options.emit({ type: 'session.removed', sessionId: id });
      return;
    }
    const previous = this.catalog.get(id);
    this.catalog.set(id, { ...meta });
    const active = this.active.get(id);
    if (active) active.observer.refresh();
    else if (!this.opening.has(id)) {
      const snapshot = projectSessionCatalog(meta);
      const current = this.snapshots.get(id);
      // Retired sessions keep their last durable result; catalog edits only
      // update the title/archive fields, never replace that result with idle.
      const next =
        current?.source === 'persisted'
          ? {
              ...current,
              machineId: snapshot.machineId,
              title: snapshot.title,
              archived: snapshot.archived,
            }
          : snapshot;
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        this.snapshots.set(id, next);
        await this.options.emit({
          type: initial || !previous ? 'snapshot' : 'session.changed',
          sessionId: id,
          session: next,
        });
      }
    }
    if (
      this.options.follow &&
      !active &&
      this.admitted.get(id) !== activityKey(meta) &&
      (needsHistory(meta) ||
        (!initial && (!previous || previous.latestUserMsgId !== meta.latestUserMsgId)))
    ) {
      this.candidates.add(id);
    }
  }

  private openCandidates(): void {
    if (!this.initialized || this.closed || !this.options.follow) return;
    for (const id of this.candidates) {
      if (this.opening.size >= 4) break;
      this.candidates.delete(id);
      const meta = this.catalog.get(id);
      if (!meta || this.active.has(id) || this.opening.has(id)) continue;
      this.admitted.set(id, activityKey(meta));
      const opening = this.options
        .open(id, async (event) => {
          if (this.closed) return;
          if (event.type === 'snapshot' || event.type === 'session.changed') {
            this.snapshots.set(id, event.session);
            if (event.session.state === 'idle' && event.session.freshness === 'synced')
              this.retiring.add(id);
          } else if (event.type === 'session.removed') {
            this.catalog.delete(id);
            this.snapshots.delete(id);
            this.candidates.delete(id);
          }
          await this.options.emit(event);
          this.run();
        })
        .then(async (handle) => {
          if (!handle) return;
          if (this.closed || !this.catalog.has(id)) {
            await handle.close();
            return;
          }
          this.active.set(id, handle);
          if (handle.observer.current?.state === 'idle') {
            this.retiring.add(id);
            this.run();
          } else handle.observer.refresh();
        })
        .catch((error: unknown) => {
          this.closed = true;
          this.options.onError(error);
        })
        .finally(() => {
          this.opening.delete(id);
          this.openCandidates();
        });
      this.opening.set(id, opening);
    }
  }
}

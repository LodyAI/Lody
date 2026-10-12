import {
  collectSessionArchiveTargets,
  pickLatestSessionArchivePr,
  hasPendingUserTurnActivation,
  isArchiveRequestActive,
  type MachineId,
  type SessionArchiveRequest,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

/** Status=idle is deliberately absent: finalization and queue promotion outlive it. */
export async function isSessionArchiveBusy(ports: {
  hasRuntimeWork: () => boolean;
  readQueue: () => Promise<readonly unknown[]>;
  hasActiveGoal: () => Promise<boolean>;
  readMeta: () => Promise<SessionMeta | null | undefined>;
}): Promise<boolean> {
  if (ports.hasRuntimeWork()) return true;
  // Include blocked, scheduled, and failed queue entries, not only ready entries.
  if ((await ports.readQueue()).length > 0 || (await ports.hasActiveGoal())) return true;
  const meta = await ports.readMeta();
  return !meta || hasPendingUserTurnActivation(meta) || ports.hasRuntimeWork();
}

export type SessionArchiveCoordinatorDeps = {
  machineId: MachineId;
  list: () => Promise<SessionMeta[]>;
  read: (id: SessionId) => Promise<SessionMeta | undefined>;
  write: (id: SessionId, patch: Partial<SessionMeta>) => Promise<void>;
  /** Includes execution finalization, the entire queue, activation and active Goals. */
  isBusy: (session: SessionMeta) => Promise<boolean>;
  /** Synchronous acquisition must conflict with execution, steer and queue promotion. */
  acquireFence: (id: SessionId) => (() => void) | null;
  watch: (id: SessionId, changed: () => void) => Promise<() => void>;
  wake: (id: SessionId) => void;
  onError: (error: unknown) => void;
};

/** Durable intent, owner-local readiness and a recoverable group commit decision. */
export class SessionArchiveCoordinator {
  private readonly fences = new Map<SessionId, { key: string; release: () => void }>();
  private readonly subscriptions = new Map<SessionId, () => void>();
  private work: Promise<void> | undefined;
  private dirty = false;
  private stopped = false;
  hasPendingRequests = false;

  constructor(private readonly deps: SessionArchiveCoordinatorDeps) {}

  schedule(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    if (this.work) return this.work;
    this.work = this.drain()
      .catch((error) => {
        this.dirty = false;
        this.deps.onError(error);
      })
      .finally(() => {
        this.work = undefined;
        if (this.dirty && !this.stopped) void this.schedule();
      });
    return this.work;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.work;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    for (const fence of this.fences.values()) fence.release();
    this.fences.clear();
  }

  private async drain() {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      await this.reconcile();
    }
  }

  private release(id: SessionId) {
    const fence = this.fences.get(id);
    if (!fence) return;
    fence.release();
    this.fences.delete(id);
    this.deps.wake(id);
  }

  private async update(id: SessionId, patch: Partial<SessionMeta>) {
    if (this.stopped) return;
    await this.deps.write(id, patch);
    this.dirty = true;
  }

  private async current(root: SessionId, request: SessionArchiveRequest) {
    const meta = await this.deps.read(root);
    if (meta?.archiveCancelledRequestId === request.id) return undefined;
    const latest = meta?.archiveRequest;
    if (request.pr && request.phase !== 'committed') {
      const pr = pickLatestSessionArchivePr(meta?.pullRequests);
      if (pr?.url !== request.pr.url || pr.status !== request.pr.status) return undefined;
    }
    return latest?.id === request.id &&
      latest.generation === request.generation &&
      latest.phase === request.phase
      ? latest
      : undefined;
  }

  private async reconcile() {
    const sessions = await this.deps.list();
    this.hasPendingRequests = sessions.some(
      (session) =>
        Boolean(session.archivePending) || Boolean(isArchiveRequestActive(session.archiveRequest))
    );
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const watched = new Set<SessionId>();
    for (const session of sessions) {
      const link = session.archivePending;
      const root = link ? byId.get(link.rootId) : undefined;
      const request = root?.archiveRequest;
      if (
        !link ||
        !request ||
        request.id !== link.requestId ||
        root?.archiveCancelledRequestId === request.id ||
        !isArchiveRequestActive(request)
      ) {
        this.release(session.id);
        if (link && session.machineId === this.deps.machineId && root) {
          await this.update(session.id, { archivePending: null, archiveReadiness: null });
        }
        continue;
      }
      if (session.machineId !== this.deps.machineId) continue;
      if (!session.isArchived) {
        watched.add(session.id);
        if (!this.subscriptions.has(session.id)) {
          const unsubscribe = await this.deps.watch(session.id, () => {
            void this.schedule();
          });
          this.subscriptions.set(session.id, unsubscribe);
        }
      }
      if (request.phase === 'committed') {
        // The decision survives partial writes/restarts; prepared send writers retain the fence.
        if (!(await this.current(root.id, request))) continue;
        if (!session.isArchived) {
          // A late replicated activation must never be mistaken for finished work.
          // Preserve the commit intent, but let that owner's queue drain first.
          if (await this.deps.isBusy(session)) {
            this.release(session.id);
            continue;
          }
          if (!(await this.current(root.id, request))) continue;
          await this.update(session.id, { isArchived: true });
        }
        this.release(session.id);
        continue;
      }
      if (session.isArchived) continue;
      const key = `${request.id}:${request.generation}`;
      if (this.fences.get(session.id)?.key !== key || request.phase === 'waiting') {
        this.release(session.id);
      }
      const busy = await this.deps.isBusy(session);
      let state: 'busy' | 'ready' | 'prepared' = busy ? 'busy' : 'ready';
      if (!busy && request.phase === 'preparing') {
        if (!this.fences.has(session.id)) {
          const release = this.deps.acquireFence(session.id);
          if (release) this.fences.set(session.id, { key, release });
        }
        if (this.fences.has(session.id)) {
          // Recheck after all asynchronous queue/history reads and after acquiring admission.
          if (await this.deps.isBusy(session)) {
            state = 'busy';
            this.release(session.id);
          } else state = 'prepared';
        } else state = 'busy';
      }
      if (!(await this.current(root.id, request))) {
        this.release(session.id);
        continue;
      }
      const previous = session.archiveReadiness;
      if (
        previous?.requestId !== request.id ||
        previous.generation !== request.generation ||
        previous.state !== state
      ) {
        await this.update(session.id, {
          archiveReadiness: { requestId: request.id, generation: request.generation, state },
        });
      }
    }
    for (const [id, unsubscribe] of this.subscriptions) {
      if (!watched.has(id)) {
        unsubscribe();
        this.subscriptions.delete(id);
      }
    }
    for (const root of sessions) {
      const request = root.archiveRequest;
      if (root.machineId !== this.deps.machineId || !isArchiveRequestActive(request) || !request)
        continue;
      if (root.archiveCancelledRequestId === request.id) {
        await this.update(root.id, { archiveRequest: { ...request, phase: 'cancelled' } });
        continue;
      }
      if (request.pr && request.phase !== 'committed') {
        const latestRoot = await this.deps.read(root.id);
        const pr = pickLatestSessionArchivePr(latestRoot?.pullRequests);
        if (!pr || pr.url !== request.pr.url || pr.status !== request.pr.status) {
          await this.update(root.id, { archiveCancelledRequestId: request.id });
          continue;
        }
      }
      if (!(await this.current(root.id, request))) continue;
      if (request.phase === 'committed') {
        const targets = await Promise.all(request.targets.map((id) => this.deps.read(id)));
        if (targets.every((target) => target?.isArchived)) {
          await this.update(root.id, { archiveRequest: { ...request, phase: 'completed' } });
        }
        continue;
      }
      const ids = new Set(request.targets);
      for (const id of request.roots) {
        ids.add(id);
        for (const descendant of collectSessionArchiveTargets(id, sessions)) ids.add(descendant.id);
      }
      if (ids.size !== request.targets.length) {
        await this.update(root.id, {
          archiveRequest: {
            ...request,
            targets: [...ids],
            phase: 'waiting',
            generation: request.generation + 1,
          },
        });
        continue;
      }
      let linked = true;
      for (const id of ids) {
        const target = await this.deps.read(id);
        if (!target || target.isArchived) continue;
        if (target.archivePending?.requestId === request.id) continue;
        if (target.archivePending) {
          linked = false;
          continue;
        }
        await this.update(id, { archivePending: { rootId: root.id, requestId: request.id } });
        linked = false;
      }
      if (!linked || request.heldSendIds.length > 0) continue;
      const targets = await Promise.all(request.targets.map((id) => this.deps.read(id)));
      const ready = targets.every(
        (target) =>
          target?.isArchived ||
          (target?.archivePending?.requestId === request.id &&
            target.archiveReadiness?.requestId === request.id &&
            target.archiveReadiness.generation === request.generation &&
            target.archiveReadiness.state ===
              (request.phase === 'preparing' ? 'prepared' : 'ready'))
      );
      if (!(await this.current(root.id, request))) continue;
      // Re-read owner-local work at the commit boundary, not just a cached acknowledgement.
      if (ready && request.phase === 'preparing') {
        let changed = false;
        for (const target of targets) {
          if (
            target &&
            !target.isArchived &&
            target.machineId === this.deps.machineId &&
            (await this.deps.isBusy(target))
          ) {
            changed = true;
            break;
          }
        }
        if (changed) {
          await this.update(root.id, {
            archiveRequest: { ...request, phase: 'waiting', generation: request.generation + 1 },
          });
          continue;
        }
        if (!(await this.current(root.id, request))) continue;
      }
      if (ready) {
        await this.update(root.id, {
          archiveRequest: {
            ...request,
            phase: request.phase === 'waiting' ? 'preparing' : 'committed',
          },
        });
      } else if (
        request.phase === 'preparing' &&
        targets.some(
          (target) =>
            target?.archiveReadiness?.requestId === request.id &&
            target.archiveReadiness.generation === request.generation &&
            target.archiveReadiness.state === 'busy'
        )
      ) {
        await this.update(root.id, {
          archiveRequest: {
            ...request,
            phase: 'waiting',
            generation: request.generation + 1,
          },
        });
      }
    }
  }
}

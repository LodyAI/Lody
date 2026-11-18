import {
  NativeDocumentDomainIpcError,
  type NativeDocumentDomainSnapshot,
  type NativeDocumentDomainTarget,
} from '@lody/shared/native-document-domain-ipc';
import type { SessionId, PreviewVisualCommentDocState, ScheduleDocument } from '@lody/shared';
import type { PreviewVisualCommentDocStore, ScheduleDocStore } from '../atoms/runtime';
import type { RoomSyncState } from '../lib/room-sync-state';
import { createElectronNativeDocumentDomainClient } from './electron-native-document-domains';

type Source = ReturnType<typeof createElectronNativeDocumentDomainClient>;
type Lease = Awaited<ReturnType<Source['observe']>>;
type Entry = {
  source?: Source;
  lease?: Lease;
  opening?: Promise<void>;
  closing?: Promise<void>;
  recovery?: Promise<void>;
  disposed: boolean;
  epoch: number;
  state: RoomSyncState;
  snapshot?: NativeDocumentDomainSnapshot;
  listeners: Set<() => void>;
  syncListeners: Set<(state: RoomSyncState) => void>;
  firstSynced: Promise<void>;
  ready(): void;
  fail(error: unknown): void;
  preview?: PreviewVisualCommentDocStore;
  schedule?: ScheduleDocStore;
};
/** Read-only renderer resources. Native stores have no LoroDoc or writable
 * callback facade. Scope close retains the real source/lease until ACK. */
export function createRendererNativeDocumentStores(options: {
  registrationId: string;
  onFailure?(error: unknown): void;
  source?(target: NativeDocumentDomainTarget): Source;
}) {
  let closed = false;
  const entries = new Map<string, Entry>();
  const key = (target: NativeDocumentDomainTarget) => JSON.stringify(target);
  const source = (target: NativeDocumentDomainTarget) =>
    options.source?.(target) ??
    createElectronNativeDocumentDomainClient({ registrationId: options.registrationId, target });
  const report = (error: unknown) => {
    try {
      options.onFailure?.(error);
    } catch {
      /* A view error does not release its native scope. */
    }
  };
  const setState = (entry: Entry, state: RoomSyncState) => {
    entry.state = state;
    for (const listener of entry.syncListeners) {
      try {
        listener(state);
      } catch (error) {
        report(error);
      }
    }
    for (const listener of entry.listeners) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
    }
  };
  const closeSource = (entry: Entry): Promise<void> => {
    if (entry.closing) return entry.closing;
    const work = (async () => {
      if (entry.lease) {
        await entry.lease.close();
        entry.lease = undefined;
      }
      if (entry.source) {
        await entry.source.close();
        entry.source = undefined;
      }
    })();
    entry.closing = work;
    void work
      .finally(() => {
        if (entry.closing === work) entry.closing = undefined;
      })
      .catch(() => {});
    return work;
  };
  const route = async (target: NativeDocumentDomainTarget) => {
    if (closed) throw new NativeDocumentDomainIpcError('restart_required');
    const candidate = source(target);
    try {
      const owner = await candidate.route();
      if (closed) throw new NativeDocumentDomainIpcError('restart_required');
      return owner;
    } finally {
      await candidate.close();
    }
  };
  const ensure = (target: NativeDocumentDomainTarget, entry: Entry): Promise<void> => {
    if (closed || entry.disposed)
      return Promise.reject(new NativeDocumentDomainIpcError('restart_required'));
    if (entry.snapshot && entry.state === 'synced') return Promise.resolve();
    if (entry.opening) return entry.opening;
    const epoch = ++entry.epoch;
    const work = (async () => {
      await closeSource(entry);
      if (closed || entry.disposed || epoch !== entry.epoch)
        throw new NativeDocumentDomainIpcError('restart_required');
      setState(entry, 'connecting');
      const candidate = source(target);
      entry.source = candidate;
      if ((await candidate.route()) !== 'native')
        throw new NativeDocumentDomainIpcError('restart_required');
      const lease = await candidate.observe(
        (snapshot) => {
          if (closed || entry.disposed || epoch !== entry.epoch) return;
          entry.snapshot = snapshot;
          setState(entry, 'synced');
          entry.ready();
        },
        (error) => {
          if (closed || entry.disposed || epoch !== entry.epoch) return;
          entry.snapshot = undefined;
          setState(entry, 'disconnected');
          report(error);
          queueMicrotask(() => {
            if (!entry.opening) void recover(target, entry).catch(() => {});
          });
        }
      );
      entry.lease = lease;
      if (closed || entry.disposed || epoch !== entry.epoch) {
        await closeSource(entry);
        throw new NativeDocumentDomainIpcError('restart_required');
      }
      if (!entry.snapshot) throw new NativeDocumentDomainIpcError('unavailable');
    })();
    entry.opening = work;
    void work
      .finally(() => {
        if (entry.opening === work) entry.opening = undefined;
      })
      .catch(() => {});
    return work;
  };
  const recover = (target: NativeDocumentDomainTarget, entry: Entry): Promise<void> => {
    if (entry.recovery) return entry.recovery;
    const work = (async () => {
      let failure: unknown;
      // Reacquisition is read-only and bounded. No mutation is retried.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (closed || entry.disposed) throw new NativeDocumentDomainIpcError('restart_required');
        try {
          await ensure(target, entry);
          return;
        } catch (error) {
          failure = error;
          if (error instanceof NativeDocumentDomainIpcError && error.code === 'access_denied')
            break;
        }
      }
      entry.snapshot = undefined;
      setState(entry, 'error');
      entry.fail(failure);
      throw failure;
    })();
    entry.recovery = work;
    void work
      .finally(() => {
        if (entry.recovery === work) entry.recovery = undefined;
      })
      .catch(() => {});
    return work;
  };
  const open = async (target: NativeDocumentDomainTarget) => {
    const owner = await route(target);
    if (owner === 'legacy') return undefined;
    if (owner !== 'native') throw new NativeDocumentDomainIpcError('restart_required');
    let entry = entries.get(key(target));
    if (entry?.disposed) {
      await closeRoom(target);
      entry = undefined;
    }
    if (!entry) {
      if (entries.size >= 64) throw new NativeDocumentDomainIpcError('cleanup_unconfirmed');
      let ready!: () => void, fail!: (error: unknown) => void;
      const firstSynced = new Promise<void>((resolve, reject) => {
        ready = resolve;
        fail = reject;
      });
      void firstSynced.catch(() => {});
      entry = {
        disposed: false,
        epoch: 0,
        state: 'idle',
        listeners: new Set(),
        syncListeners: new Set(),
        firstSynced,
        ready,
        fail,
      };
      entries.set(key(target), entry);
    }
    await recover(target, entry);
    return entry;
  };
  const dispose = (entry: Entry) => {
    entry.disposed = true;
    entry.epoch++;
    entry.snapshot = undefined;
    setState(entry, 'disconnected');
    entry.listeners.clear();
    entry.syncListeners.clear();
    void closeSource(entry).catch(report);
  };
  const closeRoom = async (target: NativeDocumentDomainTarget) => {
    const entry = entries.get(key(target));
    if (!entry) return;
    dispose(entry);
    await entry.opening?.catch(() => {});
    await entry.recovery?.catch(() => {});
    await closeSource(entry);
    if (entries.get(key(target)) === entry) entries.delete(key(target));
  };
  const requireSnapshot = (entry: Entry) => {
    if (entry.disposed || entry.state !== 'synced' || !entry.snapshot)
      throw new NativeDocumentDomainIpcError('restart_required');
    return entry.snapshot;
  };
  return {
    route,
    owns(target: NativeDocumentDomainTarget) {
      return entries.has(key(target));
    },
    async preview(sessionId: SessionId): Promise<PreviewVisualCommentDocStore | undefined> {
      const target = { domain: 'preview_comments' as const, id: sessionId },
        entry = await open(target);
      if (!entry) return undefined;
      if (!entry.preview) {
        const current = (): PreviewVisualCommentDocState => {
          const snapshot = entry.snapshot;
          // This is a checked read-only JSON projection, not a Mirror or Doc.
          return (
            snapshot?.domain === 'preview_comments'
              ? structuredClone(snapshot.value)
              : { meta: { sessionId }, turns: {} }
          ) as PreviewVisualCommentDocState;
        };
        entry.preview = {
          sessionId,
          roomId: `preview-comment-${sessionId}`,
          doc: undefined,
          nativePreview: {
            async mutate(mutation) {
              requireSnapshot(entry);
              if (!entry.source) throw new NativeDocumentDomainIpcError('restart_required');
              await entry.source.preview.mutatePreviewVisualComments(sessionId, mutation);
            },
          },
          firstSynced: entry.firstSynced,
          getSyncState: () => entry.state,
          subscribeSyncState(listener) {
            entry.syncListeners.add(listener);
            return () => {
              entry.syncListeners.delete(listener);
            };
          },
          getState: current,
          setState() {
            throw new NativeDocumentDomainIpcError('invalid_request');
          },
          subscribe(listener) {
            const read = () => listener(current());
            entry.listeners.add(read);
            return () => {
              entry.listeners.delete(read);
            };
          },
          dispose: () => dispose(entry),
          waitUntilSynced: () => recover(target, entry),
        };
      }
      return entry.preview;
    },
    async schedule(scheduleId: string): Promise<ScheduleDocStore | undefined> {
      const target = { domain: 'schedule_definition' as const, id: scheduleId },
        entry = await open(target);
      if (!entry) return undefined;
      if (!entry.schedule)
        entry.schedule = {
          roomId: `schedule-${scheduleId}`,
          getSyncState: () => entry.state,
          firstSynced: entry.firstSynced,
          getState: (): ScheduleDocument | null =>
            entry.snapshot?.domain === 'schedule_definition'
              ? structuredClone(entry.snapshot.value)
              : null,
          subscribe(listener) {
            entry.listeners.add(listener);
            return () => {
              entry.listeners.delete(listener);
            };
          },
          dispose: () => dispose(entry),
          waitUntilSynced: () => recover(target, entry),
        };
      return entry.schedule;
    },
    closeRoom,
    async close() {
      closed = true;
      const results = await Promise.allSettled(
        [...entries.keys()].map((id) => closeRoom(JSON.parse(id) as NativeDocumentDomainTarget))
      );
      const failed = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failed.length)
        throw new AggregateError(failed, 'Native document store cleanup unconfirmed');
    },
  };
}

import type { SessionAttachmentDraft } from './session-attachment-draft';
import type { SessionHistory, SessionId, SessionMeta } from '@lody/shared';
import type { SessionSendResources } from './session-send-resources';
import { throwIfSendAborted } from './session-send-resources';

export type SessionSendRecord = {
  version: 1 | 2;
  attachments?: SessionAttachmentDraft[];
  targetMachineId?: import('@lody/shared').MachineId;
  cancelRequested?: boolean;
  id: string;
  sessionId: SessionId;
  accountId: string;
  workspaceId: string;
  sourceReplica: string;
  sequence: number;
  entry: SessionHistory;
  creation?: SessionMeta;
  queue?: Record<string, unknown>;
  delivery: { kind: 'queue' | 'dispatch' } | { kind: 'guide'; expectedTurnId: string };
  stage: 'saved' | 'prepared' | 'committed' | 'delivered';
  /** Exact authored operations: replay imports these bytes, never appends again. */
  update?: Uint8Array;
  error?: string;
  guideOffer?: 'offered' | 'applied' | 'not-applied';
};

export type SessionSendJournalStorage = {
  list(): Promise<SessionSendRecord[]>;
  insert(record: Omit<SessionSendRecord, 'sequence'>): Promise<SessionSendRecord>;
  put(record: SessionSendRecord): Promise<void>;
  requestCancel?(id: string): Promise<SessionSendRecord | undefined>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
};

export type SessionSendJournalPorts = {
  resources: SessionSendResources;
  preparationReplica?: string;
  storage: SessionSendJournalStorage;
  observeExternal?(refresh: () => void): () => void;
  notifyExternal?(): void;
  /** Cross-window exclusion for the same account/workspace/session. */
  lock<A>(key: string, signal: AbortSignal, execute: () => Promise<A>): Promise<A>;
  prepareInput?(
    record: SessionSendRecord,
    signal: AbortSignal,
    checkpoint: (
      patch: Partial<Pick<SessionSendRecord, 'attachments' | 'entry' | 'queue'>>
    ) => Promise<void>,
    report: (id: string, progress: number) => void
  ): Promise<void>;
  /** Flush the source baseline, validate once, and prepare immutable CRDT operations. */
  prepare(record: SessionSendRecord, signal: AbortSignal): Promise<Uint8Array>;
  /** Recover the original baseline, import exact operations and confirm local persistence. */
  commit(record: SessionSendRecord, signal: AbortSignal): Promise<void>;
  /** Resolve only on a target receipt; uncertainty keeps the committed record. */
  deliver(
    record: SessionSendRecord,
    signal: AbortSignal,
    checkpoint: (patch: Pick<SessionSendRecord, 'guideOffer'>) => Promise<void>
  ): Promise<void>;
};

/** Durable stages are separate from transient fibers and UI subscription lifetimes. */
export function createSessionSendJournal(ports: SessionSendJournalPorts) {
  let snapshot: readonly SessionSendRecord[] = [];
  const listeners = new Set<() => void>();
  const running = new Map<SessionId, Promise<void>>();
  const preparations = new Map<string, AbortController>();
  let closed = false;
  let refreshGeneration = 0;
  const refresh = async () => {
    const generation = ++refreshGeneration;
    const records = await ports.storage.list();
    if (closed || generation !== refreshGeneration) return;
    for (const record of records) if (record.cancelRequested) preparations.get(record.id)?.abort();
    snapshot = records.sort((a, b) => a.sequence - b.sequence);
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Pending message observer failed', error);
      }
    }
  };

  const unobserve = ports.observeExternal?.(() => {
    void refresh().catch((error: unknown) =>
      console.error('Pending message refresh failed', error)
    );
  });
  const changed = async () => {
    await refresh();
    ports.notifyExternal?.();
  };

  const workSession = (sessionId: SessionId): Promise<void> => {
    const existing = running.get(sessionId);
    if (existing) return existing.then(() => workSession(sessionId));
    if (closed) return Promise.reject(new Error('Session send journal is closed'));
    const work = ports.resources.run(async (signal) => {
      await ports.lock(`submit:${sessionId}`, signal, async () => {
        const records = (await ports.storage.list())
          .filter((record) => record.sessionId === sessionId)
          .sort((a, b) => a.sequence - b.sequence);
        for (let record of records) {
          throwIfSendAborted(signal);
          const latestRecord = (await ports.storage.list()).find((item) => item.id === record.id);
          if (!latestRecord) continue;
          record = latestRecord;
          if (record.version !== 1 && record.version !== 2)
            throw new Error('Unsupported session send record version');
          if (record.stage === 'delivered') continue;
          const preparation = new AbortController();
          preparations.set(record.id, preparation);
          const preparationSignal = AbortSignal.any([signal, preparation.signal]);
          try {
            if (record.cancelRequested) {
              await ports.storage.remove(record.id);
              continue;
            }
            if (record.stage === 'saved') {
              await ports.prepareInput?.(
                record,
                preparationSignal,
                async (patch) => {
                  const next = { ...record, ...patch };
                  await ports.storage.put(next);
                  record = next;
                  await changed();
                  throwIfSendAborted(preparationSignal);
                },
                (id, progress) => {
                  if (preparationSignal.aborted) return;
                  snapshot = snapshot.map((item) =>
                    item.id === record.id
                      ? {
                          ...item,
                          attachments: item.attachments?.map((attachment) =>
                            attachment.id === id ? { ...attachment, progress } : attachment
                          ),
                        }
                      : item
                  );
                  for (const listener of listeners) {
                    try {
                      listener();
                    } catch (error) {
                      console.error(error);
                    }
                  }
                }
              );
              throwIfSendAborted(preparationSignal);
              const update = await ports.prepare(record, preparationSignal);
              throwIfSendAborted(preparationSignal);
              record = {
                ...record,
                update,
                sourceReplica: ports.preparationReplica ?? record.sourceReplica,
                stage: 'prepared',
                error: undefined,
              };
              // No externally visible mutation may precede this storage receipt.
              await ports.storage.put(record);
            }
            if (record.stage === 'prepared') {
              await ports.commit(record, signal);
              record = { ...record, stage: 'committed', error: undefined };
              await ports.storage.put(record);
            }
          } catch (error) {
            const latest = (await ports.storage.list()).find((item) => item.id === record.id);
            if (latest?.cancelRequested && latest.stage === 'saved') {
              await ports.storage.remove(record.id);
              await changed();
              continue;
            }
            // Failed preparation/commit blocks later same-session submissions.
            // Keep exact operations across lost acknowledgements and interruption.
            await ports.storage.put({
              ...record,
              error: error instanceof Error ? error.message : 'Submission interrupted',
            });
            await changed();
            throw error;
          } finally {
            preparations.delete(record.id);
          }
          await changed();
        }
      });
    });
    running.set(sessionId, work);
    void work
      .finally(() => {
        running.delete(sessionId);
      })
      .catch(() => {});
    return work;
  };

  const deliver = (record: SessionSendRecord) =>
    ports.resources.run(async (signal) => {
      await ports.lock(`delivery:${record.sessionId}`, signal, async () => {
        let current = (await ports.storage.list()).find((item) => item.id === record.id);
        if (!current || current.stage !== 'committed') return;
        try {
          await ports.deliver(current, signal, async (patch) => {
            const next = { ...current!, ...patch };
            await ports.storage.put(next);
            current = next;
          });
          throwIfSendAborted(signal);
          await ports.storage.put({
            ...current,
            stage: 'delivered',
            error: undefined,
            attachments: undefined,
          });
        } catch (error) {
          await ports.storage.put({
            ...current,
            error: error instanceof Error ? error.message : 'Delivery interrupted',
          });
          throw error;
        } finally {
          await changed();
        }
      });
    });

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    read: async (id: string) => (await ports.storage.list()).find((record) => record.id === id),
    activate: async (id: string, delivery: SessionSendRecord['delivery']) =>
      ports.resources.run(async (signal) => {
        const found = (await ports.storage.list()).find((record) => record.id === id);
        if (!found) return undefined;
        return ports.lock(`delivery:${found.sessionId}`, signal, async () => {
          const current = (await ports.storage.list()).find((record) => record.id === id);
          if (!current) return undefined;
          if (JSON.stringify(current.delivery) === JSON.stringify(delivery)) return current;
          if (current.guideOffer)
            throw new Error('Guide outcome must be reconciled before changing delivery');
          const next = {
            ...current,
            delivery,
            stage: current.stage === 'delivered' ? ('committed' as const) : current.stage,
          };
          await ports.storage.put(next);
          await changed();
          return next;
        });
      }),
    /** Admission means the complete record is on disk, not that the daemon received it. */
    accept: async (record: Omit<SessionSendRecord, 'sequence' | 'stage' | 'version'>) => {
      if (closed) throw new Error('Session send journal is closed');
      let saved: SessionSendRecord | undefined;
      try {
        await ports.resources.run((signal) =>
          ports.lock('admission', signal, async () => {
            saved = await ports.storage.insert({ ...record, stage: 'saved', version: 2 });
          })
        );
      } catch (error) {
        // Interruption after the storage receipt cannot turn an accepted input
        // back into an unsent composer draft. No submission is launched here.
        if (!saved) throw error;
      }
      if (!saved) throw new Error('Recovery storage returned no admission receipt');
      const receipt = saved;
      snapshot = [...snapshot.filter((item) => item.id !== receipt.id), receipt].sort(
        (a, b) => a.sequence - b.sequence
      );
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.error('Pending message observer failed', error);
        }
      }
      ports.notifyExternal?.();
      return saved;
    },
    submit: workSession,
    deliver,
    retry: async (sessionId: SessionId) => {
      await workSession(sessionId);
      const records = await ports.storage.list();
      for (const record of records.filter(
        (item) => item.sessionId === sessionId && item.stage === 'committed'
      ))
        await deliver(record);
    },
    cancel: async (id: string) =>
      ports.resources.run(async (signal) => {
        if (!ports.storage.requestCancel)
          throw new Error('Recovery storage does not support safe cancellation');
        const found = await ports.storage.requestCancel(id);
        if (!found) return;
        preparations.get(id)?.abort();
        await changed();
        await ports.lock(`submit:${found.sessionId}`, signal, async () => {
          const current = (await ports.storage.list()).find((record) => record.id === id);
          if (current && current.stage !== 'saved')
            throw new Error('Submission may already be accepted; reconcile before cancellation');
          await ports.storage.remove(id);
          await changed();
        });
      }),
    close: async () => {
      closed = true;
      unobserve?.();
      listeners.clear();
      await ports.storage.close();
    },
  };
}

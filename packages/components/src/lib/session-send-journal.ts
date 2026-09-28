import type { SessionAttachmentDraft } from './session-attachment-draft';
import type { SessionHistory, SessionId, SessionMeta } from '@lody/shared';
import type { SessionSendResources } from './session-send-resources';
import { throwIfSendAborted } from './session-send-resources';

export type SessionSendRecord = {
  /**
   * 3 marks a prepared record whose turn is written from `entry`. Older clients
   * can only replay prepared bytes, so they must refuse it. Every other stage
   * stays 2: committed turns are already in the document.
   */
  version: 1 | 2 | 3;
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
  /**
   * Never read: resume appends `entry` when its id is absent. Current clients
   * store empty bytes because older readers reject non-saved records without them.
   */
  update?: Uint8Array;
  error?: string;
  guideOffer?: 'offered' | 'applied' | 'not-applied';
};

export type SessionSendViewRecord = SessionSendRecord & {
  /** Observation only; never persisted and never used to authorize writes. */
  activity?: 'active' | 'interrupted';
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
  activeSessions?(): Promise<ReadonlySet<string>>;
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
  /** Validate once before the record may publish anything. */
  prepare(record: SessionSendRecord, signal: AbortSignal): Promise<void>;
  /**
   * Write the turn as a local commit and confirm local persistence. `resumed`
   * means an earlier attempt may already have written it, so the port must
   * look for the turn before writing again.
   */
  commit(
    record: SessionSendRecord,
    signal: AbortSignal,
    options: { resumed: boolean }
  ): Promise<void>;
  /** Resolve only on a target receipt; uncertainty keeps the committed record. */
  deliver(
    record: SessionSendRecord,
    signal: AbortSignal,
    checkpoint: (patch: Pick<SessionSendRecord, 'guideOffer'>) => Promise<void>
  ): Promise<void>;
};

/** Durable stages are separate from transient fibers and UI subscription lifetimes. */
export function createSessionSendJournal(ports: SessionSendJournalPorts) {
  let snapshot: readonly SessionSendViewRecord[] = [];
  const active = new Map<string, number>();
  let externalActive: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const running = new Map<SessionId, Promise<void>>();
  const preparations = new Map<string, AbortController>();
  let closed = false;
  let refreshGeneration = 0;
  const withActivity = (record: SessionSendRecord): SessionSendViewRecord => ({
    ...record,
    activity:
      active.has(record.sessionId) || externalActive.has(record.sessionId)
        ? 'active'
        : 'interrupted',
  });
  const publishActivity = () => {
    if (closed) return;
    snapshot = snapshot.map(withActivity);
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Pending message observer failed', error);
      }
    }
    ports.notifyExternal?.();
  };
  const observeWork = async (sessionId: string, work: Promise<void>): Promise<void> => {
    active.set(sessionId, (active.get(sessionId) ?? 0) + 1);
    publishActivity();
    try {
      await work;
    } finally {
      const remaining = (active.get(sessionId) ?? 1) - 1;
      if (remaining) active.set(sessionId, remaining);
      else active.delete(sessionId);
      if (!closed) {
        try {
          externalActive = (await ports.activeSessions?.()) ?? new Set();
        } catch (error) {
          console.warn('Pending send activity observation failed', error);
        }
        publishActivity();
      }
    }
  };
  const refresh = async () => {
    const generation = ++refreshGeneration;
    const [records, observed] = await Promise.all([ports.storage.list(), ports.activeSessions?.()]);
    if (closed || generation !== refreshGeneration) return;
    for (const record of records) if (record.cancelRequested) preparations.get(record.id)?.abort();
    externalActive = observed ?? new Set();
    snapshot = records.sort((a, b) => a.sequence - b.sequence).map(withActivity);
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
    const work = observeWork(
      sessionId,
      ports.resources.run(async (signal) => {
        await ports.lock(`submit:${sessionId}`, signal, async () => {
          const records = (await ports.storage.list())
            .filter((record) => record.sessionId === sessionId)
            .sort((a, b) => a.sequence - b.sequence);
          for (let record of records) {
            throwIfSendAborted(signal);
            const latestRecord = (await ports.storage.list()).find((item) => item.id === record.id);
            if (!latestRecord) continue;
            record = latestRecord;
            if (record.version !== 1 && record.version !== 2 && record.version !== 3)
              throw new Error('Unsupported session send record version');
            if (record.stage === 'delivered') continue;
            const preparation = new AbortController();
            preparations.set(record.id, preparation);
            const preparationSignal = AbortSignal.any([signal, preparation.signal]);
            const resumed = record.stage === 'prepared';
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
                await ports.prepare(record, preparationSignal);
                throwIfSendAborted(preparationSignal);
                record = {
                  ...record,
                  version: 3,
                  update: new Uint8Array(),
                  sourceReplica: ports.preparationReplica ?? record.sourceReplica,
                  stage: 'prepared',
                  error: undefined,
                };
                // No externally visible mutation may precede this storage receipt.
                await ports.storage.put(record);
              }
              if (record.stage === 'prepared') {
                await ports.commit(record, signal, { resumed });
                record = {
                  ...record,
                  version: record.version === 3 ? 2 : record.version,
                  // The committing replica now persists the turn.
                  sourceReplica: ports.preparationReplica ?? record.sourceReplica,
                  stage: 'committed',
                  error: undefined,
                };
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
              // Keep the record across lost acknowledgements so a retry reconciles the turn.
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
      })
    );
    running.set(sessionId, work);
    void work
      .finally(() => {
        running.delete(sessionId);
      })
      .catch(() => {});
    return work;
  };

  const deliver = (record: SessionSendRecord) =>
    observeWork(
      record.sessionId,
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
      })
    );

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
    /**
     * A native queue steer changes an already delivered queue operation into a
     * normal history turn. Keep its durable identity, but write the history turn
     * before the queue row may be removed.
     */
    promoteQueuedTurn: async (
      id: string,
      entry: SessionHistory,
      delivery: Extract<SessionSendRecord['delivery'], { kind: 'guide' }>
    ) =>
      ports.resources.run(async (signal) => {
        const found = (await ports.storage.list()).find((record) => record.id === id);
        if (!found) return undefined;
        return ports.lock(`submit:${found.sessionId}`, signal, async () => {
          const current = (await ports.storage.list()).find((record) => record.id === id);
          if (!current) return undefined;
          if (!current.queue) return current;
          if (current.stage !== 'delivered')
            throw new Error('Queued message must be delivered before it can be guided');
          if (current.guideOffer)
            throw new Error('Guide outcome must be reconciled before promoting the queued message');
          const next: SessionSendRecord = {
            ...current,
            entry,
            queue: undefined,
            delivery,
            stage: 'saved',
            update: undefined,
            error: undefined,
          };
          await ports.storage.put(next);
          await changed();
          return next;
        });
      }),
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
      snapshot = [...snapshot.filter((item) => item.id !== receipt.id), withActivity(receipt)].sort(
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
    /** Discard a locally committed recovery obligation after explicit user disclosure. */
    discard: async (id: string) =>
      ports.resources.run(async (signal) => {
        const found = (await ports.storage.list()).find((record) => record.id === id);
        if (!found) return;
        await ports.lock(`submit:${found.sessionId}`, signal, async () => {
          await ports.lock(`delivery:${found.sessionId}`, signal, async () => {
            const current = (await ports.storage.list()).find((record) => record.id === id);
            if (!current) return;
            if (current.stage !== 'prepared' && current.stage !== 'committed')
              throw new Error('Only a prepared or committed submission can be discarded');
            await ports.storage.remove(id);
            await changed();
          });
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

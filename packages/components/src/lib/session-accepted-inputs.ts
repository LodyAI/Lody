import type { SessionId } from '@lody/shared';
import type { SessionInputAcceptanceResult } from '@lody/shared/session-data';
import type { SessionSendResources } from './session-send-resources';
import type { PendingSessionSend } from './session-pending-sends';
import type { SessionInputStorage, StoredSessionInput } from './session-input-storage';
import { SessionHistoryRequestError } from './roost-history-error';

/** Proven source-side refusal before owner history is invoked. */
export class SessionInputNotSentError extends Error {}
const refusalCodes = new Set([
  'session_metadata_pending',
  'session_owner_mismatch',
  'session_unavailable',
  'session_identity_mismatch',
  'session_backend_mismatch',
]);
const didNotStart = (error: unknown) =>
  error instanceof SessionInputNotSentError ||
  (error instanceof SessionHistoryRequestError &&
    error.failure.source === 'remote' &&
    refusalCodes.has(error.failure.code));

type InputPorts = {
  resources: Pick<SessionSendResources, 'run'>;
  storage: SessionInputStorage;
  lock<T>(sessionId: SessionId, signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  write(
    send: PendingSessionSend,
    signal: AbortSignal
  ): Promise<SessionInputAcceptanceResult & { readonly dispatchHandled?: boolean }>;
  lookup(send: PendingSessionSend, signal: AbortSignal): Promise<SessionInputAcceptanceResult>;
  deliver(
    send: PendingSessionSend,
    signal: AbortSignal,
    receipt: SessionInputAcceptanceResult & { readonly dispatchHandled?: boolean }
  ): Promise<void | SessionInputAcceptanceResult>;
  confirmed?(send: PendingSessionSend): void;
  visible(send: PendingSessionSend, signal: AbortSignal): Promise<boolean>;
  unknownMessage(): string;
  changed?: () => void;
  paused?: boolean;
};

/** Ready-input lifecycle. The workspace's native send scope owns every raw I/O task. */
export function createAcceptedSessionInputs(ports: InputPorts) {
  let sends: readonly PendingSessionSend[] = [];
  let closed = false;
  let paused = ports.paused ?? false;
  let localSequence = 0;
  let revision = 0;
  let initializationFailure: unknown;
  const listeners = new Set<() => void>();
  const saving = new Map<string, Promise<void>>();
  const running = new Map<SessionId, Promise<void>>();
  const controllers = new Map<SessionId, AbortController>();
  const deliveries = new Map<
    string,
    { kind: PendingSessionSend['delivery']['kind']; completed: boolean }
  >();
  const hasCompleted = (id: string) => deliveries.get(id)?.completed === true;
  const rememberDelivery = (send: Pick<PendingSessionSend, 'id' | 'delivery'>) => {
    if (!deliveries.has(send.id))
      deliveries.set(send.id, { kind: send.delivery.kind, completed: false });
  };
  const requested = new Map<SessionId, number>();
  const canceled = new Set<string>();
  const waitForChange = (signal: AbortSignal, observed: number) =>
    new Promise<void>((resolve, reject) => {
      const finish = () => {
        listeners.delete(finish);
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        listeners.delete(finish);
        reject(new DOMException('Input wait canceled', 'AbortError'));
      };
      listeners.add(finish);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted || closed) abort();
      else if (revision !== observed) finish();
    });
  let saveTail: Promise<void> = Promise.resolve();
  const publish = (next: readonly PendingSessionSend[]) => {
    sends = next;
    revision += 1;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Accepted input observer failed', error);
      }
    }
  };
  const removeVisible = (id: string) => publish(sends.filter((send) => send.id !== id));
  const project = (row: StoredSessionInput, sending = false) => {
    if (closed || row.canceled || canceled.has(row.id)) {
      removeVisible(row.id);
      return;
    }
    const send: PendingSessionSend = {
      ...row.send,
      creation: row.state === 'confirmed' ? undefined : row.send.creation,
      persisted: true,
      inputState:
        sending || row.state === 'queued'
          ? 'sending'
          : row.state === 'failed'
            ? 'sending'
            : row.state,
      ...(row.error ? { error: row.error } : {}),
    };
    const found = sends.findIndex((value) => value.id === row.id);
    publish(
      found < 0 ? [...sends, send] : sends.map((value, index) => (index === found ? send : value))
    );
  };
  const load = async () => {
    const rows = await ports.storage.list();
    if (closed) return rows;
    for (const row of rows) rememberDelivery(row.send);
    const storedIds = new Set(rows.map((row) => row.id));
    const retained = sends.filter(
      (send) => !send.persisted && !storedIds.has(send.id) && !canceled.has(send.id)
    );
    publish([
      ...rows
        .filter((row) => !row.canceled && !canceled.has(row.id))
        .map((row) => ({
          ...row.send,
          creation: row.state === 'confirmed' ? undefined : row.send.creation,
          persisted: true,
          inputState:
            row.state === 'queued' || row.state === 'failed' ? ('sending' as const) : row.state,
          ...(row.error ? { error: row.error } : {}),
        })),
      ...retained,
    ]);
    return rows;
  };
  const initialized = ports.resources
    .run(
      async () => {
        await load();
      },
      undefined,
      { protectExit: false }
    )
    .catch((error: unknown) => {
      initializationFailure = error;
    });
  const ensureInitialized = async () => {
    await initialized;
    if (initializationFailure) {
      await load();
      initializationFailure = undefined;
    }
  };

  const process = async (row: StoredSessionInput, signal: AbortSignal): Promise<boolean> => {
    if (row.canceled || canceled.has(row.id)) return true;
    if (row.state === 'failed') {
      project(row);
      return false;
    }
    let current = row;
    try {
      let receipt: SessionInputAcceptanceResult & { readonly dispatchHandled?: boolean };
      if (row.state === 'queued') {
        // A crash after handoff must recover by query, never a new append.
        current =
          (await ports.storage.patch(row.id, { state: 'unknown', error: undefined })) ?? row;
        project(current, true);
        receipt = await ports.write(current.send, signal);
      } else {
        receipt = await ports.lookup(current.send, signal);
        if (receipt.status === 'unobserved') {
          // Absence is not non-delivery evidence. The immutable acceptance
          // operation can safely converge with a late original request using
          // the very same identity and payload, including retired generations.
          const stored = await ports.storage.get(row.id);
          if (!stored || stored.canceled || signal.aborted || closed || canceled.has(row.id))
            return true;
          receipt = await ports.write(stored.send, signal);
        }
      }
      if (signal.aborted || closed || canceled.has(row.id)) return false;
      // Another window may have canceled this stored input while owner I/O
      // held the session lease. Its persisted fence also governs this worker.
      const latest = await ports.storage.get(row.id);
      if (!latest || latest.canceled) {
        removeVisible(row.id);
        return true;
      }
      current = latest;
      if (receipt.status === 'unobserved') {
        const unresolved = await ports.storage.patch(row.id, {
          state: 'unknown',
          error: ports.unknownMessage(),
        });
        if (unresolved) project(unresolved);
        ports.changed?.();
        return false;
      }
      if (!receipt.active) {
        // Accepted history was subsequently removed. A retry cannot resurrect it.
        await ports.storage.remove(row.id);
        removeVisible(row.id);
        ports.changed?.();
        return true;
      }
      if (signal.aborted || closed || canceled.has(row.id)) return false;
      ports.confirmed?.(current.send);
      current =
        (await ports.storage.patch(row.id, { state: 'confirmed', error: undefined })) ?? current;
      if (current.canceled) return true;
      project(current);
      if (!hasCompleted(row.id)) {
        // A guide may already have reached ACP even when no reply made it back.
        // Persist this fence before offering it and never offer again on restore.
        if (current.send.delivery.kind !== 'guide' || !current.deliveryStarted) {
          if (current.send.delivery.kind === 'guide') {
            current = (await ports.storage.patch(row.id, { deliveryStarted: true })) ?? current;
          }
          if (!current.canceled && !signal.aborted && !closed && !canceled.has(row.id)) {
            const delivered = await ports.deliver(current.send, signal, receipt);
            if (delivered?.status === 'accepted' && !delivered.active) {
              await ports.storage.remove(row.id);
              removeVisible(row.id);
              ports.changed?.();
              return true;
            }
          }
        }
        deliveries.set(row.id, { kind: current.send.delivery.kind, completed: true });
      }
      if (signal.aborted || closed || canceled.has(row.id)) return false;
      if (await ports.visible(current.send, signal)) {
        await ports.storage.remove(row.id);
        removeVisible(row.id);
      } else project(current);
      ports.changed?.();
      return true;
    } catch (error) {
      if (signal.aborted || closed || canceled.has(row.id)) return false;
      const next = await ports.storage.patch(row.id, {
        state:
          current.state === 'confirmed'
            ? 'confirmed'
            : row.state === 'queued' && didNotStart(error)
              ? 'failed'
              : 'unknown',
        error: error instanceof Error ? error.message : ports.unknownMessage(),
      });
      if (next) project(next);
      ports.changed?.();
      return false;
    }
  };

  const drain = (sessionId: SessionId) => {
    const generation = (requested.get(sessionId) ?? 0) + 1;
    requested.set(sessionId, generation);
    if (closed || paused || running.has(sessionId)) return;
    const controller = new AbortController();
    controllers.set(sessionId, controller);
    const work = ports.resources
      .run(
        async (signal) => {
          await ensureInitialized();
          await ports.lock(sessionId, signal, async () => {
            // Storage is shared across windows; reread under the session lease.
            for (;;) {
              if (signal.aborted || closed) return;
              if (
                sends.some(
                  (send) =>
                    send.sessionId === sessionId && !send.persisted && !canceled.has(send.id)
                )
              )
                return;
              const rows = (await ports.storage.list()).filter(
                (row) => row.send.sessionId === sessionId
              );
              let madeProgress = false;
              for (const row of rows) {
                if (signal.aborted || closed) return;
                if (row.canceled) {
                  await ports.storage.remove(row.id);
                  removeVisible(row.id);
                  madeProgress = true;
                  continue;
                }
                // A cancellation that failed to persist its mark still fences this
                // window. Skipping is not progress: a later cancellation marks and
                // removes the row, while relisting it here would spin under the lease.
                if (canceled.has(row.id)) continue;
                if (hasCompleted(row.id) && row.state === 'confirmed') continue;
                if (!(await process(row, signal))) return;
                madeProgress = true;
              }
              if (!madeProgress) return;
            }
          });
        },
        controller.signal,
        { protectExit: false }
      )
      .catch((error: unknown) => {
        if (closed || controller.signal.aborted) return;
        publish(
          sends.map((send) =>
            send.sessionId === sessionId
              ? { ...send, error: error instanceof Error ? error.message : ports.unknownMessage() }
              : send
          )
        );
      })
      .finally(() => {
        running.delete(sessionId);
        controllers.delete(sessionId);
        if (!closed && requested.get(sessionId) !== generation) drain(sessionId);
      });
    running.set(sessionId, work);
  };

  const resume = async () => {
    await ensureInitialized();
    if (closed) return;
    paused = false;
    const rows = await ports.resources.run(async () => load(), undefined, { protectExit: false });
    for (const id of new Set(rows.map((row) => row.send.sessionId))) drain(id);
  };
  const cancelWhere = async (match: (send: PendingSessionSend) => boolean) => {
    const local = sends.filter(match);
    for (const send of local) canceled.add(send.id);
    publish(sends.filter((send) => !canceled.has(send.id)));
    await initialized;
    await Promise.all(local.map((send) => saving.get(send.id)));
    const selected = await ports.resources.run(async () => {
      // A window's projection can lag BroadcastChannel delivery. Cancellation
      // must discover shared durable work independently of its visible rows.
      const stored = (await ports.storage.list()).filter((row) => match(row.send));
      const all = [
        ...new Map(
          [...local, ...stored.map((row) => row.send)].map((send) => [send.id, send])
        ).values(),
      ];
      for (const send of all) {
        canceled.add(send.id);
        await ports.storage.patch(send.id, { canceled: true });
      }
      return all;
    });
    publish(sends.filter((send) => !canceled.has(send.id)));
    for (const sessionId of new Set(selected.map((send) => send.sessionId)))
      controllers.get(sessionId)?.abort();
    await Promise.all(selected.map((send) => running.get(send.sessionId)));
    await ports.resources.run(async (signal) => {
      for (const sessionId of new Set(selected.map((send) => send.sessionId))) {
        await ports.lock(sessionId, signal, async () => {
          for (const send of selected.filter((value) => value.sessionId === sessionId)) {
            if ((await ports.storage.get(send.id))?.canceled) await ports.storage.remove(send.id);
          }
        });
      }
    });
    ports.changed?.();
    for (const sessionId of new Set(selected.map((send) => send.sessionId))) drain(sessionId);
  };
  const persist = (owned: PendingSessionSend) => {
    if (closed || canceled.has(owned.id) || saving.has(owned.id)) return;
    publish(sends.map((send) => (send.id === owned.id ? { ...send, error: undefined } : send)));
    const predecessor = saveTail;
    let saved = false;
    const work = ports.resources
      .run(async () => {
        await predecessor;
        await ensureInitialized();
        const blocked = sends.find(
          (send) =>
            send.sessionId === owned.sessionId &&
            !send.persisted &&
            send.sequence < owned.sequence &&
            !canceled.has(send.id)
        );
        if (blocked) throw new Error(blocked.error ?? ports.unknownMessage());
        const row = await ports.storage.save(owned);
        saved = true;
        project(row);
        ports.changed?.();
      })
      .catch((error: unknown) => {
        if (closed || canceled.has(owned.id)) return;
        publish(
          sends.map((value) =>
            value.id === owned.id
              ? { ...value, error: error instanceof Error ? error.message : ports.unknownMessage() }
              : value
          )
        );
      })
      .finally(() => {
        if (saving.get(owned.id) === work) saving.delete(owned.id);
        if (closed) return;
        if (saved) {
          for (const next of sends
            .filter(
              (send) =>
                send.sessionId === owned.sessionId && !send.persisted && !saving.has(send.id)
            )
            .sort((a, b) => a.sequence - b.sequence))
            persist(next);
        }
        drain(owned.sessionId);
      });
    saveTail = work;
    saving.set(owned.id, work);
  };
  return {
    getSnapshot: () => sends,
    rememberDelivery,
    ownsDelivery: (id: string, kind: PendingSessionSend['delivery']['kind']) =>
      deliveries.get(id)?.kind === kind,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enqueue(send: Omit<PendingSessionSend, 'sequence' | 'error'>) {
      if (closed) throw new Error('Workspace closed before the input could be accepted');
      if (sends.some((value) => value.id === send.id))
        throw new Error('Input is already accepted locally');
      const owned = structuredClone({ ...send, sequence: ++localSequence }) as PendingSessionSend;
      rememberDelivery(owned);
      publish([...sends, { ...owned, inputState: 'saving' }]);
      persist(owned);
    },
    retry(id: string) {
      const send = sends.find((value) => value.id === id);
      if (!send || closed) return;
      if (!send.persisted) {
        const prior = saving.get(id) ?? Promise.resolve();
        void prior.then(() => persist(send));
        return;
      }
      void ports.resources
        .run(async () => {
          const row = await ports.storage.get(id);
          if (row?.state === 'failed')
            await ports.storage.patch(id, { state: 'queued', error: undefined });
          // Resolve or retry the same immutable operation, never a fresh input.
        })
        .then(
          () => drain(send.sessionId),
          (error: unknown) => {
            publish(
              sends.map((value) =>
                value.id === id
                  ? {
                      ...value,
                      error: error instanceof Error ? error.message : ports.unknownMessage(),
                    }
                  : value
              )
            );
          }
        );
    },
    cancel: (id: string) => cancelWhere((send) => send.id === id),
    cancelSessions(ids: Iterable<SessionId>) {
      const targets = new Set(ids);
      return cancelWhere(
        (send) =>
          targets.has(send.sessionId) ||
          Boolean(send.creation?.parentSessionId && targets.has(send.creation.parentSessionId))
      );
    },
    capturePredecessors(sessionId: SessionId): Promise<readonly string[]> {
      const priorSaves = saveTail;
      const local = sends.filter((send) => send.sessionId === sessionId).map((send) => send.id);
      return ports.resources.run(
        async () => {
          await priorSaves;
          await ensureInitialized();
          return [
            ...new Set([
              ...local,
              ...(await ports.storage.list())
                .filter((row) => row.send.sessionId === sessionId)
                .map((row) => row.id),
            ]),
          ];
        },
        undefined,
        { protectExit: false }
      );
    },
    async afterInputs<T>(
      sessionId: SessionId,
      ids: readonly string[],
      signal: AbortSignal,
      work: () => Promise<T>
    ): Promise<T> {
      await ensureInitialized();
      const predecessors = new Set(ids);
      for (;;) {
        if (signal.aborted || closed) throw new DOMException('Input wait canceled', 'AbortError');
        const outcome = await ports.lock(sessionId, signal, async () => {
          if (
            sends.some(
              (send) => predecessors.has(send.id) && !send.persisted && !canceled.has(send.id)
            )
          )
            return { ready: false as const, observed: revision };
          const rows = (await ports.storage.list()).filter((row) => predecessors.has(row.id));
          for (const row of rows) {
            if (row.canceled || (hasCompleted(row.id) && row.state === 'confirmed')) continue;
            if (!(await process(row, signal))) return { ready: false as const, observed: revision };
          }
          if (signal.aborted || closed) throw new DOMException('Input wait canceled', 'AbortError');
          return { ready: true as const, value: await work() };
        });
        if (outcome.ready) return outcome.value;
        // Subscribe synchronously after the last locked observation. A later
        // retry, cancellation or refresh wakes this barrier without polling.
        await waitForChange(signal, outcome.observed);
      }
    },
    resume,
    refresh: () =>
      ports.resources.run(
        async () => {
          await initialized;
          await load();
        },
        undefined,
        { protectExit: false }
      ),
    async acknowledgeLanded(ids: Iterable<string>) {
      const selected = [...ids].filter((id) => hasCompleted(id));
      await ports.resources.run(
        async () => {
          for (const id of selected) {
            const row = await ports.storage.get(id);
            if (row?.state === 'confirmed') {
              await ports.storage.remove(id);
              removeVisible(id);
            }
          }
        },
        undefined,
        { protectExit: false }
      );
      if (selected.length) ports.changed?.();
    },
    async dispose() {
      if (closed) return;
      closed = true;
      listeners.clear();
      await initialized;
      await Promise.all(saving.values());
      for (const controller of controllers.values()) controller.abort();
      await Promise.all(running.values());
      await ports.storage.close();
      sends = [];
    },
  };
}
export type AcceptedSessionInputs = ReturnType<typeof createAcceptedSessionInputs>;

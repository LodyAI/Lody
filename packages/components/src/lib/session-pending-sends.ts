import type { MachineId, SessionId } from '@lody/shared';
import type { SessionAttachmentDraft } from './session-attachment-draft';
import type { UserTurnSend } from './session-send-delivery';

/**
 * A send held in renderer memory because its attachments are still being
 * prepared, or because an earlier held send of the same conversation is. Nothing
 * of it exists in the synchronized documents until it is written, and nothing
 * persists it: closing the window loses it (the page asks first).
 */
export type PendingSessionSend = UserTurnSend & {
  /** The user turn id (`entry.id`). */
  id: string;
  workspaceId: string;
  /** Machine that runs the conversation; decides the same-machine image fallback. */
  targetMachineId?: MachineId;
  attachments: SessionAttachmentDraft[];
  /** Set when preparation or the local write failed; blocks the conversation's FIFO. */
  error?: string;
  sequence: number;
};

export type PendingSessionSendsPorts = {
  /**
   * Prepare every unready attachment and return the send with final
   * references. `update` publishes per-attachment progress and results.
   */
  prepare(
    send: PendingSessionSend,
    signal: AbortSignal,
    update: (attachments: SessionAttachmentDraft[]) => void
  ): Promise<Pick<PendingSessionSend, 'entry' | 'queue' | 'attachments'>>;
  /** The ordinary local write; see `writeUserTurn`. */
  write(send: PendingSessionSend, signal: AbortSignal): Promise<void>;
  /** Best-effort delivery after the write; failures are the port's to log. */
  deliver(send: PendingSessionSend): Promise<void>;
};

export type PendingSessionSends = ReturnType<typeof createPendingSessionSends>;

const abortError = () => new DOMException('Pending send canceled', 'AbortError');

/**
 * Per-runtime, in-memory FIFO of held sends. Each conversation drains in order:
 * a later send to the same conversation waits behind an earlier held one, and a
 * failed send blocks the ones behind it until it is retried or canceled.
 */
export function createPendingSessionSends(ports: PendingSessionSendsPorts) {
  let sends: readonly PendingSessionSend[] = [];
  let sequence = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const controllers = new Map<string, AbortController>();
  const inflight = new Map<string, Promise<boolean>>();
  const running = new Map<SessionId, Promise<void>>();

  const publish = (next: readonly PendingSessionSend[]) => {
    sends = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Pending send observer failed', error);
      }
    }
  };
  const patch = (id: string, change: Partial<PendingSessionSend>) =>
    publish(sends.map((send) => (send.id === id ? { ...send, ...change } : send)));
  const find = (id: string) => sends.find((send) => send.id === id);
  const head = (sessionId: SessionId) => sends.find((send) => send.sessionId === sessionId);

  /** Remove sends; the creation metadata of a removed first send moves to the next one. */
  const remove = (ids: ReadonlySet<string>) => {
    const next: PendingSessionSend[] = [];
    const orphaned = new Map<SessionId, PendingSessionSend['creation']>();
    for (const send of sends) {
      if (ids.has(send.id)) {
        if (send.creation) orphaned.set(send.sessionId, send.creation);
        continue;
      }
      const creation = orphaned.get(send.sessionId);
      if (creation && !send.creation) {
        orphaned.delete(send.sessionId);
        next.push({ ...send, creation });
      } else next.push(send);
    }
    publish(next);
  };

  const track = (send: PendingSessionSend) => {
    const work = attempt(send).finally(() => inflight.delete(send.id));
    inflight.set(send.id, work);
    return work;
  };

  const attempt = async (send: PendingSessionSend) => {
    const controller = new AbortController();
    controllers.set(send.id, controller);
    const { signal } = controller;
    try {
      let current = send;
      if (current.attachments.some((attachment) => !attachment.ready)) {
        const prepared = await ports.prepare(current, signal, (attachments) => {
          if (!signal.aborted && find(send.id)) patch(send.id, { attachments });
        });
        if (signal.aborted || !find(send.id)) throw abortError();
        patch(send.id, prepared);
      }
      current = find(send.id) ?? current;
      if (signal.aborted || !find(send.id)) throw abortError();
      await ports.write(current, signal);
      remove(new Set([send.id]));
      // Canceled mid-write (archive/delete): the turn landed, but nothing starts it.
      if (signal.aborted) return true;
      void ports.deliver(current).catch((error: unknown) => {
        console.warn('Pending send delivery failed after its local write', {
          sessionId: current.sessionId,
          turnId: current.id,
          error,
        });
      });
      return true;
    } catch (error) {
      if (signal.aborted || !find(send.id)) return false;
      patch(send.id, {
        error: error instanceof Error ? error.message : 'Message could not be sent',
      });
      return false;
    } finally {
      controllers.delete(send.id);
    }
  };

  const drain = (sessionId: SessionId): Promise<void> => {
    const existing = running.get(sessionId);
    if (existing) return existing;
    const work = (async () => {
      for (;;) {
        const next = head(sessionId);
        if (disposed || !next || next.error) return;
        if (!(await track(next)) && find(next.id)) return;
      }
    })().finally(() => {
      running.delete(sessionId);
      // A send added or retried while the loop was finishing starts a new pass.
      const next = head(sessionId);
      if (!disposed && next && !next.error) void drain(sessionId);
    });
    running.set(sessionId, work);
    return work;
  };

  const cancelWhere = async (match: (send: PendingSessionSend) => boolean) => {
    const matched = sends.filter(match);
    if (!matched.length) return;
    for (const send of matched) controllers.get(send.id)?.abort();
    remove(new Set(matched.map((send) => send.id)));
    // Join in-flight work so nothing canceled writes after this resolves.
    await Promise.all(matched.map((send) => inflight.get(send.id)));
    // A failed head blocked its conversation; the next send may start now.
    for (const sessionId of new Set(matched.map((send) => send.sessionId)))
      if (head(sessionId)) void drain(sessionId);
  };

  return {
    getSnapshot: () => sends,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    has: (id: string) => Boolean(find(id)),
    hasSession: (sessionId: SessionId) => Boolean(head(sessionId)),
    hasPendingCreation: (sessionId: SessionId) =>
      sends.some((send) => send.sessionId === sessionId && send.creation),
    enqueue(send: Omit<PendingSessionSend, 'sequence' | 'error'>) {
      if (disposed) throw new Error('Workspace closed before the message could be sent');
      if (find(send.id)) throw new Error('Message is already pending');
      publish([...sends, { ...send, sequence: ++sequence }]);
      void drain(send.sessionId);
    },
    retry(id: string) {
      const send = find(id);
      if (!send) return;
      patch(id, {
        error: undefined,
        attachments: send.attachments.map((attachment) =>
          attachment.ready ? attachment : { ...attachment, error: undefined, progress: 0 }
        ),
      });
      void drain(send.sessionId);
    },
    cancel: (id: string) => cancelWhere((send) => send.id === id),
    /** Archive/delete: drop held sends of these conversations and their pending children. */
    cancelSessions: (sessionIds: Iterable<SessionId>) => {
      const targets = new Set<string>(sessionIds);
      return cancelWhere(
        (send) =>
          targets.has(send.sessionId) ||
          Boolean(send.creation?.parentSessionId && targets.has(send.creation.parentSessionId))
      );
    },
    dispose() {
      disposed = true;
      for (const controller of controllers.values()) controller.abort();
      listeners.clear();
      sends = [];
    },
  };
}

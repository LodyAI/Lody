import type { SessionId } from '@lody/shared';
import { terminalNotificationSchema, type TerminalNotification } from '@lody/shared/notifications';

type Entry = { id: SessionId; notificationId?: string };

/** Watches only changes observed during this consumer's lifetime. Initial rows,
 * restores and reconnect baselines never replay alerts. No history enumeration.
 */
export function createTerminalNotificationConsumer(ports: {
  recipientId: string;
  now: () => number;
  read: (sessionId: SessionId, signal: AbortSignal) => Promise<unknown>;
  show: (sessionId: SessionId, notification: TerminalNotification) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  let previous = new Map<SessionId, string | undefined>();
  const lifetime = new AbortController();
  let initialized = false;
  const pending = new Set<string>();
  return {
    async observe(entries: readonly Entry[]): Promise<void> {
      if (lifetime.signal.aborted) return;
      const next = new Map(entries.map((entry) => [entry.id, entry.notificationId]));
      const changes = initialized
        ? entries.filter(
            (entry) =>
              previous.has(entry.id) &&
              entry.notificationId &&
              previous.get(entry.id) !== entry.notificationId
          )
        : [];
      previous = next;
      initialized = true;
      // At most four active reads across observations. Overload is dropped, not queued.
      for (let offset = 0; offset < changes.length; offset += 4) {
        await Promise.all(
          changes.slice(offset, offset + 4).map(async (entry) => {
            const key = `${entry.id}:${entry.notificationId}`;
            if (lifetime.signal.aborted || pending.has(key) || pending.size >= 4) return;
            pending.add(key);
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]);
            try {
              const parsed = terminalNotificationSchema.safeParse(
                await ports.read(entry.id, signal)
              );
              if (
                !parsed.success ||
                signal.aborted ||
                previous.get(entry.id) !== entry.notificationId
              )
                return;
              const fact = parsed.data;
              const age = ports.now() - fact.createdAt;
              if (
                fact.id !== entry.notificationId ||
                fact.recipientId !== ports.recipientId ||
                age < 0 ||
                age > 60_000
              )
                return;
              await ports.show(entry.id, fact);
            } catch (error) {
              if (!signal.aborted) ports.onError(error);
            } finally {
              pending.delete(key);
            }
          })
        );
      }
    },
    dispose(): void {
      lifetime.abort();
      previous.clear();
    },
  };
}

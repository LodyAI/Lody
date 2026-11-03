import { useAtomValue } from 'jotai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getScheduleRoomId, ScheduleRepository, type ScheduleRegistryRow } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { scheduledMessageText } from './scheduled-message-content';

type Target = { scheduleId: string; definitionFingerprint: string };
type CachedText = { definitionFingerprint: string; text: string };

/** Keep a missing-content pull to a few documents so one list cannot saturate I/O. */
const READ_CONCURRENCY = 4;
const SYNC_BATCH_SIZE = 4;

const targetKey = (target: Target) => `${target.scheduleId}\u0000${target.definitionFingerprint}`;

async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>
) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await run(items[index]);
    }
  });
  await Promise.all(workers);
}

/**
 * The full text of each scheduled message, read from its own document because
 * the Registry row deliberately carries no message content. Only scheduled
 * messages are read; ordinary schedules never load their definitions here.
 *
 * A local replica is tried first, so content created or edited on this device
 * appears without a network round trip. When that replica has no payload yet,
 * one bounded batch of one-shot document syncs brings it in; there is no room
 * join and no continuing subscription. The fingerprint cache prevents Registry
 * runtime projections from re-reading unchanged messages.
 */
export function useScheduledMessageContents(
  rows: readonly ScheduleRegistryRow[]
): ReadonlyMap<string, string> {
  const activeRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime =
    scope.enabled && scope.workspaceId === activeRuntime?.workspaceId ? activeRuntime : null;
  const targets = useMemo<Target[]>(
    () =>
      rows.flatMap((row) =>
        row.scheduledMessage
          ? [{ scheduleId: row.scheduleId, definitionFingerprint: row.definitionFingerprint }]
          : []
      ),
    [rows]
  );
  // The Registry snapshot is a new array on every runtime projection, but the
  // rows that need a document only change when one is created, edited or gone.
  const signature = targets
    .map((target) => `${target.scheduleId}\u0000${target.definitionFingerprint}`)
    .join('\u0001');
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const cache = useRef(new Map<string, CachedText>());
  const syncAttempts = useRef(new Set<string>());
  const [retryToken, setRetryToken] = useState(0);
  const [contents, setContents] = useState<ReadonlyMap<string, string>>(new Map());

  // A failed or offline pull should get another chance when the browser
  // reconnects, without polling while it is offline.
  useEffect(() => {
    const retry = () => {
      syncAttempts.current.clear();
      setRetryToken((value) => value + 1);
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, []);

  useEffect(() => {
    if (!runtime) {
      cache.current.clear();
      syncAttempts.current.clear();
      setContents(new Map());
      return undefined;
    }
    const controller = new AbortController();
    let disposed = false;
    const repository = new ScheduleRepository(runtime.repo, runtime.workspaceId, {
      protectedContent: runtime.contentMode === 'e2ee',
    });
    const readText = async (target: Target) => {
      try {
        return scheduledMessageText(await repository.read(target.scheduleId));
      } catch {
        return undefined;
      }
    };
    const current = new Map<string, string>();
    const pending: Target[] = [];
    for (const target of targetsRef.current) {
      const cached = cache.current.get(target.scheduleId);
      if (cached?.definitionFingerprint === target.definitionFingerprint)
        current.set(target.scheduleId, cached.text);
      else pending.push(target);
    }
    setContents(current);
    if (pending.length === 0) {
      return () => {
        disposed = true;
        controller.abort();
      };
    }

    void (async () => {
      const missing: Target[] = [];
      await forEachWithConcurrency(pending, READ_CONCURRENCY, async (target) => {
        const text = await readText(target);
        if (disposed) return;
        if (text === undefined) {
          cache.current.delete(target.scheduleId);
          missing.push(target);
          return;
        }
        cache.current.set(target.scheduleId, {
          definitionFingerprint: target.definitionFingerprint,
          text,
        });
        current.set(target.scheduleId, text);
      });
      if (disposed) return;
      setContents(new Map(current));

      const toSync = missing.filter((target) => !syncAttempts.current.has(targetKey(target)));
      for (let offset = 0; offset < toSync.length; offset += SYNC_BATCH_SIZE) {
        const batch = toSync.slice(offset, offset + SYNC_BATCH_SIZE);
        try {
          await runtime.repo.sync({
            scope: 'doc',
            docIds: batch.map((target) => getScheduleRoomId(target.scheduleId)),
            // These bodies are read once for a one-line preview; the detail view
            // owns any long-lived replica. Releasing them keeps a long list from
            // pinning every schedule document in memory.
            retainLoadedDocs: false,
            signal: controller.signal,
          });
        } catch {
          if (disposed || controller.signal.aborted) return;
          // Offline or transport failure keeps the stored title. The batch is
          // marked attempted and retried on the next `online` event.
        }
        if (disposed) return;
        for (const target of batch) syncAttempts.current.add(targetKey(target));
        await forEachWithConcurrency(batch, READ_CONCURRENCY, async (target) => {
          const text = await readText(target);
          if (disposed) return;
          if (text === undefined) {
            cache.current.delete(target.scheduleId);
            current.delete(target.scheduleId);
            return;
          }
          cache.current.set(target.scheduleId, {
            definitionFingerprint: target.definitionFingerprint,
            text,
          });
          current.set(target.scheduleId, text);
        });
        if (!disposed) setContents(new Map(current));
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [runtime, signature, retryToken]);

  return contents;
}

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useSetAtom } from 'jotai';
import { getSessionRoomId, type SessionMeta } from '@lody/shared';
import { pendingSendSessionMetasAtom, setDocMetaByRoomIdAtom } from '@/atoms/doc-meta';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { sessionSendStatusesAtom } from '@/atoms/session-send-status';
import type { PendingSessionSend } from '@/lib/session-pending-sends';
import { deriveSessionSendStatuses } from '@/lib/session-send-status';

const EMPTY: readonly PendingSessionSend[] = [];
const emptySnapshot = () => EMPTY;
const emptySubscribe = () => () => {};

/**
 * Projects the runtime's in-memory held sends into workspace UI: placeholder
 * metadata for new conversations that are not written yet, the sidebar send
 * status, and a leave confirmation. Held sends are lost when the page goes
 * away, so that confirmation is their only protection. Renders nothing.
 */
export function SessionPendingSendsHost({ runtime }: { runtime: WorkspaceRuntime | null }) {
  const pending = runtime?.pendingSends;
  const sends = useSyncExternalStore(
    pending?.subscribe ?? emptySubscribe,
    pending?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  );
  const setPendingMetas = useSetAtom(pendingSendSessionMetasAtom);
  const setDocMeta = useSetAtom(setDocMetaByRoomIdAtom);
  const setSendStatuses = useSetAtom(sessionSendStatusesAtom);
  const placeholders = useRef<Record<string, SessionMeta>>({});
  const handingOver = useRef(new Map<string, SessionMeta>());

  useEffect(() => {
    let active = true;
    const publish = () => {
      const next = { ...Object.fromEntries(handingOver.current), ...placeholders.current };
      setPendingMetas((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next
      );
    };
    const next = Object.fromEntries(
      sends.flatMap((send) =>
        send.creation ? [[getSessionRoomId(send.sessionId), send.creation] as const] : []
      )
    );
    const previous = placeholders.current;
    placeholders.current = next;
    // A placeholder that left the queue was either written or canceled. A
    // written one hands over to its repo metadata before it disappears, so an
    // open conversation never flashes "not found" while the meta watch catches up.
    for (const roomId of Object.keys(previous)) {
      if (roomId in next || handingOver.current.has(roomId)) continue;
      handingOver.current.set(roomId, previous[roomId]!);
      void Promise.resolve(runtime?.repo.getDocMeta(roomId))
        .then((found) => {
          const meta = found?.meta as SessionMeta | undefined;
          if (active && meta?.id) setDocMeta(roomId, meta);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!active) return;
          handingOver.current.delete(roomId);
          publish();
        });
    }
    publish();
    setSendStatuses(deriveSessionSendStatuses(sends));
    return () => {
      active = false;
    };
  }, [runtime, sends, setDocMeta, setPendingMetas, setSendStatuses]);

  useEffect(
    () => () => {
      placeholders.current = {};
      handingOver.current.clear();
      setPendingMetas({});
      setSendStatuses({});
    },
    [runtime, setPendingMetas, setSendStatuses]
  );

  const hasPending = sends.length > 0;
  useEffect(() => {
    if (!hasPending) return undefined;
    const confirmLeave = (event: BeforeUnloadEvent) => {
      console.warn('[unload-blocked] pending session sends', { count: sends.length });
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', confirmLeave);
    return () => window.removeEventListener('beforeunload', confirmLeave);
  }, [hasPending, sends.length]);

  return null;
}

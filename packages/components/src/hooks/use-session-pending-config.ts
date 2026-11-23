import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import {
  resolveSessionConversationConfig,
  type SessionConversationConfig,
  type SessionConversationSourceFence,
  type SessionHistory,
  type SessionId,
} from '@lody/shared';
import type { ConversationView } from '@/lib/conversation-view/types';
import type { PendingSessionSends } from '@/lib/session-pending-sends';

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

/** Bridges the frozen local send to its history/queue source, without retaining attachments. */
export function useSessionPendingConfig({
  sessionId,
  pendingSends,
  history,
  config,
  sourceFence,
  documentReady,
}: {
  sessionId: SessionId;
  pendingSends?: PendingSessionSends | null;
  history: Pick<ConversationView, 'indexOf'> | null | undefined;
  config: SessionConversationConfig;
  sourceFence: SessionConversationSourceFence;
  documentReady: boolean;
}) {
  // Progress replaces the send wrapper, but not its entry. Other conversations
  // and attachment progress must not rebuild this composer's selector catalog.
  const getSnapshot = useCallback(() => {
    const sends = pendingSends?.getSnapshot() ?? [];
    for (let index = sends.length - 1; index >= 0; index -= 1) {
      if (sends[index]!.sessionId === sessionId) return sends[index]!.entry;
    }
    return null;
  }, [pendingSends, sessionId]);
  const latest = useSyncExternalStore(
    pendingSends?.subscribe ?? emptySubscribe,
    getSnapshot,
    emptySnapshot
  );
  const [observed, setObserved] = useState<{
    sessionId: SessionId;
    pendingSends: PendingSessionSends | null | undefined;
    entry: SessionHistory | null;
    knownTurnKeys: readonly string[];
    documentReady: boolean;
    superseded: boolean;
  }>({ sessionId, pendingSends, entry: null, knownTurnKeys: [], documentReady, superseded: false });

  const sameScope = observed.sessionId === sessionId && observed.pendingSends === pendingSends;
  const previous = sameScope ? observed.entry : null;
  const previousKey = previous ? `turn:${previous.id}` : null;
  const confirmed = previousKey != null && sourceFence.knownTurnKeys.includes(previousKey);
  // History publication can lag the local write. Cancellation has no landed
  // turn; a written turn retains its frozen config until the source catches up.
  const entry =
    latest ??
    (previous && !confirmed && (!documentReady || (history?.indexOf(previous.id) ?? -1) >= 0)
      ? previous
      : null);
  const newTurn = !sameScope || entry?.id !== previous?.id;
  const hydrated = sameScope && !observed.documentReady && documentReady;
  const currentTurnKey = sourceFence.currentTurnKey;
  const superseded =
    Boolean(entry) &&
    !newTurn &&
    !hydrated &&
    (observed.superseded ||
      Boolean(
        documentReady &&
        currentTurnKey &&
        currentTurnKey !== previousKey &&
        !observed.knownTurnKeys.includes(currentTurnKey)
      ));

  if (!sameScope || entry !== observed.entry || hydrated || superseded !== observed.superseded) {
    setObserved({
      sessionId,
      pendingSends,
      entry,
      knownTurnKeys:
        newTurn || hydrated
          ? [
              ...new Set([
                ...sourceFence.knownTurnKeys,
                ...(pendingSends?.getSnapshot() ?? [])
                  .filter((send) => send.sessionId === sessionId)
                  .map((send) => `turn:${send.id}`),
              ]),
            ]
          : observed.knownTurnKeys,
      documentReady,
      superseded,
    });
  }

  const turnKey = entry ? `turn:${entry.id}` : null;
  const hasPendingConfig = Boolean(
    entry && !superseded && !sourceFence.knownTurnKeys.includes(turnKey!)
  );
  return useMemo(() => {
    if (!hasPendingConfig || !entry) return { config, sourceFence, hasPendingConfig: false };
    const pendingConfig = resolveSessionConversationConfig([
      { id: 'baseline', role: 'user', inputConfig: config },
      entry,
    ]);
    return {
      config: pendingConfig,
      sourceFence: {
        currentTurnKey: turnKey!,
        knownTurnKeys: [
          ...new Set([...sourceFence.knownTurnKeys, ...observed.knownTurnKeys, turnKey!]),
        ],
      },
      hasPendingConfig: true,
    };
  }, [config, entry, hasPendingConfig, observed.knownTurnKeys, sourceFence, turnKey]);
}

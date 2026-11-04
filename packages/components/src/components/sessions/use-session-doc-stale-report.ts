import { useEffect, useRef } from 'react';
import type { SessionId } from '@lody/shared';
import type { MachineOnlineStatus } from '@/atoms/presence';
import type { SessionDocStore } from '@/atoms/runtime';
import { recordClientLog } from '@/lib/client-log';

/**
 * How long a conversation may end in an unfinished turn that nothing runs
 * before it is reported. Longer than presence and history normally disagree
 * when a turn finishes.
 */
export const SESSION_DOC_STALE_REPORT_DELAY_MS = 30_000;
const UPLOAD_PROBE_TIMEOUT_MS = 10_000;

export type SessionDocStaleSignal = {
  docReady: boolean;
  machineOnlineStatus: MachineOnlineStatus;
  /** Live presence, a pending dispatch or an active goal. */
  agentBusy: boolean;
  activeAssistantTurnId: string | null;
};

/**
 * The unfinished assistant turn that a fresh machine heartbeat says nothing is
 * running, or `null`. Unknown or offline machines prove nothing: a dead agent
 * also leaves an unfinished turn.
 */
export const resolveStaleCandidateTurnId = (signal: SessionDocStaleSignal): string | null =>
  signal.docReady && signal.machineOnlineStatus === 'online' && !signal.agentBusy
    ? signal.activeAssistantTurnId
    : null;

/**
 * Records one `session.doc_stale` client-log entry (sent with bug reports) and
 * console warning when a conversation keeps ending in an unfinished turn that
 * presence says is no longer running — the shape of a room that stays joined
 * while it stops applying updates. Once per turn per mounted conversation.
 */
export function useSessionDocStaleReport(
  options: SessionDocStaleSignal & {
    sessionId: SessionId;
    /** Session meta's `lastMessageAt`: the Meta room advancing while this doc does not. */
    lastMessageAt: number | null | undefined;
    peekStore: () => SessionDocStore | undefined;
  }
): void {
  const { sessionId, peekStore } = options;
  const candidateTurnId = resolveStaleCandidateTurnId(options);
  const latest = useRef(options);
  latest.current = options;
  const reported = useRef<{ sessionId: SessionId; turnIds: Set<string> }>({
    sessionId,
    turnIds: new Set(),
  });
  if (reported.current.sessionId !== sessionId) {
    reported.current = { sessionId, turnIds: new Set() };
  }

  useEffect(() => {
    if (!candidateTurnId || reported.current.turnIds.has(candidateTurnId)) return undefined;
    const turnIds = reported.current.turnIds;
    const staleSince = Date.now();
    let cancelled = false;
    const timer = setTimeout(() => {
      turnIds.add(candidateTurnId);
      void (async () => {
        const store = peekStore();
        const reportedAt = Date.now();
        const inspection = store
          ? await store
              .inspectSync({ uploadProbeTimeoutMs: UPLOAD_PROBE_TIMEOUT_MS })
              .catch(() => null)
          : null;
        if (cancelled) return;
        const lastMessageAt = latest.current.lastMessageAt;
        const details = {
          sessionId,
          turnId: candidateTurnId,
          historyBackend: store?.historyBackend ?? null,
          transportId: inspection?.transportId ?? null,
          bindingStatus: inspection?.bindingStatus ?? null,
          syncState: inspection?.syncState ?? null,
          pendingUploadProbe: inspection?.pendingUploadProbe ?? null,
          pendingUploadProbeMs: inspection ? Date.now() - reportedAt : null,
          staleForMs: reportedAt - staleSince,
          openForMs: inspection ? reportedAt - inspection.openedAt : null,
          lastRemoteImportAgoMs:
            inspection?.lastRemoteImportAt != null
              ? reportedAt - inspection.lastRemoteImportAt
              : null,
          lastMessageAgoMs: lastMessageAt != null ? reportedAt - lastMessageAt : null,
          browserOnline: typeof navigator === 'undefined' ? null : navigator.onLine,
          documentVisible:
            typeof document === 'undefined' ? null : document.visibilityState === 'visible',
        };
        recordClientLog('warn', 'session.doc_stale', undefined, details);
        console.warn('[session-sync] conversation looks stale', details);
      })();
    }, SESSION_DOC_STALE_REPORT_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [candidateTurnId, peekStore, sessionId]);
}

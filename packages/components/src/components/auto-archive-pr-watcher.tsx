import { WorkspaceWindowOwnerContext } from '@/lib/desktop-window';
import { useContext, useEffect, useMemo } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { autoArchiveOnPrClosedAtom, autoArchiveOnPrMergedAtom, userAtom } from '@/atoms';
import {
  useVisibleArchivedSessionMetas,
  useVisibleSessionMetas,
} from '@/hooks/use-visible-session-metas';
import { useSessionActions } from '@/hooks/use-session-actions';
import {
  type AutoArchivePrSnapshot,
  getAutoArchivePrDecision,
  getAutoArchivePrSnapshot,
} from '@/lib/auto-archive-pr';
import { useAppCapability } from '@/lib/app-platform';

type PendingArchive = {
  sessionId: SessionId;
  pr: AutoArchivePrSnapshot;
  accepted: Set<SessionId>;
  retryDelay: number;
  timer?: ReturnType<typeof setTimeout>;
};

export function AutoArchivePrWatcher() {
  const owner = useContext(WorkspaceWindowOwnerContext);
  const githubIntegrationAvailable = useAppCapability('githubIntegration');
  if (!githubIntegrationAvailable || !owner) {
    return null;
  }
  return <CloudAutoArchivePrWatcher />;
}

function CloudAutoArchivePrWatcher() {
  const { sessions } = useVisibleSessionMetas();
  const { archivedSessions } = useVisibleArchivedSessionMetas();
  const user = useAtomValue(userAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const onPrMerged = useAtomValue(autoArchiveOnPrMergedAtom);
  const onPrClosed = useAtomValue(autoArchiveOnPrClosedAtom);
  const { archiveSession } = useSessionActions();
  const store = useStore();
  const currentUserId = typeof user?.id === 'string' ? user.id.trim() : '';
  const state = useMemo(
    () => ({
      runtime,
      currentUserId,
      previous: new Map<string, AutoArchivePrSnapshot>(),
      pending: new Map<string, PendingArchive>(),
      inFlight: new Set<string>(),
      run: undefined as ((intent: PendingArchive) => void) | undefined,
    }),
    [runtime, currentUserId]
  );

  useEffect(() => {
    const retire = (intent: PendingArchive) => {
      clearTimeout(intent.timer);
      if (state.pending.get(intent.sessionId) === intent) state.pending.delete(intent.sessionId);
    };
    const applicable = (intent: PendingArchive) => {
      if (!state.runtime || store.get(activeWorkspaceRuntimeAtom) !== state.runtime) return false;
      if (store.get(userAtom)?.id?.trim() !== state.currentUserId) return false;
      const cache = store.get(sessionMetaCacheAtom);
      const session = cache[getSessionRoomId(intent.sessionId)];
      const pr = getAutoArchivePrSnapshot(session?.pullRequests);
      if (
        !session ||
        session.userId !== currentUserId ||
        pr?.url !== intent.pr.url ||
        pr.status !== intent.pr.status
      )
        return false;
      if (
        !store.get(
          intent.pr.status === 'merged' ? autoArchiveOnPrMergedAtom : autoArchiveOnPrClosedAtom
        )
      )
        return false;
      return true;
    };
    const reconcile = () => {
      for (const intent of state.pending.values()) {
        if (!applicable(intent)) retire(intent);
      }
    };
    state.run = (intent) => {
      if (state.pending.get(intent.sessionId) !== intent || !applicable(intent)) {
        retire(intent);
        return;
      }
      if (intent.timer || state.inFlight.has(intent.sessionId)) return;
      state.inFlight.add(intent.sessionId);
      void (async () => {
        try {
          await archiveSession(intent.sessionId, {
            accepted: intent.accepted,
            shouldContinue: (targets) => {
              if (!applicable(intent) || state.pending.get(intent.sessionId) !== intent)
                return false;
              const root = targets[0];
              const pr = getAutoArchivePrSnapshot(root?.pullRequests);
              if (
                root?.userId !== currentUserId ||
                pr?.url !== intent.pr.url ||
                pr.status !== intent.pr.status
              )
                return false;
              // An accepted root does not prove all descendants succeeded. A
              // restore/removal of any accepted target supersedes this intent.
              // Read the action's authoritative snapshot: Repo watch events
              // can coalesce archive/restore into the final unarchived state.
              return [...intent.accepted].every((id) =>
                targets.some((target) => target.id === id && target.isArchived)
              );
            },
          });
          retire(intent);
        } catch (error) {
          // Logging must not turn an observed background failure into a rejection.
          try {
            console.error('AutoArchivePrWatcher: failed to archive session', {
              sessionId: intent.sessionId,
              status: intent.pr.status,
              error,
            });
          } catch {}
        } finally {
          state.inFlight.delete(intent.sessionId);
          const next = state.pending.get(intent.sessionId);
          if (next) {
            if (!applicable(next)) {
              retire(next);
            } else if (next !== intent) {
              state.run?.(next);
            } else {
              intent.timer = setTimeout(() => {
                intent.timer = undefined;
                state.run?.(intent);
              }, intent.retryDelay);
              intent.retryDelay = Math.min(30_000, intent.retryDelay * 2);
            }
          }
        }
      })();
    };
    const unsubscribe = [
      sessionMetaCacheAtom,
      activeWorkspaceRuntimeAtom,
      userAtom,
      autoArchiveOnPrMergedAtom,
      autoArchiveOnPrClosedAtom,
    ].map((atom) => store.sub(atom, reconcile));
    return () => {
      for (const intent of state.pending.values()) retire(intent);
      state.previous.clear();
      for (const release of unsubscribe) release();
    };
  }, [archiveSession, currentUserId, runtime, state, store]);

  useEffect(() => {
    const seenSessionIds = new Set<string>();
    for (const session of [...archivedSessions, ...sessions]) {
      if (!currentUserId || session.userId !== currentUserId) continue;
      seenSessionIds.add(session.id);
      const current = getAutoArchivePrSnapshot(session.pullRequests);
      const decision = getAutoArchivePrDecision({
        previous: state.previous.get(session.id),
        current,
        archiveOnMerged: onPrMerged,
        archiveOnClosed: onPrClosed,
      });
      if (current) state.previous.set(session.id, current);
      else state.previous.delete(session.id);
      // A missing baseline cannot be a transition, including at startup. Archived
      // Sessions keep that baseline so restore does not create new work either.
      if (session.isArchived || !decision.shouldArchive || !current) continue;
      const prior = state.pending.get(session.id);
      if (prior) clearTimeout(prior.timer);
      const intent: PendingArchive = {
        sessionId: session.id,
        pr: current,
        accepted: new Set(),
        retryDelay: 1_000,
      };
      state.pending.set(session.id, intent);
      state.run?.(intent);
    }
    for (const sessionId of state.previous.keys()) {
      if (!seenSessionIds.has(sessionId)) state.previous.delete(sessionId);
    }
    for (const [sessionId, intent] of state.pending) {
      if (!seenSessionIds.has(sessionId)) {
        clearTimeout(intent.timer);
        state.pending.delete(sessionId);
      }
    }
  }, [sessions, archivedSessions, currentUserId, onPrMerged, onPrClosed, state]);

  return null;
}

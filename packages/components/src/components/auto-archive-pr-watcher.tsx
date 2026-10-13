import { WorkspaceWindowOwnerContext } from '@/lib/desktop-window';
import { useContext, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { SessionMeta } from '@lody/shared';
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

// Skip the first effect run so we never retro-archive on app open: a session whose PR
// was already merged days ago must not vanish into the archive at startup. Only archive
// when we actually observe the status flip during this app session.
// (Same shape as electron-session-completion-notifier's initializedRef + prev-status map.)
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
  const onPrMerged = useAtomValue(autoArchiveOnPrMergedAtom);
  const onPrClosed = useAtomValue(autoArchiveOnPrClosedAtom);
  const { requestArchiveSession } = useSessionActions();

  const currentUserId = typeof user?.id === 'string' ? user.id.trim() : '';
  const previousPrRef = useRef<Map<string, AutoArchivePrSnapshot>>(new Map());
  const initializedRef = useRef(false);
  const inFlightRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef(
    new Map<string, { snapshot: AutoArchivePrSnapshot; attempts: number; notBefore: number }>()
  );
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    previousPrRef.current.clear();
    const pending = pendingRef.current;
    pending.clear();
    initializedRef.current = false;
    inFlightRef.current.clear();
    const timer = setInterval(() => {
      if (pendingRef.current.size) setRetryTick((tick) => tick + 1);
    }, 5_000);
    return () => {
      clearInterval(timer);
      pending.clear();
    };
  }, [currentUserId]);

  useEffect(() => {
    const seenSessionIds = new Set<string>();

    const updateBaseline = (session: SessionMeta) => {
      if (!currentUserId || session.userId !== currentUserId) return;
      seenSessionIds.add(session.id);

      const current = getAutoArchivePrSnapshot(session.pullRequests);
      if (current) {
        previousPrRef.current.set(session.id, current);
      } else {
        previousPrRef.current.delete(session.id);
      }
    };

    // Archived sessions cannot be auto-archived again, but their PR state must
    // stay in the baseline so restoring a merged/closed PR session is not
    // misread as a fresh terminal transition.
    for (const session of archivedSessions) {
      updateBaseline(session);
    }

    for (const session of sessions) {
      if (!currentUserId || session.userId !== currentUserId) continue;
      seenSessionIds.add(session.id);

      const current = getAutoArchivePrSnapshot(session.pullRequests);
      const prev = previousPrRef.current.get(session.id);

      const decision = getAutoArchivePrDecision({
        previous: prev,
        current,
        archiveOnMerged: onPrMerged,
        archiveOnClosed: onPrClosed,
      });
      if (current) {
        previousPrRef.current.set(session.id, current);
      } else {
        previousPrRef.current.delete(session.id);
      }
      if (!initializedRef.current) continue;
      if (decision.shouldArchive && current) {
        pendingRef.current.set(session.id, { snapshot: current, attempts: 0, notBefore: 0 });
      }
      const pending = pendingRef.current.get(session.id);
      if (!pending) continue;
      if (
        !current ||
        pending.snapshot.url !== current.url ||
        pending.snapshot.status !== current.status ||
        (current.status === 'merged' ? !onPrMerged : !onPrClosed)
      ) {
        pendingRef.current.delete(session.id);
        continue;
      }
      if (inFlightRef.current.has(session.id) || Date.now() < pending.notBefore) continue;
      if (current.status !== 'merged' && current.status !== 'closed') continue;
      inFlightRef.current.add(session.id);
      void requestArchiveSession(session.id, {
        mode: 'wait',
        source: 'pr',
        pr: { url: current.url, status: current.status },
      })
        .then(() => {
          if (pendingRef.current.get(session.id) === pending) pendingRef.current.delete(session.id);
        })
        .catch((error: unknown) => {
          if (pendingRef.current.get(session.id) !== pending) return;
          pending.attempts += 1;
          const delay = Math.min(5_000 * 2 ** Math.min(pending.attempts - 1, 4), 60_000);
          pending.notBefore = Date.now() + delay;
          console.error('AutoArchivePrWatcher: failed to request archive', {
            sessionId: session.id,
            status: decision.status,
            error,
          });
        })
        .finally(() => {
          inFlightRef.current.delete(session.id);
        });
    }

    for (const sessionId of Array.from(previousPrRef.current.keys())) {
      if (!seenSessionIds.has(sessionId)) {
        previousPrRef.current.delete(sessionId);
        pendingRef.current.delete(sessionId);
      }
    }

    if (!initializedRef.current) {
      initializedRef.current = true;
    }
  }, [
    sessions,
    archivedSessions,
    currentUserId,
    onPrMerged,
    onPrClosed,
    requestArchiveSession,
    retryTick,
  ]);

  return null;
}

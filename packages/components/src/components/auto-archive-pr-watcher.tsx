import { WorkspaceWindowOwnerContext } from '@/lib/desktop-window';
import { useContext, useEffect, useRef } from 'react';
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
  const { archiveSession } = useSessionActions();

  const currentUserId = typeof user?.id === 'string' ? user.id.trim() : '';
  const previousPrRef = useRef<Map<string, AutoArchivePrSnapshot>>(new Map());
  const initializedRef = useRef(false);
  const inFlightRef = useRef<Set<string>>(new Set());

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
      if (!decision.shouldArchive || !decision.status) continue;
      if (inFlightRef.current.has(session.id)) continue;

      inFlightRef.current.add(session.id);
      void archiveSession(session.id)
        .catch((error: unknown) => {
          console.error('AutoArchivePrWatcher: failed to archive session', {
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
      }
    }

    if (!initializedRef.current) {
      initializedRef.current = true;
    }
  }, [sessions, archivedSessions, currentUserId, onPrMerged, onPrClosed, archiveSession]);

  return null;
}

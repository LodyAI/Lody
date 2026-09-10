import { WorkspaceWindowOwnerContext } from '@/lib/desktop-window';
import { useContext, useEffect, useRef } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  currentWorkspaceSlugAtom,
  electronSessionCompletionNotificationsEnabledAtom,
  userAtom,
} from '@/atoms';
import { useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';
import {
  isAppForeground,
  shouldNotifySessionCompletion,
} from '@/lib/session-completion-notification';
import type { SessionListEntry } from '@/lib/session-visibility';
import type { SessionLegacyMetaFields } from '@lody/shared';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';

type SessionStatusType = 'running' | 'initializing' | 'requestPermission' | 'idle';

const NOTIFICATION_DEBOUNCE_MS = 5_000;

function normalizeSessionStatusType(status: unknown): SessionStatusType {
  if (status == null || typeof status !== 'object') {
    return 'idle';
  }

  const type = (status as { type?: unknown }).type;
  if (type === 'idle') {
    return 'idle';
  }
  if (type === 'initializing') {
    return 'initializing';
  }
  if (type === 'requestPermission') {
    return 'requestPermission';
  }
  return 'running';
}

function isWorkingStatusType(statusType: SessionStatusType): boolean {
  return statusType !== 'idle';
}

function isNonEmptyString(value: string | undefined | null): value is string {
  return value != null && value !== '';
}

export function ElectronSessionCompletionNotifier() {
  const owner = useContext(WorkspaceWindowOwnerContext);
  const router = useRouter();
  const { t } = useTranslation();
  const { sessions } = useVisibleSessionMetas();
  const user = useAtomValue(userAtom);
  const currentUserId = typeof user?.id === 'string' ? user.id.trim() : '';
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const enabled = useAtomValue(electronSessionCompletionNotificationsEnabledAtom);
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const previousStatusBySessionRef = useRef<Map<string, SessionStatusType>>(new Map());
  const pendingCompletionTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const latestSessionsByIdRef = useRef<Map<string, SessionListEntry>>(new Map());
  const initializedRef = useRef(false);

  latestSessionsByIdRef.current = new Map(sessions.map((session) => [session.id, session]));

  useEffect(() => {
    if (!owner || !isElectron || typeof window === 'undefined') {
      initializedRef.current = false;
      previousStatusBySessionRef.current.clear();
      return undefined;
    }

    const showCompletionNotification = (session: SessionListEntry): void => {
      const sessionTitle = typeof session.title === 'string' ? session.title.trim() : '';
      const title = t('notifications.desktopCompletion.title');
      const body = sessionTitle
        ? t('notifications.desktopCompletion.bodyWithTitle', { title: sessionTitle })
        : t('notifications.desktopCompletion.body');
      void getIpcServices()?.notifications.showSessionCompletion({
        sessionId: session.id,
        workspaceSlug: workspaceSlug ?? undefined,
        title,
        body,
      });
    };

    const showPermissionRequestNotification = (session: SessionListEntry): void => {
      const sessionTitle = typeof session.title === 'string' ? session.title.trim() : '';
      const title = t('notifications.desktopPermissionRequest.title');
      const body = isNonEmptyString(sessionTitle)
        ? t('notifications.desktopPermissionRequest.bodyWithSession', { sessionTitle })
        : t('notifications.desktopPermissionRequest.body');
      void getIpcServices()?.notifications.showSessionCompletion({
        sessionId: session.id,
        workspaceSlug: workspaceSlug ?? undefined,
        title,
        body,
      });
    };

    const clearTimerForSession = (sessionId: string): void => {
      const timer = pendingCompletionTimersRef.current.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        pendingCompletionTimersRef.current.delete(sessionId);
      }
    };

    const activeSessionIds = new Set<string>();
    for (const session of sessions) {
      if (!currentUserId || session.userId !== currentUserId) {
        continue;
      }

      activeSessionIds.add(session.id);
      const currentStatusType = normalizeSessionStatusType(session.status);
      const previousStatusType = previousStatusBySessionRef.current.get(session.id);
      const legacy = session as SessionLegacyMetaFields;

      const shouldStartCompletionTimer =
        shouldNotifySessionCompletion({
          initialized: initializedRef.current,
          enabled,
          previousStatusType,
          currentStatusType,
          latestGoal: legacy.latestGoal,
        }) && !pendingCompletionTimersRef.current.has(session.id);

      if (shouldStartCompletionTimer) {
        const timer = setTimeout(() => {
          pendingCompletionTimersRef.current.delete(session.id);
          const latestSession = latestSessionsByIdRef.current.get(session.id);
          const latestStatusType = latestSession
            ? normalizeSessionStatusType(latestSession.status)
            : 'idle';
          if (latestStatusType !== 'idle') {
            return;
          }
          if (isAppForeground()) {
            return;
          }
          showCompletionNotification(latestSession ?? session);
        }, NOTIFICATION_DEBOUNCE_MS);
        pendingCompletionTimersRef.current.set(session.id, timer);
      }

      if (
        isWorkingStatusType(currentStatusType) &&
        pendingCompletionTimersRef.current.has(session.id)
      ) {
        clearTimerForSession(session.id);
      }

      if (
        initializedRef.current &&
        enabled &&
        previousStatusType !== undefined &&
        previousStatusType !== 'requestPermission' &&
        currentStatusType === 'requestPermission' &&
        !isAppForeground()
      ) {
        showPermissionRequestNotification(session);
      }

      previousStatusBySessionRef.current.set(session.id, currentStatusType);
    }

    for (const sessionId of Array.from(previousStatusBySessionRef.current.keys())) {
      if (!activeSessionIds.has(sessionId)) {
        previousStatusBySessionRef.current.delete(sessionId);
        clearTimerForSession(sessionId);
      }
    }

    if (!initializedRef.current) {
      initializedRef.current = true;
    }
    return undefined;
  }, [owner, currentUserId, enabled, isElectron, sessions, t, workspaceSlug]);

  useEffect(() => {
    if (!isElectron || typeof window === 'undefined') {
      return undefined;
    }
    const timers = pendingCompletionTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, [isElectron, owner]);

  useEffect(() => {
    if (!isElectron || typeof window === 'undefined') {
      return undefined;
    }
    return onIpcEvent('app.sessionCompletionClick', (payload) => {
      const sessionId = payload?.sessionId?.trim();
      if (!isNonEmptyString(sessionId)) {
        return;
      }

      const targetWorkspaceSlug =
        typeof payload.workspaceSlug === 'string' && payload.workspaceSlug.trim() !== ''
          ? payload.workspaceSlug.trim()
          : workspaceSlug;
      if (!isNonEmptyString(targetWorkspaceSlug)) {
        return;
      }

      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: {
          workspaceName: targetWorkspaceSlug,
          sessionId,
        },
      });
    });
  }, [isElectron, router, workspaceSlug]);

  return null;
}

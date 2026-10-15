import { useContext, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getMachineRoomId,
  machineSupportsProtocolCapability,
  type MachineMeta,
  type SessionLegacyMetaFields,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { WorkspaceWindowOwnerContext } from '@/lib/desktop-window';
import { getIpcServices } from '@/lib/electron-ipc-client';
import {
  isAppForeground,
  shouldNotifySessionCompletion,
} from '@/lib/session-completion-notification';
import type { SessionListEntry } from '@/lib/session-visibility';

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

/** Compatibility observer. Completion is only for pre-terminalNotifications peers.
 * Permission status observation remains for all peers until a typed request source
 * replaces it. Remove these paths independently when their last caller is retired.
 */
export function LegacyElectronSessionNotifier({
  sessions,
  machines,
  runtime,
  currentUserId,
  workspaceSlug,
  enabled,
}: {
  sessions: SessionListEntry[];
  machines: Record<string, MachineMeta>;
  runtime: WorkspaceRuntime | null;
  currentUserId: string;
  workspaceSlug: string | null;
  enabled: boolean;
}) {
  const owner = useContext(WorkspaceWindowOwnerContext);
  const { t } = useTranslation();
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const previousStatusBySessionRef = useRef<Map<string, SessionStatusType>>(new Map());
  const pendingCompletionTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const latestSessionsByIdRef = useRef<Map<string, SessionListEntry>>(new Map());
  const initializedRef = useRef(false);
  latestSessionsByIdRef.current = new Map(sessions.map((session) => [session.id, session]));
  const latestRef = useRef({ enabled, currentUserId, runtime, machines });
  latestRef.current = { enabled, currentUserId, runtime, machines };

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
          supportsTerminalNotifications: machineSupportsProtocolCapability(
            machines[getMachineRoomId(session.machineId)],
            'terminalNotifications'
          ),
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
          if (
            !latestRef.current.enabled ||
            latestRef.current.currentUserId !== currentUserId ||
            !latestSession ||
            latestSession.userId !== currentUserId ||
            latestRef.current.runtime !== runtime ||
            machineSupportsProtocolCapability(
              latestRef.current.machines[getMachineRoomId(latestSession.machineId)],
              'terminalNotifications'
            ) ||
            latestStatusType !== 'idle'
          ) {
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
  }, [owner, currentUserId, enabled, isElectron, sessions, t, workspaceSlug, machines, runtime]);

  useEffect(() => {
    if (!isElectron || typeof window === 'undefined') {
      return undefined;
    }
    const timers = pendingCompletionTimersRef.current;
    const previousStatuses = previousStatusBySessionRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      initializedRef.current = false;
      previousStatuses.clear();
    };
  }, [isElectron, owner, currentUserId, runtime, workspaceSlug]);

  return null;
}

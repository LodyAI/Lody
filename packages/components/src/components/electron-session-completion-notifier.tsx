import { formatNotification, resolveNotificationPresentation } from '@lody/shared/notifications';
import { LegacyElectronSessionNotifier } from './legacy-electron-session-notifier';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { machineMetaCacheAtom } from '@/atoms/doc-meta';
import { lodyPresenceSyncStateAtom } from '@/atoms/presence';
import { createTerminalNotificationConsumer } from '@/lib/terminal-notification-consumer';
import { getServerNow } from '@lody/shared';
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
import { isAppForeground } from '@/lib/session-completion-notification';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';

function isNonEmptyString(value: string | undefined | null): value is string {
  return value != null && value !== '';
}

export function ElectronSessionCompletionNotifier() {
  const owner = useContext(WorkspaceWindowOwnerContext);
  const router = useRouter();
  const { t } = useTranslation();
  const { sessions, allActiveSessions, isLoading } = useVisibleSessionMetas();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const machines = useAtomValue(machineMetaCacheAtom);
  const presenceSync = useAtomValue(lodyPresenceSyncStateAtom);
  const user = useAtomValue(userAtom);
  const currentUserId = typeof user?.id === 'string' ? user.id.trim() : '';
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const enabled = useAtomValue(electronSessionCompletionNotificationsEnabledAtom);
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const terminalConsumerRef = useRef<ReturnType<typeof createTerminalNotificationConsumer> | null>(
    null
  );
  const latestRef = useRef({
    allActiveSessions,
    enabled,
    currentUserId,
    workspaceSlug,
    runtime,
  });
  latestRef.current = {
    allActiveSessions,
    enabled,
    currentUserId,
    workspaceSlug,
    runtime,
  };

  useEffect(() => {
    if (
      !owner ||
      !isElectron ||
      !runtime ||
      !currentUserId ||
      isLoading ||
      presenceSync !== 'synced'
    )
      return undefined;
    const consumer = createTerminalNotificationConsumer({
      recipientId: currentUserId,
      now: getServerNow,
      read: (sessionId, signal) =>
        runtime.withSessionStore(sessionId, async (store) => {
          signal.throwIfAborted();
          await store.waitUntilSynced(signal);
          return store.getState().notification;
        }),
      show: async (sessionId, notification) => {
        const latest = latestRef.current;
        const session = latest.allActiveSessions.find((s) => s.id === sessionId && !s.isArchived);
        if (
          !latest.enabled ||
          latest.runtime !== runtime ||
          latest.currentUserId !== currentUserId ||
          !session
        )
          return;
        const route = `/${encodeURIComponent(latest.workspaceSlug ?? '')}/sessions/${encodeURIComponent(sessionId)}`;
        if (isAppForeground() && router.state.location.pathname === route) return;
        await getIpcServices()?.notifications.showSessionCompletion({
          sessionId,
          workspaceSlug: latest.workspaceSlug ?? undefined,
          ...formatNotification(
            notification.outcome,
            notification.presentation ?? resolveNotificationPresentation(session, []),
            (key) => t(key)
          ),
          allowWhileForeground: true,
        });
      },
      onError: () => console.debug('[notifications] Terminal notification attempt failed'),
    });
    terminalConsumerRef.current = consumer;
    // Establish a baseline before reacting to any later index change.
    void consumer.observe(latestRef.current.allActiveSessions);
    return () => {
      consumer.dispose();
      terminalConsumerRef.current = null;
    };
  }, [owner, isElectron, runtime, currentUserId, isLoading, presenceSync, router, t]);

  useEffect(() => {
    void terminalConsumerRef.current?.observe(allActiveSessions);
  }, [allActiveSessions]);

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

  return (
    <LegacyElectronSessionNotifier
      sessions={sessions}
      machines={machines}
      runtime={runtime}
      currentUserId={currentUserId}
      workspaceSlug={workspaceSlug ?? null}
      enabled={enabled}
    />
  );
}

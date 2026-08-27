import { useEffect, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { allActiveSessionsAtom } from '@/atoms/doc-meta';
import { iosLiveActivitiesEnabledAtom, userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import { isNativeIOSAppShell } from '@/lib/native-platform';
import { useStableNow } from '@/hooks/use-stable-now';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { usePlatformCapability } from '@lody/platform/react';
import {
  buildLodyConversationsLiveActivityId,
  buildLiveActivityConversationItems,
  countLiveActivityConversationCandidates,
  countLiveActivityConversationStatuses,
  findFreshSessionPresenceState,
  findLiveActivityPermissionAlertCandidate,
  LODY_CONVERSATIONS_LIVE_ACTIVITY_SCHEMA_VERSION,
  type LiveActivityConversationItem,
  type LiveActivityPermissionAlert,
  type LiveActivityStatusCounts,
  type SessionStatus,
} from '@lody/shared';

export type LodyLiveActivitySyncPayload = {
  activityId: string;
  workspaceId: string;
  workspaceName: string;
  totalCount: number;
  statusCounts: LiveActivityStatusCounts;
  items: LiveActivityConversationItem[];
  permissionAlert?: LiveActivityPermissionAlert;
};

export type LodyLiveActivitySyncResult = {
  activityId?: string;
  nativeActivityId?: string;
};

export type LodyLiveActivityPermissionActionsConfig = {
  authToken?: string;
  convexSiteUrl: string;
};

export type LodyLiveActivityBridge = {
  setupOneSignalLiveActivities?: () => Promise<void>;
  configurePermissionActions?: (payload: LodyLiveActivityPermissionActionsConfig) => Promise<void>;
  syncConversationSummary: (
    payload: LodyLiveActivitySyncPayload
  ) => Promise<LodyLiveActivitySyncResult>;
  endConversationSummary: (payload: { activityId: string }) => Promise<void>;
};

type LodyLiveActivityWindow = Window & {
  __LODY_LIVE_ACTIVITY__?: LodyLiveActivityBridge;
};

const LIVE_ACTIVITY_RECHECK_INTERVAL_MS = 60_000;
const LIVE_ACTIVITY_SYNC_DEBOUNCE_MS = 250;
function getLiveActivityBridge(): LodyLiveActivityBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as LodyLiveActivityWindow).__LODY_LIVE_ACTIVITY__;
  if (!bridge || typeof bridge !== 'object') return null;
  if (typeof bridge.syncConversationSummary !== 'function') return null;
  if (typeof bridge.endConversationSummary !== 'function') return null;
  return bridge;
}

function formatCompactUpdatedAt(value: number, nowMs: number, language: string): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  const elapsedMs = Math.max(0, nowMs - value);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const isChinese = language.startsWith('zh');

  if (elapsedMs < minute) return isChinese ? '刚刚' : 'now';
  if (elapsedMs < hour) {
    const minutes = Math.max(1, Math.floor(elapsedMs / minute));
    return isChinese ? `${minutes}分钟前` : `${minutes}m`;
  }
  if (elapsedMs < day) {
    const hours = Math.max(1, Math.floor(elapsedMs / hour));
    return isChinese ? `${hours}小时前` : `${hours}h`;
  }
  const days = Math.max(1, Math.floor(elapsedMs / day));
  return isChinese ? `${days}天前` : `${days}d`;
}

function normalizeLiveActivitySyncPayload(
  payload: LodyLiveActivitySyncPayload
): LodyLiveActivitySyncPayload {
  return {
    activityId: payload.activityId,
    workspaceId: payload.workspaceId,
    workspaceName: payload.workspaceName,
    totalCount: payload.totalCount,
    statusCounts: payload.statusCounts,
    items: payload.items,
  };
}

export function useLodyLiveActivity({ workspaceName }: { workspaceName: string }): void {
  const notificationsAvailable = usePlatformCapability('notifications');
  const sessions = useAtomValue(allActiveSessionsAtom);
  const presenceStates = useAtomValue(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue(lodyPresenceNowMsAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const user = useAtomValue(userAtom);
  const { workspaceId: currentWorkspaceId } = useResolvedWorkspaceScope();
  const { t, i18n } = useTranslation();
  const now = useStableNow(LIVE_ACTIVITY_RECHECK_INTERVAL_MS);
  const userId = user?.id ?? null;
  const liveActivitiesEnabled = useAtomValue(iosLiveActivitiesEnabledAtom);
  const shownPermissionAlertKeysRef = useRef<Set<string>>(new Set());

  const payload = useMemo<
    (LodyLiveActivitySyncPayload & { permissionAlertCandidateKey?: string }) | null
  >(() => {
    if (!notificationsAvailable) return null;
    if (!currentWorkspaceId || !userId) return null;
    const nowMs = now.getTime();
    const liveSessionStatuses = new Map<string, SessionStatus>();
    for (const session of sessions) {
      const status = findFreshSessionPresenceState(
        presenceStates,
        session.id,
        presenceNowMs
      )?.status;
      if (status) {
        liveSessionStatuses.set(session.id, status);
      }
    }
    const defaultTitle = t('sessions.newSession.title', 'New Task');
    const items = buildLiveActivityConversationItems({
      sessions,
      agentConfigs,
      currentUserId: userId,
      defaultTitle,
      statusLabels: {
        permission: t('sessions.status.requestPermission', 'Request Permission'),
        question: t('sessions.status.askUserQuestion', 'Question'),
        running: t('sessions.status.running', 'Running'),
        unread: t('sessions.status.completed', 'Completed'),
      },
      formatUpdatedAt: (updatedAt) => formatCompactUpdatedAt(updatedAt, nowMs, i18n.language),
      liveSessionStatuses,
    });
    const totalCount = countLiveActivityConversationCandidates({
      sessions,
      currentUserId: userId,
      liveSessionStatuses,
    });
    const statusCounts = countLiveActivityConversationStatuses({
      sessions,
      currentUserId: userId,
      liveSessionStatuses,
    });
    const permissionAlertCandidate = findLiveActivityPermissionAlertCandidate({
      sessions,
      currentUserId: userId,
      defaultTitle,
      liveSessionStatuses,
    });
    const nextPayload: LodyLiveActivitySyncPayload & { permissionAlertCandidateKey?: string } = {
      activityId: buildLodyConversationsLiveActivityId({
        workspaceId: currentWorkspaceId,
        userId,
        schemaVersion: LODY_CONVERSATIONS_LIVE_ACTIVITY_SCHEMA_VERSION,
      }),
      workspaceId: currentWorkspaceId,
      workspaceName,
      totalCount,
      statusCounts,
      items,
    };
    if (permissionAlertCandidate) {
      nextPayload.permissionAlert = {
        title: t('sessions.permissionRequired', 'Permission Required'),
        body: permissionAlertCandidate.sessionTitle,
      };
      nextPayload.permissionAlertCandidateKey = permissionAlertCandidate.key;
    }
    return nextPayload;
  }, [
    agentConfigs,
    currentWorkspaceId,
    i18n.language,
    now,
    notificationsAvailable,
    presenceNowMs,
    presenceStates,
    sessions,
    t,
    userId,
    workspaceName,
  ]);

  useEffect(() => {
    if (!notificationsAvailable) return undefined;
    if (!isNativeIOSAppShell()) return undefined;
    if (!liveActivitiesEnabled) return undefined;
    const bridge = getLiveActivityBridge();
    if (!bridge || !payload) return undefined;

    const handle = window.setTimeout(() => {
      const permissionAlertCandidateKey = payload.permissionAlertCandidateKey;
      const shouldShowPermissionAlert =
        payload.permissionAlert !== undefined &&
        permissionAlertCandidateKey !== undefined &&
        !shownPermissionAlertKeysRef.current.has(permissionAlertCandidateKey);
      if (shouldShowPermissionAlert) {
        shownPermissionAlertKeysRef.current.add(permissionAlertCandidateKey);
      }

      // Rejected alternative: continuing normal summary sync while permission is pending can
      // replace the just-triggered permission alert with the standard Live Activity UI.
      if (payload.permissionAlert !== undefined && !shouldShowPermissionAlert) {
        return;
      }

      const syncPayload = normalizeLiveActivitySyncPayload(payload);
      if (shouldShowPermissionAlert) {
        syncPayload.permissionAlert = payload.permissionAlert;
      }
      bridge.syncConversationSummary(syncPayload).catch((error: unknown) => {
        if (shouldShowPermissionAlert && permissionAlertCandidateKey) {
          shownPermissionAlertKeysRef.current.delete(permissionAlertCandidateKey);
        }
        console.error('Failed to sync Lody Live Activity', error);
      });
    }, LIVE_ACTIVITY_SYNC_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(handle);
    };
  }, [liveActivitiesEnabled, notificationsAvailable, payload]);

  useEffect(() => {
    if (!notificationsAvailable) return undefined;
    if (!isNativeIOSAppShell() || liveActivitiesEnabled || !payload?.activityId) return undefined;
    getLiveActivityBridge()
      ?.endConversationSummary({ activityId: payload.activityId })
      .catch((error: unknown) => {
        console.error('Failed to end disabled Lody Live Activity', error);
      });
    return undefined;
  }, [liveActivitiesEnabled, notificationsAvailable, payload?.activityId]);

  useEffect(() => {
    if (!notificationsAvailable) return undefined;
    if (!isNativeIOSAppShell() || !payload?.activityId) return undefined;
    const activityId = payload.activityId;
    return () => {
      getLiveActivityBridge()
        ?.endConversationSummary({ activityId })
        .catch((error: unknown) => {
          console.error('Failed to end Lody Live Activity', error);
        });
    };
  }, [notificationsAvailable, payload?.activityId]);
}

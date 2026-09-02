import { useEffect, useMemo, useRef, useState } from 'react';
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
  findLiveActivityPermissionAlertCandidate,
  isFreshLodyPresenceState,
  LODY_CONVERSATIONS_LIVE_ACTIVITY_SCHEMA_VERSION,
  type LiveActivityConversationItem,
  type LiveActivityPermissionAlert,
  type LiveActivityStatusCounts,
  type LodySessionPresenceState,
  type SessionMeta,
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

/**
 * Upper bound on how often the conversation summary is rebuilt from a changing
 * session list.
 *
 * `atoms/doc-meta` flushes metadata in batches per macrotask, so a cold start or
 * a reconnect catch-up republishes `allActiveSessionsAtom` many times per
 * second. Rebuilding the summary is three passes over every session plus item
 * sorting and relative-time formatting, and debouncing only the bridge call did
 * not help: the payload identity changed on every batch, so the debounce timer
 * was reset before it ever fired while the CPU still paid for every rebuild.
 * Throttling the *input* bounds that work instead.
 *
 * Pending permission requests are deliberately excluded — they are scanned from
 * the unthrottled session list and flush this window (see `flushSignal` below),
 * so nothing the user has to answer waits on it.
 */
export const LIVE_ACTIVITY_SUMMARY_THROTTLE_MS = 1_000;

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

/**
 * Leading-edge throttle. The mounted value is live, later values are emitted at
 * most once per `intervalMs`, and a changed `flushSignal` emits immediately.
 *
 * The trailing deadline is anchored to the last emit rather than to the last
 * change, so a burst cannot push it back the way a debounce would: an update
 * stream of any rate still emits on a fixed cadence, and the final value of a
 * burst always lands.
 */
function useThrottledSnapshot<T>(value: T, intervalMs: number, flushSignal: string): T {
  const [snapshot, setSnapshot] = useState<T>(value);
  const lastEmittedAtRef = useRef<number>(Date.now());
  const lastEmittedFlushSignalRef = useRef<string>(flushSignal);

  useEffect(() => {
    const flushRequested = flushSignal !== lastEmittedFlushSignalRef.current;
    if (!flushRequested && Object.is(value, snapshot)) return undefined;

    const emit = () => {
      lastEmittedAtRef.current = Date.now();
      lastEmittedFlushSignalRef.current = flushSignal;
      setSnapshot(() => value);
    };

    const waitMs = intervalMs - (Date.now() - lastEmittedAtRef.current);
    if (flushRequested || waitMs <= 0) {
      emit();
      return undefined;
    }

    const handle = window.setTimeout(emit, waitMs);
    return () => {
      window.clearTimeout(handle);
    };
  }, [flushSignal, intervalMs, snapshot, value]);

  return snapshot;
}

type LiveActivitySummaryInput = {
  sessions: readonly SessionMeta[];
  liveSessionStatuses: ReadonlyMap<string, SessionStatus>;
};

const EMPTY_LIVE_SESSION_STATUSES: ReadonlyMap<string, SessionStatus> = new Map();

const EMPTY_SUMMARY_INPUT: LiveActivitySummaryInput = {
  sessions: [],
  liveSessionStatuses: EMPTY_LIVE_SESSION_STATUSES,
};

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
  // The host shell cannot change for the lifetime of the document; the sync and
  // teardown effects below already rely on that.
  const nativeIOSAppShell = useMemo(() => isNativeIOSAppShell(), []);

  // Kept separate from the payload so the teardown paths below still know which
  // activity to end after the payload itself has been gated off.
  const activityId = useMemo(() => {
    if (!notificationsAvailable) return null;
    if (!currentWorkspaceId || !userId) return null;
    return buildLodyConversationsLiveActivityId({
      workspaceId: currentWorkspaceId,
      userId,
      schemaVersion: LODY_CONVERSATIONS_LIVE_ACTIVITY_SCHEMA_VERSION,
    });
  }, [currentWorkspaceId, notificationsAvailable, userId]);

  // A disabled Live Activity used to pay for the whole summary build and throw
  // it away in the sync effect. Gate the computation itself instead.
  const enabled = activityId !== null && nativeIOSAppShell && liveActivitiesEnabled;

  /**
   * One pass over the presence snapshot instead of one `findFreshSessionPresenceState`
   * scan per session — the latter is O(sessions × presence entries) and ran on
   * every metadata batch.
   */
  const liveSessionStatuses = useMemo<ReadonlyMap<string, SessionStatus>>(() => {
    if (!enabled) return EMPTY_LIVE_SESSION_STATUSES;
    const freshestBySession = new Map<string, LodySessionPresenceState>();
    for (const state of Object.values(presenceStates)) {
      if (state.kind !== 'session') continue;
      if (!isFreshLodyPresenceState(state, presenceNowMs)) continue;
      const current = freshestBySession.get(state.sessionId);
      if (!current || state.updatedAt > current.updatedAt) {
        freshestBySession.set(state.sessionId, state);
      }
    }
    const statuses = new Map<string, SessionStatus>();
    for (const [sessionId, state] of freshestBySession) {
      statuses.set(sessionId, state.status);
    }
    return statuses;
  }, [enabled, presenceNowMs, presenceStates]);

  // Resolve every label to a string up front and memoize on those strings rather
  // than on `t`: the payload identity drives the bridge debounce, so a `t` whose
  // identity changed per render would reset that timer forever — exactly the
  // starvation this change exists to remove.
  const defaultTitle = t('sessions.newSession.title', 'New Task');
  const permissionStatusLabel = t('sessions.status.requestPermission', 'Request Permission');
  const questionStatusLabel = t('sessions.status.askUserQuestion', 'Question');
  const runningStatusLabel = t('sessions.status.running', 'Running');
  const unreadStatusLabel = t('sessions.status.completed', 'Completed');
  const permissionAlertTitle = t('sessions.permissionRequired', 'Permission Required');
  const language = i18n.language;

  /**
   * Deliberately reads the *unthrottled* session list. A permission request the
   * user has to answer must never wait on the summary throttle window, and this
   * is a single filtering pass with no item building, sorting, or formatting.
   */
  const permissionAlertCandidate = useMemo(() => {
    if (!enabled) return null;
    return findLiveActivityPermissionAlertCandidate({
      sessions,
      currentUserId: userId,
      defaultTitle,
      liveSessionStatuses,
    });
  }, [defaultTitle, enabled, liveSessionStatuses, sessions, userId]);

  const summaryInput = useMemo<LiveActivitySummaryInput>(
    () => (enabled ? { sessions, liveSessionStatuses } : EMPTY_SUMMARY_INPUT),
    [enabled, liveSessionStatuses, sessions]
  );

  // A new permission candidate, a workspace switch, and re-enabling the feature
  // each bypass the throttle: those are the moments where a stale summary would
  // be visible rather than merely late.
  const flushSignal = `${enabled ? '1' : '0'}|${activityId ?? ''}|${permissionAlertCandidate?.key ?? ''}`;
  const throttledInput = useThrottledSnapshot(
    summaryInput,
    LIVE_ACTIVITY_SUMMARY_THROTTLE_MS,
    flushSignal
  );

  const payload = useMemo<
    (LodyLiveActivitySyncPayload & { permissionAlertCandidateKey?: string }) | null
  >(() => {
    if (!enabled || !activityId || !currentWorkspaceId || !userId) return null;
    const nowMs = now.getTime();
    const { sessions: throttledSessions, liveSessionStatuses: throttledStatuses } = throttledInput;
    const items = buildLiveActivityConversationItems({
      sessions: throttledSessions,
      agentConfigs,
      currentUserId: userId,
      defaultTitle,
      statusLabels: {
        permission: permissionStatusLabel,
        question: questionStatusLabel,
        running: runningStatusLabel,
        unread: unreadStatusLabel,
      },
      formatUpdatedAt: (updatedAt) => formatCompactUpdatedAt(updatedAt, nowMs, language),
      liveSessionStatuses: throttledStatuses,
    });
    const totalCount = countLiveActivityConversationCandidates({
      sessions: throttledSessions,
      currentUserId: userId,
      liveSessionStatuses: throttledStatuses,
    });
    const statusCounts = countLiveActivityConversationStatuses({
      sessions: throttledSessions,
      currentUserId: userId,
      liveSessionStatuses: throttledStatuses,
    });
    const nextPayload: LodyLiveActivitySyncPayload & { permissionAlertCandidateKey?: string } = {
      activityId,
      workspaceId: currentWorkspaceId,
      workspaceName,
      totalCount,
      statusCounts,
      items,
    };
    if (permissionAlertCandidate) {
      nextPayload.permissionAlert = {
        title: permissionAlertTitle,
        body: permissionAlertCandidate.sessionTitle,
      };
      nextPayload.permissionAlertCandidateKey = permissionAlertCandidate.key;
    }
    return nextPayload;
  }, [
    activityId,
    agentConfigs,
    currentWorkspaceId,
    defaultTitle,
    enabled,
    language,
    now,
    permissionAlertCandidate,
    permissionAlertTitle,
    permissionStatusLabel,
    questionStatusLabel,
    runningStatusLabel,
    throttledInput,
    unreadStatusLabel,
    userId,
    workspaceName,
  ]);

  useEffect(() => {
    if (!payload) return undefined;
    const bridge = getLiveActivityBridge();
    if (!bridge) return undefined;

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
  }, [payload]);

  useEffect(() => {
    if (!nativeIOSAppShell || liveActivitiesEnabled || !activityId) return undefined;
    getLiveActivityBridge()
      ?.endConversationSummary({ activityId })
      .catch((error: unknown) => {
        console.error('Failed to end disabled Lody Live Activity', error);
      });
    return undefined;
  }, [activityId, liveActivitiesEnabled, nativeIOSAppShell]);

  useEffect(() => {
    if (!nativeIOSAppShell || !activityId) return undefined;
    return () => {
      getLiveActivityBridge()
        ?.endConversationSummary({ activityId })
        .catch((error: unknown) => {
          console.error('Failed to end Lody Live Activity', error);
        });
    };
  }, [activityId, nativeIOSAppShell]);
}

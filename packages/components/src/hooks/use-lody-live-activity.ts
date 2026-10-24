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
  type AgentConfigMeta,
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
  /** Legacy native bridge input. Current producers always send silent summaries. */
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
  setupPushLiveActivities?: () => Promise<void>;
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

/** Coalesce the render that requests a throttle flush with its committed snapshot. */
const LIVE_ACTIVITY_SYNC_DEBOUNCE_MS = 250;

/**
 * Upper bound on how often the conversation summary is rebuilt from a changing
 * session list.
 *
 * `atoms/doc-meta` flushes metadata in batches per macrotask, so a cold start or
 * a reconnect catch-up republishes `allActiveSessionsAtom` and
 * `getAllAgentConfigAtom` many times per second. Rebuilding the summary is three
 * passes over every session plus item sorting and relative-time formatting, and
 * debouncing only the bridge call did not help: the payload identity changed on
 * every batch, so that timer was reset before it ever fired while the CPU still
 * paid for every rebuild. Throttling the *input* bounds that work instead.
 *
 * Every input the summary reads must go through here — a single one left outside
 * (agent configs were, at first) restores the starvation on its own.
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
    // Also what makes this effect a no-op in the steady state: it re-runs on the
    // commit that lands an emit, and without this it would schedule a timer to
    // re-emit a value the snapshot already holds.
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
  agentConfigs: readonly AgentConfigMeta[];
  liveSessionStatuses: ReadonlyMap<string, SessionStatus>;
};

const EMPTY_LIVE_SESSION_STATUSES: ReadonlyMap<string, SessionStatus> = new Map();

const EMPTY_SUMMARY_INPUT: LiveActivitySummaryInput = {
  sessions: [],
  agentConfigs: [],
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
  const nativeIOSAppShell = isNativeIOSAppShell();

  // The id and the two fields it is built from travel together, and the teardown
  // paths below still need them after the payload itself has been gated off.
  const activityTarget = useMemo(() => {
    if (!notificationsAvailable || !currentWorkspaceId || !userId) return null;
    return {
      activityId: buildLodyConversationsLiveActivityId({
        workspaceId: currentWorkspaceId,
        userId,
        schemaVersion: LODY_CONVERSATIONS_LIVE_ACTIVITY_SCHEMA_VERSION,
      }),
      workspaceId: currentWorkspaceId,
      userId,
    };
  }, [currentWorkspaceId, notificationsAvailable, userId]);

  // A disabled Live Activity used to pay for the whole summary build and throw it
  // away in the sync effect. Gate the computation itself instead. The two
  // conditions are not equivalent: the atom defaults to `true`, so without the
  // shell check every desktop build rebuilds the summary it can never show.
  const enabled = activityTarget !== null && nativeIOSAppShell && liveActivitiesEnabled;

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

  const defaultTitle = t('sessions.newSession.title', 'New Task');

  /**
   * Deliberately reads the *unthrottled* session list. A permission request the
   * user has to answer must never wait on the summary throttle window, and this
   * is a single filtering pass with no item building, sorting, or formatting.
   */
  const permissionAlertCandidate = useMemo(() => {
    if (!enabled) return null;
    return findLiveActivityPermissionAlertCandidate({
      sessions,
      currentUserId: activityTarget?.userId ?? null,
      defaultTitle,
      liveSessionStatuses,
    });
  }, [activityTarget?.userId, defaultTitle, enabled, liveSessionStatuses, sessions]);

  // Depend on the candidate's VALUE, not its identity. The scan above reruns on
  // every metadata batch and builds a fresh object each time, so leaking that
  // identity into the payload memo restored the debounce starvation for exactly
  // the case that matters most: a pending permission request during a sync burst.
  const permissionAlertKey = permissionAlertCandidate?.key ?? null;

  const summaryInput = useMemo<LiveActivitySummaryInput>(
    () => (enabled ? { sessions, agentConfigs, liveSessionStatuses } : EMPTY_SUMMARY_INPUT),
    [agentConfigs, enabled, liveSessionStatuses, sessions]
  );

  // A new permission candidate and a workspace switch each bypass the throttle:
  // those are the moments where a stale summary would be wrong on screen rather
  // than merely late — the previous workspace's rows, or a permission state next to a list
  // that does not contain the session asking for permission.
  const flushSignal = `${activityTarget?.activityId ?? ''}|${permissionAlertKey ?? ''}`;
  const throttledInput = useThrottledSnapshot(
    summaryInput,
    LIVE_ACTIVITY_SUMMARY_THROTTLE_MS,
    flushSignal
  );

  const payload = useMemo<LodyLiveActivitySyncPayload | null>(() => {
    if (!enabled || !activityTarget) return null;
    const { activityId, workspaceId, userId: currentUserId } = activityTarget;
    const nowMs = now.getTime();
    const {
      sessions: throttledSessions,
      agentConfigs: throttledAgentConfigs,
      liveSessionStatuses: throttledStatuses,
    } = throttledInput;
    const items = buildLiveActivityConversationItems({
      sessions: throttledSessions,
      agentConfigs: throttledAgentConfigs,
      currentUserId,
      defaultTitle,
      statusLabels: {
        permission: t('sessions.status.requestPermission', 'Request Permission'),
        question: t('sessions.status.askUserQuestion', 'Question'),
        running: t('sessions.status.running', 'Running'),
        unread: t('sessions.status.completed', 'Completed'),
      },
      formatUpdatedAt: (updatedAt) => formatCompactUpdatedAt(updatedAt, nowMs, i18n.language),
      liveSessionStatuses: throttledStatuses,
    });
    const totalCount = countLiveActivityConversationCandidates({
      sessions: throttledSessions,
      currentUserId,
      liveSessionStatuses: throttledStatuses,
    });
    const statusCounts = countLiveActivityConversationStatuses({
      sessions: throttledSessions,
      currentUserId,
      liveSessionStatuses: throttledStatuses,
    });
    return {
      activityId,
      workspaceId,
      workspaceName,
      totalCount,
      statusCounts,
      items,
    };
  }, [activityTarget, defaultTitle, enabled, i18n.language, now, t, throttledInput, workspaceName]);

  useEffect(() => {
    if (!payload) return undefined;
    const bridge = getLiveActivityBridge();
    if (!bridge) return undefined;

    const handle = window.setTimeout(() => {
      // Ordinary push owns alerts. Keep refreshing the summary while requests are pending.
      bridge.syncConversationSummary(payload).catch((error: unknown) => {
        console.error('Failed to sync Lody Live Activity', error);
      });
    }, LIVE_ACTIVITY_SYNC_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(handle);
    };
  }, [payload]);

  const activityId = activityTarget?.activityId;

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

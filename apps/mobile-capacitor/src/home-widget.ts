import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { atom } from 'jotai';
import { jotaiStore } from '@lody/components/lib';
import {
  getAuthSessionIntentGeneration,
  subscribeLocalAuthStateCleared,
  type LodyAuthClient,
} from '@lody/components/lib/auth';
import { userAtom } from '@lody/components/atoms/index';
import { activeWorkspaceRuntimeAtom, authTokenAtom } from '@lody/components/atoms/runtime';
import { allActiveSessionsAtom, docMetaCacheScopeAtom } from '@lody/components/atoms/doc-meta';
import { currentWorkspaceSlugAtom } from '@lody/components/atoms/workspace-context';
import { getAllAgentConfigAtom } from '@lody/components/atoms/agents';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@lody/components/atoms/presence';
import {
  buildLiveActivityConversationItems,
  isFreshLodyPresenceState,
  type LodySessionPresenceState,
  type SessionStatus,
} from '@lody/shared';
import {
  createHomeWidgetSync,
  homeWidgetBridgeOptions,
  resolveHomeWidgetIdentity,
  resolveHomeWidgetScope,
  toHomeWidgetConversations,
  type HomeWidgetSummary,
  type HomeWidgetBridgeOptions,
  type HomeWidgetPending,
} from './home-widget-core';

const homeWidget = registerPlugin<{
  syncSummary: (options: HomeWidgetBridgeOptions<HomeWidgetSummary>) => Promise<void>;
}>('LodyHomeWidget');

// Native sign-in replaces the page. Keep logout closed for this page lifetime:
// an old get-session response must never re-enable either widget publisher.
const logoutRequestedAtom = atom(false);

export const homeWidgetIdentityAtom = atom((get) => {
  if (get(logoutRequestedAtom)) return null;
  const user = get(userAtom);
  const runtime = get(activeWorkspaceRuntimeAtom);
  const slug = get(currentWorkspaceSlugAtom);
  const token = get(authTokenAtom);
  return resolveHomeWidgetIdentity({
    userId: user?.id ?? null,
    hasAuthToken: token !== null && token.length > 0,
    slug,
    runtime,
  });
});

export const homeWidgetScopeAtom = atom((get) => {
  const identity = get(homeWidgetIdentityAtom);
  if (!identity) return null;
  return resolveHomeWidgetScope({
    userId: identity.userId,
    hasAuthToken: true,
    slug: identity.workspaceName,
    runtime: get(activeWorkspaceRuntimeAtom),
    metadata: get(docMetaCacheScopeAtom),
  });
});

// Observe inputs without scanning all sessions on each metadata publication.
const inputAtom = atom((get) => {
  const scope = get(homeWidgetScopeAtom);
  if (!scope) return null;
  return {
    scope,
    sessions: get(allActiveSessionsAtom),
    agentConfigs: get(getAllAgentConfigAtom),
    presence: get(lodyPresenceStatesAtom),
    nowMs: get(lodyPresenceNowMsAtom),
  };
});

function readSummary(): HomeWidgetSummary | HomeWidgetPending | null {
  const identity = jotaiStore.get(homeWidgetIdentityAtom);
  if (!identity) return null;
  const input = jotaiStore.get(inputAtom);
  if (!input) return { pendingScope: identity };
  const { scope, sessions, agentConfigs, presence, nowMs } = input;
  const freshest = new Map<string, LodySessionPresenceState>();
  for (const state of Object.values(presence)) {
    if (state.kind !== 'session' || !isFreshLodyPresenceState(state, nowMs)) continue;
    const previous = freshest.get(state.sessionId);
    if (!previous || state.updatedAt > previous.updatedAt) freshest.set(state.sessionId, state);
  }
  const liveSessionStatuses = new Map<string, SessionStatus>();
  for (const [id, state] of freshest) liveSessionStatuses.set(id, state.status);
  // Unanswered questions and approvals remain pending even if their machine
  // goes offline. The durable attention signal takes priority over presence.
  for (const session of sessions) {
    if (Number.isFinite(session.awaitingUserSince) && (session.awaitingUserSince ?? 0) > 0) {
      liveSessionStatuses.set(session.id, { type: 'requestPermission' });
    }
  }
  const items = buildLiveActivityConversationItems({
    sessions,
    agentConfigs,
    currentUserId: scope.userId,
    liveSessionStatuses,
    defaultTitle: '',
    statusLabels: { permission: '', question: '', running: '', unread: '' },
    formatUpdatedAt: () => '',
    maxItems: 3,
  });
  const configsById = new Map(agentConfigs.map((config) => [config.id, config]));
  const agentNames = new Map<string, string>();
  const selectedIds = new Set(items.map((item) => item.id));
  for (const session of sessions) {
    if (!selectedIds.has(session.id) || !session.agentConfigId) continue;
    const name = configsById.get(session.agentConfigId)?.name;
    if (name !== undefined && name.length > 0) agentNames.set(session.id, name);
  }
  return {
    ...scope,
    items: toHomeWidgetConversations(items, agentNames),
  };
}

export function initHomeWidgetSync(authClient: LodyAuthClient): () => Promise<void> {
  if (Capacitor.getPlatform() !== 'ios') return async () => {};
  if (getAuthSessionIntentGeneration(authClient) > 0) {
    jotaiStore.set(logoutRequestedAtom, true);
  }
  const unsubscribeAuth = subscribeLocalAuthStateCleared(() => {
    jotaiStore.set(logoutRequestedAtom, true);
  });
  const sync = createHomeWidgetSync({
    read: readSummary,
    sync: (summary) => homeWidget.syncSummary(homeWidgetBridgeOptions(summary)),
    schedule: (callback) => {
      const timer = window.setTimeout(callback, 250);
      return () => window.clearTimeout(timer);
    },
    scheduleRetry: (callback, delayMs) => {
      const timer = window.setTimeout(callback, delayMs);
      return () => window.clearTimeout(timer);
    },
    now: Date.now,
    onError: (error) => console.error('Failed to update Home Screen widget', error),
  });
  // Scope loss, workspace transitions and logout bypass coalescing. Native calls
  // are serialized so an old write cannot restore data after a clear.
  const unsubscribeScope = jotaiStore.sub(homeWidgetScopeAtom, () =>
    sync.refresh({ immediate: true })
  );
  const unsubscribeIdentity = jotaiStore.sub(homeWidgetIdentityAtom, () =>
    sync.refresh({ immediate: true })
  );
  const unsubscribeInput = jotaiStore.sub(inputAtom, () => sync.refresh());
  sync.refresh({ immediate: true, force: true });
  const listener = App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) sync.refresh({ immediate: true, force: true });
  });
  void listener.catch((error: unknown) => console.error('Failed to watch widget app state', error));
  return async () => {
    unsubscribeAuth();
    unsubscribeScope();
    unsubscribeIdentity();
    unsubscribeInput();
    if (jotaiStore.get(homeWidgetScopeAtom) === null) {
      // stop() cancels queued work. Finish a scope-loss clear first, including
      // after a non-abortable write, so disposal cannot discard logout cleanup.
      sync.refresh({ immediate: true, force: true });
      await sync.whenSettled();
    }
    await Promise.all([
      sync.stop(),
      listener
        .then((handle) => handle.remove())
        .catch((error: unknown) => {
          console.error('Failed to remove widget app state listener', error);
        }),
    ]);
  };
}

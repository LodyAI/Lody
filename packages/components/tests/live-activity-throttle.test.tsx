// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider, type PrimitiveAtom } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigMeta,
  LodyPresenceStateMap,
  SessionId,
  SessionMeta,
} from '@lody/shared';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW_MS = Date.parse('2026-09-03T12:00:00.000Z');

const testAtoms = await vi.hoisted(async () => {
  const { atom } = await import('jotai');
  return {
    sessionsAtom: atom<SessionMeta[]>([]),
    presenceStatesAtom: atom<LodyPresenceStateMap>({}),
    presenceNowMsAtom: atom<number>(Date.parse('2026-09-03T12:00:00.000Z')),
    agentConfigsAtom: atom<AgentConfigMeta[]>([]),
    userAtom: atom<{ id: string } | null>({ id: 'user-1' }),
    liveActivitiesEnabledAtom: atom<boolean>(true),
    workspaceIdAtom: atom<string | null>('ws-1'),
    notificationsAvailableAtom: atom<boolean>(true),
  };
});

vi.mock('../src/atoms/doc-meta', () => ({ allActiveSessionsAtom: testAtoms.sessionsAtom }));
vi.mock('../src/atoms/presence', () => ({
  lodyPresenceStatesAtom: testAtoms.presenceStatesAtom,
  lodyPresenceNowMsAtom: testAtoms.presenceNowMsAtom,
}));
vi.mock('../src/atoms/agents', () => ({ getAllAgentConfigAtom: testAtoms.agentConfigsAtom }));
vi.mock('../src/atoms', () => ({
  userAtom: testAtoms.userAtom,
  iosLiveActivitiesEnabledAtom: testAtoms.liveActivitiesEnabledAtom,
}));
vi.mock('../src/hooks/use-resolved-workspace-scope', async () => {
  const { useAtomValue } = await import('jotai');
  return {
    useResolvedWorkspaceScope: () => ({
      workspaceId: useAtomValue(testAtoms.workspaceIdAtom),
      enabled: true,
    }),
  };
});
vi.mock('../src/lib/native-platform', () => ({ isNativeIOSAppShell: () => true }));
vi.mock('@lody/platform/react', async () => {
  const { useAtomValue } = await import('jotai');
  return { usePlatformCapability: () => useAtomValue(testAtoms.notificationsAvailableAtom) };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

import {
  LIVE_ACTIVITY_SUMMARY_THROTTLE_MS,
  useLodyLiveActivity,
  type LodyLiveActivitySyncPayload,
} from '../src/hooks/use-lody-live-activity';

/** Matches the private constant in the hook; the bridge call trails every emit by it. */
const SYNC_DEBOUNCE_MS = 250;
const ACTIVITY_ID_WS_1 = 'lody-conversations:v5:ws-1:user-1';

type LiveActivityBridgeWindow = Window & {
  __LODY_LIVE_ACTIVITY__?: {
    syncConversationSummary: (payload: LodyLiveActivitySyncPayload) => Promise<unknown>;
    endConversationSummary: (payload: { activityId: string }) => Promise<void>;
  };
};

function Probe({ workspaceName }: { workspaceName: string }) {
  useLodyLiveActivity({ workspaceName });
  return null;
}

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: id as SessionId,
    machineId: 'machine-1',
    userId: 'user-1',
    createdAt: new Date(NOW_MS - 60_000).toISOString(),
    cliType: 'builtin',
    agentType: 'codex',
    title: `Task ${id}`,
    lastMessageAt: NOW_MS - 10_000,
    status: { type: 'idle' },
    ...overrides,
  } as SessionMeta;
}

/** A fresh session presence entry — the only source of live status the hook reads. */
function presence(sessionId: string, status: SessionMeta['status'], updatedAt: number) {
  return {
    [`session:${sessionId}`]: {
      kind: 'session' as const,
      sessionId: sessionId as SessionId,
      machineId: 'machine-1',
      instanceId: `instance-${sessionId}`,
      status,
      updatedAt,
    },
  } as unknown as LodyPresenceStateMap;
}

describe('useLodyLiveActivity summary throttling', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let syncedPayloads: LodyLiveActivitySyncPayload[];
  let endedActivityIds: string[];

  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };

  const setSessions = async (sessions: SessionMeta[]) => {
    await act(async () => {
      store.set(testAtoms.sessionsAtom as PrimitiveAtom<SessionMeta[]>, sessions);
    });
  };

  const setPresence = async (states: LodyPresenceStateMap) => {
    await act(async () => {
      store.set(testAtoms.presenceStatesAtom as PrimitiveAtom<LodyPresenceStateMap>, states);
      store.set(testAtoms.presenceNowMsAtom as PrimitiveAtom<number>, Date.now());
    });
  };

  const mount = async (workspaceName = 'Workspace One') => {
    await act(async () => {
      root.render(
        <Provider store={store}>
          <Probe workspaceName={workspaceName} />
        </Provider>
      );
    });
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    syncedPayloads = [];
    endedActivityIds = [];
    (window as LiveActivityBridgeWindow).__LODY_LIVE_ACTIVITY__ = {
      syncConversationSummary: async (payload) => {
        syncedPayloads.push(structuredClone(payload));
        return {};
      },
      endConversationSummary: async ({ activityId }) => {
        endedActivityIds.push(activityId);
      },
    };
    store = createStore();
    store.set(testAtoms.sessionsAtom as PrimitiveAtom<SessionMeta[]>, [session('a')]);
    store.set(testAtoms.presenceStatesAtom as PrimitiveAtom<LodyPresenceStateMap>, {});
    store.set(testAtoms.presenceNowMsAtom as PrimitiveAtom<number>, NOW_MS);
    store.set(testAtoms.agentConfigsAtom as PrimitiveAtom<AgentConfigMeta[]>, []);
    store.set(testAtoms.userAtom as PrimitiveAtom<{ id: string } | null>, { id: 'user-1' });
    store.set(testAtoms.liveActivitiesEnabledAtom as PrimitiveAtom<boolean>, true);
    store.set(testAtoms.workspaceIdAtom as PrimitiveAtom<string | null>, 'ws-1');
    store.set(testAtoms.notificationsAvailableAtom as PrimitiveAtom<boolean>, true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (window as LiveActivityBridgeWindow).__LODY_LIVE_ACTIVITY__;
    vi.useRealTimers();
  });

  it('keeps delivering summaries during a metadata burst instead of starving on a reset debounce', async () => {
    await mount();
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads).toHaveLength(1);
    syncedPayloads.length = 0;

    // `atoms/doc-meta` republishes the session array once per flushed batch. A
    // burst faster than the bridge debounce used to reset that timer forever, so
    // nothing was ever delivered while every batch still paid for a full rebuild.
    const burstMs = 2 * LIVE_ACTIVITY_SUMMARY_THROTTLE_MS;
    const stepMs = 50;
    for (let step = 1; step <= burstMs / stepMs; step += 1) {
      await setSessions([session('a'), ...Array.from({ length: step }, (_, i) => session(`b${i}`))]);
      await advance(stepMs);
    }

    // One emit per throttle window, each trailed by the bridge debounce.
    expect(syncedPayloads.length).toBeGreaterThanOrEqual(1);
    expect(syncedPayloads.length).toBeLessThanOrEqual(burstMs / LIVE_ACTIVITY_SUMMARY_THROTTLE_MS);

    // Each delivery carries burst content, not the pre-burst snapshot.
    expect(syncedPayloads[0]?.totalCount).toBeGreaterThan(1);

    // The burst's final state still lands once it settles: the trailing throttle
    // emit, then the bridge debounce that follows it.
    await advance(LIVE_ACTIVITY_SUMMARY_THROTTLE_MS);
    await advance(SYNC_DEBOUNCE_MS);
    const latest = syncedPayloads.at(-1);
    expect(latest?.totalCount).toBe(1 + burstMs / stepMs);
    expect(latest?.activityId).toBe(ACTIVITY_ID_WS_1);
  });

  it('delivers a pending permission alert within the debounce rather than at the next throttle window', async () => {
    await mount();
    await advance(SYNC_DEBOUNCE_MS);
    syncedPayloads.length = 0;

    // Open the throttle window with an ordinary batch, then raise a permission
    // request while that window is still closed.
    await setSessions([session('a'), session('b')]);
    await advance(100);
    expect(syncedPayloads).toHaveLength(0);

    await setPresence(presence('b', { type: 'requestPermission' }, Date.now()));
    await advance(SYNC_DEBOUNCE_MS);

    expect(syncedPayloads).toHaveLength(1);
    const alertPayload = syncedPayloads[0];
    expect(alertPayload?.permissionAlert).toEqual({
      title: 'Permission Required',
      body: 'Task b',
    });
    // The flush also refreshes the summary, so the alert does not ship next to a
    // stale item list that omits the session asking for permission.
    expect(alertPayload?.items.map((item) => [item.id, item.status])).toContainEqual([
      'b',
      'permission',
    ]);
    expect(alertPayload?.statusCounts.permission).toBe(1);
  });

  it('does not re-alert or resume summary sync while the same permission request is pending', async () => {
    await mount();
    await advance(SYNC_DEBOUNCE_MS);
    await setPresence(presence('b', { type: 'requestPermission' }, Date.now()));
    await setSessions([session('a'), session('b')]);
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads.at(-1)?.permissionAlert).toBeDefined();
    syncedPayloads.length = 0;

    // Further batches must not replace the just-shown alert with a plain summary.
    for (let step = 0; step < 40; step += 1) {
      await setSessions([session('a'), session('b'), ...Array.from({ length: step }, (_, i) => session(`c${i}`))]);
      await advance(50);
    }
    expect(syncedPayloads).toHaveLength(0);

    // Once the request is answered, ordinary summaries resume.
    await setPresence(presence('b', { type: 'running' }, Date.now()));
    await advance(LIVE_ACTIVITY_SUMMARY_THROTTLE_MS);
    await advance(SYNC_DEBOUNCE_MS);
    const resumed = syncedPayloads.at(-1);
    expect(resumed?.permissionAlert).toBeUndefined();
    expect(resumed?.statusCounts.permission).toBe(0);
    expect(resumed?.statusCounts.running).toBe(1);
  });

  it('re-alerts when a new permission request arrives after the previous one resolved', async () => {
    await mount();
    await advance(SYNC_DEBOUNCE_MS);
    await setSessions([session('a'), session('b', { lastMessageAt: NOW_MS - 5_000 })]);
    await setPresence(presence('b', { type: 'requestPermission' }, Date.now()));
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads.at(-1)?.permissionAlert).toBeDefined();

    await setPresence({});
    await advance(LIVE_ACTIVITY_SUMMARY_THROTTLE_MS);
    await advance(SYNC_DEBOUNCE_MS);
    syncedPayloads.length = 0;

    // A later request on the same session is a distinct candidate key because its
    // last message moved on.
    await setSessions([session('a'), session('b', { lastMessageAt: NOW_MS - 1_000 })]);
    await setPresence(presence('b', { type: 'requestPermission' }, Date.now()));
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads.at(-1)?.permissionAlert).toEqual({
      title: 'Permission Required',
      body: 'Task b',
    });
  });

  it('sends nothing while Live Activities are disabled and ends the existing activity', async () => {
    await mount();
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads).toHaveLength(1);
    syncedPayloads.length = 0;

    await act(async () => {
      store.set(testAtoms.liveActivitiesEnabledAtom as PrimitiveAtom<boolean>, false);
    });
    expect(endedActivityIds).toEqual([ACTIVITY_ID_WS_1]);

    for (let step = 0; step < 20; step += 1) {
      await setSessions([session('a'), ...Array.from({ length: step }, (_, i) => session(`b${i}`))]);
      await advance(100);
    }
    await setPresence(presence('a', { type: 'requestPermission' }, Date.now()));
    await advance(LIVE_ACTIVITY_SUMMARY_THROTTLE_MS);
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads).toHaveLength(0);

    // Re-enabling resumes without waiting out a throttle window.
    await act(async () => {
      store.set(testAtoms.liveActivitiesEnabledAtom as PrimitiveAtom<boolean>, true);
    });
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads).toHaveLength(1);
    expect(syncedPayloads[0]?.totalCount).toBe(20);
  });

  it('ends the previous activity and syncs the new workspace on a workspace switch', async () => {
    await mount();
    await advance(SYNC_DEBOUNCE_MS);
    syncedPayloads.length = 0;

    // Switch inside a closed throttle window: the new workspace must not wait it out.
    await setSessions([session('a'), session('b')]);
    await advance(100);
    await act(async () => {
      store.set(testAtoms.workspaceIdAtom as PrimitiveAtom<string | null>, 'ws-2');
      store.set(testAtoms.sessionsAtom as PrimitiveAtom<SessionMeta[]>, [session('z')]);
    });
    await advance(SYNC_DEBOUNCE_MS);

    expect(endedActivityIds).toEqual([ACTIVITY_ID_WS_1]);
    expect(syncedPayloads).toHaveLength(1);
    expect(syncedPayloads[0]?.activityId).toBe('lody-conversations:v5:ws-2:user-1');
    expect(syncedPayloads[0]?.workspaceId).toBe('ws-2');
    expect(syncedPayloads[0]?.items.map((item) => item.id)).toEqual(['z']);
  });

  it('ends the activity on unmount', async () => {
    await mount();
    await advance(SYNC_DEBOUNCE_MS);
    expect(endedActivityIds).toEqual([]);

    await act(async () => {
      root.render(<Provider store={store} />);
    });
    expect(endedActivityIds).toEqual([ACTIVITY_ID_WS_1]);
  });
});

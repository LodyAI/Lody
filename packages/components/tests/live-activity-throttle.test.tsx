// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider, type PrimitiveAtom } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigMeta, LodyPresenceStateMap, SessionId, SessionMeta } from '@lody/shared';

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
    nativeIOSAppShell: { value: true },
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
vi.mock('../src/lib/native-platform', () => ({
  isNativeIOSAppShell: () => testAtoms.nativeIOSAppShell.value,
}));
vi.mock('@lody/platform/react', () => ({ usePlatformCapability: () => true }));
// Faithful to react-i18next: `t` and `i18n` hold a stable identity across renders
// and are replaced only when the language or namespace changes.
vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key);
  const i18n = { language: 'en' };
  return { useTranslation: () => ({ t, i18n }) };
});

import {
  LIVE_ACTIVITY_SUMMARY_THROTTLE_MS,
  useLodyLiveActivity,
  type LodyLiveActivitySyncPayload,
} from '../src/hooks/use-lody-live-activity';

/** Mirrors the hook's private constant; every bridge call trails an emit by it. */
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

  /**
   * One `atoms/doc-meta` flush: a republished session array plus a republished
   * agent-config array, the two inputs that stream in during a catch-up.
   */
  const metadataBatch = async (step: number, extra: SessionMeta[] = []) => {
    await act(async () => {
      store.set(testAtoms.sessionsAtom as PrimitiveAtom<SessionMeta[]>, [
        session('a'),
        ...extra,
        ...Array.from({ length: step }, (_, index) => session(`b${index}`)),
      ]);
      store.set(testAtoms.agentConfigsAtom as PrimitiveAtom<AgentConfigMeta[]>, [
        { id: `config-${step}`, name: `Config ${step}` } as AgentConfigMeta,
      ]);
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
    testAtoms.nativeIOSAppShell.value = true;
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

    // A burst faster than the bridge debounce used to reset that timer forever,
    // so nothing was ever delivered while every batch still paid for a rebuild.
    // Any summary input left outside the throttle reproduces this on its own.
    const burstMs = 2 * LIVE_ACTIVITY_SUMMARY_THROTTLE_MS;
    const stepMs = 50;
    for (let step = 1; step <= burstMs / stepMs; step += 1) {
      await metadataBatch(step);
      await advance(stepMs);
    }

    // One emit per throttle window, each trailed by the bridge debounce.
    expect(syncedPayloads.length).toBeGreaterThanOrEqual(1);
    expect(syncedPayloads.length).toBeLessThanOrEqual(burstMs / LIVE_ACTIVITY_SUMMARY_THROTTLE_MS);

    // The burst's final state still lands once it settles: the trailing throttle
    // emit, then the bridge debounce that follows it.
    await advance(LIVE_ACTIVITY_SUMMARY_THROTTLE_MS);
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads.at(-1)?.totalCount).toBe(1 + burstMs / stepMs);
  });

  it('delivers a permission alert raised in the middle of an ongoing metadata burst', async () => {
    await mount();
    await advance(SYNC_DEBOUNCE_MS);
    syncedPayloads.length = 0;

    const pending = [session('b')];
    for (let step = 1; step <= 6; step += 1) {
      await metadataBatch(step, pending);
      await advance(50);
    }

    // The request arrives while batches are still streaming in. Neither the
    // throttle window nor the batches that keep coming may swallow it.
    await setPresence(presence('b', { type: 'requestPermission' }, Date.now()));
    for (let step = 7; step <= 12; step += 1) {
      await metadataBatch(step, pending);
      await advance(50);
    }

    const alertPayload = syncedPayloads.find((payload) => payload.permissionAlert !== undefined);
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
    for (let step = 1; step <= 40; step += 1) {
      await metadataBatch(step, [session('b')]);
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

  it('sends nothing while Live Activities are disabled and ends the existing activity', async () => {
    await mount();
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads).toHaveLength(1);
    syncedPayloads.length = 0;

    await act(async () => {
      store.set(testAtoms.liveActivitiesEnabledAtom as PrimitiveAtom<boolean>, false);
    });
    expect(endedActivityIds).toEqual([ACTIVITY_ID_WS_1]);

    for (let step = 1; step <= 20; step += 1) {
      await metadataBatch(step);
      await advance(100);
    }
    await setPresence(presence('a', { type: 'requestPermission' }, Date.now()));
    await advance(LIVE_ACTIVITY_SUMMARY_THROTTLE_MS);
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads).toHaveLength(0);

    // Re-enabling resumes, carrying the state that accumulated while it was off.
    await act(async () => {
      store.set(testAtoms.liveActivitiesEnabledAtom as PrimitiveAtom<boolean>, true);
    });
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads).toHaveLength(1);
    expect(syncedPayloads[0]?.totalCount).toBe(21);
  });

  it('sends nothing on a host that is not a native iOS shell', async () => {
    testAtoms.nativeIOSAppShell.value = false;
    await mount();
    await advance(SYNC_DEBOUNCE_MS);

    for (let step = 1; step <= 10; step += 1) {
      await metadataBatch(step);
      await advance(100);
    }
    await setPresence(presence('a', { type: 'requestPermission' }, Date.now()));
    await advance(LIVE_ACTIVITY_SUMMARY_THROTTLE_MS);
    await advance(SYNC_DEBOUNCE_MS);
    expect(syncedPayloads).toEqual([]);
  });

  it('ends the previous activity and syncs the new workspace on a workspace switch', async () => {
    await mount();
    await advance(SYNC_DEBOUNCE_MS);
    syncedPayloads.length = 0;

    // Switch inside a closed throttle window: the new workspace must not wait it
    // out, and must never ship the previous workspace's rows.
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

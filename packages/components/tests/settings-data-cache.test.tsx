// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore, type Store } from 'jotai';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceId } from '@lody/shared';
import { PlatformContext } from '@lody/platform/react';
import type { PlatformProvider } from '@lody/platform';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  workspaceId: 'workspace-1',
  auth: {
    isAuthenticated: true,
    isLoading: false,
    authSessionId: 'session-1' as string | null,
    confirmedUnauthenticated: false,
  },
}));

vi.mock('../src/hooks/use-recoverable-convex-query', () => ({
  usePublicConvexQuery: () => undefined,
  useRecoverableConvexQuery: mocks.useQuery,
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => mocks.auth,
}));

vi.mock('../src/hooks/useOrganization', () => ({
  useOrganization: () => ({
    activeOrganization: { id: mocks.workspaceId },
    hasAdminPermission: true,
  }),
}));

import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import {
  SettingsDataCacheProvider,
  useSettingsDataCache,
  useSettingsUsageDay,
  type SettingsUsageDayData,
} from '../src/components/settings/settings-data-cache';
import { TEST_CLOUD_PLATFORM } from './test-platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIRST_DAY = Date.UTC(2026, 0, 1);
const SECOND_DAY = FIRST_DAY + DAY_MS;

function usageDay(
  dayStartMs = FIRST_DAY,
  tokens = 100,
  workspaceId = 'workspace-1'
): SettingsUsageDayData {
  return {
    workspaceId,
    dayStartMs,
    date: new Date(dayStartMs).toISOString().slice(0, 10),
    totals: {
      tokens,
      costUSD: 0,
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
    },
    byModel: [{ modelId: 'test-model', tokens, costUSD: 0 }],
    byUser: [],
    users: {},
  };
}

function Probe({ dayStartMs }: { dayStartMs: number | null }) {
  const { workspaceId } = useSettingsDataCache();
  const { day, loading } = useSettingsUsageDay(dayStartMs);
  return <output>{JSON.stringify({ workspaceId, day: day ?? null, loading })}</output>;
}

describe('settings usage day cache', () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: Store;
  let result: SettingsUsageDayData | undefined;

  const snapshot = () => JSON.parse(container.querySelector('output')!.textContent!);
  const usageQueryArgs = () =>
    mocks.useQuery.mock.calls
      .filter(([query]) => getFunctionName(query) === 'usage:getWorkspaceUsageDay')
      .at(-1)?.[1];

  async function advanceTime(ms: number) {
    await act(async () => vi.advanceTimersByTime(ms));
  }

  async function render(dayStartMs: number | null, platform = TEST_CLOUD_PLATFORM) {
    await act(async () => {
      root.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={store}>
            <SettingsDataCacheProvider>
              <Probe dayStartMs={dayStartMs} />
            </SettingsDataCacheProvider>
          </Provider>
        </PlatformContext.Provider>
      );
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(FIRST_DAY);
    localStorage.clear();
    result = undefined;
    mocks.workspaceId = 'workspace-1';
    mocks.auth = {
      isAuthenticated: true,
      isLoading: false,
      authSessionId: 'session-1',
      confirmedUnauthenticated: false,
    };
    mocks.useQuery.mockReset();
    mocks.useQuery.mockImplementation((query, args) =>
      args !== 'skip' && getFunctionName(query) === 'usage:getWorkspaceUsageDay'
        ? result
        : undefined
    );
    store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-1' as WorkspaceId);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('reuses each date for a full hour, then refreshes without dropping its snapshot', async () => {
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: true });
    result = usageDay();
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });

    result = undefined;
    await render(SECOND_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: true });
    result = usageDay(SECOND_DAY, 200);
    await render(SECOND_DAY);

    result = undefined;
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });
    result = usageDay(FIRST_DAY, 150);
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });
    expect(usageQueryArgs()).toBe('skip');

    result = undefined;
    await advanceTime(HOUR_MS - 1);
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });
    expect(usageQueryArgs()).toBe('skip');
    await advanceTime(1);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });
    expect(usageQueryArgs()).toEqual({ workspaceId: 'workspace-1', dayStartMs: FIRST_DAY });

    result = usageDay(FIRST_DAY, 150);
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(FIRST_DAY, 150), loading: false });
    expect(usageQueryArgs()).toBe('skip');

    result = undefined;
    await render(SECOND_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(SECOND_DAY, 200), loading: false });
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(FIRST_DAY, 150), loading: false });
  });

  it('persists zero-usage results across closing settings and recreating the app store', async () => {
    result = usageDay(FIRST_DAY, 0);
    await render(FIRST_DAY);
    result = undefined;
    await render(null);
    expect(snapshot()).toMatchObject({ day: null, loading: false });
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(FIRST_DAY, 0), loading: false });

    await act(async () => root.render(null));
    await advanceTime(20 * 60 * 1000);
    store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-1' as WorkspaceId);
    mocks.useQuery.mockClear();
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(FIRST_DAY, 0), loading: false });
    expect(
      mocks.useQuery.mock.calls
        .filter(([query]) => getFunctionName(query) === 'usage:getWorkspaceUsageDay')
        .every(([, args]) => args === 'skip')
    ).toBe(true);
  });

  it('keeps an expired persisted snapshot visible on reopen until its refresh finishes', async () => {
    result = usageDay();
    await render(FIRST_DAY);
    await act(async () => root.render(null));
    result = undefined;
    await advanceTime(2 * HOUR_MS);
    store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-1' as WorkspaceId);
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });
    expect(usageQueryArgs()).toEqual({ workspaceId: 'workspace-1', dayStartMs: FIRST_DAY });

    result = usageDay(FIRST_DAY, 175);
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: result, loading: false });
    expect(usageQueryArgs()).toBe('skip');
  });

  it('renews the hour even when a refresh returns the same data object', async () => {
    result = usageDay();
    await render(FIRST_DAY);
    await advanceTime(HOUR_MS);
    expect(snapshot()).toMatchObject({ day: result, loading: false });
    expect(usageQueryArgs()).toBe('skip');
    result = undefined;
    await advanceTime(HOUR_MS - 1);
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });
    expect(usageQueryArgs()).toBe('skip');
    await advanceTime(1);
    expect(usageQueryArgs()).toEqual({ workspaceId: 'workspace-1', dayStartMs: FIRST_DAY });
  });

  it('isolates workspace snapshots and skips queries when the workspace is cleared', async () => {
    result = usageDay();
    await render(FIRST_DAY);
    mocks.useQuery.mockClear();
    await act(async () => store.set(currentWorkspaceIdAtom, null));
    expect(snapshot()).toEqual({ workspaceId: null, day: null, loading: false });
    expect(mocks.useQuery.mock.calls.every(([, args]) => args === 'skip')).toBe(true);

    result = undefined;
    mocks.workspaceId = 'workspace-2';
    await act(async () => store.set(currentWorkspaceIdAtom, 'workspace-2' as WorkspaceId));
    expect(snapshot()).toEqual({ workspaceId: 'workspace-2', day: null, loading: true });
    result = usageDay(FIRST_DAY, 250, 'workspace-2');
    await render(FIRST_DAY);
    expect(snapshot().day).toEqual(result);

    result = undefined;
    mocks.workspaceId = 'workspace-1';
    await act(async () => store.set(currentWorkspaceIdAtom, 'workspace-1' as WorkspaceId));
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });
  });

  it('keeps data through auth recovery but discards it on logout or session change', async () => {
    result = usageDay();
    await render(FIRST_DAY);
    result = undefined;
    mocks.auth.isAuthenticated = false;
    mocks.auth.isLoading = true;
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });

    mocks.auth.authSessionId = null;
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: false });
    mocks.auth.authSessionId = 'session-1';
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });
    expect(usageQueryArgs()).toBe('skip');

    mocks.auth.confirmedUnauthenticated = true;
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: false });
    expect(localStorage.getItem('lody:usageDayDetails')).toBe('{}');
    mocks.auth.confirmedUnauthenticated = false;
    mocks.auth.isAuthenticated = true;
    mocks.auth.isLoading = false;
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: true });

    result = usageDay();
    await render(FIRST_DAY);
    result = undefined;
    mocks.auth.authSessionId = 'session-2';
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: true });
    mocks.auth.authSessionId = 'session-1';
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: true });
  });

  it('rejects responses for another date or workspace without poisoning the cache', async () => {
    result = usageDay();
    await render(FIRST_DAY);
    await render(SECOND_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: true });
    result = usageDay(SECOND_DAY, 300, 'workspace-2');
    await render(SECOND_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: true });
    result = undefined;
    await render(FIRST_DAY);
    expect(snapshot().day).toEqual(usageDay());
    await render(SECOND_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: true });
  });

  it('bounds retained dates and evicts the oldest snapshot', async () => {
    for (let index = 0; index < 129; index++) {
      result = usageDay(FIRST_DAY + index * DAY_MS, index);
      await render(result.dayStartMs);
    }
    result = undefined;
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: true });
    await render(SECOND_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(SECOND_DAY, 1), loading: false });
  });

  it('ignores malformed persisted entries', async () => {
    localStorage.setItem(
      'lody:usageDayDetails',
      JSON.stringify({
        current: {
          authSessionId: 'session-1',
          days: [{ fetchedAt: Date.now(), day: { workspaceId: 'workspace-1' } }],
        },
      })
    );
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: null, loading: true });
    result = usageDay();
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });
  });

  it('still caches in memory if local storage writes fail', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    result = usageDay();
    await render(FIRST_DAY);
    result = undefined;
    await render(null);
    await advanceTime(30 * 60 * 1000);
    await render(FIRST_DAY);
    expect(snapshot()).toMatchObject({ day: usageDay(), loading: false });
    expect(usageQueryArgs()).toBe('skip');
  });

  it('does not expose cached usage or query cloud APIs in local composition', async () => {
    result = usageDay();
    await render(FIRST_DAY);
    await act(async () => root.render(null));
    mocks.useQuery.mockClear();
    const localPlatform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      kind: 'local',
      capabilities: new Set(),
      cloudApi: null,
      sync: { mode: 'local' },
    };
    await render(FIRST_DAY, localPlatform);
    expect(snapshot()).toMatchObject({ day: null, loading: false });
    expect(mocks.useQuery).not.toHaveBeenCalled();
  });
});

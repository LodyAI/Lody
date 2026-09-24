// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const environment = vi.hoisted(() => ({
  warm: true,
  mode: 'local',
  workspace: { id: 'local:workspace', slug: 'local' } as { id: string; slug: string } | null,
}));
vi.mock('@/atoms', () => ({
  currentWorkspaceSlugAtom: atom<string | null>(null),
  currentWorkspaceIdAtom: atom<string | null>(null),
}));
vi.mock('@/atoms/runtime', () => ({ authTokenAtom: atom(null), runtimeAtom: atom(null) }));
vi.mock('@/atoms/doc-meta', () => ({
  clearDocMetaCacheAtom: atom(null, () => {}),
  docMetaSubscriptionAtom: atom(null),
}));
vi.mock('@/atoms/presence', () => ({
  clearLodyPresenceStatesAtom: atom(null, () => {}),
  setLodyPresenceNowMsAtom: atom(null, () => {}),
  setLodyPresenceStatesAtom: atom(null, () => {}),
  setLodyPresenceSyncStateAtom: atom(null, () => {}),
}));
vi.mock('@/atoms/local-probe', () => ({
  localAgentEnabledAtom: atom(false),
  localProbeAttemptedAtom: atom(false),
  localProbeEffectAtom: atom(null),
  localProbeResultAtom: atom(null),
}));
vi.mock('@/atoms/control-connection', () => ({
  lodyControlConnectionStateAtom: atom('idle'),
  runtimeInitializingAtom: atom(false),
  browserOnlineAtom: atom(true),
}));
vi.mock('@/lib', () => ({ API_BASE_URL: '' }));
vi.mock('@/lib/local-storage-cache', () => ({ getCachedWorkspaceId: () => null }));
vi.mock('@posthog/react', () => ({ usePostHog: () => null }));
vi.mock('@/lib/posthog-analytics', () => ({ capturePostHogEvent: () => {} }));
vi.mock('@/lib/clear-local-cache', () => ({ maybeClearLodyCacheOnBoot: async () => {} }));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => true }));
vi.mock('@/lib/native-platform', () => ({ isNativeAppShell: () => false }));
vi.mock('@/lib/desktop-window', () => ({ isWarmWindow: () => environment.warm }));
vi.mock('@lody/platform/react', () => ({
  usePlatform: () => ({ sync: { mode: environment.mode }, capabilities: new Set() }),
}));
vi.mock('@/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ isLoading: true }),
}));
vi.mock('@/providers/local-platform-provider', () => ({
  useImplicitLocalWorkspace: () => environment.workspace,
  getLocalWorkspaceSlug: (workspace: { slug: string }) => workspace.slug,
}));
vi.mock('@/providers/create-workspace-runtime', () => ({ createWorkspaceRuntime: vi.fn() }));

import { RuntimeProvider } from '../src/providers/runtime-provider';
import { createWorkspaceRuntime } from '../src/providers/create-workspace-runtime';
import { currentWorkspaceSlugAtom } from '../src/atoms';
import { runtimeAtom } from '../src/atoms/runtime';

function runtimeFixture() {
  return {
    workspaceId: 'local:workspace',
    workspaceSlug: 'local',
    disposed: false,
    metadata: new Map([['session', 'already prepared']]),
    setAuthToken: async () => {},
    async dispose() { this.disposed = true; },
  };
}

describe('RuntimeProvider warm workspace preparation', () => {
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let prepared: ReturnType<typeof runtimeFixture>;
  const render = () => act(async () => {
    root.render(<Provider store={store}><RuntimeProvider>{null}</RuntimeProvider></Provider>);
  });

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    environment.warm = true;
    environment.mode = 'local';
    environment.workspace = { id: 'local:workspace', slug: 'local' };
    store = createStore();
    root = createRoot(document.createElement('div'));
    prepared = runtimeFixture();
    vi.mocked(createWorkspaceRuntime).mockReset().mockResolvedValue(prepared as never);
  });
  afterEach(async () => { await act(async () => root.unmount()); });

  it('prepares before routing and retains the populated runtime when claimed', async () => {
    await render();
    expect(store.get(currentWorkspaceSlugAtom)).toBeNull();
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () => {
      environment.warm = false;
      store.set(currentWorkspaceSlugAtom, 'local');
    });
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.metadata.get('session')).toBe('already prepared');
    expect(prepared.disposed).toBe(false);
  });

  it('retains initialization already in flight when claimed early', async () => {
    let complete!: (runtime: never) => void;
    vi.mocked(createWorkspaceRuntime).mockReturnValue(new Promise(resolve => { complete = resolve; }));
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    await act(async () => {
      environment.warm = false;
      store.set(currentWorkspaceSlugAtom, 'local');
      complete(prepared as never);
    });
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
  });

  it('disposes the prepared runtime when the route changes scope', async () => {
    await render();
    const replacement = runtimeFixture();
    vi.mocked(createWorkspaceRuntime).mockResolvedValue(replacement as never);
    await act(async () => { store.set(currentWorkspaceSlugAtom, 'different'); });
    expect(prepared.disposed).toBe(true);
    expect(store.get(runtimeAtom)).toBe(replacement);
  });

  it.each(['ordinary', 'cloud', 'missing identity'])('does not guess a workspace for %s', async kind => {
    if (kind === 'ordinary') environment.warm = false;
    if (kind === 'cloud') environment.mode = 'cloud';
    if (kind === 'missing identity') environment.workspace = null;
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    expect(store.get(currentWorkspaceSlugAtom)).toBeNull();
  });

  it('waits for local identity and disposes when the spare unmounts', async () => {
    environment.workspace = null;
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    environment.workspace = { id: 'local:workspace', slug: 'local' };
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () => { root.render(null); });
    expect(prepared.disposed).toBe(true);
    expect(store.get(runtimeAtom)).toBeNull();
  });
});

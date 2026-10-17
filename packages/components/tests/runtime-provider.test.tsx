// @vitest-environment jsdom

import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStore as createPlatformStore,
  type MutableStore,
  type PlatformSessionState,
  type PlatformE2eeWorkspaces,
} from '@lody/platform';

const environment = vi.hoisted(() => ({
  warm: true,
  mode: 'local',
  e2eeWorkspaces: undefined as PlatformE2eeWorkspaces | undefined,
  cachedWorkspaceId: null as string | null,
  workspace: { id: 'local:workspace', slug: 'local' } as { id: string; slug: string } | null,
  session: undefined as unknown as MutableStore<PlatformSessionState>,
}));
vi.mock('@/atoms', () => ({
  userAtom: atom({ id: 'local:user' }),
  currentWorkspaceSlugAtom: atom<string | null>(null),
  currentWorkspaceIdAtom: atom<string | null>(null),
}));
vi.mock('@/atoms/runtime', () => ({
  authTokenAtom: atom(null),
  runtimeAtom: atom(null),
  workspaceRuntimeInitFailureAtom: atom(null),
  workspaceModeAdmissionRetryAtom: atom(0),
}));
vi.mock('@/atoms/doc-meta', () => ({
  sessionMetaCacheAtom: atom({}),
  docMetaCacheReadyAtom: atom(false),
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
vi.mock('@/lib/local-storage-cache', () => ({
  getCachedWorkspaceId: () => environment.cachedWorkspaceId,
}));
vi.mock('@posthog/react', () => ({ usePostHog: () => null }));
vi.mock('@/lib/posthog-analytics', () => ({ capturePostHogEvent: () => {} }));
vi.mock('@/lib/clear-local-cache', () => ({ maybeClearLodyCacheOnBoot: async () => {} }));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => true }));
vi.mock('@/lib/native-platform', () => ({ isNativeAppShell: () => false }));
vi.mock('@/lib/desktop-window', () => ({ isWarmWindow: () => environment.warm }));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: () => undefined,
  usePlatform: () => ({
    identity: { session: environment.session },
    sync: { mode: environment.mode },
    capabilities: new Set(),
    e2eeWorkspaces: environment.e2eeWorkspaces,
  }),
}));
vi.mock('@/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ isLoading: true }),
}));
vi.mock('@/providers/local-platform-provider', () => ({
  useImplicitLocalWorkspace: () => environment.workspace,
  getLocalWorkspaceSlug: (workspace: { slug: string }) => workspace.slug,
}));
vi.mock('../src/components/chat/session-pending-sends-host', () => ({
  SessionPendingSendsHost: () => null,
}));
vi.mock('@/providers/create-workspace-runtime', () => ({ createWorkspaceRuntime: vi.fn() }));

import { RuntimeProvider } from '../src/providers/runtime-provider';
import { createWorkspaceRuntime } from '../src/providers/create-workspace-runtime';
import { currentWorkspaceSlugAtom, currentWorkspaceIdAtom, userAtom } from '../src/atoms';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import {
  readWorkspaceModeProof,
  repairUnreadableE2eeCaches,
  retainWorkspaceModeProof,
  saveE2eeGenesisPin,
} from '../src/lib/e2ee-workspace-storage';
import {
  runtimeAtom,
  workspaceModeAdmissionRetryAtom,
  workspaceRuntimeInitFailureAtom,
} from '../src/atoms/runtime';
import {
  editSessionRunConfigDraftAtom,
  registerSessionRunConfigDraftLeaseAtom,
  sessionRunConfigDraftAccountAtom,
  sessionRunConfigDraftsAtom,
} from '../src/atoms/session-run-config-drafts';
import { signOutWithoutRedirect, type LodyAuthClient } from '../src/lib/auth';
import { useSessionRunConfigDraft } from '../src/hooks/use-session-run-config-draft';
import { createCloudE2eeWorkspaces } from '../src/providers/cloud-e2ee-workspaces';
import { createPendingSessionSends } from '../src/lib/session-pending-sends';
import {
  describeAuthenticatedWorkspace,
  WorkspaceModeAdmissionTimeoutError,
} from '../src/providers/workspace-mode-admission';

function editDraft(store: ReturnType<typeof createStore>, accountId = 'local:user') {
  const lease = store.set(registerSessionRunConfigDraftLeaseAtom, {
    accountId,
    workspaceId: 'local:workspace',
    sessionId: 'session-1',
    targetKey: 'codex',
  });
  store.set(editSessionRunConfigDraftAtom, {
    lease,
    edit: { type: 'config', configId: 'fast', value: false },
  });
  return lease;
}

function runtimeFixture() {
  return {
    workspaceId: 'local:workspace',
    workspaceSlug: 'local',
    disposed: false,
    metadata: new Map([['session', 'already prepared']]),
    setAuthToken: async () => {},
    async dispose() {
      this.disposed = true;
    },
  };
}

describe('RuntimeProvider warm workspace preparation', () => {
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let prepared: ReturnType<typeof runtimeFixture>;
  const render = () =>
    act(async () => {
      root.render(
        <Provider store={store}>
          <RuntimeProvider>{null}</RuntimeProvider>
        </Provider>
      );
    });

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    environment.warm = true;
    environment.mode = 'local';
    environment.e2eeWorkspaces = undefined;
    environment.cachedWorkspaceId = null;
    environment.session = createPlatformStore<PlatformSessionState>({
      status: 'authenticated',
      user: { id: 'local:user' },
    });
    localStorage.clear();
    environment.workspace = { id: 'local:workspace', slug: 'local' };
    store = createStore();
    root = createRoot(document.createElement('div'));
    prepared = runtimeFixture();
    vi.mocked(createWorkspaceRuntime)
      .mockReset()
      .mockResolvedValue(prepared as never);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
  });

  function ordinaryCloud() {
    environment.mode = 'cloud';
    environment.warm = false;
    environment.cachedWorkspaceId = 'local:workspace';
    environment.e2eeWorkspaces = createCloudE2eeWorkspaces({
      session: environment.session.get,
      remote: {
        describe: async ({ workspaceId }) => ({
          workspaceId,
          contentMode: 'plaintext',
          contentModeVersion: 1,
        }),
        create: async () => {
          throw new Error('unused');
        },
        history: async () => {
          throw new Error('unused');
        },
      },
      refreshWorkspaces: async () => {},
    });
    store.set(currentWorkspaceSlugAtom, 'local');
    store.set(currentWorkspaceIdAtom, 'local:workspace');
  }

  it('waits for the same account to authenticate, then preserves the runtime through auth refresh', async () => {
    ordinaryCloud();
    environment.session.set({ status: 'loading' });
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
    await act(async () =>
      environment.session.set({
        status: 'authenticated',
        user: { id: 'local:user' },
      })
    );
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
      contentMode: 'plaintext',
    });
    await act(async () => environment.session.set({ status: 'loading' }));
    await render();
    await act(async () =>
      environment.session.set({
        status: 'authenticated',
        user: { id: 'local:user' },
      })
    );
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
  });

  it('does not admit a cached account using another account authentication', async () => {
    ordinaryCloud();
    environment.session.set({ status: 'loading' });
    await render();
    await act(async () =>
      environment.session.set({
        status: 'authenticated',
        user: { id: 'other-user' },
      })
    );
    expect(store.get(runtimeAtom)).toBeNull();
    expect(store.get(workspaceContentModeAtom)).toBeNull();
    expect(store.get(workspaceRuntimeInitFailureAtom)?.workspaceSlug).toBe('local');
  });

  it('rechecks account and cancellation after the authentication wait resolves', async () => {
    ordinaryCloud();
    const abort = new AbortController();
    const input = {
      session: environment.session,
      workspaces: environment.e2eeWorkspaces!,
      accountId: 'local:user',
      workspaceId: 'local:workspace',
      signal: abort.signal,
    };
    const switched = describeAuthenticatedWorkspace(input);
    environment.session.set({ status: 'authenticated', user: { id: 'other-user' } });
    await expect(switched).rejects.toThrow('e2ee_account_changed');
    environment.session.set({ status: 'authenticated', user: { id: 'local:user' } });
    const cancelled = describeAuthenticatedWorkspace(input);
    abort.abort(new Error('replaced workspace'));
    await expect(cancelled).rejects.toThrow('replaced workspace');
  });

  it('ends first admission when authentication never becomes ready and accepts a later retry', async () => {
    ordinaryCloud();
    environment.session.set({ status: 'loading' });
    const input = {
      session: environment.session,
      workspaces: environment.e2eeWorkspaces!,
      accountId: 'local:user',
      workspaceId: 'local:workspace',
      signal: new AbortController().signal,
    };
    vi.useFakeTimers();
    try {
      const pending = describeAuthenticatedWorkspace(input, 100);
      const outcome = expect(pending).rejects.toBeInstanceOf(WorkspaceModeAdmissionTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await outcome;
      environment.session.set({ status: 'authenticated', user: { id: 'local:user' } });
      await expect(describeAuthenticatedWorkspace(input, 100)).resolves.toMatchObject({
        contentMode: 'plaintext',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a mode read that arrives after timeout and admits only the retried read', async () => {
    environment.mode = 'cloud';
    environment.warm = false;
    let resolveOld!: (value: Awaited<ReturnType<PlatformE2eeWorkspaces['describe']>>) => void;
    let reads = 0;
    environment.e2eeWorkspaces = {
      describe: ({ workspaceId }) => {
        reads++;
        return reads === 1
          ? new Promise((resolve) => {
              resolveOld = resolve;
            })
          : Promise.resolve({ workspaceId, contentMode: 'plaintext', contentModeVersion: 1 });
      },
      create: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
    };
    store.set(currentWorkspaceSlugAtom, 'local');
    store.set(currentWorkspaceIdAtom, 'local:workspace');
    vi.useFakeTimers();
    try {
      await render();
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(store.get(workspaceRuntimeInitFailureAtom)?.errorType).toBe(
        WorkspaceModeAdmissionTimeoutError.name
      );
      expect(store.get(runtimeAtom)).toBeNull();
      await act(async () => store.set(workspaceModeAdmissionRetryAtom, 1));
      expect(store.get(runtimeAtom)).toBe(prepared);
      await act(async () =>
        resolveOld({
          workspaceId: 'local:workspace',
          contentMode: 'e2ee',
          contentModeVersion: 1,
          genesisHash: '11'.repeat(32),
          cryptoOrgId: '11'.repeat(32),
          activation: 'control-only',
        })
      );
      expect(store.get(runtimeAtom)).toBe(prepared);
      expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
        contentMode: 'plaintext',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a bounded failure when only an unverified workspace ID cache exists', async () => {
    ordinaryCloud();
    environment.cachedWorkspaceId = 'local:workspace';
    store.set(currentWorkspaceIdAtom, null);
    vi.useFakeTimers();
    try {
      await render();
      expect(store.get(runtimeAtom)).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(store.get(workspaceRuntimeInitFailureAtom)?.errorType).toBe(
        WorkspaceModeAdmissionTimeoutError.name
      );
      expect(createWorkspaceRuntime).not.toHaveBeenCalled();
      await act(async () => store.set(currentWorkspaceIdAtom, 'local:workspace'));
      expect(store.get(runtimeAtom)).toBe(prepared);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries timed-out authentication after the same account becomes ready', async () => {
    ordinaryCloud();
    environment.session.set({ status: 'loading' });
    vi.useFakeTimers();
    try {
      await render();
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(store.get(workspaceRuntimeInitFailureAtom)?.errorType).toBe(
        WorkspaceModeAdmissionTimeoutError.name
      );
      await act(async () =>
        environment.session.set({ status: 'authenticated', user: { id: 'local:user' } })
      );
      expect(store.get(runtimeAtom)).toBe(prepared);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers an in-flight auth error even if the same account is ready before the error is received', async () => {
    ordinaryCloud();
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = environment.e2eeWorkspaces!;
    let first = true;
    const adapter = createCloudE2eeWorkspaces({
      session: environment.session.get,
      remote: {
        ...remote,
        describe: async ({ workspaceId }) => {
          if (first) {
            first = false;
            await response;
          }
          return { workspaceId, contentMode: 'plaintext', contentModeVersion: 1 };
        },
      },
      refreshWorkspaces: async () => {},
    });
    environment.e2eeWorkspaces = {
      ...adapter,
      describe: async (request) => {
        try {
          return await adapter.describe(request);
        } catch (error) {
          // Deliver the real adapter error only after auth has recovered.
          environment.session.set({ status: 'authenticated', user: { id: 'local:user' } });
          throw error;
        }
      },
    };
    await render();
    environment.session.set({ status: 'loading' });
    await act(async () => release());
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
  });

  it('cancels an old authentication wait when switching workspace and ignores its later readiness', async () => {
    ordinaryCloud();
    environment.session.set({ status: 'loading' });
    await render();
    retainWorkspaceModeProof(localStorage, 'local:user', 'next', {
      workspaceId: 'next',
      contentMode: 'plaintext',
      contentModeVersion: 1,
    });
    await act(async () => {
      store.set(currentWorkspaceSlugAtom, 'next');
      store.set(currentWorkspaceIdAtom, 'next');
    });
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () =>
      environment.session.set({
        status: 'authenticated',
        user: { id: 'local:user' },
      })
    );
    expect(store.get(workspaceContentModeAtom)?.workspaceId).toBe('next');
    expect(
      readWorkspaceModeProof(localStorage, 'local:user', 'local:workspace', 'local')
    ).toBeNull();
    expect(prepared.disposed).toBe(false);
  });

  it.each(['plaintext', 'legacy'] as const)(
    'opens verified %s admission when the offline cache is full',
    async (kind) => {
      ordinaryCloud();
      if (kind === 'legacy')
        environment.e2eeWorkspaces!.describe = async ({ workspaceId }) => ({
          workspaceId,
          admission: 'legacy-unclassified',
        });
      localStorage.setItem('unrelated-application-cache', 'x'.repeat(4_999_920));
      await render();
      expect(store.get(runtimeAtom)).toBe(prepared);
      expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
      expect(
        readWorkspaceModeProof(localStorage, 'local:user', 'local:workspace', 'local')
      ).toBeNull();
      expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject(
        kind === 'legacy' ? { admission: 'legacy-unclassified' } : { contentMode: 'plaintext' }
      );
    }
  );

  it.each([
    'server-id',
    'other-workspace',
    'other-account',
    'same-value',
    'session-storage',
  ] as const)('preserves the runtime and held attachment on %s changes', async (change) => {
    ordinaryCloud();
    retainWorkspaceModeProof(localStorage, 'local:user', 'local', {
      workspaceId: 'local:workspace',
      contentMode: 'plaintext',
      contentModeVersion: 1,
    });
    store.set(currentWorkspaceIdAtom, null);
    const writes: string[] = [];
    const held = createPendingSessionSends({
      prepare: async (_send, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Stopped', 'AbortError')),
            { once: true }
          );
        }),
      write: async (send) => {
        writes.push(send.id);
      },
      deliver: async () => {},
    });
    prepared.dispose = async function () {
      this.disposed = true;
      held.dispose();
    };
    await render();
    held.enqueue({
      id: 'held-turn',
      workspaceId: 'local:workspace',
      sessionId: 'session-1',
      entry: { id: 'held-turn', text: 'Unsent draft' },
      attachments: [{ id: 'attachment', ready: false }],
      delivery: { kind: 'dispatch' },
    } as never);
    await act(async () => {
      if (change === 'server-id') store.set(currentWorkspaceIdAtom, 'local:workspace');
      else {
        const key =
          change === 'other-workspace'
            ? 'lody-workspace-mode-proof:local%3Auser:other-workspace'
            : change === 'other-account'
              ? 'lody-workspace-mode-proof:other-account:local%3Aworkspace'
              : 'lody-workspace-mode-proof:local%3Auser:local%3Aworkspace';
        window.dispatchEvent(
          new StorageEvent('storage', {
            key,
            oldValue: change === 'same-value' ? '{}' : null,
            newValue: '{}',
            storageArea: change === 'session-storage' ? sessionStorage : localStorage,
          })
        );
      }
    });
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
    expect(held.has('held-turn')).toBe(true);
    expect(writes).toEqual([]);
  });

  it('still retires a plaintext runtime when its own encrypted evidence changes', async () => {
    ordinaryCloud();
    await render();
    saveE2eeGenesisPin(localStorage, 'local:user', 'local:workspace', '11'.repeat(32));
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'lody-e2ee-genesis-pin:local%3Auser:local%3Aworkspace',
          newValue: '11'.repeat(32),
          storageArea: localStorage,
        })
      )
    );
    expect(store.get(runtimeAtom)).toBeNull();
    expect(prepared.disposed).toBe(true);
    expect(store.get(workspaceRuntimeInitFailureAtom)?.workspaceSlug).toBe('local');
  });

  it('does not open any data plane while authoritative mode is pending, then exposes encrypted control access', async () => {
    environment.mode = 'cloud';
    environment.warm = false;
    let resolveMode!: (mode: Awaited<ReturnType<PlatformE2eeWorkspaces['describe']>>) => void;
    environment.e2eeWorkspaces = {
      describe: () =>
        new Promise((resolve) => {
          resolveMode = resolve;
        }),
      create: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
    };
    store.set(currentWorkspaceSlugAtom, 'encrypted');
    store.set(currentWorkspaceIdAtom, 'workspace-encrypted');
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    expect(store.get(workspaceContentModeAtom)).toBeNull();
    expect(createWorkspaceRuntime).not.toHaveBeenCalled();
    await act(async () =>
      resolveMode({
        workspaceId: 'workspace-encrypted',
        contentMode: 'e2ee',
        contentModeVersion: 1,
        genesisHash: '11'.repeat(32),
        cryptoOrgId: '11'.repeat(32),
        activation: 'control-only',
      })
    );
    expect(store.get(runtimeAtom)).toBeNull();
    expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({ contentMode: 'e2ee' });
    expect(createWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'unavailable'])(
    'refuses the plaintext runtime when mode is %s',
    async (failure) => {
      environment.mode = 'cloud';
      environment.warm = false;
      environment.e2eeWorkspaces = {
        describe: async () => {
          if (failure === 'unavailable') throw new Error('Offline');
          return {
            workspaceId: 'workspace-encrypted',
            contentMode: 'future',
            contentModeVersion: 2,
          } as never;
        },
        create: async () => {
          throw new Error('unused');
        },
        history: async () => {
          throw new Error('unused');
        },
      };
      store.set(currentWorkspaceSlugAtom, 'encrypted');
      store.set(currentWorkspaceIdAtom, 'workspace-encrypted');
      await render();
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        workspaceSlug: 'encrypted',
      });
      expect(createWorkspaceRuntime).not.toHaveBeenCalled();
    }
  );

  it.each(['plaintext', 'legacy'] as const)(
    'rejects a server %s downgrade of a locally pinned encrypted workspace',
    async (kind) => {
      environment.mode = 'cloud';
      environment.warm = false;
      saveE2eeGenesisPin(localStorage, 'local:user', 'workspace-encrypted', '11'.repeat(32));
      environment.e2eeWorkspaces = {
        describe: async () =>
          kind === 'plaintext'
            ? {
                workspaceId: 'workspace-encrypted',
                contentMode: 'plaintext',
                contentModeVersion: 1,
              }
            : { workspaceId: 'workspace-encrypted', admission: 'legacy-unclassified' },
        create: async () => {
          throw new Error('unused');
        },
        history: async () => {
          throw new Error('unused');
        },
      };
      store.set(currentWorkspaceSlugAtom, 'encrypted');
      store.set(currentWorkspaceIdAtom, 'workspace-encrypted');
      await render();
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(workspaceContentModeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        workspaceSlug: 'encrypted',
      });
      expect(createWorkspaceRuntime).not.toHaveBeenCalled();
    }
  );

  it('reopens an authenticated plaintext mode offline using only its matching account and slug proof', async () => {
    environment.mode = 'cloud';
    environment.warm = false;
    environment.cachedWorkspaceId = 'local:workspace';
    retainWorkspaceModeProof(localStorage, 'local:user', 'local', {
      workspaceId: 'local:workspace',
      contentMode: 'plaintext',
      contentModeVersion: 1,
    });
    environment.e2eeWorkspaces = {
      describe: async () => {
        throw new Error('Network offline');
      },
      create: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
    };
    store.set(currentWorkspaceSlugAtom, 'local');
    await render();
    expect(store.get(currentWorkspaceIdAtom)).toBeNull();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
      contentMode: 'plaintext',
    });
    expect(
      readWorkspaceModeProof(localStorage, 'other-user', 'local:workspace', 'local')
    ).toBeNull();
    expect(
      readWorkspaceModeProof(localStorage, 'local:user', 'local:workspace', 'other-slug')
    ).toBeNull();
    await act(async () => store.set(userAtom, { id: 'other-user' } as never));
    expect(store.get(runtimeAtom)).toBeNull();
    expect(prepared.disposed).toBe(true);
  });

  it('blocks an unreadable mode cache, then admits after local repair and an in-place retry', async () => {
    ordinaryCloud();
    localStorage.setItem('lody-workspace-mode-proof:local%3Auser:local%3Aworkspace', '{broken');
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
      workspaceSlug: 'local',
      errorType: 'E2eeLocalEvidenceCorruptError',
    });
    // The route's retry repairs only unreadable caches before bumping the retry atom.
    expect(repairUnreadableE2eeCaches(localStorage, 'local:user')).toBe(1);
    await act(async () => store.set(workspaceModeAdmissionRetryAtom, 1));
    expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
    expect(store.get(runtimeAtom)).toBe(prepared);
  });

  it('accepts an explicit server legacy admission without labelling the workspace plaintext', async () => {
    environment.mode = 'cloud';
    environment.warm = false;
    const admission = { workspaceId: 'local:workspace', admission: 'legacy-unclassified' as const };
    environment.e2eeWorkspaces = {
      describe: async () => admission,
      create: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
    };
    store.set(currentWorkspaceSlugAtom, 'local');
    store.set(currentWorkspaceIdAtom, 'local:workspace');
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(store.get(workspaceContentModeAtom)?.descriptor).toEqual(admission);
    expect(readWorkspaceModeProof(localStorage, 'local:user', 'local:workspace', 'local')).toEqual(
      admission
    );
  });

  it('reopens a previously authenticated legacy admission while offline without reclassifying it', async () => {
    environment.mode = 'cloud';
    environment.warm = false;
    environment.cachedWorkspaceId = 'local:workspace';
    const admission = { workspaceId: 'local:workspace', admission: 'legacy-unclassified' as const };
    retainWorkspaceModeProof(localStorage, 'local:user', 'local', admission);
    environment.e2eeWorkspaces = {
      describe: async () => {
        throw new Error('Offline');
      },
      create: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
    };
    store.set(currentWorkspaceSlugAtom, 'local');
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(store.get(workspaceContentModeAtom)?.descriptor).toEqual(admission);
  });

  it('lets another workspace initialize while an old mode read is unresolved and ignores its late result', async () => {
    environment.mode = 'cloud';
    environment.warm = false;
    let resolveOld!: (value: Awaited<ReturnType<PlatformE2eeWorkspaces['describe']>>) => void;
    environment.e2eeWorkspaces = {
      describe: async ({ workspaceId }) =>
        workspaceId === 'old'
          ? new Promise((resolve) => {
              resolveOld = resolve;
            })
          : { workspaceId, contentMode: 'plaintext', contentModeVersion: 1 },
      create: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
    };
    store.set(currentWorkspaceSlugAtom, 'old');
    store.set(currentWorkspaceIdAtom, 'old');
    await render();
    await act(async () => {
      store.set(currentWorkspaceSlugAtom, 'local');
      store.set(currentWorkspaceIdAtom, 'local:workspace');
    });
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () =>
      resolveOld({
        workspaceId: 'old',
        contentMode: 'e2ee',
        contentModeVersion: 1,
        genesisHash: '11'.repeat(32),
        cryptoOrgId: '11'.repeat(32),
        activation: 'control-only',
      })
    );
    expect(store.get(workspaceContentModeAtom)?.workspaceId).toBe('local:workspace');
    expect(store.get(runtimeAtom)).toBe(prepared);
  });

  it('prepares before routing and retains the populated runtime when claimed', async () => {
    await render();
    expect(store.get(currentWorkspaceSlugAtom)).toBeNull();
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () => {
      store.set(currentWorkspaceSlugAtom, 'local');
      store.set(currentWorkspaceIdAtom, 'local:workspace');
    });
    // Electron clears the warm marker only after navigation has completed.
    environment.warm = false;
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.metadata.get('session')).toBe('already prepared');
    expect(prepared.disposed).toBe(false);
  });

  it('records a rejected runtime creation for its workspace until the next attempt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createWorkspaceRuntime).mockRejectedValueOnce(
      new DOMException('The database connection is closing.', 'InvalidStateError')
    );
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    expect(store.get(workspaceRuntimeInitFailureAtom)).toEqual({
      workspaceSlug: 'local',
      errorType: 'InvalidStateError',
    });

    await act(async () => {
      environment.workspace = { id: 'local:workspace-2', slug: 'local' };
      root.render(
        <Provider store={store}>
          <RuntimeProvider>{null}</RuntimeProvider>
        </Provider>
      );
    });
    expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
    expect(store.get(runtimeAtom)).toBe(prepared);
  });

  it.each([false, true])(
    'opens another workspace after failed close and retries its owner, with an earlier failed return: %s',
    async (failedReturn) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      let blocked = true;
      let released = false;
      const privateFailure = new Error('synthetic private release payload');
      prepared.dispose = async () => {
        prepared.disposed = true;
        if (blocked) throw privateFailure;
        released = true;
      };
      const original = prepared;
      await render();
      const other = runtimeFixture();
      vi.mocked(createWorkspaceRuntime).mockResolvedValueOnce(other as never);
      environment.workspace = { id: 'local:other', slug: 'other' };
      await render();
      expect(store.get(runtimeAtom)).toBe(other);
      expect(released).toBe(false);
      expect(logged.mock.calls.flat()).not.toContain(privateFailure);
      if (failedReturn) {
        environment.workspace = { id: 'local:workspace', slug: 'local' };
        await render();
        expect(store.get(runtimeAtom)).toBeNull();
        expect(released).toBe(false);
        environment.workspace = { id: 'local:other', slug: 'other' };
        vi.mocked(createWorkspaceRuntime).mockResolvedValueOnce(other as never);
        await render();
        expect(store.get(runtimeAtom)).toBe(other);
      }
      const replacement = runtimeFixture();
      vi.mocked(createWorkspaceRuntime).mockImplementationOnce(async () => {
        expect(released).toBe(true);
        return replacement as never;
      });
      blocked = false;
      environment.workspace = { id: 'local:workspace', slug: 'local' };
      await render();
      expect(store.get(runtimeAtom)).toBe(replacement);
      expect(store.get(runtimeAtom)).not.toBe(original);
      expect(released).toBe(true);
      logged.mockRestore();
    }
  );

  it('establishes an editable real draft lease after StrictMode owner replay', async () => {
    let selection!: ReturnType<typeof useSessionRunConfigDraft>;
    function DraftProbe() {
      selection = useSessionRunConfigDraft(
        {
          accountId: 'local:user',
          workspaceId: 'local:workspace',
          sessionId: 'strict-session',
          targetKey: 'codex',
        },
        true
      );
      return null;
    }
    expect(store.get(sessionRunConfigDraftAccountAtom).accountId).toBeNull();
    const app = (
      <StrictMode>
        <Provider store={store}>
          <RuntimeProvider>
            <DraftProbe />
          </RuntimeProvider>
        </Provider>
      </StrictMode>
    );
    await act(async () => {
      root.render(app);
    });
    await act(async () => {
      selection.selectConfigOption('fast', false);
    });
    expect(selection.edits.configOptions.fast).toBe(false);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(1);
    await act(async () => {
      root.render(app);
    });
    expect(selection.edits.configOptions.fast).toBe(false);
    expect(selection.captureForSend({ configOptionValues: { fast: false } })).toBeTypeOf(
      'function'
    );
  });

  it('retains initialization already in flight when claimed early', async () => {
    let complete!: (runtime: never) => void;
    vi.mocked(createWorkspaceRuntime).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
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

  it('cancels a retired initialization and publishes only the latest account runtime', async () => {
    const late = Promise.withResolvers<never>();
    const replacement = runtimeFixture();
    vi.mocked(createWorkspaceRuntime)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValue(replacement as never);
    await render();
    const signal = vi.mocked(createWorkspaceRuntime).mock.calls[0]![0].signal!;
    await act(async () => {
      store.set(userAtom, { id: 'new-account' });
    });
    expect(signal.aborted).toBe(true);
    expect(store.get(runtimeAtom)).toBeNull();
    await act(async () => {
      late.resolve(prepared as never);
    });
    expect(prepared.disposed).toBe(true);
    expect(store.get(runtimeAtom)).toBe(replacement);
    expect(replacement.disposed).toBe(false);
  });

  it('disposes the prepared runtime when the route changes scope', async () => {
    await render();
    const lease = editDraft(store);
    const drafts = store.get(sessionRunConfigDraftsAtom);
    const replacement = runtimeFixture();
    vi.mocked(createWorkspaceRuntime).mockResolvedValue(replacement as never);
    await act(async () => {
      store.set(currentWorkspaceSlugAtom, 'different');
    });
    expect(prepared.disposed).toBe(true);
    expect(store.get(runtimeAtom)).toBe(replacement);
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(drafts);
    expect(lease.active).toBe(true);
  });

  it('retires draft ownership on account change and provider termination', async () => {
    await render();
    const lease = editDraft(store);
    const owner = store.get(sessionRunConfigDraftAccountAtom);
    await render();
    expect(store.get(sessionRunConfigDraftAccountAtom)).toBe(owner);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(1);

    await act(async () => {
      store.set(userAtom, { id: 'another-user' } as never);
    });
    expect(store.get(sessionRunConfigDraftAccountAtom).accountId).toBe('another-user');
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    expect(lease.active).toBe(false);
    store.set(editSessionRunConfigDraftAtom, {
      lease,
      edit: { type: 'config', configId: 'fast', value: true },
    });
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);

    const replacement = editDraft(store, 'another-user');
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(1);
    await act(async () => {
      root.render(null);
    });
    expect(store.get(sessionRunConfigDraftAccountAtom).accountId).toBeNull();
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    expect(replacement.active).toBe(false);
  });

  it('clears the owning store at logout intent before async sign-out settles', async () => {
    await render();
    const lease = editDraft(store);
    let finishSignOut!: () => void;
    const authClient = {
      signOut: () =>
        new Promise<void>((resolve) => {
          finishSignOut = resolve;
        }),
    } as unknown as LodyAuthClient;
    const signingOut = signOutWithoutRedirect(authClient);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    expect(store.get(sessionRunConfigDraftAccountAtom).accountId).toBeNull();
    expect(lease.active).toBe(false);
    store.set(editSessionRunConfigDraftAtom, {
      lease,
      edit: { type: 'config', configId: 'fast', value: true },
    });
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    await render();
    expect(store.get(sessionRunConfigDraftAccountAtom).accountId).toBeNull();
    finishSignOut();
    await signingOut;
  });

  it.each(['ordinary', 'cloud', 'missing identity'])(
    'does not guess a workspace for %s',
    async (kind) => {
      if (kind === 'ordinary') environment.warm = false;
      if (kind === 'cloud') environment.mode = 'cloud';
      if (kind === 'missing identity') environment.workspace = null;
      await render();
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(currentWorkspaceSlugAtom)).toBeNull();
    }
  );

  it('waits for local identity and disposes when the spare unmounts', async () => {
    environment.workspace = null;
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    environment.workspace = { id: 'local:workspace', slug: 'local' };
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () => {
      root.render(null);
    });
    expect(prepared.disposed).toBe(true);
    expect(store.get(runtimeAtom)).toBeNull();
  });
});

// @vitest-environment jsdom

import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformE2eeWorkspaces } from '@lody/platform';

const environment = vi.hoisted(() => ({
  warm: true,
  mode: 'local',
  e2eeWorkspaces: undefined as PlatformE2eeWorkspaces | undefined,
  cachedWorkspaceId: null as string | null,
  workspace: { id: 'local:workspace', slug: 'local' } as { id: string; slug: string } | null,
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
  retainWorkspaceModeProof,
  saveE2eeGenesisPin,
} from '../src/lib/e2ee-workspace-storage';
import { runtimeAtom, workspaceRuntimeInitFailureAtom } from '../src/atoms/runtime';
import {
  editSessionRunConfigDraftAtom,
  registerSessionRunConfigDraftLeaseAtom,
  sessionRunConfigDraftAccountAtom,
  sessionRunConfigDraftsAtom,
} from '../src/atoms/session-run-config-drafts';
import { signOutWithoutRedirect, type LodyAuthClient } from '../src/lib/auth';
import { useSessionRunConfigDraft } from '../src/hooks/use-session-run-config-draft';

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
      environment.warm = false;
      store.set(currentWorkspaceSlugAtom, 'local');
    });
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

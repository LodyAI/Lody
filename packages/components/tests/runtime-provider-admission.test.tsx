// @vitest-environment jsdom
import { unexpectedE2eeWorkspaceOperation } from './fixtures/e2ee-workspaces';
import {
  authorizePlaintextAttachmentUpload,
  installAttachmentWorkspaceAccess,
} from '../src/lib/attachment-workspace-access';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  encryptedLocalNamespace,
  retainEncryptedLocalIdentity,
  readEncryptedLocalIdentity,
} from '../src/lib/e2ee-local-data';
import { resumeEncryptedWorkspaceCleanup } from '../src/lib/e2ee-member-removal';
import { notifyE2eeLedgerChanged } from '../src/providers/e2ee-runtime-notifications';

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { atom, createStore, Provider } from 'jotai';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { ConvexError } from 'convex/values';
import {
  createStore as createPlatformStore,
  type MutableStore,
  type PlatformSessionState,
  type PlatformE2eeWorkspaces,
  type E2eeRefreshOptions,
  type E2eeWorkspaceRuntime,
  type WorkspacesState,
} from '@lody/platform';

const environment = vi.hoisted(() => ({
  warm: true,
  electron: true,
  mode: 'local',
  e2eeWorkspaces: undefined as PlatformE2eeWorkspaces | undefined,
  cachedWorkspaceId: null as string | null,
  workspace: { id: 'local:workspace', slug: 'local' } as { id: string; slug: string } | null,
  session: undefined as unknown as MutableStore<PlatformSessionState>,
  workspaces: undefined as unknown as MutableStore<WorkspacesState>,
  transportFailure: undefined as Error | undefined,
}));
// Only the remote I/O is replaced below. The login regression mounts the real
// provider, runtime, token provider and IndexedDB-backed Repo.
const IdleRoomTransport = vi.hoisted(
  () =>
    class {
      start() {}
      async stop() {}
      getSyncState() {
        return 'idle' as const;
      }
      subscribeSyncState() {
        return () => {};
      }
      subscribeDisplaySyncState() {
        return () => {};
      }
      needsReconnect() {
        return false;
      }
      shouldRestartOnExternalWake() {
        return false;
      }
      refreshRoutes() {}
      detachLocal() {}
    }
);
vi.mock('../src/providers/workspace-presence-transport', () => ({
  WorkspacePresenceTransport: IdleRoomTransport,
}));
vi.mock('../src/providers/workspace-machine-monitor-transport', () => ({
  WorkspaceMachineMonitorTransport: IdleRoomTransport,
}));
vi.mock('../src/providers/workspace-prompt-suggestions', () => ({
  WorkspacePromptSuggestions: IdleRoomTransport,
}));
vi.mock('@lody/loro-streams-rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lody/loro-streams-rpc')>()),
  LoroStreamsRpcResponseDispatcher: class {
    async start() {}
    async stop() {}
  },
}));
vi.mock('../src/providers/workspace-streams-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/workspace-streams-transport')>()),
  createWorkspaceStreamsTransport: () => {
    if (environment.transportFailure) throw environment.transportFailure;
    let connected = false;
    const join = () => ({
      status: 'joined' as const,
      firstSyncedWithRemote: Promise.resolve(),
      onStatusChange: () => () => {},
      unsubscribe() {},
    });
    return {
      async connect() {
        connected = true;
      },
      async close() {
        connected = false;
      },
      isConnected: () => connected,
      getStatus: () => (connected ? ('connected' as const) : ('disconnected' as const)),
      onStatusChange: () => () => {},
      syncMeta: async () => ({ ok: true }),
      joinMetaRoom: join,
      syncDoc: async () => ({ ok: true }),
      joinDocRoom: join,
    };
  },
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
vi.mock('@/lib/posthog-context', () => ({ usePostHog: () => null }));
vi.mock('@/lib/posthog-analytics', () => ({ capturePostHogEvent: () => {} }));
vi.mock('@/lib/clear-local-cache', () => ({ maybeClearLodyCacheOnBoot: async () => {} }));
vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => environment.electron }));
vi.mock('@/lib/native-platform', () => ({ isNativeAppShell: () => false }));
vi.mock('@/lib/desktop-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/desktop-window')>()),
  isWarmWindow: () => environment.warm,
  desktopWindowId: () => 'test-window',
}));
vi.mock('@lody/platform/react', () => ({
  usePlatformSession: () =>
    React.useSyncExternalStore(environment.session.subscribe, environment.session.get),
  useCloudQuery: () => undefined,
  usePlatform: () => ({
    identity: { session: environment.session },
    sync: { mode: environment.mode },
    capabilities: new Set(),
    e2eeWorkspaces: environment.e2eeWorkspaces,
    workspaces: { state: environment.workspaces },
  }),
}));
vi.mock('@/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ isLoading: true }),
}));
vi.mock('@/providers/local-platform-provider', () => ({
  useImplicitLocalWorkspace: () => environment.workspace,
  getLocalWorkspaceSlug: (workspace: { slug: string }) => workspace.slug,
}));
// Keep visual recovery diagnostics out of this router/provider boundary test.
vi.mock('../src/components/blocking-wait-placeholder', () => ({
  BlockingWaitPlaceholder: () => <div>workspace waiting</div>,
}));
vi.mock('../src/components/chat/session-pending-sends-host', () => ({
  SessionPendingSendsHost: () => null,
}));
vi.mock('@/providers/create-workspace-runtime', () => ({ createWorkspaceRuntime: vi.fn() }));

import { RuntimeProvider } from '../src/providers/runtime-provider';
import { WorkspaceAdmissionGate } from '../src/components/workspace-admission-gate';
import { createWorkspaceRuntime } from '../src/providers/create-workspace-runtime';
import { currentWorkspaceSlugAtom, currentWorkspaceIdAtom, userAtom } from '../src/atoms';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import {
  readWorkspaceModeEvidence,
  readWorkspaceModeProof,
  repairUnreadableE2eeCaches,
  retainWorkspaceModeProof,
  saveE2eeGenesisPin,
  savePendingE2eeWorkspace,
} from '../src/lib/e2ee-workspace-storage';
import {
  authTokenAtom,
  runtimeAtom,
  workspaceModeAdmissionRetryAtom,
  workspaceRuntimeInitFailureAtom,
} from '../src/atoms/runtime';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import {
  lodyControlConnectionStateAtom,
  runtimeInitializingAtom,
} from '../src/atoms/control-connection';
import * as clientLog from '../src/lib/client-log';
import {
  editSessionRunConfigDraftAtom,
  registerSessionRunConfigDraftLeaseAtom,
  sessionRunConfigDraftAccountAtom,
  sessionRunConfigDraftsAtom,
} from '../src/atoms/session-run-config-drafts';
import { signOutWithoutRedirect, type LodyAuthClient } from '../src/lib/auth';

import { createCloudE2eeWorkspaces } from '../src/providers/cloud-e2ee-workspaces';
import { createPendingSessionSends } from '../src/lib/session-pending-sends';
import {
  HOST_IDENTITY_STALL_MS,
  WORKSPACE_MODE_ADMISSION_TIMEOUT_MS,
  WorkspaceModeAdmissionTimeoutError,
} from '../src/providers/workspace-mode-admission';
import { editDraft, runtimeFixture } from './runtime-provider-test-helpers';

describe('RuntimeProvider warm workspace preparation', () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ReturnType<typeof createStore>;
  let prepared: ReturnType<typeof runtimeFixture>;
  let actualRuntime: WorkspaceRuntime | undefined;
  let realRuntimeSelected = false;
  let actualRuntimeFactory: typeof import('../src/providers/create-workspace-runtime');
  // Cold module transformation is setup, not part of login admission's deadline.
  beforeAll(async () => {
    actualRuntimeFactory = await vi.importActual<
      typeof import('../src/providers/create-workspace-runtime')
    >('../src/providers/create-workspace-runtime');
  }, 0);
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
    vi.stubGlobal('localStorage', window.localStorage);
    vi.stubGlobal('sessionStorage', window.sessionStorage);
    environment.warm = true;
    environment.electron = true;
    environment.transportFailure = undefined;
    actualRuntime = undefined;
    realRuntimeSelected = false;
    environment.mode = 'local';
    environment.e2eeWorkspaces = undefined;
    environment.cachedWorkspaceId = null;
    environment.session = createPlatformStore<PlatformSessionState>({
      status: 'authenticated',
      user: { id: 'local:user' },
    });
    environment.workspaces = createPlatformStore<WorkspacesState>({ status: 'loading' });
    localStorage.clear();
    environment.workspace = { id: 'local:workspace', slug: 'local' };
    store = createStore();
    container = document.createElement('div');
    root = createRoot(container);
    prepared = runtimeFixture();
    vi.mocked(createWorkspaceRuntime)
      .mockReset()
      .mockResolvedValue(prepared as never);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    if (realRuntimeSelected) {
      await actualRuntime?.dispose();
      vi.unstubAllEnvs();
    }
    vi.unstubAllGlobals();
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
        deleteWorkspace: unexpectedE2eeWorkspaceOperation,
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

  /** The server listing marks the workspace encrypted. Display metadata cannot
   * prove plaintext, but it is enough to demand authoritative admission. */
  function listEncrypted(id = 'local:workspace', slug = 'local') {
    environment.workspaces.set({
      status: 'ready',
      activeWorkspaceId: id,
      workspaces: [{ id, slug, name: slug, role: 'owner', contentMode: 'e2ee' }],
    });
  }

  const encryptedDescriptor = (workspaceId: string) =>
    ({
      workspaceId,
      contentMode: 'e2ee',
      contentModeVersion: 1,
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      cryptoOrgId: '11'.repeat(32),
      activation: 'control-only',
    }) as const;

  /** Renderer storage was cleared (or this is another window profile) while the
   * device host still holds the workspace's encrypted identity. */
  function hostIdentity(
    answer: (input: {
      accountId: string;
      workspaceId: string;
    }) => Promise<{ workspaceId: string; genesisHash: string }>
  ) {
    const readIdentity = vi.fn(answer);
    environment.e2eeWorkspaces = {
      ...environment.e2eeWorkspaces!,
      runtime: { readIdentity } as unknown as NonNullable<PlatformE2eeWorkspaces['runtime']>,
    };
    return readIdentity;
  }

  it.each([
    [
      'Electron',
      new Error("Error invoking remote method 'e2ee': Error: e2ee_missing-binding"),
      true,
    ],
    ['portable', { _tag: 'PersonalHostError', code: 'approval-required' }, true],
    ['unreadable', new Error('e2ee_permissions'), false],
  ] as const)(
    'admits plaintext only when the %s host has no identity record',
    async (_, failure, admitted) => {
      ordinaryCloud();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      hostIdentity(async () => {
        throw failure;
      });
      await render();
      const gate = vi.mocked(createWorkspaceRuntime).mock.calls[0]![0].waitForContentAdmission!;
      if (admitted) {
        await gate(new AbortController().signal);
        expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
          contentMode: 'plaintext',
        });
      } else {
        // Unknown host state is not plaintext proof: local data stays, egress waits.
        await expect(gate(new AbortController().signal)).rejects.toBe(failure);
        expect(store.get(workspaceContentModeAtom)?.descriptor).toBeNull();
      }
      expect(store.get(runtimeAtom)).toBe(prepared);
    }
  );

  it('asks a transiently unavailable host again and admits without any send once it reports no identity', async () => {
    ordinaryCloud();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let answers = 0;
    const readIdentity = hostIdentity(async () => {
      answers += 1;
      throw new Error(answers === 1 ? 'e2ee_account_unavailable' : 'e2ee_missing-binding');
    });
    vi.useFakeTimers();
    try {
      await render();
      expect(store.get(workspaceContentModeAtom)?.descriptor).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(readIdentity).toHaveBeenCalledTimes(2);
      expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
        contentMode: 'plaintext',
      });
      expect(store.get(runtimeAtom)).toBe(prepared);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a persistent host failure with its code, keeps egress closed, and admits after recovery', async () => {
    ordinaryCloud();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failure: unknown = { _tag: 'PersonalHostError', code: 'storage' };
    const readIdentity = hostIdentity(async () => {
      throw failure;
    });
    vi.useFakeTimers();
    try {
      await render();
      await act(async () => vi.advanceTimersByTimeAsync(HOST_IDENTITY_STALL_MS + 8_000));
      const notice = container.querySelector('[role="status"]');
      expect(notice?.querySelector('code')?.textContent).toBe('storage');
      expect(warn).toHaveBeenCalledWith(
        'Device host identity check is still unavailable',
        expect.objectContaining({ code: 'storage', error: failure })
      );
      // Still unclassified: no plaintext admission while the host is unavailable.
      expect(store.get(workspaceContentModeAtom)?.descriptor).toBeNull();
      expect(store.get(runtimeAtom)).toBe(prepared);
      const calls = readIdentity.mock.calls.length;
      failure = new Error('e2ee_missing-binding');
      await act(async () => {
        notice?.querySelector('button')?.click();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(readIdentity.mock.calls.length).toBe(calls + 1);
      expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
        contentMode: 'plaintext',
      });
      expect(container.querySelector('[role="status"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps at most one unanswered host read per workspace', async () => {
    ordinaryCloud();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const readIdentity = hostIdentity(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      await render();
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(readIdentity).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="status"] code')?.textContent).toBe('timeout');
      expect(store.get(workspaceContentModeAtom)?.descriptor).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a prefetch round at the first temporarily unavailable host answer', async () => {
    ordinaryCloud();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    environment.workspaces.set({
      status: 'ready',
      activeWorkspaceId: 'local:workspace',
      workspaces: [
        { id: 'local:workspace', slug: 'local', name: 'Local', role: 'owner' },
        { id: 'workspace-beta', slug: 'beta', name: 'Beta', role: 'member' },
        { id: 'workspace-gamma', slug: 'gamma', name: 'Gamma', role: 'member' },
      ],
    });
    const asked: string[] = [];
    const first = Promise.withResolvers<void>();
    hostIdentity(async ({ workspaceId }) => {
      if (workspaceId === 'local:workspace') throw new Error('e2ee_missing-binding');
      asked.push(workspaceId);
      first.resolve();
      throw { _tag: 'PersonalHostError', code: 'storage' };
    });
    vi.useFakeTimers();
    try {
      await render();
      await act(async () => first.promise);
      // Past every per-workspace deadline: no re-ask and no next workspace.
      await act(async () => vi.advanceTimersByTimeAsync(2 * WORKSPACE_MODE_ADMISSION_TIMEOUT_MS));
    } finally {
      vi.useRealTimers();
    }
    expect(asked).toEqual(['workspace-beta']);
    for (const [id, slug] of [
      ['workspace-beta', 'beta'],
      ['workspace-gamma', 'gamma'],
    ])
      expect(readWorkspaceModeProof(localStorage, 'local:user', id, slug)).toBeNull();
  });

  it('shows a recoverable timeout instead of initializing forever when the host never answers', async () => {
    ordinaryCloud();
    listEncrypted();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const readIdentity = hostIdentity(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      await render();
      await act(async () => vi.advanceTimersByTimeAsync(WORKSPACE_MODE_ADMISSION_TIMEOUT_MS + 1));
      // The unanswered read is joined, not repeated, until it settles.
      expect(readIdentity).toHaveBeenCalledTimes(1);
      expect(createWorkspaceRuntime).not.toHaveBeenCalled();
      expect(store.get(workspaceContentModeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        errorType: 'WorkspaceModeAdmissionTimeoutError',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['retains an encrypted identity', true],
    ['cannot be read', false],
  ] as const)(
    'never prefetches a plaintext proof for a listed workspace whose host %s',
    async (_, retained) => {
      ordinaryCloud();
      vi.spyOn(console, 'info').mockImplementation(() => {});
      environment.workspaces.set({
        status: 'ready',
        activeWorkspaceId: 'local:workspace',
        workspaces: [
          { id: 'local:workspace', slug: 'local', name: 'Local', role: 'owner' },
          { id: 'workspace-beta', slug: 'beta', name: 'Beta', role: 'member' },
        ],
      });
      const beta = Promise.withResolvers<void>();
      hostIdentity(async ({ workspaceId }) => {
        if (workspaceId !== 'workspace-beta') throw new Error('e2ee_missing-binding');
        beta.resolve();
        if (!retained) throw new Error('e2ee_permissions');
        return { workspaceId, genesisHash: '11'.repeat(32) };
      });
      await render();
      await act(async () => beta.promise);
      expect(
        readWorkspaceModeProof(localStorage, 'local:user', 'workspace-beta', 'beta')
      ).toBeNull();
      expect(
        readWorkspaceModeEvidence(localStorage, 'local:user', 'workspace-beta').encrypted
      ).toBe(retained);
    }
  );

  it.each(['plaintext', 'encrypted', 'account change'] as const)(
    'keeps the provisional Repo local and releases its content gate only for %s admission',
    async (answer) => {
      ordinaryCloud();
      const descriptor =
        Promise.withResolvers<Awaited<ReturnType<PlatformE2eeWorkspaces['describe']>>>();
      environment.e2eeWorkspaces!.describe = () => descriptor.promise;
      await render();
      const gate = vi.mocked(createWorkspaceRuntime).mock.calls[0]![0].waitForContentAdmission!;
      const outcome = gate(new AbortController().signal).then(
        () => 'admitted',
        () => 'cancelled'
      );
      expect(store.get(runtimeAtom)).toBe(prepared);
      expect(prepared.metadata.get('session')).toBe('already prepared');
      if (answer === 'account change') {
        await act(async () => store.set(userAtom, { id: 'other-account' } as never));
      }
      await act(async () =>
        descriptor.resolve(
          answer === 'encrypted'
            ? encryptedDescriptor('local:workspace')
            : {
                workspaceId: 'local:workspace',
                contentMode: 'plaintext',
                contentModeVersion: 1,
              }
        )
      );
      expect(await outcome).toBe(answer === 'plaintext' ? 'admitted' : 'cancelled');
      if (answer === 'plaintext') {
        expect(store.get(runtimeAtom)).toBe(prepared);
        expect(prepared.disposed).toBe(false);
        // An authenticated immutable verdict remains valid through temporary
        // authentication hydration, just like a retained offline proof.
        await act(async () => environment.session.set({ status: 'loading' }));
        await expect(gate(new AbortController().signal)).resolves.toBeUndefined();
        expect(store.get(runtimeAtom)).toBe(prepared);
      }
    }
  );

  it('opens local data but refuses outbound admission when cloud classification is unavailable', async () => {
    ordinaryCloud();
    environment.e2eeWorkspaces = undefined;
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    const gate = vi.mocked(createWorkspaceRuntime).mock.calls[0]![0].waitForContentAdmission!;
    await expect(gate(new AbortController().signal)).rejects.toThrow(
      'e2ee_workspace_mode_unavailable'
    );
    expect(prepared.metadata.get('session')).toBe('already prepared');
  });

  it.each(['unknown mode', 'other workspace'] as const)(
    'retires a provisional runtime and fails closed when background verification returns %s',
    async (answer) => {
      ordinaryCloud();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      environment.e2eeWorkspaces!.describe = async () =>
        answer === 'unknown mode'
          ? ({
              workspaceId: 'local:workspace',
              contentMode: 'future',
              contentModeVersion: 2,
            } as never)
          : encryptedDescriptor('another-workspace');
      await render();
      expect(store.get(runtimeAtom)).toBeNull();
      expect(prepared.disposed).toBe(true);
      expect(store.get(workspaceContentModeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        workspaceSlug: 'local',
        modeAdmission: { knownEncrypted: false },
      });
      // The rejection is sticky: Retry waits for authoritative admission and
      // fails closed again instead of reopening a plaintext runtime.
      await act(async () => store.set(workspaceModeAdmissionRetryAtom, 1));
      expect(createWorkspaceRuntime).toHaveBeenCalledTimes(1);
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(workspaceContentModeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        modeAdmission: { knownEncrypted: false },
      });
    }
  );

  /** Storage refuses writes of one evidence record, as a full quota would. */
  function refuseWrites(prefix: string) {
    const setItem = Storage.prototype.setItem;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (key.startsWith(prefix)) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
  }

  it('keeps a rejection for the session when storage refuses its marker', async () => {
    ordinaryCloud();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = refuseWrites('lody-e2ee-rejected-mode:');
    try {
      environment.e2eeWorkspaces!.describe = async () =>
        ({ workspaceId: 'local:workspace', contentMode: 'future', contentModeVersion: 2 }) as never;
      await render();
      expect(store.get(runtimeAtom)).toBeNull();
      expect(
        localStorage.getItem('lody-e2ee-rejected-mode:local%3Auser:local%3Aworkspace')
      ).toBeNull();
      await act(async () => store.set(workspaceModeAdmissionRetryAtom, 1));
      environment.mode = 'dual';
      await render();
      environment.mode = 'cloud';
      await render();
      expect(createWorkspaceRuntime).toHaveBeenCalledTimes(1);
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({ workspaceSlug: 'local' });
    } finally {
      refused.mockRestore();
    }
  });

  it('fails closed when an encrypted answer cannot be recorded', async () => {
    ordinaryCloud();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = refuseWrites('lody-e2ee-known-mode:');
    try {
      environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
      await render();
      expect(store.get(runtimeAtom)).toBeNull();
      expect(prepared.disposed).toBe(true);
      expect(store.get(workspaceContentModeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        workspaceSlug: 'local',
        errorType: 'QuotaExceededError',
      });
      await act(async () => store.set(workspaceModeAdmissionRetryAtom, 1));
      expect(createWorkspaceRuntime).toHaveBeenCalledTimes(1);
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({ workspaceSlug: 'local' });
    } finally {
      refused.mockRestore();
    }
  });

  it('retires a provisional runtime when the listing later marks the workspace encrypted', async () => {
    ordinaryCloud();
    environment.e2eeWorkspaces!.describe = () => new Promise(() => {});
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () => listEncrypted());
    expect(store.get(runtimeAtom)).toBeNull();
    expect(prepared.disposed).toBe(true);
    expect(store.get(workspaceContentModeAtom)).toBeNull();
    expect(createWorkspaceRuntime).toHaveBeenCalledTimes(1);
  });

  it.each(['with', 'without'] as const)(
    'before sign-in, opens provisionally only %s no other account holding encrypted evidence',
    async (kind) => {
      ordinaryCloud();
      store.set(userAtom, null as never);
      environment.session.set({ status: 'loading' });
      if (kind === 'with')
        saveE2eeGenesisPin(localStorage, 'other-account', 'local:workspace', '11'.repeat(32));
      await render();
      expect(store.get(runtimeAtom)).toBe(kind === 'with' ? null : prepared);
      expect(createWorkspaceRuntime).toHaveBeenCalledTimes(kind === 'with' ? 0 : 1);
    }
  );

  it.each(['offline', 'access-restored'] as const)(
    'independent review: a recovered SEC1 mode proof must release the C1 content gate (%s)',
    async (failureKind) => {
      ordinaryCloud();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const describeWorkspace = environment.e2eeWorkspaces!.describe;
      const failure =
        failureKind === 'offline'
          ? new Error('Offline')
          : new ConvexError({ code: 'workspace_access_denied' });
      environment.e2eeWorkspaces!.describe = async () => {
        throw failure;
      };
      await render();
      const gate = vi.mocked(createWorkspaceRuntime).mock.calls[0]![0].waitForContentAdmission!;
      await expect(gate(new AbortController().signal)).rejects.toBe(failure);
      environment.e2eeWorkspaces!.describe = describeWorkspace;
      environment.workspaces.set({
        status: 'ready',
        activeWorkspaceId: 'local:workspace',
        workspaces: [{ id: 'local:workspace', slug: 'local', name: 'Local' }],
      });
      const uninstall = installAttachmentWorkspaceAccess({
        identity: { session: environment.session, signOut: async () => {} },
        workspaces: { state: environment.workspaces, setActive: async () => {} },
        e2eeWorkspaces: environment.e2eeWorkspaces,
      });
      try {
        await act(async () => {
          await authorizePlaintextAttachmentUpload('local:workspace', undefined, 'local:user');
          window.dispatchEvent(new Event('online'));
        });
        expect(
          readWorkspaceModeProof(localStorage, 'local:user', 'local:workspace', 'local')
        ).toMatchObject({ contentMode: 'plaintext' });
        expect(store.get(runtimeAtom)).toBe(prepared);
        expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
        await expect(gate(new AbortController().signal)).resolves.toBeUndefined();
      } finally {
        uninstall();
      }
    }
  );

  it('retires a provisional runtime when attachment admission discovers encryption after background verification failed', async () => {
    ordinaryCloud();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    environment.e2eeWorkspaces!.describe = async () => {
      throw new Error('Offline');
    };
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    const remove = installAttachmentWorkspaceAccess({
      identity: { session: environment.session, signOut: async () => {} },
      workspaces: { state: environment.workspaces, setActive: async () => {} },
      e2eeWorkspaces: environment.e2eeWorkspaces,
    });
    try {
      environment.e2eeWorkspaces!.describe = async ({ workspaceId }) =>
        encryptedDescriptor(workspaceId);
      await act(async () => {
        await expect(authorizePlaintextAttachmentUpload('other-workspace')).rejects.toThrow(
          'e2ee_attachment_unprotected'
        );
      });
      expect(prepared.disposed).toBe(false);
      expect(store.get(runtimeAtom)).toBe(prepared);
      await act(async () => {
        await expect(authorizePlaintextAttachmentUpload('local:workspace')).rejects.toThrow(
          'e2ee_attachment_unprotected'
        );
      });
      expect(prepared.disposed).toBe(true);
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
        contentMode: 'e2ee',
      });
    } finally {
      remove();
    }
  });

  it.each(['new proof', 'send retry', 'online'] as const)(
    'recovers content admission after access is restored through %s without rebuilding the Repo',
    async (recovery) => {
      ordinaryCloud();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const describeWorkspace = environment.e2eeWorkspaces!.describe;
      const failure = new ConvexError({ code: 'workspace_access_denied' });
      environment.e2eeWorkspaces!.describe = async () => {
        throw failure;
      };
      await render();
      const gate = vi.mocked(createWorkspaceRuntime).mock.calls[0]![0].waitForContentAdmission!;
      await expect(gate(new AbortController().signal)).rejects.toBe(failure);
      environment.e2eeWorkspaces!.describe = describeWorkspace;
      if (recovery === 'new proof') {
        retainWorkspaceModeProof(localStorage, 'local:user', 'local', {
          workspaceId: 'local:workspace',
          contentMode: 'plaintext',
          contentModeVersion: 1,
        });
      } else if (recovery === 'online') {
        await act(async () => window.dispatchEvent(new Event('online')));
      }
      await act(async () => {
        await expect(gate(new AbortController().signal)).resolves.toBeUndefined();
      });
      expect(store.get(runtimeAtom)).toBe(prepared);
      expect(prepared.disposed).toBe(false);
      expect(prepared.metadata.get('session')).toBe('already prepared');
      expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
      expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
        contentMode: 'plaintext',
      });
    }
  );

  it.each(['other workspace', 'other account', 'encrypted'] as const)(
    'does not recover a failed content gate from %s evidence',
    async (kind) => {
      ordinaryCloud();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new ConvexError({ code: 'workspace_access_denied' });
      environment.e2eeWorkspaces!.describe = async () => {
        throw failure;
      };
      await render();
      const gate = vi.mocked(createWorkspaceRuntime).mock.calls[0]![0].waitForContentAdmission!;
      await expect(gate(new AbortController().signal)).rejects.toBe(failure);
      retainWorkspaceModeProof(
        localStorage,
        kind === 'other account' ? 'other-account' : 'local:user',
        'local',
        kind === 'encrypted'
          ? encryptedDescriptor('local:workspace')
          : {
              workspaceId: kind === 'other workspace' ? 'other-workspace' : 'local:workspace',
              contentMode: 'plaintext',
              contentModeVersion: 1,
            }
      );
      await act(async () => {
        await expect(gate(new AbortController().signal)).rejects.toThrow();
      });
      expect(store.get(runtimeAtom)).toBe(kind === 'encrypted' ? null : prepared);
      expect(prepared.metadata.get('session')).toBe('already prepared');
      if (kind !== 'encrypted') expect(store.get(workspaceContentModeAtom)?.descriptor).toBeNull();
    }
  );

  it('retries a mode read rejected while backend authentication catches up', async () => {
    ordinaryCloud();
    listEncrypted();
    let reads = 0;
    const remote = environment.e2eeWorkspaces!.describe;
    environment.e2eeWorkspaces!.describe = async (request) => {
      reads++;
      if (reads === 1) throw new ConvexError({ kind: 'lody.auth', code: 'unauthenticated' });
      return remote(request);
    };
    vi.useFakeTimers();
    try {
      await render();
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(reads).toBe(2);
      expect(store.get(runtimeAtom)).toBe(prepared);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a mode proof saved under a previous slug and rewrites it for the current slug', async () => {
    ordinaryCloud();
    retainWorkspaceModeProof(localStorage, 'local:user', 'old-slug', {
      workspaceId: 'local:workspace',
      contentMode: 'plaintext',
      contentModeVersion: 1,
    });
    environment.e2eeWorkspaces!.describe = () => new Promise(() => {});
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
      contentMode: 'plaintext',
    });
    expect(
      readWorkspaceModeProof(localStorage, 'local:user', 'local:workspace', 'local')
    ).toMatchObject({ contentMode: 'plaintext' });
  });

  it('retains mode proofs for listed workspaces once signed in, so a later offline open is admitted', async () => {
    ordinaryCloud();
    environment.workspaces.set({
      status: 'ready',
      activeWorkspaceId: 'local:workspace',
      workspaces: [
        { id: 'local:workspace', slug: 'local', name: 'Local', role: 'owner' },
        { id: 'workspace-beta', slug: 'beta', name: 'Beta', role: 'member' },
      ],
    });
    await render();
    expect(
      readWorkspaceModeProof(localStorage, 'local:user', 'workspace-beta', 'beta')
    ).toMatchObject({ contentMode: 'plaintext' });
    environment.e2eeWorkspaces!.describe = () => new Promise(() => {});
    environment.cachedWorkspaceId = 'workspace-beta';
    await act(async () => {
      store.set(currentWorkspaceSlugAtom, 'beta');
      store.set(currentWorkspaceIdAtom, null);
    });
    expect(store.get(workspaceContentModeAtom)).toMatchObject({
      workspaceId: 'workspace-beta',
      descriptor: { contentMode: 'plaintext' },
    });
  });

  it.each(['genesis pin', 'known-mode marker', 'pending creation for the slug'] as const)(
    'still waits for authoritative admission when a %s exists',
    async (evidence) => {
      ordinaryCloud();
      if (evidence === 'genesis pin')
        saveE2eeGenesisPin(localStorage, 'local:user', 'local:workspace', '11'.repeat(32));
      else if (evidence === 'known-mode marker')
        localStorage.setItem(
          'lody-e2ee-known-mode:local%3Auser:local%3Aworkspace',
          '11'.repeat(32)
        );
      else
        savePendingE2eeWorkspace(localStorage, {
          accountId: 'local:user',
          requestId: 'request-1',
          name: 'Local',
          slug: 'local',
        });
      environment.e2eeWorkspaces!.describe = () => new Promise(() => {});
      vi.useFakeTimers();
      try {
        await render();
        expect(store.get(runtimeAtom)).toBeNull();
        expect(store.get(workspaceContentModeAtom)).toBeNull();
        await act(async () => vi.advanceTimersByTimeAsync(15_000));
        expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
          errorType: WorkspaceModeAdmissionTimeoutError.name,
          modeAdmission: { knownEncrypted: true },
        });
        expect(createWorkspaceRuntime).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('retains an encrypted identity failure and its workspace ID when the listing has no encryption hint', async () => {
    ordinaryCloud();
    retainWorkspaceModeProof(localStorage, 'local:user', 'local', {
      workspaceId: 'local:workspace',
      contentMode: 'plaintext',
      contentModeVersion: 1,
    });
    localStorage.setItem('lody-e2ee-known-mode:local%3Auser:local%3Aworkspace', '11'.repeat(32));
    await render();
    expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
      errorType: 'E2eeLocalEvidenceConflictError',
      modeAdmission: { knownEncrypted: true, workspaceId: 'local:workspace' },
    });
    expect(store.get(runtimeAtom)).toBeNull();
  });

  it('waits for the same account to authenticate, then preserves the runtime through auth refresh', async () => {
    ordinaryCloud();
    listEncrypted();
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
    listEncrypted();
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
      deleteWorkspace: unexpectedE2eeWorkspaceOperation,
      create: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
    };
    store.set(currentWorkspaceSlugAtom, 'local');
    store.set(currentWorkspaceIdAtom, 'local:workspace');
    listEncrypted();
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
          signingPublicKey: '22'.repeat(32),
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

  it('reports a bounded failure when an encrypted-listed workspace has only an unverified ID cache', async () => {
    ordinaryCloud();
    listEncrypted();
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
    listEncrypted();
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
    listEncrypted();
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
      deleteWorkspace: unexpectedE2eeWorkspaceOperation,
      create: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
    };
    store.set(currentWorkspaceSlugAtom, 'encrypted');
    store.set(currentWorkspaceIdAtom, 'workspace-encrypted');
    listEncrypted('workspace-encrypted', 'encrypted');
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
        signingPublicKey: '22'.repeat(32),
        cryptoOrgId: '11'.repeat(32),
        activation: 'control-only',
      })
    );
    expect(store.get(runtimeAtom)).toBeNull();
    expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({ contentMode: 'e2ee' });
    expect(createWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'unavailable'])(
    'refuses the plaintext runtime of an encrypted-listed workspace when mode is %s',
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
        deleteWorkspace: unexpectedE2eeWorkspaceOperation,
        create: async () => {
          throw new Error('unused');
        },
        history: async () => {
          throw new Error('unused');
        },
      };
      store.set(currentWorkspaceSlugAtom, 'encrypted');
      store.set(currentWorkspaceIdAtom, 'workspace-encrypted');
      listEncrypted('workspace-encrypted', 'encrypted');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await render();
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        workspaceSlug: 'encrypted',
        modeAdmission: { knownEncrypted: true },
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
        deleteWorkspace: unexpectedE2eeWorkspaceOperation,
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

  it('reopens an authenticated plaintext mode offline using only its matching account proof', async () => {
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
      deleteWorkspace: unexpectedE2eeWorkspaceOperation,
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
    await act(async () => store.set(userAtom, { id: 'other-user' } as never));
    expect(prepared.disposed).toBe(true);
    // Another account cannot inherit the proof; its runtime is only provisional.
    expect(store.get(workspaceContentModeAtom)).toMatchObject({
      accountId: 'other-user',
      descriptor: null,
    });
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
      deleteWorkspace: unexpectedE2eeWorkspaceOperation,
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
      deleteWorkspace: unexpectedE2eeWorkspaceOperation,
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
      deleteWorkspace: unexpectedE2eeWorkspaceOperation,
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
        signingPublicKey: '22'.repeat(32),
        cryptoOrgId: '11'.repeat(32),
        activation: 'control-only',
      })
    );
    expect(store.get(workspaceContentModeAtom)?.workspaceId).toBe('local:workspace');
    expect(store.get(runtimeAtom)).toBe(prepared);
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
});

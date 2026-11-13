// @vitest-environment jsdom
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
vi.mock('@posthog/react', () => ({ usePostHog: () => null }));
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

  it.each(['success', 'transport failure', 'other AbortError', 'same-message Error'] as const)(
    'handles superseded login admission and preserves the new token outcome: %s',
    async (outcome) => {
      realRuntimeSelected = true;
      ordinaryCloud();
      environment.electron = false;
      environment.cachedWorkspaceId = 'cloud-workspace';
      store.set(currentWorkspaceIdAtom, 'cloud-workspace');
      store.set(authTokenAtom, 'login-token-before-refresh');
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      vi.stubEnv('VITE_CONVEX_SITE_URL', 'https://api.example.test');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      errors.mockClear();
      const diagnostics = vi.spyOn(clientLog, 'recordClientError');
      diagnostics.mockClear();
      const mode = Promise.withResolvers<{
        workspaceId: string;
        contentMode: 'plaintext';
        contentModeVersion: 1;
      }>();
      environment.e2eeWorkspaces!.describe = () => mode.promise;
      const requests: string[] = [];
      vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
        requests.push(new Headers(init?.headers).get('Authorization')!);
        return new Response(
          JSON.stringify({
            token: 'streams-token',
            expiresIn: 3600,
            gatewayBaseUrl: 'https://streams.example.test',
          }),
          { status: 200 }
        );
      });
      const created = Promise.withResolvers<WorkspaceRuntime>();
      const factory = actualRuntimeFactory;
      let tokens!: MockInstance<WorkspaceRuntime['setAuthToken']>;
      vi.mocked(createWorkspaceRuntime).mockImplementation(async (deps) => {
        try {
          actualRuntime = await factory.createWorkspaceRuntime(deps);
          tokens = vi.spyOn(actualRuntime, 'setAuthToken');
          created.resolve(actualRuntime);
          return actualRuntime;
        } catch (error) {
          created.reject(error);
          throw error;
        }
      });
      const failure =
        outcome === 'other AbortError'
          ? new DOMException('Gateway request aborted', 'AbortError')
          : new Error(
              outcome === 'same-message Error'
                ? 'Authentication superseded'
                : 'Gateway transport setup failed'
            );
      try {
        await render();
        await act(async () => {
          await created.promise;
        });
        const runtime = actualRuntime!;
        const initial = tokens.mock.results[0]!.value as Promise<void>;
        const previous = tokens.mock.results.at(-1)!.value as Promise<void>;
        await act(async () => {
          store.set(authTokenAtom, 'login-token-after-refresh');
        });
        await expect(initial).rejects.toMatchObject({
          name: 'AbortError',
          message: 'Authentication superseded',
        });
        await expect(previous).rejects.toMatchObject({
          name: 'AbortError',
          message: 'Authentication superseded',
        });
        const latest = tokens.mock.results.at(-1)!.value as Promise<void>;
        expect(requests).toEqual([]);
        expect(runtime.repo.getTransportIds()).toEqual([]);
        if (outcome !== 'success') environment.transportFailure = failure;
        await act(async () => {
          mode.resolve({
            workspaceId: 'cloud-workspace',
            contentMode: 'plaintext',
            contentModeVersion: 1,
          });
          if (outcome === 'success') await latest;
          else await expect(latest).rejects.toBe(failure);
        });
        expect(requests).toEqual(['Bearer login-token-after-refresh']);
        expect(store.get(runtimeAtom)).toBe(runtime);
        if (outcome === 'success') {
          expect(runtime.repo.getTransportAdapter('cloud')?.isConnected()).toBe(true);
          expect(store.get(lodyControlConnectionStateAtom)).toBe('online');
          expect(errors.mock.calls).toEqual([]);
          expect(diagnostics.mock.calls).toEqual([]);
        } else {
          expect(errors.mock.calls).toContainEqual([
            'RuntimeProvider: set auth token failed',
            failure,
          ]);
          expect(diagnostics.mock.calls).toContainEqual([
            'runtime.operation_failed',
            failure,
            { operation: 'set auth token' },
          ]);
          expect(store.get(lodyControlConnectionStateAtom)).not.toBe('online');
        }
      } finally {
        mode.resolve({
          workspaceId: 'cloud-workspace',
          contentMode: 'plaintext',
          contentModeVersion: 1,
        });
        errors.mockRestore();
        diagnostics.mockRestore();
      }
    }
  );

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

  it('reopens the same admitted two-epoch binding only after a failed content close really drains', async () => {
    ordinaryCloud();
    listEncrypted();
    realRuntimeSelected = true;
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const installed = new Set([0, 1]);
    const status = {
      workspaceId: 'local:workspace',
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 1,
      writeEpoch: 1,
      hasCurrentKey: installed.has(1),
      rotationRequired: false,
      memberRole: 'member' as const,
      deviceKind: 'personal' as const,
    };
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor(status.workspaceId);
    environment.e2eeWorkspaces!.runtime = {
      readerLeases: 'preallocated-v1',
      open: async (_id, _observed, _account, readerOwner) => ({ ...status, readerOwner }),
      status: async () => status,
      refresh: async () => status,
      close: async () => {},
    } as E2eeWorkspaceRuntime;
    const created: WorkspaceRuntime[] = [];
    const firstCreated = Promise.withResolvers<void>();
    const secondCreated = Promise.withResolvers<void>();
    vi.mocked(createWorkspaceRuntime).mockImplementation(async (deps) => {
      actualRuntime = await actualRuntimeFactory.createWorkspaceRuntime(deps);
      created.push(actualRuntime);
      firstCreated.resolve();
      if (created.length === 2) secondCreated.resolve();
      return actualRuntime;
    });
    const failure = new Error('synthetic private data must not enter diagnostics', {
      cause: new DOMException('private storage details', 'QuotaExceededError'),
    });
    const firstFailed = Promise.withResolvers<void>();
    const retryEntered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const secondFailed = Promise.withResolvers<unknown>();
    const errors = vi.spyOn(console, 'error').mockImplementation((message, error) => {
      if (message === 'RuntimeProvider: cleanup dispose failed') firstFailed.resolve();
      if (message === 'RuntimeProvider: runtime initialization failed') secondFailed.resolve(error);
    });
    const reports = vi.spyOn(clientLog, 'recordClientLog');
    let destroy: (() => Promise<void>) | undefined;
    try {
      await render();
      await act(async () => firstCreated.promise);
      const original = actualRuntime!;
      expect(store.get(runtimeAtom)).toBe(original);
      const history = await original.repo.openPersistedDoc('two-epoch-history');
      history.doc.getText('body').insert(0, 'epoch zero and epoch one history');
      history.doc.commit();
      await original.repo.flush();
      destroy = original.repo.destroy.bind(original.repo);
      vi.spyOn(original.repo, 'destroy')
        .mockRejectedValueOnce(failure)
        .mockImplementation(async () => {
          retryEntered.resolve();
          await released.promise;
          await destroy!();
        });
      await act(async () => store.set(currentWorkspaceSlugAtom, null));
      await firstFailed.promise;
      await act(async () => store.set(currentWorkspaceSlugAtom, 'local'));
      // Fail immediately on the old poisoned result instead of waiting for a timeout.
      const retried = await Promise.race([
        retryEntered.promise.then(() => true),
        secondFailed.promise.then(() => false),
      ]);
      expect(retried).toBe(true);
      expect(store.get(runtimeAtom)).toBeNull();
      expect(created).toHaveLength(1);
      await original.setAuthToken('must-remain-retired');
      expect(original.repo.getTransportIds()).toEqual([]);
      await act(async () => {
        released.resolve();
        await original.dispose();
        await secondCreated.promise;
      });
      expect(created).toHaveLength(2);
      expect(store.get(runtimeAtom)).toBe(created[1]);
      const reopened = await created[1]!.repo.openPersistedDoc('two-epoch-history');
      expect(reopened.doc.getText('body').toString()).toBe('epoch zero and epoch one history');
      expect(installed).toEqual(new Set([0, 1]));
      const closeReports = reports.mock.calls.filter(
        ([, event]) => event === 'runtime.close_failed'
      );
      expect(closeReports).toContainEqual([
        'error',
        'runtime.close_failed',
        'Workspace close failed',
        { stage: 'repo', causeTypes: 'Error,QuotaExceededError' },
      ]);
      expect(JSON.stringify(closeReports)).not.toContain('synthetic private');
      expect(JSON.stringify(closeReports)).not.toContain('private storage details');
    } finally {
      released.resolve();
      errors.mockRestore();
      reports.mockRestore();
      for (const runtime of created) {
        await runtime.dispose().catch(() => {});
      }
      await destroy?.();
      actualRuntime = undefined;
      realRuntimeSelected = false;
    }
  });

  it('opens a re-invited member under the new device instance while retaining exact local identity', async () => {
    ordinaryCloud();
    listEncrypted();
    const original = {
      accountId: 'local:user',
      workspaceId: 'local:workspace',
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
    };
    retainEncryptedLocalIdentity(original);
    const installed = { ...original, signingPublicKey: '33'.repeat(32) };
    const status = { ...installed, epoch: 0, hasCurrentKey: true, rotationRequired: false };
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor(original.workspaceId);
    environment.e2eeWorkspaces!.runtime = {
      open: async () => status,
      status: async () => status,
      refresh: async () => status,
      close: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    const options = vi.mocked(createWorkspaceRuntime).mock.calls.at(-1)?.[0];
    expect(options?.e2eeLocalIdentity).toEqual(installed);
    expect(readEncryptedLocalIdentity(original.accountId, original.workspaceId)).toEqual(installed);
    expect(encryptedLocalNamespace({ ...installed, windowId: 'test-window' })).not.toBe(
      encryptedLocalNamespace({ ...original, windowId: 'test-window' })
    );
  });

  it.each(['success', 'temporary failure'])(
    'keeps the local replica without a key warning after background refresh %s',
    async (outcome) => {
      ordinaryCloud();
      listEncrypted();
      const status = {
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
        epoch: 0,
        hasCurrentKey: true,
        rotationRequired: false,
      };
      let finishRefresh!: (value: typeof status) => void;
      let failRefresh!: () => void;
      environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
      environment.e2eeWorkspaces!.runtime = {
        open: async () => status,
        refresh: (_workspaceId, options) =>
          options?.installKeys === false
            ? new Promise((resolve, reject) => {
                finishRefresh = resolve;
                failRefresh = () => reject(new Error('temporary network failure'));
              })
            : Promise.resolve({ ...status, epoch: 1 }),
        status: async () => ({ ...status, epoch: 1 }),
        close: async () => {},
      } as unknown as E2eeWorkspaceRuntime;
      await render();
      expect(store.get(runtimeAtom)).toBe(prepared);
      await act(async () =>
        outcome === 'success' ? finishRefresh({ ...status, epoch: 1 }) : failRefresh()
      );
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(store.get(runtimeAtom)).toBe(prepared);
      expect(prepared.disposed).toBe(false);
    }
  );

  it('selects a manually installed key without mailbox I/O and isolates unrelated workspace/account notifications', async () => {
    ordinaryCloud();
    listEncrypted();
    let epoch = 0;
    const status = () => ({
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch,
      hasCurrentKey: true,
      rotationRequired: false,
    });
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      open: async () => status(),
      status: async () => status(),
      refresh: async () => status(),
      close: async () => {},
      seal: async (_workspace: string, input: { epoch: number }) => ({
        header: new Uint8Array([3]),
        sealed: new Uint8Array([input.epoch]),
      }),
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    const content = vi.mocked(createWorkspaceRuntime).mock.calls.at(-1)![0].content!;
    if (content.mode !== 'protected') throw new Error('expected encrypted content');
    const room = content.resolve({ kind: 'doc', docId: 'preserved-room' });
    if (room?.mode !== 'protected') throw new Error('expected encrypted room');
    const request = {
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'update_batch',
      } as const,
      plaintext: new Uint8Array([1]),
      additionalData: () => new Uint8Array([2]),
    };
    expect((await room.config.provider.seal(request)).sealed).toEqual(new Uint8Array([0]));
    epoch = 1;
    environment.e2eeWorkspaces!.runtime!.refresh = async () => {
      throw new Error('unrelated mailbox outage');
    };
    await act(async () => {
      notifyE2eeLedgerChanged('another-account', 'local:workspace');
      notifyE2eeLedgerChanged('local:user', 'another-workspace');
    });
    expect((await room.config.provider.seal(request)).sealed).toEqual(new Uint8Array([0]));
    await act(async () => notifyE2eeLedgerChanged('local:user', 'local:workspace'));
    expect((await room.config.provider.seal(request)).sealed).toEqual(new Uint8Array([1]));
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
  });

  it.each(['e2ee_member_removed', 'e2ee_device_revoked'] as const)(
    'retires the local replica when native credential refresh confirms %s',
    async (code) => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      ordinaryCloud();
      listEncrypted();
      const status = {
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
        epoch: 0,
        hasCurrentKey: true,
        rotationRequired: false,
      };
      let rejectRefresh: (error: Error) => void = () => {};
      let closed = false;
      environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
      environment.e2eeWorkspaces!.runtime = {
        open: async () => status,
        status: async () => status,
        close: async () => {
          closed = true;
        },
        refresh: () =>
          new Promise((_resolve, reject) => {
            rejectRefresh = reject;
          }),
      } as unknown as E2eeWorkspaceRuntime;
      await render();
      expect(store.get(runtimeAtom)).toBe(prepared);
      await act(async () =>
        rejectRefresh(new Error(`Error invoking remote method 'e2ee.refresh': Error: ${code}`))
      );
      expect(store.get(runtimeAtom)).toBeNull();
      expect(prepared.disposed).toBe(true);
      expect(closed).toBe(true);
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        errorType: code,
        workspaceId: 'local:workspace',
      });
      await resumeEncryptedWorkspaceCleanup({
        accountId: 'local:user',
        workspaceId: 'local:workspace',
        windowId: 'test-window',
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
      });
      vi.unstubAllGlobals();
    }
  );

  it.each(['e2ee_member_removed', 'e2ee_device_revoked'] as const)(
    'a main-process access-loss hint makes a still-member window confirm %s and retire its replica',
    async (code) => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      const pushes = new Map<string, (payload: unknown) => void>();
      vi.stubGlobal('ipc', {
        on: (channel: string, handler: (payload: unknown) => void) => {
          pushes.set(channel, handler);
          return () => pushes.delete(channel);
        },
      });
      ordinaryCloud();
      listEncrypted();
      const status = {
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
        epoch: 0,
        hasCurrentKey: true,
        rotationRequired: false,
      };
      let lost = false;
      let closed = false;
      environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
      environment.e2eeWorkspaces!.runtime = {
        open: async () => status,
        status: async () => status,
        close: async () => {
          closed = true;
        },
        refresh: async () => {
          if (lost) throw new Error(`Error invoking remote method 'e2ee.refresh': Error: ${code}`);
          return status;
        },
      } as unknown as E2eeWorkspaceRuntime;
      await render();
      expect(store.get(runtimeAtom)).toBe(prepared);
      // Main recorded the loss; workspace membership lists have not changed.
      lost = true;
      await act(async () => pushes.get('e2ee.accessLost')?.({ workspaceId: 'local:other' }));
      expect(store.get(runtimeAtom)).toBe(prepared);
      await act(async () => pushes.get('e2ee.accessLost')?.({ workspaceId: 'local:workspace' }));
      expect(store.get(runtimeAtom)).toBeNull();
      expect(prepared.disposed).toBe(true);
      expect(closed).toBe(true);
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        errorType: code,
        workspaceId: 'local:workspace',
      });
      await resumeEncryptedWorkspaceCleanup({
        accountId: 'local:user',
        workspaceId: 'local:workspace',
        windowId: 'test-window',
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
      });
      vi.unstubAllGlobals();
    }
  );

  it.each([true, false])(
    'cold native removal uses only a saved exact locator: %s',
    async (saved) => {
      const factory = new IDBFactory();
      vi.stubGlobal('indexedDB', factory);
      vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      const identity = {
        accountId: 'local:user',
        workspaceId: 'local:workspace',
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
      };
      const scope = { ...identity, windowId: 'test-window' };
      const original = 'lody-loro-repo-db-' + encryptedLocalNamespace(scope);
      const replacement =
        'lody-loro-repo-db-' +
        encryptedLocalNamespace({ ...scope, signingPublicKey: '33'.repeat(32) });
      for (const name of [original, replacement]) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = factory.open(name, 1);
          request.onupgradeneeded = () => request.result.createObjectStore('content');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
      }
      const deleted = Promise.withResolvers<void>();
      const remove = factory.deleteDatabase.bind(factory);
      factory.deleteDatabase = (name) => {
        const request = remove(name);
        if (name === original) request.addEventListener('success', () => deleted.resolve());
        return request;
      };
      if (saved) retainEncryptedLocalIdentity(identity);
      ordinaryCloud();
      listEncrypted();
      environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
      environment.e2eeWorkspaces!.runtime = {
        open: async () => {
          throw new Error('e2ee_member_removed');
        },
      } as unknown as E2eeWorkspaceRuntime;
      await render();
      if (saved) await deleted.promise;
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        errorType: 'e2ee_member_removed',
      });
      const names = (await factory.databases()).map((row) => row.name);
      expect(names).toContain(replacement);
      expect(names.includes(original)).toBe(!saved);
      if (saved) await resumeEncryptedWorkspaceCleanup(scope);
      vi.unstubAllGlobals();
    }
  );

  it('a failed removed-workspace deletion does not fail the next sibling initialization', async () => {
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const name =
      'lody-loro-repo-db-' +
      encryptedLocalNamespace({
        accountId: 'local:user',
        workspaceId: 'local:workspace',
        windowId: 'test-window',
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
      });
    const blocked = Promise.withResolvers<void>();
    const originalDelete = factory.deleteDatabase.bind(factory);
    factory.deleteDatabase = (database) => {
      const request = originalDelete(database);
      if (database === name) request.addEventListener('blocked', () => blocked.resolve());
      return request;
    };
    const held = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      ordinaryCloud();
      listEncrypted();
      const status = {
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
        epoch: 0,
        hasCurrentKey: true,
        rotationRequired: false,
      };
      let rejectRefresh: (error: Error) => void = () => {};
      environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
      environment.e2eeWorkspaces!.runtime = {
        open: async () => status,
        status: async () => status,
        close: async () => {},
        refresh: () =>
          new Promise((_resolve, reject) => {
            rejectRefresh = reject;
          }),
      } as unknown as E2eeWorkspaceRuntime;
      await render();
      await act(async () => {
        rejectRefresh(new Error('e2ee_member_removed'));
        await blocked.promise;
      });
      expect(prepared.disposed).toBe(true);
      const sibling = { ...runtimeFixture(), workspaceId: 'sibling', workspaceSlug: 'sibling' };
      vi.mocked(createWorkspaceRuntime).mockResolvedValue(sibling as never);
      environment.e2eeWorkspaces!.describe = async ({ workspaceId }) => ({
        workspaceId,
        contentMode: 'plaintext',
        contentModeVersion: 1,
      });
      environment.cachedWorkspaceId = 'sibling';
      await act(async () => {
        environment.workspaces.set({
          status: 'ready',
          activeWorkspaceId: 'sibling',
          workspaces: [
            {
              id: 'sibling',
              slug: 'sibling',
              name: 'Sibling',
              role: 'owner',
              contentMode: 'plaintext',
            },
          ],
        });
        store.set(currentWorkspaceSlugAtom, 'sibling');
        store.set(currentWorkspaceIdAtom, 'sibling');
      });
      expect(store.get(runtimeAtom)).toBe(sibling);
      expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
    } finally {
      held.close();
      await resumeEncryptedWorkspaceCleanup({
        accountId: 'local:user',
        workspaceId: 'local:workspace',
        windowId: 'test-window',
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
      }).catch(() => undefined);
      await resumeEncryptedWorkspaceCleanup({
        accountId: 'local:user',
        workspaceId: 'local:workspace',
        windowId: 'test-window',
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
      });
      vi.unstubAllGlobals();
    }
  });

  it('binds the protected reader to its authenticated account and releases only that lease', async () => {
    ordinaryCloud();
    listEncrypted();
    const readers = new Set(['other-window']);
    const status = {
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 0,
      hasCurrentKey: true,
      rotationRequired: false,
      readerOwner: 'this-window',
    };
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      open: async (_id: string, _observed: unknown, account: string) => {
        if (account !== 'local:user') throw new Error('account not bound');
        readers.add('this-window');
        return status;
      },
      status: async () => status,
      refresh: async () => status,
      close: async (_id: string, account: string, reader: string) => {
        if (account !== 'local:user' || reader !== 'this-window')
          throw new Error('reader not bound');
        readers.delete(reader);
      },
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(readers).toEqual(new Set(['other-window', 'this-window']));
    await act(async () => root.render(null));
    expect(prepared.disposed).toBe(true);
    expect(readers).toEqual(new Set(['other-window']));
  });

  it('keeps an encrypted runtime and its reader when Run local agent changes the sync mode', async () => {
    ordinaryCloud();
    listEncrypted();
    const opened: string[] = [];
    const closed: string[] = [];
    const status = {
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 0,
      hasCurrentKey: true,
      rotationRequired: false,
      readerOwner: 'this-window',
    };
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      open: async (id: string) => {
        opened.push(id);
        return status;
      },
      status: async () => status,
      refresh: async () => status,
      close: async (id: string) => {
        closed.push(id);
      },
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    for (const mode of ['dual', 'cloud', 'dual']) {
      environment.mode = mode;
      await render();
    }
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
    expect(opened).toEqual(['local:workspace']);
    expect(closed).toEqual([]);
    expect(vi.mocked(createWorkspaceRuntime).mock.calls.map(([options]) => options.syncMode)).toEqual(
      ['cloud']
    );
  });

  it('reopens an ordinary workspace runtime in the sync mode Run local agent selects', async () => {
    ordinaryCloud();
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    const first = prepared;
    const next = runtimeFixture();
    vi.mocked(createWorkspaceRuntime).mockResolvedValue(next as never);
    environment.mode = 'dual';
    await render();
    expect(first.disposed).toBe(true);
    expect(store.get(runtimeAtom)).toBe(next);
    expect(vi.mocked(createWorkspaceRuntime).mock.calls.map(([options]) => options.syncMode)).toEqual(
      ['cloud', 'dual']
    );
  });

  it('opens an independent ordinary workspace while an encrypted workspace retains incomplete native close', async () => {
    ordinaryCloud();
    listEncrypted();
    let allowOldClose = false,
      oldOpen = false;
    const status = {
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 0,
      hasCurrentKey: true,
      rotationRequired: false,
      readerOwner: 'old-encrypted-reader',
    };
    environment.e2eeWorkspaces!.describe = async ({ workspaceId }) =>
      workspaceId === 'local:workspace'
        ? encryptedDescriptor(workspaceId)
        : { workspaceId, contentMode: 'plaintext', contentModeVersion: 1 };
    environment.e2eeWorkspaces!.runtime = {
      open: async () => {
        if (oldOpen) throw new Error('overlapping reader');
        oldOpen = true;
        return status;
      },
      status: async () => status,
      refresh: async () => status,
      close: async () => {
        if (!allowOldClose) throw new Error('close-incomplete: old native work retained');
        oldOpen = false;
      },
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    vi.mocked(createWorkspaceRuntime).mockImplementation(
      async ({ workspaceId }) => ({ ...runtimeFixture(), workspaceId }) as never
    );
    environment.cachedWorkspaceId = 'independent-workspace';
    await act(async () => {
      environment.workspaces.set({
        status: 'ready',
        activeWorkspaceId: 'independent-workspace',
        workspaces: [
          { id: 'independent-workspace', slug: 'independent', name: 'independent', role: 'owner' },
        ],
      });
      store.set(currentWorkspaceSlugAtom, 'independent');
      store.set(currentWorkspaceIdAtom, 'independent-workspace');
    });
    expect(store.get(runtimeAtom)?.workspaceId).toBe('independent-workspace');
    await act(async () => store.set(workspaceModeAdmissionRetryAtom, 1));
    expect(store.get(runtimeAtom)?.workspaceId).toBe('independent-workspace');
    expect(oldOpen).toBe(true);
    // Returning to A must still join its retained owner, even after B opened and retried.
    environment.cachedWorkspaceId = 'local:workspace';
    await act(async () => {
      listEncrypted();
      store.set(currentWorkspaceSlugAtom, 'local');
      store.set(currentWorkspaceIdAtom, 'local:workspace');
    });
    expect(store.get(runtimeAtom)).toBeNull();
    expect(oldOpen).toBe(true);
    allowOldClose = true;
    await act(async () => store.set(workspaceModeAdmissionRetryAtom, 2));
    expect(store.get(runtimeAtom)?.workspaceId).toBe('local:workspace');
    expect(oldOpen).toBe(true);
  });

  it('fences its preallocated reader while cold open is pending and ignores the late identity', async () => {
    ordinaryCloud();
    listEncrypted();
    let entered!: () => void, closeEntered!: () => void, settle!: () => void;
    const openEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const closing = new Promise<void>((resolve) => {
      closeEntered = resolve;
    });
    let label: string | undefined,
      settled = false;
    const status = {
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 0,
      hasCurrentKey: true,
      rotationRequired: false,
    };
    const pending = new Promise<typeof status & { readerOwner: string }>((resolve) => {
      settle = () => {
        settled = true;
        resolve({ ...status, readerOwner: label! });
      };
    });
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      readerLeases: 'preallocated-v1',
      open: async (_id: string, _observed: unknown, account: string, reader: string) => {
        if (account !== 'local:user' || !reader) throw new Error('unbound pending reader');
        label = reader;
        entered();
        return pending;
      },
      close: async (_id: string, account: string, reader: string) => {
        if (account !== 'local:user' || reader !== label) throw new Error('wrong pending reader');
        closeEntered();
        if (!settled) throw new Error('close incomplete');
      },
    } as unknown as E2eeWorkspaceRuntime;
    try {
      await render();
      await openEntered;
      await act(async () => root.render(null));
      await closing;
      expect(store.get(runtimeAtom)).toBeNull();
      expect(prepared.disposed).toBe(false);
      expect(readEncryptedLocalIdentity('local:user', 'local:workspace')).toBeNull();
    } finally {
      await act(async () => {
        settle();
        await pending;
      });
    }
    expect(store.get(runtimeAtom)).toBeNull();
    expect(readEncryptedLocalIdentity('local:user', 'local:workspace')).toBeNull();
    await environment.e2eeWorkspaces!.runtime!.close('local:workspace', 'local:user', label);
  });

  it.each(['ready', 'unavailable', 'failure'] as const)(
    'keeps encrypted admission initializing until first key reception settles: %s',
    async (outcome) => {
      ordinaryCloud();
      listEncrypted();
      const received = Promise.withResolvers<void>();
      const receiving = Promise.withResolvers<void>();
      let installed = false;
      const status = () => ({
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
        epoch: 1,
        hasCurrentKey: installed,
        writeEpoch: installed ? 1 : null,
        rotationRequired: false,
      });
      environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
      environment.e2eeWorkspaces!.runtime = {
        open: async () => status(),
        status: async () => status(),
        refresh: async (_id, options) => {
          if (options?.installKeys) {
            receiving.resolve();
            await received.promise;
            if (outcome === 'failure') throw new Error('mailbox unavailable');
            installed = outcome === 'ready';
          }
          return status();
        },
        close: async () => {},
      } as unknown as E2eeWorkspaceRuntime;
      Object.assign(prepared, { accountId: 'local:user', contentMode: 'e2ee' });
      const route = createRootRoute({
        component: () => (
          <RuntimeProvider>
            <Outlet />
          </RuntimeProvider>
        ),
      });
      const router = createRouter({
        history: createMemoryHistory({ initialEntries: ['/local/chat'] }),
        routeTree: route.addChildren([
          createRoute({
            getParentRoute: () => route,
            path: '/local/chat',
            component: () => (
              <WorkspaceAdmissionGate workspaceName="local">
                <div>protected history</div>
              </WorkspaceAdmissionGate>
            ),
          }),
          createRoute({
            getParentRoute: () => route,
            path: '/workspace/e2ee/$workspaceId',
            component: () => <div>workspace control</div>,
          }),
        ]),
      });
      try {
        await act(async () => {
          await router.load();
          root.render(
            <Provider store={store}>
              <RouterProvider router={router} />
            </Provider>
          );
        });
        await receiving.promise;
        expect(store.get(runtimeAtom)).toBeNull();
        expect(router.state.location.pathname).toBe('/local/chat');
        expect(store.get(runtimeInitializingAtom)).toBe(true);
        expect(container.textContent).not.toContain('protected history');
        await act(async () => received.resolve());
        expect(store.get(runtimeAtom)).toBe(installed ? prepared : null);
        expect(store.get(runtimeInitializingAtom)).toBe(false);
        expect(prepared.disposed).toBe(false);
        expect(router.state.location.pathname).toBe(
          installed ? '/local/chat' : '/workspace/e2ee/local%3Aworkspace'
        );
        expect(container.textContent).toContain(
          installed ? 'protected history' : 'workspace control'
        );
      } finally {
        await act(async () => received.resolve());
      }
    }
  );

  it('does not revive a cancelled first-key admission when its receive settles late', async () => {
    ordinaryCloud();
    listEncrypted();
    const received = Promise.withResolvers<void>();
    const receiving = Promise.withResolvers<void>();
    let installed = false;
    const status = () => ({
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 1,
      hasCurrentKey: installed,
      writeEpoch: installed ? 1 : null,
      rotationRequired: false,
    });
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      open: async () => status(),
      status: async () => status(),
      refresh: async (_id, options) => {
        if (options?.installKeys) {
          receiving.resolve();
          await received.promise;
          installed = true;
        }
        return status();
      },
      close: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    try {
      await render();
      await receiving.promise;
      expect(store.get(runtimeInitializingAtom)).toBe(true);
      await act(async () => store.set(currentWorkspaceSlugAtom, null));
      await act(async () => received.resolve());
      expect(store.get(runtimeAtom)).toBeNull();
      expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
      expect(prepared.disposed).toBe(false);
    } finally {
      await act(async () => received.resolve());
    }
  });

  it('opens when a retained epoch arrives after the initial no-key lease, without requiring the current epoch', async () => {
    ordinaryCloud();
    listEncrypted();
    let retained: number | null = null;
    const status = () => ({
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 1,
      hasCurrentKey: false,
      writeEpoch: retained,
      rotationRequired: true,
    });
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      open: async () => status(),
      status: async () => status(),
      refresh: async () => status(),
      close: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    retained = 0;
    await act(async () => notifyE2eeLedgerChanged('local:user', 'local:workspace'));
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
  });

  it('opens with a retained key while current-key reception fails', async () => {
    ordinaryCloud();
    listEncrypted();
    const status = {
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 1,
      hasCurrentKey: false,
      writeEpoch: 0,
      rotationRequired: false,
    };
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      open: async () => status,
      status: async () => status,
      refresh: async () => {
        throw new Error('temporary staging failure');
      },
      seal: async () => {
        throw new Error('e2ee_key-update-required');
      },
      close: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
    // A background receive failure does not show a warning while grace saves can succeed.
    expect(container.querySelector('[role="status"]')).toBeNull();
    const content = vi.mocked(createWorkspaceRuntime).mock.calls.at(-1)?.[0].content;
    if (content?.mode !== 'protected') throw new Error('expected protected content');
    const room = content.resolve({ kind: 'doc', docId: 'retry-after-grace' });
    if (room.mode !== 'protected') throw new Error('expected protected room');
    await act(async () => {
      await expect(
        room.config.provider.seal({
          context: {
            protocol: 'loro-streams-crdt-payload-protection',
            version: 2,
            kind: 'update_batch',
          },
          plaintext: Uint8Array.of(1),
          additionalData: () => Uint8Array.of(3),
        })
      ).rejects.toThrow('e2ee_key-update-required');
    });
    environment.e2eeWorkspaces!.runtime!.refresh = async () => ({
      ...status,
      hasCurrentKey: true,
      writeEpoch: 1,
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
  });

  it('keeps the runtime and edits while delayed key reception clears through the existing installation signal', async () => {
    ordinaryCloud();
    listEncrypted();
    let installed = false;
    let resumed = false;
    const status = () => ({
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 1,
      writeEpoch: installed ? 1 : 0,
      hasCurrentKey: installed,
      rotationRequired: false,
    });
    const failure = new Error('e2ee_key-update-required');
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      open: async () => status(),
      status: async () => status(),
      close: async () => {},
      refresh: async () => {
        throw new Error('temporary key reception failure');
      },
      seal: async () => {
        if (resumed) return { header: Uint8Array.of(3), sealed: Uint8Array.of(0) };
        throw failure;
      },
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    const content = vi.mocked(createWorkspaceRuntime).mock.calls.at(-1)?.[0].content;
    if (content?.mode !== 'protected') throw new Error('expected protected content');
    const room = content.resolve({ kind: 'doc', docId: 'session' });
    if (room.mode !== 'protected') throw new Error('expected protected room');
    const request = {
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'update_batch',
      } as const,
      plaintext: new Uint8Array([1, 2, 3]),
      additionalData: () => Uint8Array.of(3),
    };
    editDraft(store);
    const before = store.get(sessionRunConfigDraftsAtom);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await act(async () => {
      await expect(room.config.provider.seal(request)).rejects.toBe(failure);
    });
    const retry = container.querySelector<HTMLButtonElement>('button')!;
    expect(retry.textContent).toBe('e2ee.content.retryKeyUpdate');
    await act(async () => {
      vi.advanceTimersByTime(29_999);
    });
    expect(container.textContent).not.toContain('e2ee.content.receivingNewKey');
    await act(async () => {
      await expect(room.config.provider.seal(request)).rejects.toBe(failure);
    });
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(container.querySelector('p[role="status"]')?.textContent).toBe(
      'e2ee.content.receivingNewKey'
    );
    expect(container.querySelector('button')).toBe(retry);
    await act(async () => retry.click());
    expect(container.querySelector('p[role="status"]')).not.toBeNull();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
    expect(store.get(sessionRunConfigDraftsAtom)).toEqual(before);
    resumed = true;
    await act(async () => {
      await room.config.provider.seal(request);
    });
    expect(container.querySelector('p[role="status"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    resumed = false;
    await act(async () => {
      await expect(room.config.provider.seal(request)).rejects.toBe(failure);
    });
    await act(async () => {
      vi.advanceTimersByTime(30_001);
    });
    expect(container.querySelector('p[role="status"]')).not.toBeNull();
    installed = true;
    await act(async () => notifyE2eeLedgerChanged('local:user', 'local:workspace'));
    expect(container.querySelector('p[role="status"]')).toBeNull();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(store.get(sessionRunConfigDraftsAtom)).toEqual(before);
  });

  it('opens an ordinary workspace before authentication, verifies it in the background and keeps it through auth refresh', async () => {
    ordinaryCloud();
    environment.session.set({ status: 'loading' });
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(store.get(workspaceContentModeAtom)).toMatchObject({
      workspaceSlug: 'local',
      descriptor: null,
    });
    await act(async () =>
      environment.session.set({ status: 'authenticated', user: { id: 'local:user' } })
    );
    expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
      contentMode: 'plaintext',
    });
    // The verdict is retained for the next offline launch.
    expect(
      readWorkspaceModeProof(localStorage, 'local:user', 'local:workspace', 'local')
    ).toMatchObject({ contentMode: 'plaintext' });
    await act(async () => environment.session.set({ status: 'loading' }));
    await act(async () =>
      environment.session.set({ status: 'authenticated', user: { id: 'local:user' } })
    );
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
    expect(createWorkspaceRuntime).toHaveBeenCalledTimes(1);
  });

  it('opens an ordinary workspace offline from its cached ID without a mode proof', async () => {
    ordinaryCloud();
    store.set(currentWorkspaceIdAtom, null);
    environment.e2eeWorkspaces!.describe = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      await render();
      expect(store.get(runtimeAtom)).toBe(prepared);
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(store.get(runtimeAtom)).toBe(prepared);
      expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
      expect(store.get(workspaceContentModeAtom)).toMatchObject({
        workspaceId: 'local:workspace',
        descriptor: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires a provisional runtime when background verification finds an encrypted workspace', async () => {
    ordinaryCloud();
    const mode = Promise.withResolvers<ReturnType<typeof encryptedDescriptor>>();
    environment.e2eeWorkspaces!.describe = () => mode.promise;
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () => mode.resolve(encryptedDescriptor('local:workspace')));
    expect(store.get(runtimeAtom)).toBeNull();
    expect(prepared.disposed).toBe(true);
    expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({ contentMode: 'e2ee' });
    // The learned mode is sticky: a later restart for an unrelated reason
    // (account token refresh, local-agent setting) never opens plaintext.
    await render();
    environment.mode = 'dual';
    await render();
    environment.mode = 'cloud';
    await render();
    await act(async () => store.set(workspaceModeAdmissionRetryAtom, 1));
    expect(createWorkspaceRuntime).toHaveBeenCalledTimes(1);
    expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({ contentMode: 'e2ee' });
  });

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

  it.each(['plaintext', 'legacy'] as const)(
    'never admits a %s answer for a workspace whose encrypted identity the device host retains',
    async (kind) => {
      ordinaryCloud();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      environment.e2eeWorkspaces!.describe = async ({ workspaceId }) =>
        kind === 'legacy'
          ? { workspaceId, admission: 'legacy-unclassified' }
          : { workspaceId, contentMode: 'plaintext', contentModeVersion: 1 };
      hostIdentity(async () => ({ workspaceId: 'local:workspace', genesisHash: '11'.repeat(32) }));
      await render();
      const gate = vi.mocked(createWorkspaceRuntime).mock.calls[0]![0].waitForContentAdmission!;
      await expect(gate(new AbortController().signal)).rejects.toThrow();
      expect(store.get(runtimeAtom)).toBeNull();
      expect(prepared.disposed).toBe(true);
      expect(store.get(workspaceContentModeAtom)).toBeNull();
      // The host's genesis is now local evidence: no later start opens provisionally.
      expect(
        readWorkspaceModeEvidence(localStorage, 'local:user', 'local:workspace')
      ).toMatchObject({ encrypted: true, descriptor: null });
      await act(async () => store.set(workspaceModeAdmissionRetryAtom, 1));
      expect(createWorkspaceRuntime).toHaveBeenCalledTimes(1);
      expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
        modeAdmission: { knownEncrypted: true },
      });
    }
  );

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

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
          options?.keyMode === 'none'
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

  it('installs a rotated epoch key announced by a ledger hint on a host whose bare refresh skips keys', async () => {
    ordinaryCloud();
    listEncrypted();
    let epoch = 0,
      installed = 0;
    const status = () => ({
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch,
      hasCurrentKey: installed === epoch,
      writeEpoch: installed,
      rotationRequired: false,
    });
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    // The portable host's contract: without `keyMode`, no key round runs.
    environment.e2eeWorkspaces!.runtime = {
      open: async () => status(),
      status: async () => status(),
      refresh: async (_workspace: string, options?: E2eeRefreshOptions) => {
        const mode = options?.keyMode ?? 'none';
        if (mode === 'receive' || mode === 'full') installed = epoch;
        return status();
      },
      close: async () => {},
      seal: async (_workspace: string, input: { epoch: number }) => ({
        header: new Uint8Array([3]),
        sealed: new Uint8Array([input.epoch]),
      }),
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    const content = vi.mocked(createWorkspaceRuntime).mock.calls.at(-1)![0].content!;
    if (content.mode !== 'protected') throw new Error('expected encrypted content');
    const room = content.resolve({ kind: 'doc', docId: 'rotated-room' });
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
    // Another device rotated: the hint's status shows an epoch whose key is not installed.
    epoch = 1;
    await act(async () => notifyE2eeLedgerChanged('local:user', 'local:workspace'));
    expect(installed).toBe(1);
    expect((await room.config.provider.seal(request)).sealed).toEqual(new Uint8Array([1]));
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

  it('refreshes native access on ledger hints and releases the subscription with its reader', async () => {
    ordinaryCloud();
    listEncrypted();
    let local = {
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      length: 1,
      headHash: '33'.repeat(32),
      epoch: 0,
      hasCurrentKey: true,
      rotationRequired: false,
    };
    let changed!: Parameters<NonNullable<PlatformE2eeWorkspaces['subscribeLedgerHead']>>[1];
    let subscribed = false;
    let refreshes = 0;
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.subscribeLedgerHead = (_input, listener) => {
      changed = listener;
      subscribed = true;
      return () => {
        subscribed = false;
      };
    };
    environment.e2eeWorkspaces!.runtime = {
      open: async () => local,
      status: async () => local,
      refresh: async () => {
        refreshes++;
        return local;
      },
      close: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    expect(subscribed).toBe(true);
    const before = refreshes;
    const hint = (workspaceId = 'local:workspace') =>
      changed({
        workspaceId,
        genesisHash: local.genesisHash,
        checkpoint: { length: local.length, headHash: local.headHash },
      });
    await act(async () => hint());
    expect(refreshes).toBe(before);
    local = { ...local, length: 2, headHash: '44'.repeat(32) };
    await act(async () => hint('another-workspace'));
    expect(refreshes).toBe(before);
    await act(async () => hint());
    expect(refreshes).toBe(before + 1);
    expect(store.get(runtimeAtom)).toBe(prepared);
    await act(async () => hint());
    expect(refreshes).toBe(before + 1);
    await act(async () => root.render(null));
    expect(subscribed).toBe(false);
    expect(prepared.disposed).toBe(true);
    local = { ...local, length: 3 };
    await act(async () => hint());
    expect(refreshes).toBe(before + 1);
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
    expect(
      vi.mocked(createWorkspaceRuntime).mock.calls.map(([options]) => options.syncMode)
    ).toEqual(['cloud']);
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
    expect(
      vi.mocked(createWorkspaceRuntime).mock.calls.map(([options]) => options.syncMode)
    ).toEqual(['cloud', 'dual']);
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
          if (options?.keyMode && options.keyMode !== 'none') {
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
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await act(async () => received.resolve());
        if (!installed) {
          expect(store.get(runtimeInitializingAtom)).toBe(true);
          expect(router.state.location.pathname).toBe('/local/chat');
          await act(async () => vi.advanceTimersByTimeAsync(15_000));
        }
        vi.useRealTimers();
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
        if (options?.keyMode && options.keyMode !== 'none') {
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

  const lateKeyRuntime = (arrivesOnRefresh: number, fail?: (refresh: number) => Error | null) => {
    ordinaryCloud();
    listEncrypted();
    let onHead: ((head: unknown) => void) | undefined;
    let headLength = 1;
    const counter = {
      refreshes: 0,
      ledgerHint: () =>
        act(async () => {
          onHead?.({
            workspaceId: 'local:workspace',
            genesisHash: '11'.repeat(32),
            checkpoint: { length: ++headLength, headHash: 'aa'.repeat(32) },
          });
          await vi.advanceTimersByTimeAsync(0);
        }),
    };
    const status = () => ({
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      length: 1,
      headHash: 'bb'.repeat(32),
      epoch: 1,
      hasCurrentKey: counter.refreshes >= arrivesOnRefresh,
      writeEpoch: counter.refreshes >= arrivesOnRefresh ? 1 : null,
      rotationRequired: false,
    });
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      open: async () => status(),
      status: async () => status(),
      refresh: async () => {
        counter.refreshes++;
        const error = fail?.(counter.refreshes);
        if (error) throw error;
        return status();
      },
      close: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    environment.e2eeWorkspaces!.subscribeLedgerHead = (_scope, next) => {
      onHead = next as (head: unknown) => void;
      return () => {};
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    return counter;
  };
  const advanceFirstKeyPolls = async () => {
    for (const delay of [1_000, 2_000, 4_000, 8_000])
      await act(async () => vi.advanceTimersByTimeAsync(delay));
  };

  it('opens once a late mailbox key arrives on a backoff re-poll', async () => {
    lateKeyRuntime(3);
    await render();
    expect(store.get(runtimeAtom)).toBeNull();
    expect(store.get(runtimeInitializingAtom)).toBe(true);
    await advanceFirstKeyPolls();
    expect(store.get(runtimeAtom)).toBe(prepared);
  });

  it('spends the bounded re-polls only on its own timer, never on external refreshes', async () => {
    const counter = lateKeyRuntime(Infinity);
    await render();
    for (let i = 0; i < 6; i++) await counter.ledgerHint();
    expect(counter.refreshes).toBe(7);
    expect(store.get(runtimeInitializingAtom)).toBe(true);
    await advanceFirstKeyPolls();
    expect(counter.refreshes).toBe(11);
    expect(store.get(runtimeAtom)).toBeNull();
    expect(store.get(runtimeInitializingAtom)).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(counter.refreshes).toBe(11);
  });

  it('stops re-polling for the first key once the runtime retires', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const counter = lateKeyRuntime(Infinity, (refresh) =>
      refresh === 2
        ? new Error("Error invoking remote method 'e2ee.refresh': Error: e2ee_device_revoked")
        : null
    );
    await render();
    await counter.ledgerHint();
    expect(counter.refreshes).toBe(2);
    expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
      errorType: 'e2ee_device_revoked',
    });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(counter.refreshes).toBe(2);
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
});

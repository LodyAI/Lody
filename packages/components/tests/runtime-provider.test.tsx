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
// @vitest-environment jsdom

import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  mode: 'local',
  e2eeWorkspaces: undefined as PlatformE2eeWorkspaces | undefined,
  cachedWorkspaceId: null as string | null,
  workspace: { id: 'local:workspace', slug: 'local' } as { id: string; slug: string } | null,
  session: undefined as unknown as MutableStore<PlatformSessionState>,
  workspaces: undefined as unknown as MutableStore<WorkspacesState>,
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
vi.mock('@/lib/desktop-window', () => ({
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
vi.mock('../src/components/chat/session-pending-sends-host', () => ({
  SessionPendingSendsHost: () => null,
}));
vi.mock('@/providers/create-workspace-runtime', () => ({ createWorkspaceRuntime: vi.fn() }));

import { RuntimeProvider } from '../src/providers/runtime-provider';
import { createWorkspaceRuntime } from '../src/providers/create-workspace-runtime';
import { currentWorkspaceSlugAtom, currentWorkspaceIdAtom, userAtom } from '../src/atoms';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { resolveLegacyWorkspaceQueryStatus } from '../src/lib/legacy-workspace-admission';
import {
  readWorkspaceModeProof,
  repairUnreadableE2eeCaches,
  retainWorkspaceModeProof,
  saveE2eeGenesisPin,
  savePendingE2eeWorkspace,
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
  let container: HTMLDivElement;
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
    'keeps the local replica and resumes or offers retry after background refresh %s',
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
      if (outcome === 'success') expect(container.querySelector('[role="status"]')).toBeNull();
      else
        expect(container.querySelector('[role="status"]')?.textContent).toContain(
          'e2ee.content.keyUpdateRequired'
        );
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

  it('retires the local replica when native credential refresh confirms member removal', async () => {
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
      rejectRefresh(
        new Error("Error invoking remote method 'e2ee.refresh': Error: e2ee_member_removed")
      )
    );
    expect(store.get(runtimeAtom)).toBeNull();
    expect(prepared.disposed).toBe(true);
    expect(closed).toBe(true);
    expect(store.get(workspaceRuntimeInitFailureAtom)).toMatchObject({
      errorType: 'e2ee_member_removed',
    });
    await resumeEncryptedWorkspaceCleanup({
      accountId: 'local:user',
      workspaceId: 'local:workspace',
      windowId: 'test-window',
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
    });
    vi.unstubAllGlobals();
  });

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

  it('shows automatic snapshot recovery while retaining the workspace, then clears it after a valid read', async () => {
    ordinaryCloud();
    listEncrypted();
    let valid = false;
    const status = {
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 0,
      hasCurrentKey: true,
      rotationRequired: false,
    };
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      open: async () => status,
      refresh: async () => status,
      status: async () => status,
      openContent: async () => {
        if (!valid) throw new Error('snapshot rejected');
        return new Uint8Array([7]);
      },
      contentStreamsToken: async () => ({}),
      close: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    const content = vi.mocked(createWorkspaceRuntime).mock.calls.at(-1)![0].content;
    if (content.mode !== 'protected') throw new Error('expected protected content');
    const room = content.resolve({ kind: 'meta' });
    if (room.mode !== 'protected') throw new Error('expected protected room');
    const context = {
      protocol: 'loro-streams-crdt-payload-protection' as const,
      version: 2 as const,
      kind: 'snapshot' as const,
      continuationOffset: '000001',
    };
    const request = {
      context,
      header: new Uint8Array([4]),
      sealed: new Uint8Array([1]),
      additionalData: new Uint8Array([2]),
    };
    await act(async () => {
      await expect(room.config.provider.open(request)).rejects.toThrow('snapshot rejected');
      content.snapshotUpload.onSnapshotRecovery!(
        'https://streams.invalid/ds/encrypted/local%3Aworkspace%3Ameta',
        true
      );
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'e2ee.content.snapshotRecoveryPending'
    );
    expect(store.get(runtimeAtom)).toBe(prepared);
    valid = true;
    await act(async () => {
      await room.config.provider.open(request);
      content.snapshotUpload.onSnapshotRecovery!(
        'https://streams.invalid/ds/encrypted/local%3Aworkspace%3Ameta',
        false
      );
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(prepared.disposed).toBe(false);
  });

  it('installs a missing current key at cold open before any content sessions exist', async () => {
    ordinaryCloud();
    listEncrypted();
    let installed = false;
    const status = () => ({
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
      epoch: 1,
      hasCurrentKey: installed,
      rotationRequired: false,
    });
    environment.e2eeWorkspaces!.describe = async () => encryptedDescriptor('local:workspace');
    environment.e2eeWorkspaces!.runtime = {
      open: async () => status(),
      refresh: async (_workspaceId, options) => {
        if (options?.installKeys !== false) installed = true;
        return status();
      },
      status: async () => status(),
      close: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    expect(installed).toBe(true);
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
      close: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'e2ee.content.keyUpdateRequired'
    );
    environment.e2eeWorkspaces!.runtime!.refresh = async () => ({
      ...status,
      hasCurrentKey: true,
      writeEpoch: 1,
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="status"] button')!.click()
    );
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
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

  it('keeps an ordinary runtime when background verification fails without describing a mode', async () => {
    ordinaryCloud();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    environment.e2eeWorkspaces!.describe = async () => {
      throw new Error('Offline');
    };
    await render();
    expect(store.get(runtimeAtom)).toBe(prepared);
    expect(prepared.disposed).toBe(false);
    expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
  });

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

  // Temporary targeted reproduction at eee7db758f1b211cc0d71df93c0f99a70b014f60.
  // Visibility hooks are mocked in this suite; their real loading projections
  // are checked separately in workspace-legacy-queries.test.tsx.
  function legacyQueryStatus() {
    return resolveLegacyWorkspaceQueryStatus({
      workspaceId: 'local:workspace',
      platformKind: 'cloud',
      mode: store.get(workspaceContentModeAtom),
      runtime: store.get(runtimeAtom),
      accountId: 'local:user',
      currentWorkspaceId: store.get(currentWorkspaceIdAtom),
      routeSlug: store.get(currentWorkspaceSlugAtom),
      workspacesState: environment.workspaces.get(),
    });
  }

  it('targeted reproduction: access denied stays pending in a stable window, then recovers on online', async () => {
    ordinaryCloud();
    vi.useFakeTimers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = Promise.withResolvers<Awaited<ReturnType<PlatformE2eeWorkspaces['describe']>>>();
    const failure = new ConvexError({ code: 'workspace_access_denied' });
    const remote = environment.e2eeWorkspaces!.describe;
    let reads = 0;
    environment.e2eeWorkspaces!.describe = (request) => {
      reads++;
      return reads === 1 ? first.promise : remote(request);
    };
    try {
      expect(
        readWorkspaceModeProof(localStorage, 'local:user', 'local:workspace', 'local')
      ).toBeNull();
      await render();
      const original = store.get(runtimeAtom);
      expect(original).toBe(prepared);
      const gate = vi.mocked(createWorkspaceRuntime).mock.calls[0]![0].waitForContentAdmission!;
      // Observe the in-flight admission before explicitly rejecting describe.
      const rejected = expect(gate(new AbortController().signal)).rejects.toBe(failure);
      await act(async () => {
        first.reject(failure);
        await rejected;
      });
      expect(store.get(workspaceContentModeAtom)?.descriptor).toBeNull();
      expect(legacyQueryStatus()).toBe('pending');
      expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
      expect(reads).toBe(1);

      // The remote is now healthy. Token and route stay unchanged; there is no
      // send, online event, new proof, remount or page reload in this window.
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(reads).toBe(1);
      expect(store.get(workspaceContentModeAtom)?.descriptor).toBeNull();
      expect(legacyQueryStatus()).toBe('pending');
      expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
      expect(
        readWorkspaceModeProof(localStorage, 'local:user', 'local:workspace', 'local')
      ).toBeNull();
      expect(store.get(runtimeAtom)).toBe(original);

      // Online itself drives recovery: do not call the send/content gate first.
      await act(async () => window.dispatchEvent(new Event('online')));
      expect(reads).toBe(2);
      expect(legacyQueryStatus()).toBe('allowed');
      expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
        contentMode: 'plaintext',
      });
      expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
      expect(store.get(runtimeAtom)).toBe(original);
      expect(prepared.disposed).toBe(false);
      expect(prepared.metadata.get('session')).toBe('already prepared');
      expect(createWorkspaceRuntime).toHaveBeenCalledTimes(1);
      await expect(gate(new AbortController().signal)).resolves.toBeUndefined();
    } finally {
      logged.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    ['network TypeError', () => new TypeError('Failed to fetch')],
    [
      'opaque CONVEX Server Error',
      () =>
        new Error(
          '[CONVEX Q(e2eeWorkspaces:describe)] [Request ID: synthetic] Server Error\nUnexpected server failure'
        ),
    ],
  ] as const)(
    'targeted reproduction: %s recovers through backoff without an external edge',
    async (_kind, makeError) => {
      ordinaryCloud();
      vi.useFakeTimers();
      const remote = environment.e2eeWorkspaces!.describe;
      const started = Date.now();
      const attempts: number[] = [];
      environment.e2eeWorkspaces!.describe = async (request) => {
        attempts.push(Date.now() - started);
        if (attempts.length <= 2) throw makeError();
        return remote(request);
      };
      try {
        await render();
        const original = store.get(runtimeAtom);
        expect(original).toBe(prepared);
        const gate = vi.mocked(createWorkspaceRuntime).mock.calls[0]![0].waitForContentAdmission!;
        let admitted = false;
        const admission = gate(new AbortController().signal).then(() => {
          admitted = true;
        });
        expect(attempts).toEqual([0]);
        expect(legacyQueryStatus()).toBe('pending');
        await act(async () => vi.advanceTimersByTimeAsync(249));
        expect(attempts).toEqual([0]);
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(attempts).toEqual([0, 250]);
        await act(async () => vi.advanceTimersByTimeAsync(499));
        expect(attempts).toEqual([0, 250]);
        expect(admitted).toBe(false);
        expect(store.get(workspaceContentModeAtom)?.descriptor).toBeNull();
        expect(legacyQueryStatus()).toBe('pending');
        expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
          await admission;
        });
        expect(attempts).toEqual([0, 250, 750]);
        expect(admitted).toBe(true);
        expect(legacyQueryStatus()).toBe('allowed');
        expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
          contentMode: 'plaintext',
        });
        expect(store.get(workspaceRuntimeInitFailureAtom)).toBeNull();
        expect(store.get(runtimeAtom)).toBe(original);
        expect(prepared.disposed).toBe(false);
        expect(createWorkspaceRuntime).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
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

  it('keeps the verified mode through a same-workspace restart', async () => {
    ordinaryCloud();
    listEncrypted();
    retainWorkspaceModeProof(localStorage, 'local:user', 'local', {
      workspaceId: 'local:workspace',
      contentMode: 'plaintext',
      contentModeVersion: 1,
    });
    await render();
    const replacement = runtimeFixture();
    vi.mocked(createWorkspaceRuntime).mockResolvedValue(replacement as never);
    const modes: unknown[] = [];
    const unsubscribe = store.sub(workspaceContentModeAtom, () =>
      modes.push(store.get(workspaceContentModeAtom))
    );
    await act(async () => store.set(workspaceModeAdmissionRetryAtom, 1));
    unsubscribe();
    expect(prepared.disposed).toBe(true);
    expect(store.get(runtimeAtom)).toBe(replacement);
    expect(modes).not.toContain(null);
    expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({
      contentMode: 'plaintext',
    });
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

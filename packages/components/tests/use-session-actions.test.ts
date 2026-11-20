// @vitest-environment jsdom
import { cloudOperations } from '../src/lib/cloud-api-operations';
import { buildVisibleMachineIndex } from '../src/lib/visible-machine-index';
import { useVisibleSessionMetas } from '../src/hooks/use-visible-session-metas';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { userAtom } from '../src/atoms';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import {
  createSessionSendResources,
  type SessionSendResources,
} from '../src/lib/session-send-resources';
import {
  createPendingSessionSends,
  type PendingSessionSend,
  type PendingSessionSends,
} from '../src/lib/session-pending-sends';
import { deliverUserTurn, writeUserTurn } from '../src/lib/session-send-delivery';
import { finalizePreparedSend } from '../src/lib/session-attachment-preparation';
import type { SessionAttachmentDraft } from '../src/lib/session-attachment-draft';
import { applyHistoryAction } from '../../shared/src/session-data/history-actions';
import type { HistoryAction, SessionEntry } from '@lody/shared/session-data';

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';
import { LoroDoc } from 'loro-crdt';
import {
  FREE_SESSION_LIMIT_PER_WORKSPACE,
  SESSION_DOC_PREFIX,
  getMachineRoomId,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  getSessionRoomId,
  getSessionCancelRequestMarker,
  createSessionControlPlaneMirror,
  isLoroRepoDocDeleted,
  machineFlockKeys,
  type LocalProjectId,
  readSessionOperationTargets,
  isSessionCollaborationStopped,
  type MachineId,
  type SessionHistory,
  type SessionId,
  type SessionMeta,
  type SessionToCreate,
  type WorkspaceId,
} from '@lody/shared';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStaticStore,
  createStore as createPlatformStore,
  type PlatformSessionState,
  type CloudApi,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';

const visibilityIndexOverride = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../src/hooks/use-visible-machine-metas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks/use-visible-machine-metas')>();
  return {
    ...actual,
    useVisibleMachineMetas: (...args: Parameters<typeof actual.useVisibleMachineMetas>) =>
      visibilityIndexOverride.current ?? actual.useVisibleMachineMetas(...args),
  };
});
function VisibilityProbe({
  onReady,
}: {
  onReady: (value: ReturnType<typeof useVisibleSessionMetas>) => void;
}) {
  const value = useVisibleSessionMetas();
  useEffect(() => onReady(value), [onReady, value]);
  return null;
}

const { sendIpcMock } = vi.hoisted(() => ({ sendIpcMock: vi.fn() }));

vi.mock('@/lib/auth-bootstrap', () => ({
  readBootstrappedCurrentUser: () => null,
  readStoredAuthToken: () => null,
}));

vi.mock('../src/lib/electron-ipc-client', () => ({
  sendIpc: sendIpcMock,
}));

const recordMyWorkspaceDailyActiveUser = vi.fn(async () => ({}));
const requestAuthRecovery = vi.fn();
const convexAuthState = { isAuthenticated: true };
const billingEntitlementState = {
  effectivePlanTier: 'plus' as 'free' | 'plus',
  checkoutPending: false,
};

// useSessionActions now consumes the platform seam, so the harness must make
// its cloud dependencies explicit. Rejected: teaching usePlatform() a test-only
// implicit default, which would hide missing production assembly as well.
const testCloudApi = {
  useQuery: (operation, args) =>
    args !== 'skip' && operation.name.startsWith('billing:') ? billingEntitlementState : undefined,
  useMutation: () => recordMyWorkspaceDailyActiveUser,
  useAction: () => vi.fn(async () => undefined),
} as CloudApi;
const testPlatform: PlatformProvider = {
  kind: 'cloud',
  identity: {
    session: createStaticStore({ status: 'unauthenticated' }),
    signOut: () => Promise.resolve(),
  },
  workspaces: {
    state: createStaticStore({
      status: 'ready',
      workspaces: [],
      activeWorkspaceId: null,
    }),
    setActive: () => Promise.resolve(),
  },
  capabilities: CLOUD_PLATFORM_CAPABILITIES,
  cloudApi: testCloudApi,
  sync: { mode: 'cloud' },
};

vi.mock('convex/react', () => ({
  useMutation: vi.fn(() => recordMyWorkspaceDailyActiveUser),
  useQueries: vi.fn(() => ({
    query: billingEntitlementState,
  })),
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({
    isAuthenticated: convexAuthState.isAuthenticated,
    requestAuthRecovery,
  }),
}));

import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '../src/atoms/presence';
import {
  SessionArchiveConfirmationDialog,
  useArchiveSessionWithConfirmation,
} from '../src/components/sessions/session-archive-confirmation';
import { initI18n } from '../src/i18n';
import { docMetaCacheReadyAtom, sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import {
  editSessionRunConfigDraftAtom,
  registerSessionRunConfigDraftLeaseAtom,
  sessionRunConfigDraftsAtom,
  setSessionRunConfigDraftAccountAtom,
} from '../src/atoms/session-run-config-drafts';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import {
  developerModeEnabledAtom,
  experimentalFeaturesEnabledAtom,
  roostHistoryExperimentEnabledAtom,
} from '../src/atoms/settings';
import {
  SessionCreateBillingError,
  useSessionActions,
  type SessionActions,
} from '../src/hooks/use-session-actions';
import { buildResendInputBlocks } from '../src/lib/undelivered-user-turn';
import {
  createDeferred,
  editRunConfigDraft,
  sessionDataOver,
  imageDraft,
  uploadedImage,
  whenPendingSends,
  whenSessionDrained,
  whenAborted,
  createContainmentSessions,
  createSessionMetaRepo,
} from './use-session-actions-test-helpers';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ConfirmedArchive = (sessionId: SessionId, options?: { confirm?: boolean }) => Promise<boolean>;

function ConfirmedArchiveProbe({ onReady }: { onReady: (archive: ConfirmedArchive) => void }) {
  const archive = useArchiveSessionWithConfirmation(useSessionActions().archiveSession);
  useEffect(() => {
    onReady(archive);
  }, [archive, onReady]);
  return createElement(SessionArchiveConfirmationDialog);
}

function ActionsProbe({ onReady }: { onReady: (actions: SessionActions) => void }) {
  const actions = useSessionActions();
  useEffect(() => {
    onReady(actions);
  }, [actions, onReady]);
  return null;
}

const sendResourceOwners = new Set<SessionSendResources>();
const pendingSendOwners = new Set<PendingSessionSends>();

/**
 * One attachment preparation held by the fake `prepare` port. The test settles
 * it explicitly; by default an abort rejects it, like the production port.
 */
type HeldPreparation = {
  send: PendingSessionSend;
  signal: AbortSignal;
  /** Resolve with every attachment ready (a synthetic uploaded image). */
  finish(): void;
  fail(message?: string): void;
};
const heldPreparations: HeldPreparation[] = [];
/** Sessions whose held preparations ignore cancellation until the test settles them. */
const preparationsIgnoringAbort = new Set<string>();

function holdPreparation(send: PendingSessionSend, signal: AbortSignal) {
  return new Promise<Pick<PendingSessionSend, 'entry' | 'queue' | 'attachments'>>(
    (resolve, reject) => {
      heldPreparations.push({
        send,
        signal,
        finish: () =>
          resolve(
            finalizePreparedSend({
              ...send,
              attachments: send.attachments.map((attachment) =>
                attachment.ready ? attachment : { ...attachment, ready: uploadedImage(attachment) }
              ),
            })
          ),
        fail: (message = 'upload failed') => reject(new Error(message)),
      });
      if (!preparationsIgnoringAbort.has(send.sessionId))
        signal.addEventListener('abort', () =>
          reject(new DOMException('Attachment operation aborted', 'AbortError'))
        );
    }
  );
}

const createRuntime = (
  overrides: Partial<
    Pick<
      WorkspaceRuntime,
      | 'ensureDocStream'
      | 'repo'
      | 'workspaceId'
      | 'workspaceSlug'
      | 'writer'
      | 'readSessionOperationTargets'
    >
  >
): WorkspaceRuntime => {
  const repo =
    overrides.repo ??
    ({
      upsertDocMeta: vi.fn(async () => undefined),
      getDocMeta: vi.fn(async (roomId: string) => ({
        meta: {
          id: roomId.slice(SESSION_DOC_PREFIX.length),
          machineId: 'machine-1',
          protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
        },
      })),
    } as unknown as WorkspaceRuntime['repo']);

  const sessionHistory: unknown[] = [];
  if (!repo.flush) Object.defineProperty(repo, 'flush', { value: async () => {} });

  // Default direct-mode writer: durable primitives delegate to the repo mock so
  // existing `repo.upsertDocMeta` / `repo.deleteDoc` assertions keep asserting
  // the authored write, and the session-turn/history appends push into the shared
  // history array the withSessionStore mock reads back. Override `writer` to test
  // intent mode.
  const repoAsAny = repo as unknown as {
    upsertDocMeta?: (...args: unknown[]) => Promise<void>;
    deleteDoc?: (...args: unknown[]) => Promise<void>;
    openFlockDoc?: (...args: unknown[]) => unknown;
  };
  const writer =
    overrides.writer ??
    ({
      modeForMachine: () => 'direct' as const,
      modeForSession: async () => 'direct' as const,
      upsertDocMeta: vi.fn(async (roomId: string, patch: Record<string, unknown>) => {
        await repoAsAny.upsertDocMeta?.(roomId, patch);
      }),
      startSession: vi.fn(
        async (
          _sessionId: string,
          _meta: Record<string, unknown>,
          entry: Record<string, unknown>
        ) => {
          sessionHistory.push(entry);
          return 'direct' as const;
        }
      ),
      deleteDoc: vi.fn(async (roomId: string) => {
        await repoAsAny.deleteDoc?.(roomId);
      }),
      flockRowPut: vi.fn(async () => undefined),
      flockRowDelete: vi.fn(async () => undefined),
      appendSessionTurn: vi.fn(async (_sessionId: string, entry: Record<string, unknown>) => {
        sessionHistory.push(entry);
        return 'direct' as const;
      }),
      appendSessionHistory: vi.fn(async (_sessionId: string, entry: Record<string, unknown>) => {
        sessionHistory.push(entry);
      }),
      enqueueSessionMessage: vi.fn(async () => undefined),
      removeSessionMessage: vi.fn(async () => undefined),
      updateSessionMessage: vi.fn(async () => undefined),
      reorderSessionMessages: vi.fn(async () => undefined),
    } as unknown as WorkspaceRuntime['writer']);

  const runtime = {
    accountId: 'user-1',
    workspaceSlug: overrides.workspaceSlug ?? 'workspace-slug',
    workspaceId: overrides.workspaceId ?? ('workspace-1' as WorkspaceId),
    repo,
    writer,
    readSessionOperationTargets:
      overrides.readSessionOperationTargets ??
      ((sessionId, operation) => readSessionOperationTargets(repo, sessionId, operation)),
    ensureDocStream: overrides.ensureDocStream ?? vi.fn(async () => undefined),
    releaseSessionStore: vi.fn(async () => undefined),
    // Best-effort fast paths default to a timeout; tests replace them.
    requestSessionDispatchTurn: vi.fn(async () => undefined),
    requestSessionSteer: vi.fn(async () => undefined),
    withSessionStore: vi.fn(async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
      fn({
        getState: vi.fn(() => ({ history: sessionHistory })),
        sessionData: sessionDataOver(sessionHistory),
        setState: vi.fn((updater: (draft: { history: unknown[] }) => void) => {
          updater({ history: sessionHistory });
        }),
        waitUntilSynced: vi.fn(async () => undefined),
      })
    ),
  } as unknown as WorkspaceRuntime;
  const resources = createSessionSendResources({
    acquire: (sessionId) => runtime.withSessionStore(sessionId, (store) => store),
    releaseRef: () => {},
  });
  sendResourceOwners.add(resources);
  Object.defineProperty(runtime, 'sendResources', { value: resources });
  // The real in-memory queue with the real write/delivery; only attachment
  // preparation is held by the test.
  const pendingSends = createPendingSessionSends({
    prepare: (send, signal) => holdPreparation(send, signal),
    write: (send, signal) =>
      runtime.sendResources.run((owned) => writeUserTurn(runtime, send, owned), signal),
    deliver: (send) => deliverUserTurn(runtime, send),
  });
  pendingSendOwners.add(pendingSends);
  Object.defineProperty(runtime, 'pendingSends', { value: pendingSends });
  return runtime;
};

const createSessionPayload = (sessionId: SessionId): SessionToCreate =>
  ({
    sessionId,
    userId: 'user-1',
    machineId: 'machine-1',
    cliType: 'builtin',
    agentType: 'codex',
    agentConfigId: 'agent-1',
    env: {},
  }) as Parameters<typeof actions.createSession>[0];

describe('useSessionActions', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    visibilityIndexOverride.current = null;
    heldPreparations.length = 0;
    preparationsIgnoringAbort.clear();
    recordMyWorkspaceDailyActiveUser.mockClear();
    requestAuthRecovery.mockClear();
    sendIpcMock.mockClear();
    convexAuthState.isAuthenticated = true;
    billingEntitlementState.effectivePlanTier = 'plus';
    billingEntitlementState.checkoutPending = false;
  });

  afterEach(async () => {
    for (const pending of pendingSendOwners) pending.dispose();
    pendingSendOwners.clear();
    await Promise.all([...sendResourceOwners].map((resources) => resources.dispose()));
    sendResourceOwners.clear();
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const renderActions = async (
    runtime: WorkspaceRuntime,
    options: {
      workspaceId?: WorkspaceId | null;
      workspaceSlug?: string | null;
      docMetaCacheReady?: boolean;
      sessionMetaCache?: Record<string, SessionMeta>;
      store?: ReturnType<typeof createStore>;
      identitySession?: PlatformProvider['identity']['session'];
      sessionAccess?: PlatformProvider['sessionAccess'];
      onVisibility?: (value: ReturnType<typeof useVisibleSessionMetas>) => void;
    } = {}
  ): Promise<SessionActions> => {
    const jotaiStore = options.store ?? createStore();
    const accountId = runtime.accountId ?? 'synthetic-session-account';
    if (
      !visibilityIndexOverride.current &&
      runtime.contentMode !== 'e2ee' &&
      !options.sessionAccess
    ) {
      const rows = runtime.repo.listDoc ? await runtime.repo.listDoc({}).catch(() => []) : [];
      const cached = Object.values(options.sessionMetaCache ?? {});
      const rawMachines = Object.values(jotaiStore.get(machineMetaCacheAtom));
      const ids = new Set<MachineId>([
        'machine-1' as MachineId,
        ...cached.map((meta) => meta.machineId),
        ...rows.flatMap((row) =>
          typeof row.meta.machineId === 'string' ? [row.meta.machineId as MachineId] : []
        ),
        ...rawMachines.map((row) => row.id),
      ]);
      const access = new Map(
        [...ids].map((machineId) => [
          machineId,
          { machineId, ownerUserId: accountId, sharedWithTeam: false, updatedAt: 1 },
        ])
      );
      const explicit = testCloudApi.useQuery(cloudOperations.machines.listVisibleMachines, {
        workspaceId: runtime.workspaceId,
      }) as
        | {
            machineId: MachineId;
            ownerUserId: string;
            sharedWithTeam: boolean;
            updatedAt: number;
          }[]
        | undefined;
      for (const row of explicit ?? []) access.set(row.machineId, row);
      for (const row of rawMachines)
        access.set(row.id, {
          machineId: row.id,
          ownerUserId: row.ownerUserId ?? accountId,
          sharedWithTeam: false,
          updatedAt: 1,
        });
      visibilityIndexOverride.current = {
        machines: new Map(),
        accessByMachineId: access,
        isLoading: false,
      };
      const read = runtime.repo.getDocMeta?.bind(runtime.repo);
      // Lifecycle-only fixtures previously omitted authority fields. Give those
      // synthetic documents an explicit owning machine; security fixtures retain
      // their real metadata and explicit visibility indexes.
      if (read)
        runtime.repo.getDocMeta = async (id) => {
          const row = await read(id);
          return row && Object.keys(row.meta).length > 0 && typeof row.meta.machineId !== 'string'
            ? {
                ...row,
                meta: {
                  id: id.slice(SESSION_DOC_PREFIX.length),
                  machineId: 'machine-1',
                  ...row.meta,
                },
              }
            : row;
        };
    }
    jotaiStore.set(runtimeAtom, runtime);
    jotaiStore.set(docMetaCacheReadyAtom, options.docMetaCacheReady ?? true);
    jotaiStore.set(sessionMetaCacheAtom, options.sessionMetaCache ?? {});
    jotaiStore.set(currentWorkspaceIdAtom, options.workspaceId ?? ('workspace-1' as WorkspaceId));
    jotaiStore.set(currentWorkspaceSlugAtom, options.workspaceSlug ?? 'workspace-slug');
    jotaiStore.set(userAtom, { id: accountId } as never);
    jotaiStore.set(workspaceContentModeAtom, {
      accountId,
      workspaceId: options.workspaceId ?? 'workspace-1',
      workspaceSlug: options.workspaceSlug ?? 'workspace-slug',
      descriptor: {
        workspaceId: options.workspaceId ?? 'workspace-1',
        contentMode: runtime.contentMode ?? 'plaintext',
        contentModeVersion: 1,
      },
    });

    const platform: PlatformProvider = {
      ...testPlatform,
      sessionAccess: options.sessionAccess,
      identity: {
        ...testPlatform.identity,
        session:
          options.identitySession ??
          createStaticStore({ status: 'authenticated', user: { id: accountId } }),
      },
    };
    let actions: SessionActions | null = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          PlatformContext.Provider,
          { value: platform },
          createElement(
            Provider,
            { store: jotaiStore },
            createElement(ActionsProbe, {
              onReady: (nextActions) => {
                actions = nextActions;
              },
            }),
            options.onVisibility
              ? createElement(VisibilityProbe, { onReady: options.onVisibility })
              : null
          )
        )
      );
    });

    if (!actions) {
      throw new Error('Session actions were not initialized');
    }
    return actions;
  };

  it.each(['plaintext', 'e2ee'] as const)(
    'permits only personal read preferences on a shared read-only session (%s)',
    async (contentMode) => {
      const repo = await LoroRepo.create({});
      const id = 'read-shared' as SessionId;
      const meta = {
        id,
        machineId: 'private-machine' as MachineId,
        userId: 'other-session-owner',
        title: 'Original',
        lastMessageAt: 100,
      } as SessionMeta;
      await repo.upsertDocMeta(getSessionRoomId(id), meta);
      visibilityIndexOverride.current = {
        machines: new Map(),
        accessByMachineId: new Map(),
        isLoading: false,
      };
      let shared = true;
      const view = () => ({
        machineId: meta.machineId,
        canManage: false,
        readSharedSessionIds: shared ? [id] : [],
      });
      const runtime = createRuntime({
        repo,
        writer: createDirectWorkspaceWriter({ repo } as never),
      });
      Object.assign(runtime, { contentMode, accountId: 'synthetic-session-account' });
      const actions = await renderActions(runtime, {
        sessionMetaCache: { [getSessionRoomId(id)]: meta },
        sessionAccess: {
          read: async () => view(),
          list: async () => [view()],
          set: async () => {
            throw new Error('not-owned');
          },
          subscribe: () => () => {},
        },
      });
      try {
        await expect(actions.updateSessionTitle(id, 'Forbidden')).rejects.toMatchObject({
          code: 'session_management_denied',
        });
        await expect(
          actions.addSessionHistory(id, {
            role: 'user',
            timestamp: new Date(0).toISOString(),
            items: [{ type: 'text', text: 'Forbidden input' }],
            fileDiff: [],
          })
        ).rejects.toMatchObject({ code: 'session_management_denied' });
        await expect(
          actions.createSession({ parentSessionId: id } as Parameters<
            typeof actions.createSession
          >[0])
        ).rejects.toMatchObject({ code: 'session_management_denied' });
        await expect(actions.archiveSession(id)).rejects.toMatchObject({
          code: 'session_management_denied',
        });
        await expect(actions.deleteSessions([id])).rejects.toMatchObject({
          code: 'session_management_denied',
        });
        expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toEqual(meta);
        await actions.setSessionPinned(id, true);
        await actions.markSessionUnread(id);
        expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toMatchObject({
          title: 'Original',
          isPinned: true,
          lastReadAt: 99,
        });
        shared = false;
        await expect(actions.setSessionPinned(id, false)).rejects.toMatchObject({
          code: 'session_management_denied',
        });
      } finally {
        await repo.destroy();
      }
    }
  );

  it.each(['plaintext', 'e2ee'] as const)(
    'does not trust a conflicting Loro machine owner (%s)',
    async (contentMode) => {
      const repo = await LoroRepo.create({});
      const id = 'conflicting-owner' as SessionId;
      const meta = {
        id,
        machineId: 'conflicting-machine',
        userId: 'other-member',
        project: { kind: 'local', localProjectId: 'private-project' },
      } as SessionMeta;
      const raw = { id: meta.machineId, ownerUserId: 'synthetic-session-account' } as never;
      const index = buildVisibleMachineIndex({
        rawMachines: new Map([[meta.machineId, raw]]),
        convexAccessRows: [
          {
            machineId: meta.machineId,
            ownerUserId: 'other-member',
            sharedWithTeam: false,
            updatedAt: 1,
          },
        ],
        currentUserId: 'synthetic-session-account',
        isLoading: false,
      });
      visibilityIndexOverride.current = {
        ...index,
        convexAuthorizedMachineIds: new Set([meta.machineId]),
        machineFlockRemoteSyncedMachineIds: new Set(),
      };
      await repo.upsertDocMeta(getSessionRoomId(id), meta);
      const runtime = createRuntime({
        repo,
        writer: createDirectWorkspaceWriter({ repo } as never),
      });
      Object.assign(runtime, { contentMode, accountId: 'synthetic-session-account' });
      const store = createStore();
      store.set(machineMetaCacheAtom, { [getMachineRoomId(meta.machineId)]: raw });
      let visibility: ReturnType<typeof useVisibleSessionMetas> | undefined;
      const actions = await renderActions(runtime, {
        store,
        sessionMetaCache: { [getSessionRoomId(id)]: meta },
        onVisibility: (value) => {
          visibility = value;
        },
      });
      try {
        if (contentMode === 'plaintext') {
          expect(visibility?.sessions).toEqual([]);
        } else {
          // Private encrypted history is hidden unless explicitly shared.
          expect(visibility?.sessions).toEqual([]);
          expect(visibility?.historyOnlySessionIds.has(id)).toBe(false);
          await expect(actions.updateSessionTitle(id, 'Unauthorized')).rejects.toMatchObject({
            code: 'session_management_denied',
          });
          expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toEqual(meta);
        }
      } finally {
        await repo.destroy();
      }
    }
  );

  it('rejects a private-machine owner transfer without changing metadata or sharing', async () => {
    const repo = await LoroRepo.create({});
    const id = 'private-transfer' as SessionId;
    const meta = {
      id,
      machineId: 'private-machine',
      userId: 'synthetic-session-account',
    } as SessionMeta;
    await repo.upsertDocMeta(getSessionRoomId(id), meta);
    const runtime = createRuntime({ repo, writer: createDirectWorkspaceWriter({ repo } as never) });
    const store = createStore();
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(meta.machineId)]: { id: meta.machineId, ownerUserId: meta.userId } as never,
    });
    const actions = await renderActions(runtime, { store });
    try {
      await expect(actions.transferSessionOwner(id, 'colleague')).rejects.toThrow();
      expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toEqual(meta);
      expect(store.get(machineMetaCacheAtom)[getMachineRoomId(meta.machineId)]).toEqual({
        id: meta.machineId,
        ownerUserId: meta.userId,
      });
    } finally {
      await repo.destroy();
    }
  });

  it.each([false, true])(
    'requires local-project sharing as well as machine sharing (%s)',
    async (sharedWithTeam) => {
      const repo = await LoroRepo.create({});
      const id = 'shared-transfer' as SessionId;
      const meta = {
        id,
        machineId: 'shared-machine',
        userId: 'synthetic-session-account',
        project: { kind: 'local', localProjectId: 'project' },
      } as SessionMeta;
      const machineAccess = {
        machineId: meta.machineId,
        ownerUserId: meta.userId,
        sharedWithTeam: true,
        updatedAt: 1,
      };
      const originalQuery = testCloudApi.useQuery;
      vi.spyOn(testCloudApi, 'useQuery').mockImplementation(((operation, args) => {
        if (args !== 'skip' && operation.name === 'machines:listVisibleMachines')
          return [machineAccess];
        if (args !== 'skip' && operation.name === 'localProjects:listVisibleLocalProjects')
          return [{ ...machineAccess, localProjectId: 'project', sharedWithTeam }];
        return originalQuery(operation, args);
      }) as typeof testCloudApi.useQuery);
      await repo.upsertDocMeta(getSessionRoomId(id), meta);
      const runtime = createRuntime({
        repo,
        writer: createDirectWorkspaceWriter({ repo } as never),
      });
      const actions = await renderActions(runtime);
      try {
        if (sharedWithTeam) {
          await actions.transferSessionOwner(id, 'colleague');
          expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toMatchObject({
            ...meta,
            userId: 'colleague',
          });
        } else {
          await expect(actions.transferSessionOwner(id, 'colleague')).rejects.toThrow();
          expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toEqual(meta);
        }
      } finally {
        await repo.destroy();
      }
    }
  );

  it.each(['plaintext', 'e2ee'] as const)(
    'lets the machine owner reclaim a transferred session without sharing its machine (%s)',
    async (contentMode) => {
      const repo = await LoroRepo.create({});
      const id = 'reclaim-transfer' as SessionId;
      const meta = { id, machineId: 'private-machine', userId: 'colleague' } as SessionMeta;
      await repo.upsertDocMeta(getSessionRoomId(id), meta);
      const runtime = createRuntime({
        repo,
        writer: createDirectWorkspaceWriter({ repo } as never),
      });
      Object.assign(runtime, { contentMode, accountId: 'synthetic-session-account' });
      const store = createStore();
      store.set(machineMetaCacheAtom, {
        [getMachineRoomId(meta.machineId)]: {
          id: meta.machineId,
          ownerUserId: 'synthetic-session-account',
        } as never,
      });
      const actions = await renderActions(runtime, { store });
      if (contentMode === 'e2ee') await act(async () => store.set(userAtom, null));
      try {
        await actions.transferSessionOwner(id, 'synthetic-session-account');
        expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toMatchObject({
          ...meta,
          userId: 'synthetic-session-account',
        });
      } finally {
        await repo.destroy();
      }
    }
  );

  it.each([
    'archive',
    'restore',
    'delete',
    'rename',
    'pin',
    'close',
    'owner',
    'bulk-delete',
    'cancel',
    'activity',
    'unread',
    'move',
    'collaboration',
  ] as const)(
    'refuses history-only management through the shared action: %s',
    async (operation) => {
      const repo = await LoroRepo.create({});
      const id = 'foreign-history' as SessionId;
      const childId = 'foreign-child' as SessionId;
      const rootMeta = {
        id,
        machineId: 'unshared-machine',
        userId: 'another-member',
        title: 'History',
        lastMessageAt: 2,
        isArchived: operation === 'restore' || operation === 'delete',
      } as SessionMeta;
      const childMeta = { ...rootMeta, id: childId, parentSessionId: id };
      await repo.upsertDocMeta(getSessionRoomId(id), rootMeta);
      await repo.upsertDocMeta(getSessionRoomId(childId), childMeta);
      const runtime = createRuntime({
        repo,
        writer: createDirectWorkspaceWriter({ repo } as never),
        readSessionOperationTargets: (target, kind) =>
          readSessionOperationTargets(repo, target, kind),
      });
      Object.assign(runtime, { contentMode: 'e2ee', accountId: 'synthetic-session-account' });
      const actions = await renderActions(runtime);
      const run = {
        archive: () => actions.archiveSession(id),
        restore: () => actions.restoreSession(id),
        delete: () => actions.deleteArchivedSession(id),
        rename: () => actions.updateSessionTitle(id, 'Changed'),
        pin: () => actions.setSessionPinned(id, true),
        close: () => actions.setSessionTabClosed(id, true),
        owner: () => actions.transferSessionOwner(id, 'synthetic-session-account'),
        'bulk-delete': () => actions.deleteSessions([id, childId]),
        cancel: () => actions.requestSessionCancel(id, 'turn'),
        activity: () => actions.touchSessionActivity(id),
        unread: () => actions.markSessionUnread(id),
        move: () => actions.updateSessionMetadata(id, { projectGroup: { id: 'other-group' } }),
        collaboration: () => actions.setTreeCollaborationStopped(id, true),
      }[operation];
      try {
        await expect(run()).rejects.toMatchObject({ code: 'session_management_denied' });
        expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toEqual(rootMeta);
        expect((await repo.getDocMeta(getSessionRoomId(childId)))?.meta).toEqual(childMeta);
      } finally {
        await repo.destroy();
      }
    }
  );

  it.each(['archive', 'restore', 'delete'] as const)(
    'preflights a manageable root and denied child before any tree mutation: %s',
    async (operation) => {
      const repo = await LoroRepo.create({});
      const id = 'owned-root' as SessionId;
      const rootMeta = {
        id,
        machineId: 'unshared-machine',
        userId: 'synthetic-session-account',
        title: 'Own root',
      } as SessionMeta;
      const childMeta = {
        ...rootMeta,
        id: 'foreign-child' as SessionId,
        userId: 'another-member',
        parentSessionId: id,
      };
      await repo.upsertDocMeta(getSessionRoomId(id), rootMeta);
      await repo.upsertDocMeta(getSessionRoomId(childMeta.id), childMeta);
      const runtime = createRuntime({
        repo,
        writer: createDirectWorkspaceWriter({ repo } as never),
        readSessionOperationTargets: (target, kind) =>
          readSessionOperationTargets(repo, target, kind),
      });
      Object.assign(runtime, { contentMode: 'e2ee', accountId: 'synthetic-session-account' });
      const actions = await renderActions(runtime);
      try {
        await expect(
          {
            archive: actions.archiveSession,
            restore: actions.restoreSession,
            delete: actions.deleteArchivedSession,
          }[operation](id)
        ).rejects.toMatchObject({ code: 'session_management_denied' });
        expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toEqual(rootMeta);
        expect((await repo.getDocMeta(getSessionRoomId(childMeta.id)))?.meta).toEqual(childMeta);
      } finally {
        await repo.destroy();
      }
    }
  );

  it('retains encrypted machine-owner management and rejects metadata/project edits after machine reassignment', async () => {
    visibilityIndexOverride.current = {
      machines: new Map(),
      accessByMachineId: new Map([
        [
          'unshared-machine',
          {
            machineId: 'unshared-machine',
            ownerUserId: 'synthetic-session-account',
            sharedWithTeam: false,
            updatedAt: 1,
          },
        ],
      ]),
      isLoading: false,
    };
    const repo = await LoroRepo.create({});
    const id = 'owned-history' as SessionId;
    const meta = {
      id,
      machineId: 'unshared-machine',
      userId: 'synthetic-session-account',
      title: 'Original',
    } as SessionMeta;
    const child = { ...meta, id: 'owned-child' as SessionId, parentSessionId: id };
    await repo.upsertDocMeta(getSessionRoomId(id), meta);
    await repo.upsertDocMeta(getSessionRoomId(child.id), child);
    const runtime = createRuntime({
      repo,
      writer: createDirectWorkspaceWriter({ repo } as never),
      readSessionOperationTargets: (target, kind) =>
        readSessionOperationTargets(repo, target, kind),
    });
    Object.assign(runtime, { contentMode: 'e2ee', accountId: 'synthetic-session-account' });
    const actions = await renderActions(runtime, {
      sessionMetaCache: { [getSessionRoomId(id)]: meta },
    });
    try {
      await actions.updateSessionTitle(id, 'Changed');
      await actions.setSessionPinned(id, true);
      await actions.archiveSession(id);
      expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toMatchObject({
        title: 'Changed',
        isPinned: true,
        isArchived: true,
      });
      expect((await repo.getDocMeta(getSessionRoomId(child.id)))?.meta?.isArchived).toBe(true);
      await actions.restoreSession(id);
      expect((await repo.getDocMeta(getSessionRoomId(child.id)))?.meta?.isArchived).toBe(false);
      // Cache still claims ownership. Current Repo state must decide each new action.
      await repo.upsertDocMeta(getSessionRoomId(id), {
        machineId: 'different-machine',
        userId: 'different-member',
      });
      await expect(
        actions.updateSessionMetadata(id, { projectGroup: { id: 'another-group' } })
      ).rejects.toMatchObject({ code: 'session_management_denied' });
      await expect(actions.updateSessionTitle(id, 'Stolen')).rejects.toMatchObject({
        code: 'session_management_denied',
      });
      expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta?.title).toBe('Changed');
      expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta?.projectGroup).toBeUndefined();
    } finally {
      await repo.destroy();
    }
  });

  it('preflights a mixed exact-ID batch before deleting any owned or history-only session', async () => {
    const repo = await LoroRepo.create({});
    const own = {
      id: 'batch-owned' as SessionId,
      machineId: 'unshared-machine',
      userId: 'synthetic-session-account',
      title: 'Own',
    } as SessionMeta;
    const foreign = { ...own, id: 'batch-foreign' as SessionId, userId: 'different-member' };
    for (const meta of [own, foreign]) await repo.upsertDocMeta(getSessionRoomId(meta.id), meta);
    const runtime = createRuntime({ repo, writer: createDirectWorkspaceWriter({ repo } as never) });
    Object.assign(runtime, { contentMode: 'e2ee', accountId: 'synthetic-session-account' });
    const actions = await renderActions(runtime);
    try {
      await expect(actions.deleteSessions([own.id, foreign.id])).rejects.toMatchObject({
        code: 'session_management_denied',
      });
      for (const meta of [own, foreign])
        expect((await repo.getDocMeta(getSessionRoomId(meta.id)))?.meta).toEqual(meta);
    } finally {
      await repo.destroy();
    }
  });

  it.each(['account', 'workspace', 'runtime', 'logout'] as const)(
    'fences a retained management callback when %s changes during its Repo read',
    async (changed) => {
      const repo = await LoroRepo.create({});
      const id = 'held-rename' as SessionId;
      const meta = {
        id,
        machineId: 'unshared-machine',
        userId: 'synthetic-session-account',
        title: 'Original',
      } as SessionMeta;
      await repo.upsertDocMeta(getSessionRoomId(id), meta);
      const runtime = createRuntime({
        repo,
        writer: createDirectWorkspaceWriter({ repo } as never),
      });
      Object.assign(runtime, { contentMode: 'e2ee', accountId: 'synthetic-session-account' });
      const state = createStore();
      const identity = createPlatformStore<PlatformSessionState>({
        status: 'authenticated',
        user: { id: 'synthetic-session-account' },
      });
      const actions = await renderActions(runtime, { store: state, identitySession: identity });
      const reached = createDeferred();
      const release = createDeferred();
      const originalRead = repo.getDocMeta.bind(repo);
      vi.spyOn(repo, 'getDocMeta').mockImplementationOnce(async (room) => {
        reached.resolve();
        await release.promise;
        return originalRead(room);
      });
      const refused = expect(
        actions.updateSessionTitle(id, 'Stale account write')
      ).rejects.toMatchObject({ code: 'session_management_denied' });
      try {
        await reached.promise;
        await act(async () => {
          if (changed === 'account') state.set(userAtom, { id: 'different-account' } as never);
          else if (changed === 'workspace')
            state.set(currentWorkspaceIdAtom, 'different-workspace' as WorkspaceId);
          else if (changed === 'runtime') state.set(runtimeAtom, { ...runtime });
          else {
            identity.set({ status: 'unauthenticated' });
            state.set(userAtom, null);
          }
        });
        release.resolve();
        await refused;
        expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toEqual(meta);
      } finally {
        release.resolve();
        await repo.destroy();
      }
    }
  );

  it('preflights related opened conversations and parent activity before changing owned metadata', async () => {
    const repo = await LoroRepo.create({});
    const own = {
      id: 'owned-root-with-relations' as SessionId,
      machineId: 'unshared-machine',
      userId: 'synthetic-session-account',
      title: 'Own',
    } as SessionMeta;
    const foreign = {
      ...own,
      id: 'foreign-opened' as SessionId,
      openedBySessionId: own.id,
      userId: 'different-member',
    };
    const child = {
      ...own,
      id: 'owned-child-with-foreign-parent' as SessionId,
      parentSessionId: foreign.id,
    };
    for (const meta of [own, foreign, child])
      await repo.upsertDocMeta(getSessionRoomId(meta.id), meta);
    const runtime = createRuntime({
      repo,
      writer: createDirectWorkspaceWriter({ repo } as never),
      readSessionOperationTargets: (target, kind) =>
        readSessionOperationTargets(repo, target, kind),
    });
    Object.assign(runtime, { contentMode: 'e2ee', accountId: 'synthetic-session-account' });
    const actions = await renderActions(runtime);
    try {
      await expect(
        actions.archiveSession(own.id, { includeOpenedSessions: true })
      ).rejects.toMatchObject({ code: 'session_management_denied' });
      await expect(actions.touchSessionActivity(child.id)).rejects.toMatchObject({
        code: 'session_management_denied',
      });
      for (const meta of [own, foreign, child])
        expect((await repo.getDocMeta(getSessionRoomId(meta.id)))?.meta).toEqual(meta);
    } finally {
      await repo.destroy();
    }
  });

  it('retains management with a bound local identity during uncertain cloud authentication', async () => {
    visibilityIndexOverride.current = {
      machines: new Map(),
      accessByMachineId: new Map([
        [
          'unshared-machine',
          {
            machineId: 'unshared-machine',
            ownerUserId: 'synthetic-session-account',
            sharedWithTeam: false,
            updatedAt: 1,
          },
        ],
      ]),
      isLoading: false,
    };
    const repo = await LoroRepo.create({});
    const id = 'offline-owned-history' as SessionId;
    await repo.upsertDocMeta(getSessionRoomId(id), {
      id,
      machineId: 'unshared-machine',
      userId: 'synthetic-session-account',
      title: 'Original',
    });
    const runtime = createRuntime({ repo, writer: createDirectWorkspaceWriter({ repo } as never) });
    Object.assign(runtime, { contentMode: 'e2ee', accountId: 'synthetic-session-account' });
    const actions = await renderActions(runtime, {
      identitySession: createStaticStore({ status: 'unauthenticated', uncertain: true }),
    });
    try {
      await actions.updateSessionTitle(id, 'Offline edit');
      expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta?.title).toBe('Offline edit');
    } finally {
      await repo.destroy();
    }
  });

  it('uses released Stop wire fields and turn marker when the target has no Inbox capability', async () => {
    const sessionId = 'legacy-stop' as SessionId;
    const metaRepo = createSessionMetaRepo([
      { id: sessionId, machineId: 'old-machine', userId: 'user-1' } as SessionMeta,
    ]);
    const runtime = createRuntime({ repo: metaRepo.repo });
    const received: unknown[] = [];
    runtime.requestSessionCancel = async (_machine, _session, turnId, options) => {
      expect(Object.keys(options ?? {})).toEqual(['timeoutMs']);
      received.push(turnId);
      return { success: true } as never;
    };
    const actions = await renderActions(runtime);
    await actions.requestSessionCancel(sessionId, 'assistant-legacy');
    expect(received).toEqual(['assistant-legacy']);
    expect(metaRepo.getSession(sessionId)?.lastCanceledTurn).toBe('assistant-legacy');
  });

  it('interrupts without a Stop identity so queued input keeps its eligibility', async () => {
    const sessionId = 'session-interrupt' as SessionId;
    const metaRepo = createSessionMetaRepo([
      { id: sessionId, machineId: 'machine-1', userId: 'user-1' } as SessionMeta,
    ]);
    metaRepo.setMeta(getMachineRoomId('machine-1'), {
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    });
    const doc = new LoroDoc();
    const control = createSessionControlPlaneMirror({
      doc,
      initialState: { session: { id: sessionId } },
    });
    const runtime = createRuntime({ repo: metaRepo.repo });
    runtime.withSessionStore = async (_id, fn) =>
      fn({ ...control, sessionData: sessionDataOver([]) } as never);
    const rpcOptions: unknown[] = [];
    runtime.requestSessionCancel = async (_machine, _session, _turnId, options) => {
      rpcOptions.push(options);
      return { success: true } as never;
    };
    try {
      const actions = await renderActions(runtime);
      await actions.requestSessionCancel(sessionId, 'assistant-running', { interrupt: true });

      expect(rpcOptions).toEqual([{ timeoutMs: 2_000, pauseInbox: false }]);
      expect(control.getState().cancelRequest?.id).toBeUndefined();
      expect(metaRepo.getSession(sessionId)?.lastCanceledTurn).toBe('assistant-running');
    } finally {
      control.dispose();
    }
  });

  it('persists Stop details before publishing only its marker, and reuses the request on RPC', async () => {
    const sessionId = 'session-stop-control' as SessionId;
    const metaRepo = createSessionMetaRepo([
      {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        createdAt: '2026-10-13T00:00:00.000Z',
        cliType: 'builtin',
        agentType: 'codex',
      },
    ]);
    metaRepo.setMeta(getMachineRoomId('machine-1'), {
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    });
    const doc = new LoroDoc();
    const control = createSessionControlPlaneMirror({
      doc,
      initialState: { session: { id: sessionId } },
    });
    const runtime = createRuntime({ repo: metaRepo.repo });
    runtime.withSessionStore = async (_id, fn) =>
      fn({ ...control, sessionData: sessionDataOver([]) } as never);
    const flushEntered = createDeferred();
    const durable = createDeferred();
    let holdFlush = true;
    runtime.repo.flush = async () => {
      if (holdFlush) {
        flushEntered.resolve();
        await durable.promise;
      }
    };
    const rpcReceipts: { turnId: string; cancelId?: string }[] = [];
    runtime.requestSessionCancel = async (_machine, _session, turnId, options) => {
      rpcReceipts.push({ turnId, cancelId: options?.cancelId });
      return undefined; // RPC timeout/loss still leaves a complete durable request.
    };
    try {
      const actions = await renderActions(runtime);
      const stopped = actions.requestSessionCancel(sessionId, 'assistant-stop');
      await flushEntered.promise;
      expect(control.getState().cancelRequest?.turnId).toBe('assistant-stop');
      expect(metaRepo.getSession(sessionId)?.lastCanceledTurn).toBeUndefined();
      expect(rpcReceipts).toEqual([
        {
          turnId: 'assistant-stop',
          cancelId: control.getState().cancelRequest!.id,
        },
      ]);
      holdFlush = false;
      durable.resolve();
      await stopped;
      const first = control.getState().cancelRequest!;
      expect(metaRepo.getSession(sessionId)?.lastCanceledTurn).toBe(
        getSessionCancelRequestMarker(first.id)
      );
      expect(Object.keys(metaRepo.getSession(sessionId)!)).toEqual([
        'id',
        'machineId',
        'userId',
        'createdAt',
        'cliType',
        'agentType',
        'lastCanceledTurn',
      ]);
      expect(rpcReceipts).toEqual([{ turnId: 'assistant-stop', cancelId: first.id }]);

      await actions.requestSessionCancel(sessionId, 'assistant-stop');
      const second = control.getState().cancelRequest!;
      expect(second.id).not.toBe(first.id);
      expect(metaRepo.getSession(sessionId)?.lastCanceledTurn).toBe(
        getSessionCancelRequestMarker(second.id)
      );
      const reopened = new LoroDoc();
      reopened.import(doc.export({ mode: 'snapshot' }));
      const reopenedControl = createSessionControlPlaneMirror({
        doc: reopened,
        initialState: { session: { id: sessionId } },
      });
      try {
        expect(reopenedControl.getState().cancelRequest).toMatchObject({
          id: second.id,
          turnId: 'assistant-stop',
        });
      } finally {
        reopenedControl.dispose();
      }
    } finally {
      durable.resolve();
      control.dispose();
    }
  });

  it('stops and restores the whole authoritative tree from a leaf, including hidden descendants', async () => {
    const tree = createContainmentSessions('collaboration', false);
    const unrelated = { ...tree.rootSession, id: 'unrelated' as SessionId };
    const metaRepo = createSessionMetaRepo([...tree.sessions, unrelated]);
    for (const session of [...tree.sessions, unrelated]) {
      metaRepo.setMeta(getMachineRoomId(session.machineId), {
        id: session.machineId,
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      });
    }
    const actions = await renderActions(createRuntime({ repo: metaRepo.repo }), {
      sessionMetaCache: {},
    });
    await actions.setTreeCollaborationStopped(tree.openedFromTabSession.id, true);
    for (const session of tree.sessions) {
      expect(metaRepo.getSession(session.id)?.collaborationStopped).toBe(true);
    }
    expect(metaRepo.getSession(unrelated.id)?.collaborationStopped).toBeUndefined();
    const lateChild = 'late-child' as SessionId;
    metaRepo.setMeta(getSessionRoomId(lateChild), {
      ...tree.openedSession,
      id: lateChild,
      openedBySessionId: tree.rootSession.id,
    });
    expect(await isSessionCollaborationStopped(metaRepo.repo, lateChild)).toBe(true);
    await actions.setTreeCollaborationStopped(tree.rootSession.id, false);
    for (const id of [...tree.sessions.map((session) => session.id), lateChild]) {
      expect(await isSessionCollaborationStopped(metaRepo.repo, id)).toBe(false);
    }
  });

  it('rejects collaboration control before writes when a target daemon lacks support', async () => {
    const tree = createContainmentSessions('unsupported-collaboration', false);
    const metaRepo = createSessionMetaRepo(tree.sessions);
    const actions = await renderActions(createRuntime({ repo: metaRepo.repo }));
    await expect(actions.setTreeCollaborationStopped(tree.rootSession.id, true)).rejects.toThrow(
      'Update every machine'
    );
    expect(
      tree.sessions.map((session) => metaRepo.getSession(session.id)?.collaborationStopped)
    ).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('does not block session creation on remote stream pre-creation', async () => {
    const sessionId = 'session-create-stream-pending' as SessionId;
    const streamCreate = createDeferred();
    const ensureDocStream = vi.fn(() => streamCreate.promise);
    const upsertDocMeta = vi.fn(async () => undefined);
    const runtime = createRuntime({
      ensureDocStream,
      repo: { upsertDocMeta } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime);

    const result = await actions.createSession(createSessionPayload(sessionId));

    expect(result).toEqual(
      expect.objectContaining({
        sessionId,
        sessionMeta: expect.objectContaining({ id: sessionId }),
      })
    );
    expect(upsertDocMeta).toHaveBeenCalledWith(
      getSessionRoomId(sessionId),
      expect.objectContaining({ id: sessionId })
    );
    expect(ensureDocStream).toHaveBeenCalledWith(getSessionRoomId(sessionId));

    streamCreate.resolve();
    await streamCreate.promise;
  });

  it('blocks a new free session when the Flock metadata cache is at the limit', async () => {
    billingEntitlementState.effectivePlanTier = 'free';
    const sessionMetaCache = Object.fromEntries(
      Array.from({ length: FREE_SESSION_LIMIT_PER_WORKSPACE }, (_, index) => {
        const id = `existing-session-${index}` as SessionId;
        return [
          getSessionRoomId(id),
          {
            id,
            machineId: 'machine-1',
            userId: 'user-1',
            status: { type: 'idle' },
            isArchived: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            cliType: 'builtin',
            agentType: 'codex',
            agentConfigId: 'agent-1',
          } as SessionMeta,
        ];
      })
    );
    const runtime = createRuntime({});
    const actions = await renderActions(runtime, {
      docMetaCacheReady: true,
      sessionMetaCache,
    });

    await expect(
      actions.createSession(createSessionPayload('new-session-over-limit' as SessionId))
    ).rejects.toMatchObject({
      code: 'free_session_limit_reached',
      current: FREE_SESSION_LIMIT_PER_WORKSPACE,
      limit: FREE_SESSION_LIMIT_PER_WORKSPACE,
    } satisfies Partial<SessionCreateBillingError>);
  });

  it('fails open while the Flock metadata cache is still loading', async () => {
    billingEntitlementState.effectivePlanTier = 'free';
    const sessionMetaCache = Object.fromEntries(
      Array.from({ length: FREE_SESSION_LIMIT_PER_WORKSPACE }, (_, index) => {
        const id = `loading-session-${index}` as SessionId;
        return [getSessionRoomId(id), { id } as SessionMeta];
      })
    );
    const runtime = createRuntime({});
    const actions = await renderActions(runtime, {
      docMetaCacheReady: false,
      sessionMetaCache,
    });

    await expect(
      actions.createSession(createSessionPayload('new-session-while-loading' as SessionId))
    ).resolves.toMatchObject({ sessionId: 'new-session-while-loading' });
  });

  it('does not mutate through a runtime from a different workspace slug', async () => {
    const sessionId = 'session-create-stale-runtime' as SessionId;
    const upsertDocMeta = vi.fn(async () => undefined);
    const runtime = createRuntime({
      workspaceSlug: 'previous-workspace',
      repo: { upsertDocMeta } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime, {
      workspaceId: null,
      workspaceSlug: 'workspace-slug',
    });

    await expect(actions.createSession(createSessionPayload(sessionId))).rejects.toThrow(
      'Runtime not ready'
    );
    expect(upsertDocMeta).not.toHaveBeenCalled();
  });

  it('marks a session unread by moving only its read receipt behind the latest message', async () => {
    const sessionId = 'session-mark-unread' as SessionId;
    const upsertDocMeta = vi.fn(async () => undefined);
    const sessionMeta = {
      ...createSessionPayload(sessionId),
      id: sessionId,
      createdAt: '2026-09-04T00:00:00.000Z',
      lastMessageAt: 500,
      lastReadAt: 500,
    } as SessionMeta;
    let metadataReady = false;
    const runtime = createRuntime({
      repo: {
        // The sidebar's rendered cache can lead the async repo read during
        // hydration; the visible row's action must still work in that window.
        getDocMeta: vi.fn(async () =>
          metadataReady ? { meta: { ...sessionMeta, machineId: 'machine-1' } } : undefined
        ),
        upsertDocMeta,
      } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime, {
      sessionMetaCache: { [getSessionRoomId(sessionId)]: sessionMeta },
    });

    await expect(actions.markSessionUnread(sessionId)).rejects.toMatchObject({
      code: 'session_management_denied',
    });
    expect(upsertDocMeta).not.toHaveBeenCalled();
    metadataReady = true;
    await actions.markSessionUnread(sessionId);

    expect(upsertDocMeta).toHaveBeenCalledWith(getSessionRoomId(sessionId), {
      lastReadAt: 499,
    });
  });

  it('does not invent activity when marking an empty session unread', async () => {
    const sessionId = 'empty-session-mark-unread' as SessionId;
    const upsertDocMeta = vi.fn(async () => undefined);
    const runtime = createRuntime({
      repo: {
        getDocMeta: vi.fn(async () => ({
          meta: {
            ...createSessionPayload(sessionId),
            id: sessionId,
            createdAt: '2026-09-04T00:00:00.000Z',
          } as SessionMeta,
        })),
        upsertDocMeta,
      } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime);

    await actions.markSessionUnread(sessionId);

    expect(upsertDocMeta).not.toHaveBeenCalled();
  });

  it('starts dispatch RPC without waiting for the metadata pointer write', async () => {
    const sessionId = 'session-dispatch-parallel' as SessionId;
    const userTurnId = 'user-turn-dispatch-parallel';
    const machineId = 'machine-1' as MachineId;
    const metaWrite = createDeferred();
    const history = [
      {
        id: userTurnId,
        role: 'user',
        userId: 'user-1',
        timestamp: '2026-07-03T00:00:00.000Z',
        status: 'pending',
        read: false,
        inputConfig: {
          prompt: 'hello',
          inputBlocks: [{ type: 'text', text: 'hello' }],
          cliType: 'builtin',
          agentType: 'codex',
        },
      },
    ];
    const control: { humanInputReceipts?: Record<string, { userId: string }> } = {};
    const setState = (update: (draft: typeof control) => void) => update(control);
    const waitUntilSynced = vi.fn(async () => undefined);
    const upsertDocMeta = vi.fn(() => metaWrite.promise);
    const requestSessionDispatchTurn = vi.fn(async () => ({
      type: 'session/dispatch-turn_response' as const,
      sessionId,
      userTurnId,
      accepted: true,
      disposition: 'accepted' as const,
    }));
    const runtime = createRuntime({
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: { machineId } })),
        upsertDocMeta,
      } as unknown as WorkspaceRuntime['repo'],
    }) as WorkspaceRuntime & {
      withSessionStore: WorkspaceRuntime['withSessionStore'];
      requestSessionDispatchTurn: WorkspaceRuntime['requestSessionDispatchTurn'];
    };
    runtime.withSessionStore = vi.fn(async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
      fn({
        getState: vi.fn(() => ({ history })),
        sessionData: sessionDataOver(history),
        setState,
        waitUntilSynced,
      })
    ) as unknown as WorkspaceRuntime['withSessionStore'];
    runtime.requestSessionDispatchTurn =
      requestSessionDispatchTurn as WorkspaceRuntime['requestSessionDispatchTurn'];
    const actions = await renderActions(runtime);

    const dispatchPromise = actions.requestSessionDispatch(sessionId, userTurnId, {
      machineId,
    });
    await vi.waitFor(() => expect(requestSessionDispatchTurn).toHaveBeenCalledTimes(1));

    expect(upsertDocMeta).toHaveBeenCalledWith(getSessionRoomId(sessionId), {
      latestUserMsgId: userTurnId,
    });
    expect(control.humanInputReceipts?.[userTurnId]).toEqual({ userId: 'user-1' });
    expect(waitUntilSynced).toHaveBeenCalledTimes(1);

    metaWrite.resolve();
    await dispatchPromise;
    expect(requestSessionDispatchTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps a later activation watermark and advances an older one across a long history', async () => {
    const sessionId = 'session-dispatch-watermark' as SessionId;
    const machineId = 'machine-1' as MachineId;
    // Far more turns than one tail page, so the two turns sit pages apart.
    const history = Array.from({ length: 300 }, (_, index) => ({
      id: `turn-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      userId: 'user-1',
      timestamp: '2026-07-03T00:00:00.000Z',
      status: 'pending',
      read: false,
      inputConfig: {
        prompt: 'hello',
        inputBlocks: [{ type: 'text', text: 'hello' }],
        cliType: 'builtin',
        agentType: 'codex',
      },
    }));
    const meta: { machineId: MachineId; latestUserMsgId?: string } = { machineId };
    const runtime = createRuntime({
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: { ...meta } })),
        upsertDocMeta: vi.fn(async (_roomId: string, patch: { latestUserMsgId?: string }) => {
          Object.assign(meta, patch);
        }),
      } as unknown as WorkspaceRuntime['repo'],
    }) as WorkspaceRuntime & {
      withSessionStore: WorkspaceRuntime['withSessionStore'];
      requestSessionDispatchTurn: WorkspaceRuntime['requestSessionDispatchTurn'];
    };
    const control: { humanInputReceipts?: Record<string, { userId: string }> } = {};
    runtime.withSessionStore = vi.fn(async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
      fn({
        getState: vi.fn(() => ({ history })),
        sessionData: sessionDataOver(history),
        setState: (update: (draft: typeof control) => void) => update(control),
        waitUntilSynced: vi.fn(async () => undefined),
      })
    ) as unknown as WorkspaceRuntime['withSessionStore'];
    runtime.requestSessionDispatchTurn = vi.fn(async (_sessionId, userTurnId) => ({
      type: 'session/dispatch-turn_response' as const,
      sessionId,
      userTurnId,
      accepted: true,
      disposition: 'accepted' as const,
    })) as unknown as WorkspaceRuntime['requestSessionDispatchTurn'];
    const actions = await renderActions(runtime);

    meta.latestUserMsgId = 'turn-298';
    await actions.requestSessionDispatch(sessionId, 'turn-0', { machineId });
    expect(meta.latestUserMsgId).toBe('turn-298');

    meta.latestUserMsgId = 'turn-0';
    await actions.requestSessionDispatch(sessionId, 'turn-298', { machineId });
    expect(meta.latestUserMsgId).toBe('turn-298');
  });

  it('resolves when the metadata write fails after RPC fast-path delivery', async () => {
    const sessionId = 'session-dispatch-meta-fail-delivered' as SessionId;
    const userTurnId = 'user-turn-meta-fail-delivered';
    const machineId = 'machine-1' as MachineId;
    const history = [
      {
        id: userTurnId,
        role: 'user',
        userId: 'user-1',
        timestamp: '2026-07-03T00:00:00.000Z',
        status: 'pending',
        read: false,
        inputConfig: {
          prompt: 'hello',
          inputBlocks: [{ type: 'text', text: 'hello' }],
          cliType: 'builtin',
          agentType: 'codex',
        },
      },
    ];
    const upsertDocMeta = vi.fn(async () => {
      throw new Error('meta write failed');
    });
    const requestSessionDispatchTurn = vi.fn(async () => ({
      type: 'session/dispatch-turn_response' as const,
      sessionId,
      userTurnId,
      accepted: true,
      disposition: 'accepted' as const,
    }));
    const runtime = createRuntime({
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: { machineId } })),
        upsertDocMeta,
      } as unknown as WorkspaceRuntime['repo'],
    }) as WorkspaceRuntime & {
      withSessionStore: WorkspaceRuntime['withSessionStore'];
      requestSessionDispatchTurn: WorkspaceRuntime['requestSessionDispatchTurn'];
    };
    runtime.withSessionStore = vi.fn(async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
      fn({
        getState: vi.fn(() => ({ history })),
        sessionData: sessionDataOver(history),
        setState: vi.fn(),
        waitUntilSynced: vi.fn(async () => undefined),
      })
    ) as unknown as WorkspaceRuntime['withSessionStore'];
    runtime.requestSessionDispatchTurn =
      requestSessionDispatchTurn as WorkspaceRuntime['requestSessionDispatchTurn'];
    const actions = await renderActions(runtime);

    await expect(
      actions.requestSessionDispatch(sessionId, userTurnId, { machineId })
    ).resolves.toBeUndefined();
    expect(requestSessionDispatchTurn).toHaveBeenCalledTimes(1);
    expect(upsertDocMeta).toHaveBeenCalledTimes(1);
  });

  it('rejects when the metadata write fails and the RPC fast path did not deliver', async () => {
    const sessionId = 'session-dispatch-meta-fail-undelivered' as SessionId;
    const userTurnId = 'user-turn-meta-fail-undelivered';
    const machineId = 'machine-1' as MachineId;
    const history = [
      {
        id: userTurnId,
        role: 'user',
        userId: 'user-1',
        timestamp: '2026-07-03T00:00:00.000Z',
        status: 'pending',
        read: false,
        inputConfig: {
          prompt: 'hello',
          inputBlocks: [{ type: 'text', text: 'hello' }],
          cliType: 'builtin',
          agentType: 'codex',
        },
      },
    ];
    const upsertDocMeta = vi.fn(async () => {
      throw new Error('meta write failed');
    });
    const requestSessionDispatchTurn = vi.fn(async () => ({
      type: 'session/dispatch-turn_response' as const,
      sessionId,
      userTurnId,
      accepted: false,
      disposition: 'not-owned' as const,
    }));
    const runtime = createRuntime({
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: { machineId } })),
        upsertDocMeta,
      } as unknown as WorkspaceRuntime['repo'],
    }) as WorkspaceRuntime & {
      withSessionStore: WorkspaceRuntime['withSessionStore'];
      requestSessionDispatchTurn: WorkspaceRuntime['requestSessionDispatchTurn'];
    };
    runtime.withSessionStore = vi.fn(async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
      fn({
        getState: vi.fn(() => ({ history })),
        sessionData: sessionDataOver(history),
        setState: vi.fn(),
        waitUntilSynced: vi.fn(async () => undefined),
      })
    ) as unknown as WorkspaceRuntime['withSessionStore'];
    runtime.requestSessionDispatchTurn =
      requestSessionDispatchTurn as WorkspaceRuntime['requestSessionDispatchTurn'];
    const actions = await renderActions(runtime);

    await expect(
      actions.requestSessionDispatch(sessionId, userTurnId, { machineId })
    ).rejects.toThrow('meta write failed');
  });

  const userInput = (text: string) =>
    ({
      role: 'user',
      userId: 'user-1',
      items: [{ type: 'text', text }],
      timestamp: '2026-09-29T00:00:00.000Z',
      status: 'pending',
      read: false,
      finished: true,
      inputConfig: {
        prompt: text,
        inputBlocks: [{ type: 'text', text }],
        cliType: 'builtin',
        agentType: 'codex',
      },
    }) as unknown as Parameters<SessionActions['addSessionHistory']>[1];

  const existingSession = (id: string) =>
    ({
      ...createSessionPayload(id as SessionId),
      id,
      createdAt: '2026-09-29T00:00:00.000Z',
    }) as unknown as SessionMeta;

  /** The fake store's history array (see `createRuntime`), shared by its sessions. */
  const readHistory = (runtime: WorkspaceRuntime, sessionId: SessionId) =>
    runtime.withSessionStore(
      sessionId,
      (store) => (store.getState() as unknown as { history: SessionHistory[] }).history
    );
});

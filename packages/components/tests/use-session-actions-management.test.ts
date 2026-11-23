import { createSessionControlPlaneMirror } from '@lody/shared/session-control-plane';
// @vitest-environment jsdom
import { cloudOperations } from '../src/lib/cloud-api-operations';
import { buildVisibleMachineIndex } from '../src/lib/visible-machine-index';
import { statusViewSessionFromMeta } from '../src/lib/status-view-state';
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
  isPinOrderKey,
  FractionalIndex,
  getSessionCancelRequestMarker,
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
  SessionSubConversationConfirmationDialog,
  useArchiveSessionWithConfirmation,
  useMoveToFocusWithConfirmation,
  useSettleSessionWithConfirmation,
  useSnoozeSessionWithConfirmation,
  type SubConversationAction,
} from '../src/components/sessions/session-sub-conversation-confirmation';
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

type ConfirmedAction = (sessionId: SessionId, options?: { confirm?: boolean }) => Promise<boolean>;

const SNOOZE_UNTIL = 1_800_000_000_000;

function ConfirmedActionProbe({
  action,
  onReady,
}: {
  action: SubConversationAction;
  onReady: (confirmed: ConfirmedAction) => void;
}) {
  const { archiveSession, settleSession, snoozeSession, moveSessionToFocus } = useSessionActions();
  const archive = useArchiveSessionWithConfirmation(archiveSession);
  const settle = useSettleSessionWithConfirmation(settleSession);
  const snooze = useSnoozeSessionWithConfirmation(snoozeSession);
  const focus = useMoveToFocusWithConfirmation(moveSessionToFocus);
  const confirmed: ConfirmedAction =
    action === 'archive'
      ? archive
      : action === 'settle'
        ? settle
        : action === 'snooze'
          ? (sessionId) => snooze(sessionId, SNOOZE_UNTIL)
          : focus;
  useEffect(() => {
    onReady(confirmed);
  }, [confirmed, onReady]);
  return createElement(SessionSubConversationConfirmationDialog);
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

  it('mints a fresh turn id when identical content is sent again (undelivered-turn resend)', async () => {
    const sessionId = 'session-resend-new-turn-id' as SessionId;
    const runtime = createRuntime({});
    const actions = await renderActions(runtime);

    // The undelivered entry's exact content, extracted the same way the
    // composer-area resend bar does it.
    const inputBlocks = buildResendInputBlocks({
      items: [{ type: 'text', text: 'same content' }],
      inputConfig: {
        prompt: 'same content',
        inputBlocks: [{ type: 'text', text: 'same content' }],
      },
    });
    const payload = {
      role: 'user',
      userId: 'user-1',
      items: [{ type: 'text', text: 'same content' }],
      timestamp: '2026-07-05T00:00:00.000Z',
      status: 'pending',
      read: false,
      finished: true,
      inputConfig: {
        inputBlocks,
        cliType: 'builtin',
        agentType: 'codex',
      },
    } as unknown as Parameters<SessionActions['addSessionHistory']>[1];

    const first = await actions.addSessionHistory(sessionId, payload);
    const second = await actions.addSessionHistory(sessionId, payload);

    // A resend rides the ordinary send path: identical content, brand-new id.
    expect(second.id).not.toBe(first.id);
    const resent = await runtime.withSessionStore(sessionId, (store) =>
      store.sessionData.history.readTurn(second.id)
    );
    expect(resent).toMatchObject({ state: 'ready', turn: { inputConfig: { inputBlocks } } });
  });

  it('selects Roost for new sessions with developer opt-in while experiments are off', async () => {
    const store = createStore();
    store.set(developerModeEnabledAtom, true);
    store.set(experimentalFeaturesEnabledAtom, false);
    store.set(roostHistoryExperimentEnabledAtom, true);
    const runtime = createRuntime({});
    const actions = await renderActions(runtime, { store });

    const result = await actions.createSession(
      createSessionPayload('session-roost-gated' as SessionId)
    );

    expect(result.sessionMeta.historyBackend).toBe('roost');
  });

  it.each([
    { developerMode: false, roostHistory: true },
    { developerMode: true, roostHistory: false },
  ])('keeps Loro when a developer gate is off: %j', async ({ developerMode, roostHistory }) => {
    const store = createStore();
    store.set(developerModeEnabledAtom, developerMode);
    store.set(experimentalFeaturesEnabledAtom, true);
    store.set(roostHistoryExperimentEnabledAtom, roostHistory);
    const runtime = createRuntime({});
    const actions = await renderActions(runtime, { store });

    const result = await actions.createSession(
      createSessionPayload('session-roost-developer-gate-off' as SessionId)
    );

    expect(result.sessionMeta.historyBackend).toBe('loro');
  });

  it('keeps creating ordinary Loro sessions on targets without Roost capability', async () => {
    const store = createStore();
    store.set(developerModeEnabledAtom, true);
    store.set(experimentalFeaturesEnabledAtom, false);
    store.set(roostHistoryExperimentEnabledAtom, true);
    const metaRepo = createSessionMetaRepo([]);
    const runtime = createRuntime({ repo: metaRepo.repo });
    const actions = await renderActions(runtime, { store });
    const result = await actions.createSession(
      createSessionPayload('old-machine-session' as SessionId)
    );
    expect(result.sessionMeta.historyBackend).toBe('loro');
    expect(metaRepo.repo.upsertDocMeta).toHaveBeenCalledWith(
      getSessionRoomId(result.sessionId),
      expect.objectContaining({ historyBackend: 'loro' })
    );
  });

  it('rejects explicit Roost creation before metadata, history or warm-up on unsupported targets', async () => {
    const metaRepo = createSessionMetaRepo([]);
    const runtime = createRuntime({ repo: metaRepo.repo });
    const actions = await renderActions(runtime);
    const payload = {
      ...createSessionPayload('unsupported-roost-session' as SessionId),
      historyBackend: 'roost' as const,
    };
    await expect(actions.createSession(payload)).rejects.toThrow('Update the machine');
    await expect(
      actions.startSession(payload, {
        role: 'user',
        userId: 'user-1',
        timestamp: '2026-10-09T00:00:00.000Z',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
        inputConfig: { inputBlocks: [{ type: 'text', text: 'hello' }] },
      } as never)
    ).rejects.toThrow('Update the machine');
    expect(metaRepo.repo.upsertDocMeta).not.toHaveBeenCalled();
    expect(runtime.ensureDocStream).not.toHaveBeenCalled();
  });

  it('keeps a local branch selector out of baseBranch until the target machine resolves it', async () => {
    const sessionId = 'session-local-selector' as SessionId;
    const metaRepo = createSessionMetaRepo([]);
    const runtime = createRuntime({ repo: metaRepo.repo });
    const actions = await renderActions(runtime);
    const selector = 'lody:branch:remote:origin:foo';

    await actions.startSession(
      {
        ...createSessionPayload(sessionId),
        project: {
          kind: 'local',
          localProjectId: 'project-1' as LocalProjectId,
          branch: selector,
          useWorktree: true,
        },
      },
      {
        role: 'user',
        userId: 'user-1',
        items: [{ type: 'text', text: 'hi' }],
        timestamp: '2026-07-18T00:00:00.000Z',
        status: 'pending',
        read: false,
        finished: true,
        inputConfig: {
          inputBlocks: [{ type: 'text', text: 'hi' }],
          agentType: 'codex',
        },
      } as unknown as Parameters<SessionActions['startSession']>[1]
    );

    const meta = metaRepo.getSession(sessionId)!;
    expect(meta).toMatchObject({ id: sessionId });
    expect(meta).not.toHaveProperty('baseBranch');
    expect(meta.project).toMatchObject({ branch: selector });
  });

  it('writes a Focus orderKey below every existing key so a new top-level session leads 进行中', async () => {
    const sessionId = 'session-focus-order' as SessionId;
    const metaRepo = createSessionMetaRepo([]);
    const runtime = createRuntime({ repo: metaRepo.repo });
    const keyed = {
      ...createSessionPayload('keyed-a' as SessionId),
      id: 'keyed-a',
      orderKey: 'a0',
    };
    const actions = await renderActions(runtime, {
      sessionMetaCache: { [getSessionRoomId('keyed-a' as SessionId)]: keyed as SessionMeta },
    });

    const result = await actions.createSession(createSessionPayload(sessionId));

    expect(isPinOrderKey(result.sessionMeta.orderKey)).toBe(true);
    expect(FractionalIndex.compare(result.sessionMeta.orderKey!, 'a0')).toBeLessThan(0);
    expect(metaRepo.getSession(sessionId)).toMatchObject({
      orderKey: result.sessionMeta.orderKey,
    });
  });

  it.each(['parentSessionId', 'openedBySessionId'] as const)(
    'leaves a session without orderKey when it is created under an opener (%s)',
    async (field) => {
      const openerId = 'opener-session' as SessionId;
      const sessionId = `child-via-${field}` as SessionId;
      const metaRepo = createSessionMetaRepo([existingSession(openerId)]);
      const runtime = createRuntime({ repo: metaRepo.repo });
      const openerMeta = {
        ...createSessionPayload(openerId),
        id: openerId,
        orderKey: 'a0',
      } as SessionMeta;
      const actions = await renderActions(runtime, {
        sessionMetaCache: { [getSessionRoomId(openerId)]: openerMeta },
      });

      const result = await actions.createSession({
        ...createSessionPayload(sessionId),
        [field]: openerId,
      } as SessionToCreate);

      expect(result.sessionMeta.orderKey).toBeUndefined();
      expect(metaRepo.getSession(sessionId)).not.toMatchObject({
        orderKey: expect.anything(),
      });
    }
  );

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

  it('writes and activates a plain dispatch before resolving; a failed fast path is not a send failure', async () => {
    const sessionId = 'session-plain-dispatch' as SessionId;
    const metaRepo = createSessionMetaRepo([existingSession(sessionId)]);
    const runtime = createRuntime({ repo: metaRepo.repo }) as WorkspaceRuntime & {
      requestSessionDispatchTurn: WorkspaceRuntime['requestSessionDispatchTurn'];
    };
    runtime.requestSessionDispatchTurn = vi.fn(async () => {
      throw new Error('machine unreachable');
    }) as WorkspaceRuntime['requestSessionDispatchTurn'];
    const actions = await renderActions(runtime);

    const entry = await actions.addSessionHistory(sessionId, userInput('plain'), {
      dispatch: true,
    });

    expect((await readHistory(runtime, sessionId)).map((turn) => turn.id)).toEqual([entry.id]);
    expect(metaRepo.getSession(sessionId)?.latestUserMsgId).toBe(entry.id);
    expect(runtime.pendingSends?.getSnapshot()).toEqual([]);
    await expect(actions.requestSessionDispatch(sessionId, entry.id)).resolves.toBeUndefined();
    expect(metaRepo.getSession(sessionId)?.latestUserMsgId).toBe(entry.id);
  });

  it('holds a new conversation with an unready attachment in memory until it is prepared', async () => {
    const sessionId = 'session-held-creation' as SessionId;
    const metaRepo = createSessionMetaRepo([]);
    const runtime = createRuntime({ repo: metaRepo.repo });
    const actions = await renderActions(runtime);

    const result = await actions.startSession(
      createSessionPayload(sessionId),
      userInput('look at this'),
      [imageDraft('att-creation')]
    );

    // Accepted, but nothing is in the synchronized documents yet.
    expect(await readHistory(runtime, sessionId)).toEqual([]);
    expect(metaRepo.getSession(sessionId)).toBeUndefined();
    expect(runtime.pendingSends?.hasPendingCreation(sessionId)).toBe(true);
    expect(heldPreparations).toHaveLength(1);

    heldPreparations[0].finish();
    await whenSessionDrained(runtime.pendingSends!, sessionId);
    expect(runtime.pendingSends?.getSnapshot()).toEqual([]);

    const [written] = await readHistory(runtime, sessionId);
    expect(written).toMatchObject({ id: result.historyEntry.id, role: 'user' });
    expect(written.inputConfig?.inputBlocks).toEqual([
      uploadedImage(imageDraft('att-creation')),
      { type: 'text', text: 'look at this' },
    ]);
    expect(metaRepo.getSession(sessionId)).toMatchObject({
      id: sessionId,
      machineId: 'machine-1',
      latestUserMsgId: result.historyEntry.id,
    });
  });

  it('keeps a conversation FIFO: a text send waits behind a preparing attachment send', async () => {
    const sessionId = 'session-held-fifo' as SessionId;
    const metaRepo = createSessionMetaRepo([existingSession(sessionId)]);
    const runtime = createRuntime({ repo: metaRepo.repo });
    const actions = await renderActions(runtime);

    const withImage = await actions.addSessionHistory(sessionId, userInput('first'), {
      dispatch: true,
      attachments: [imageDraft('att-fifo')],
    });
    const text = await actions.addSessionHistory(sessionId, userInput('second'), {
      dispatch: true,
    });

    expect(await readHistory(runtime, sessionId)).toEqual([]);
    expect(metaRepo.getSession(sessionId)?.latestUserMsgId).toBeUndefined();
    expect(runtime.pendingSends?.getSnapshot().map((send) => send.id)).toEqual([
      withImage.id,
      text.id,
    ]);
    // A dispatch request for a held turn is the queue's job, not the caller's.
    await expect(actions.requestSessionDispatch(sessionId, text.id)).resolves.toBeUndefined();
    expect(await readHistory(runtime, sessionId)).toEqual([]);

    heldPreparations[0].finish();
    await whenSessionDrained(runtime.pendingSends!, sessionId);
    expect(runtime.pendingSends?.getSnapshot()).toEqual([]);

    expect((await readHistory(runtime, sessionId)).map((turn) => turn.id)).toEqual([
      withImage.id,
      text.id,
    ]);
    expect(metaRepo.getSession(sessionId)?.latestUserMsgId).toBe(text.id);
  });

  it('turns a guide into a follow-up without sending the steer RPC when the machine is unreachable', async () => {
    const sessionId = 'session-guide-offline' as SessionId;
    const userTurnId = 'user-turn-guide-offline';
    const metaRepo = createSessionMetaRepo([
      { ...existingSession(sessionId), latestUserMsgId: 'older-turn' } as SessionMeta,
    ]);
    const runtime = createRuntime({ repo: metaRepo.repo }) as WorkspaceRuntime & {
      requestSessionSteer: WorkspaceRuntime['requestSessionSteer'];
    };
    runtime.isMachineRpcUnreachable = (machineId) => machineId === 'machine-1';
    // Sending it would reject this test's request.
    runtime.requestSessionSteer = vi.fn(async () => {
      throw new Error('steer RPC must not be sent');
    }) as WorkspaceRuntime['requestSessionSteer'];
    (await readHistory(runtime, sessionId)).push({
      ...(userInput('guide') as object),
      id: userTurnId,
      status: 'pending_apply',
    } as SessionHistory);
    const actions = await renderActions(runtime);

    await expect(
      actions.requestSessionSteer(sessionId, 'assistant:older', userTurnId)
    ).resolves.toBe(false);

    const [turn] = await readHistory(runtime, sessionId);
    expect(turn).toMatchObject({ id: userTurnId, status: 'pending' });
    expect(metaRepo.getSession(sessionId)?.latestUserMsgId).toBe(userTurnId);
  });

  it.each([
    ['no-active-turn', 'pending_apply', true],
    ['no-active-turn', 'pending', true],
    ['no-active-turn', 'seen', true],
    ['promotion-failed', 'pending_apply', true],
    ['promotion-failed', 'pending', true],
    ['promotion-failed', 'seen', true],
    ['no-active-turn', 'processing', false],
    ['promotion-failed', 'handled', false],
    ['promotion-failed', 'canceled', false],
    ['promotion-failed', 'failed', false],
    ['promotion-failed', 'removed', false],
    ['unsupported', 'pending_apply', true],
    ['unsupported', 'pending_apply', false, true],
    ['delivery-unknown', 'pending_apply', false],
    ['applied', 'pending_apply', false],
    ['no-active-turn', 'pending_apply', false, true],
    ['no-active-turn', 'pending', false, true],
    ['applied', 'canceled', false, true],
    ['applied', 'handled', false, true],
    ['promotion-failed', 'pending', false, true],
  ] as const)(
    'repairs steer dispatch for %s with history %s: %s',
    async (disposition, statusAfterRpc, repair, recoveryOwned?: boolean) => {
      const sessionId = 'session-steer-fallback' as SessionId;
      const userTurnId = 'user-turn-steer-fallback';
      const machineId = 'machine-1' as MachineId;
      const history = [
        {
          id: userTurnId,
          role: 'user',
          userId: 'user-1',
          timestamp: '2026-07-17T00:00:00.000Z',
          status: 'pending_apply',
          read: false,
          inputConfig: {
            prompt: 'continue as a new turn',
            inputBlocks: [{ type: 'text', text: 'continue as a new turn' }],
            cliType: 'builtin',
            agentType: 'codex',
          },
        },
      ];
      const state = { history };
      const setState = vi.fn((updater: (draft: typeof state) => void) => updater(state));
      const waitUntilSynced = vi.fn(async () => undefined);
      let meta = { machineId, latestUserMsgId: 'user-1' };
      const upsertDocMeta = vi.fn(async (_roomId, patch) => {
        meta = { ...meta, ...patch };
      });
      const requestSessionSteer = vi.fn(async () => {
        // History and activation travel independently: the CLI's status write
        // can reach the renderer while its metadata write failed.
        if (statusAfterRpc === 'removed') history.splice(0);
        else history[0].status = statusAfterRpc;
        return {
          type: 'session/steer_response' as const,
          sessionId,
          userTurnId,
          applied: disposition === 'applied',
          ...(recoveryOwned ? { recoveryOwned } : {}),
          disposition,
          ...(disposition === 'promotion-failed'
            ? { error: 'Injected activation write failure' }
            : {}),
        };
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
          getDocMeta: vi.fn(async () => ({ meta })),
          upsertDocMeta,
        } as unknown as WorkspaceRuntime['repo'],
      }) as WorkspaceRuntime & {
        withSessionStore: WorkspaceRuntime['withSessionStore'];
        requestSessionSteer: WorkspaceRuntime['requestSessionSteer'];
        requestSessionDispatchTurn: WorkspaceRuntime['requestSessionDispatchTurn'];
      };
      runtime.withSessionStore = vi.fn(
        async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
          fn({
            getState: vi.fn(() => state),
            sessionData: sessionDataOver(state.history),
            setState,
            waitUntilSynced,
          })
      ) as unknown as WorkspaceRuntime['withSessionStore'];
      runtime.requestSessionSteer = requestSessionSteer as WorkspaceRuntime['requestSessionSteer'];
      runtime.requestSessionDispatchTurn =
        requestSessionDispatchTurn as WorkspaceRuntime['requestSessionDispatchTurn'];
      const actions = await renderActions(runtime);

      // Uncertain and daemon-owned outcomes resolve without a send failure;
      // only an applied guide reports true.
      await expect(
        actions.requestSessionSteer(sessionId, 'assistant:user-1', userTurnId, { machineId })
      ).resolves.toBe(disposition === 'applied');

      if (!repair) {
        // An applied guide still awaiting its verdict is recorded as running.
        const expectedStatus =
          statusAfterRpc === 'removed'
            ? undefined
            : disposition === 'applied' && statusAfterRpc === 'pending_apply'
              ? 'processing'
              : statusAfterRpc;
        expect(history[0]?.status).toBe(expectedStatus);
        expect(meta.latestUserMsgId).toBe('user-1');
        expect(requestSessionDispatchTurn).not.toHaveBeenCalled();
        return;
      }
      expect(history[0]).toMatchObject({ status: statusAfterRpc === 'seen' ? 'seen' : 'pending' });
      expect(meta.latestUserMsgId).toBe(userTurnId);
      expect(requestSessionDispatchTurn).toHaveBeenCalledWith(
        machineId,
        expect.objectContaining({ sessionId, userTurnId })
      );
      expect(upsertDocMeta).toHaveBeenCalledWith(
        getSessionRoomId(sessionId),
        expect.objectContaining({ latestUserMsgId: userTurnId })
      );
      expect(waitUntilSynced).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [undefined, 'pending_apply'],
    [true, 'pending'],
    [true, 'pending_apply'],
  ] as const)(
    'never redispatches a stale-turn steer (daemon-owned: %s, history %s)',
    async (recoveryOwned, statusAfterRpc) => {
      const sessionId = 'session-steer-stale' as SessionId;
      const userTurnId = 'user-turn-steer-stale';
      const machineId = 'machine-1' as MachineId;
      const history = [
        {
          id: userTurnId,
          role: 'user',
          userId: 'user-1',
          timestamp: '2026-07-17T00:00:00.000Z',
          status: 'pending_apply',
          read: false,
          inputConfig: {
            prompt: 'stale guide',
            inputBlocks: [{ type: 'text', text: 'stale guide' }],
            cliType: 'builtin',
            agentType: 'codex',
          },
        },
      ];
      const setState = vi.fn();
      const requestSessionDispatchTurn = vi.fn();
      const runtime = createRuntime({}) as WorkspaceRuntime & {
        withSessionStore: WorkspaceRuntime['withSessionStore'];
        requestSessionSteer: WorkspaceRuntime['requestSessionSteer'];
        requestSessionDispatchTurn: WorkspaceRuntime['requestSessionDispatchTurn'];
      };
      runtime.withSessionStore = vi.fn(
        async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
          fn({
            getState: vi.fn(() => ({ history })),
            sessionData: sessionDataOver(history),
            setState,
            waitUntilSynced: vi.fn(async () => undefined),
          })
      ) as unknown as WorkspaceRuntime['withSessionStore'];
      runtime.requestSessionSteer = vi.fn(async () => {
        // A daemon-owned rejection has already requeued the turn in history.
        history[0].status = statusAfterRpc;
        return {
          type: 'session/steer_response' as const,
          sessionId,
          userTurnId,
          applied: false,
          ...(recoveryOwned ? { recoveryOwned } : {}),
          disposition: 'stale-turn' as const,
        };
      }) as WorkspaceRuntime['requestSessionSteer'];
      runtime.requestSessionDispatchTurn =
        requestSessionDispatchTurn as WorkspaceRuntime['requestSessionDispatchTurn'];
      const actions = await renderActions(runtime);

      await expect(
        actions.requestSessionSteer(sessionId, 'assistant:user-1', userTurnId, { machineId })
      ).resolves.toBe(false);

      expect(history[0]).toMatchObject({ status: statusAfterRpc });
      expect(setState).not.toHaveBeenCalled();
      expect(requestSessionDispatchTurn).not.toHaveBeenCalled();
    }
  );

  it('closes only the selected tab while retaining all lifecycle and dispatch state', async () => {
    const tree = createContainmentSessions('close', false);
    const rootSession = {
      ...tree.rootSession,
      latestUserMsgId: 'turn-pending',
      status: { type: 'running' },
    } as SessionMeta;
    const metaRepo = createSessionMetaRepo([rootSession, ...tree.sessions.slice(1)]);
    const actions = await renderActions(createRuntime({ repo: metaRepo.repo }));
    await actions.setSessionTabClosed(rootSession.id, true);
    expect(metaRepo.getSession(rootSession.id)).toEqual({ ...rootSession, isTabClosed: true });
    expect(metaRepo.getSession(tree.tabSession.id)).toEqual(tree.tabSession);
    expect(metaRepo.getSession(tree.openedSession.id)).toEqual(tree.openedSession);
    await actions.setSessionTabClosed(rootSession.id, false);
    expect(metaRepo.getSession(rootSession.id)).toEqual({ ...rootSession, isTabClosed: false });
  });

  it('reopens a closed tab of an archived workspace without restoring it', async () => {
    const tree = createContainmentSessions('archived-reopen', true);
    const archivedRoot = { ...tree.rootSession, isTabClosed: true };
    const child = { ...tree.tabSession, isTabClosed: true };
    const metaRepo = createSessionMetaRepo([archivedRoot, child, tree.openedSession]);
    const actions = await renderActions(createRuntime({ repo: metaRepo.repo }), {
      sessionMetaCache: tree.sessionMetaCache,
    });
    await actions.setSessionTabClosed(archivedRoot.id, false);
    expect(metaRepo.getSession(archivedRoot.id)).toEqual({
      ...archivedRoot,
      isArchived: true,
      isTabClosed: false,
    });
    expect(metaRepo.getSession(child.id)).toEqual(child);
    expect(metaRepo.getSession(tree.openedSession.id)).toEqual(tree.openedSession);
  });

  it.each([false, true])('uses one Repo snapshot even when UI readiness is %s', async (ready) => {
    const tree = createContainmentSessions('snapshot', false);
    const unrelated = { ...tree.rootSession, id: 'unrelated' as SessionId };
    const hintOnly = {
      ...unrelated,
      id: 'hint-only' as SessionId,
      openedByRootSessionId: tree.rootSession.id,
    };
    const conflicting = {
      ...unrelated,
      id: 'conflicting' as SessionId,
      parentSessionId: unrelated.id,
      openedBySessionId: tree.rootSession.id,
    };
    const deleted = { ...tree.tabSession, id: 'deleted' as SessionId };
    const repo = await LoroRepo.create({});
    try {
      for (const session of [...tree.sessions, unrelated, hintOnly, conflicting, deleted]) {
        await repo.upsertDocMeta(getSessionRoomId(session.id), {
          ...session,
          id: 'stale-embedded-id',
          isTabClosed: true,
        });
      }
      await repo.deleteDoc(getSessionRoomId(deleted.id));
      const runtime = createRuntime({ repo });
      const actions = await renderActions(runtime, {
        docMetaCacheReady: ready,
        sessionMetaCache: { [getSessionRoomId(tree.rootSession.id)]: tree.rootSession },
      });
      await actions.archiveSession(tree.rootSession.id);
      for (const session of [tree.rootSession, tree.tabSession]) {
        expect((await repo.getDocMeta(getSessionRoomId(session.id)))?.meta).toMatchObject({
          isArchived: true,
          status: { type: 'idle' },
        });
      }
      for (const session of [
        tree.openedSession,
        tree.openedFromTabSession,
        unrelated,
        hintOnly,
        conflicting,
      ]) {
        expect((await repo.getDocMeta(getSessionRoomId(session.id)))?.meta.isArchived).toBe(false);
      }
      expect(isLoroRepoDocDeleted(await repo.getDocMeta(getSessionRoomId(deleted.id)))).toBe(true);
      await actions.restoreSession(tree.rootSession.id);
      expect((await repo.getDocMeta(getSessionRoomId(tree.rootSession.id)))?.meta).toMatchObject({
        isArchived: false,
        isTabClosed: true,
      });
      expect((await repo.getDocMeta(getSessionRoomId(tree.tabSession.id)))?.meta).toMatchObject({
        isArchived: false,
        isTabClosed: true,
      });
      for (const session of [tree.openedSession, tree.openedFromTabSession]) {
        expect((await repo.getDocMeta(getSessionRoomId(session.id)))?.meta.isArchived).toBe(false);
      }
      await actions.archiveSession(tree.rootSession.id);
      await actions.deleteArchivedSession(tree.rootSession.id);
      for (const session of [tree.rootSession, tree.tabSession]) {
        expect(isLoroRepoDocDeleted(await repo.getDocMeta(getSessionRoomId(session.id)))).toBe(
          true
        );
      }
      for (const session of [tree.openedSession, tree.openedFromTabSession]) {
        const entry = await repo.getDocMeta(getSessionRoomId(session.id));
        expect(isLoroRepoDocDeleted(entry)).toBe(false);
        expect(entry?.meta.isArchived).toBe(false);
      }
      expect(runtime.writer.flockRowPut).not.toHaveBeenCalled();
    } finally {
      await repo.destroy();
    }
  });

  it.each(['archiveSession', 'restoreSession', 'deleteArchivedSession'] as const)(
    '%s rejects failed reads and missing roots without using the UI cache',
    async (action) => {
      const tree = createContainmentSessions('failed-read', true);
      const metaRepo = createSessionMetaRepo(tree.sessions);
      const listDoc = metaRepo.repo.listDoc.bind(metaRepo.repo);
      metaRepo.repo.listDoc = async () => {
        throw new Error('metadata unavailable');
      };
      const actions = await renderActions(createRuntime({ repo: metaRepo.repo }), {
        sessionMetaCache: tree.sessionMetaCache,
      });
      await expect(actions[action](tree.rootSession.id)).rejects.toThrow('metadata unavailable');
      for (const session of tree.sessions) expect(metaRepo.getSession(session.id)).toEqual(session);
      metaRepo.repo.listDoc = listDoc;
      await metaRepo.repo.deleteDoc(getSessionRoomId(tree.rootSession.id));
      await expect(actions[action](tree.rootSession.id)).rejects.toThrow(
        'Session metadata missing'
      );
      expect(metaRepo.getSession(tree.rootSession.id)).toBeUndefined();
      for (const session of tree.sessions.slice(1))
        expect(metaRepo.getSession(session.id)).toEqual(session);
      expect(sendIpcMock).not.toHaveBeenCalled();
    }
  );

  it.each(['archiveSession', 'restoreSession', 'deleteArchivedSession'] as const)(
    '%s refuses a workspace switch while reading targets',
    async (action) => {
      const tree = createContainmentSessions('switch', true);
      const original = createSessionMetaRepo(tree.sessions);
      const replacement = createSessionMetaRepo(tree.sessions);
      const reading = createDeferred();
      const finish = createDeferred();
      const runtime = createRuntime({
        repo: original.repo,
        readSessionOperationTargets: async (id, operation) => {
          const targets = await readSessionOperationTargets(original.repo, id, operation);
          reading.resolve();
          await finish.promise;
          return targets;
        },
      });
      const store = createStore();
      const actions = await renderActions(runtime, { store });
      const result = actions[action](tree.rootSession.id);
      const rejected = expect(result).rejects.toMatchObject({ code: 'session_management_denied' });
      await reading.promise;
      await act(async () => {
        store.set(runtimeAtom, createRuntime({ repo: replacement.repo }));
      });
      finish.resolve();
      await rejected;
      for (const session of tree.sessions) {
        expect(original.getSession(session.id)).toEqual(session);
        expect(replacement.getSession(session.id)).toEqual(session);
      }
      expect(sendIpcMock).not.toHaveBeenCalled();
    }
  );

  it('fences later management writes after a runtime switch without rolling back the first write', async () => {
    const tree = createContainmentSessions('pinned', false);
    const original = createSessionMetaRepo(tree.sessions);
    const replacement = createSessionMetaRepo(tree.sessions);
    const written = createDeferred();
    const finish = createDeferred();
    const write = original.repo.upsertDocMeta.bind(original.repo);
    original.repo.upsertDocMeta = async (id, patch) => {
      await write(id, patch);
      if (id === getSessionRoomId(tree.rootSession.id)) {
        written.resolve();
        await finish.promise;
      }
    };
    const store = createStore();
    const actions = await renderActions(createRuntime({ repo: original.repo }), { store });
    const result = actions.archiveSession(tree.rootSession.id);
    await written.promise;
    const lateChild = { ...tree.tabSession, id: 'late-child' as SessionId };
    original.setMeta(getSessionRoomId(lateChild.id), lateChild);
    await act(async () => {
      store.set(runtimeAtom, createRuntime({ repo: replacement.repo }));
    });
    finish.resolve();
    await expect(result).rejects.toMatchObject({ code: 'session_management_denied' });
    expect(original.getSession(tree.rootSession.id)?.isArchived).toBe(true);
    expect(original.getSession(tree.tabSession.id)?.isArchived).toBe(false);
    for (const session of [tree.openedSession, tree.openedFromTabSession]) {
      expect(original.getSession(session.id)).toEqual(session);
    }
    for (const session of tree.sessions)
      expect(replacement.getSession(session.id)).toEqual(session);
    expect(original.getSession(lateChild.id)).toEqual(lateChild);
  });

  it('surfaces partial archive writes without rollback and repairs them on retry', async () => {
    const tree = createContainmentSessions('partial', false);
    const metaRepo = createSessionMetaRepo(tree.sessions);
    const write = metaRepo.repo.upsertDocMeta.bind(metaRepo.repo);
    metaRepo.repo.upsertDocMeta = async (id, patch) => {
      if (id === getSessionRoomId(tree.tabSession.id)) throw new Error('disk full');
      await write(id, patch);
    };
    const actions = await renderActions(createRuntime({ repo: metaRepo.repo }));
    await expect(actions.archiveSession(tree.rootSession.id)).rejects.toThrow('disk full');
    expect(metaRepo.getSession(tree.rootSession.id)?.isArchived).toBe(true);
    for (const session of tree.sessions.slice(1))
      expect(metaRepo.getSession(session.id)).toEqual(session);
    expect(sendIpcMock.mock.calls).toEqual([
      ['terminal.closeSession', { sessionId: tree.rootSession.id }],
    ]);
    metaRepo.repo.upsertDocMeta = write;
    sendIpcMock.mockImplementationOnce(() => {
      throw new Error('terminal unavailable');
    });
    await actions.archiveSession(tree.rootSession.id);
    for (const session of [tree.rootSession, tree.tabSession])
      expect(metaRepo.getSession(session.id)?.isArchived).toBe(true);
    for (const session of [tree.openedSession, tree.openedFromTabSession])
      expect(metaRepo.getSession(session.id)).toEqual(session);
  });

  const confirmationDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

  const renderConfirmedAction = async (
    action: SubConversationAction,
    runtime: WorkspaceRuntime,
    workingIds: SessionId[]
  ) => {
    await initI18n('en');
    const jotaiStore = createStore();
    jotaiStore.set(runtimeAtom, runtime);
    jotaiStore.set(docMetaCacheReadyAtom, true);
    jotaiStore.set(currentWorkspaceIdAtom, 'workspace-1' as WorkspaceId);
    jotaiStore.set(currentWorkspaceSlugAtom, 'workspace-slug');
    const nowMs = 1_000_000;
    jotaiStore.set(lodyPresenceNowMsAtom, nowMs);
    jotaiStore.set(
      lodyPresenceStatesAtom,
      Object.fromEntries(
        workingIds.map((sessionId) => [
          `presence-${sessionId}`,
          {
            kind: 'session',
            sessionId,
            machineId: 'machine' as MachineId,
            instanceId: 'instance',
            status: { type: 'running' },
            updatedAt: nowMs,
          },
        ])
      ) as never
    );
    let confirmed: ConfirmedAction | null = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          PlatformContext.Provider,
          { value: { ...testPlatform, kind: 'local' } },
          createElement(
            Provider,
            { store: jotaiStore },
            createElement(ConfirmedActionProbe, {
              action,
              onReady: (next) => {
                confirmed = next;
              },
            })
          )
        )
      );
    });
    if (!confirmed) throw new Error('Confirmed action was not initialized');
    return confirmed;
  };

  // Wrapped: returning the pending promise would make the caller await the answer.
  const startConfirmation = async (
    confirmed: ConfirmedAction,
    sessionId: SessionId,
    options?: { confirm?: boolean }
  ) => {
    let result!: Promise<boolean>;
    await act(async () => {
      result = confirmed(sessionId, options);
    });
    await vi.waitFor(() => expect(confirmationDialog()).not.toBeNull());
    return { result };
  };

  const answerConfirmation = async (label: string) => {
    const button = Array.from(confirmationDialog()!.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label
    );
    expect(button).toBeInstanceOf(HTMLButtonElement);
    await act(async () => button!.click());
  };

  const createOpenedSubTree = (prefix: string) => {
    const tree = createContainmentSessions(prefix, false);
    const openedTab = {
      ...tree.tabSession,
      id: `${prefix}-opened-tab` as SessionId,
      parentSessionId: tree.openedSession.id,
      openedBySessionId: tree.openedSession.id,
    };
    const archivedOpened = {
      ...tree.openedSession,
      id: `${prefix}-archived-opened` as SessionId,
      isArchived: true,
    };
    const metaRepo = createSessionMetaRepo([...tree.sessions, openedTab, archivedOpened]);
    return { ...tree, openedTab, archivedOpened, metaRepo };
  };

  describe('archive confirmation for opened sub-conversations', () => {
    it('counts active and working sub-conversations, then archives the whole tree', async () => {
      const tree = createOpenedSubTree('confirm-all');
      const runtime = createRuntime({ repo: tree.metaRepo.repo });
      // Work in an opened Session's own Tab makes that sub-conversation working.
      const archive = await renderConfirmedAction('archive', runtime, [tree.openedTab.id]);

      const { result } = await startConfirmation(archive, tree.rootSession.id);
      expect(confirmationDialog()?.textContent).toContain(
        'This conversation opened 2 active sub-conversations.'
      );
      expect(confirmationDialog()?.textContent).toContain(
        '1 is still working; archiving it stops that work.'
      );
      // Nothing is written while the user decides.
      expect(tree.metaRepo.getSession(tree.rootSession.id)?.isArchived).toBe(false);

      await answerConfirmation('Archive all');
      await expect(result).resolves.toBe(true);
      for (const session of [
        tree.rootSession,
        tree.tabSession,
        tree.openedSession,
        tree.openedTab,
        tree.openedFromTabSession,
      ]) {
        expect(tree.metaRepo.getSession(session.id)?.isArchived).toBe(true);
      }
      expect(confirmationDialog()).toBeNull();
    });

    it('archives only the conversation and its Tabs, or nothing on cancel', async () => {
      const tree = createOpenedSubTree('confirm-only');
      const runtime = createRuntime({ repo: tree.metaRepo.repo });
      const archive = await renderConfirmedAction('archive', runtime, []);

      const { result: cancelled } = await startConfirmation(archive, tree.rootSession.id);
      expect(confirmationDialog()?.textContent).toContain('None of them is working right now.');
      await answerConfirmation('Cancel');
      await expect(cancelled).resolves.toBe(false);
      expect(tree.metaRepo.getSession(tree.rootSession.id)?.isArchived).toBe(false);

      const { result: onlyThis } = await startConfirmation(archive, tree.rootSession.id);
      await answerConfirmation('Archive this only');
      await expect(onlyThis).resolves.toBe(true);
      for (const session of [tree.rootSession, tree.tabSession]) {
        expect(tree.metaRepo.getSession(session.id)?.isArchived).toBe(true);
      }
      for (const session of [tree.openedSession, tree.openedTab, tree.openedFromTabSession]) {
        expect(tree.metaRepo.getSession(session.id)?.isArchived).toBe(false);
      }
    });

    it('archives directly when every opened sub-conversation is already archived', async () => {
      const tree = createOpenedSubTree('confirm-none');
      const runtime = createRuntime({ repo: tree.metaRepo.repo });
      const archive = await renderConfirmedAction('archive', runtime, []);

      await act(async () => {
        await expect(archive(tree.archivedOpened.id)).resolves.toBe(true);
      });
      expect(confirmationDialog()).toBeNull();
      expect(tree.metaRepo.getSession(tree.archivedOpened.id)?.isArchived).toBe(true);
    });

    it('asks one question when confirmation is always required', async () => {
      const tree = createOpenedSubTree('confirm-always');
      const runtime = createRuntime({ repo: tree.metaRepo.repo });
      const archive = await renderConfirmedAction('archive', runtime, []);

      // Without sub-conversations, the shared dialog asks the plain question.
      const { result: plain } = await startConfirmation(archive, tree.archivedOpened.id, {
        confirm: true,
      });
      expect(confirmationDialog()?.textContent).toContain('Archive chat?');
      expect(confirmationDialog()?.textContent).not.toContain('sub-conversation');
      await answerConfirmation('Archive');
      await expect(plain).resolves.toBe(true);
      expect(tree.metaRepo.getSession(tree.archivedOpened.id)?.isArchived).toBe(true);

      // With them, the sub-conversation choice is the only dialog.
      const { result: treeArchive } = await startConfirmation(archive, tree.rootSession.id, {
        confirm: true,
      });
      expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
      expect(confirmationDialog()?.textContent).toContain('Archive sub-conversations too?');
      await answerConfirmation('Archive all');
      await expect(treeArchive).resolves.toBe(true);
      expect(tree.metaRepo.getSession(tree.openedSession.id)?.isArchived).toBe(true);
    });
  });

  describe('settle confirmation for opened sub-conversations', () => {
    it('asks, then settles every opened sub-conversation on "all"', async () => {
      const tree = createOpenedSubTree('settle-all');
      // A snoozed sub-conversation wakes by settling, not by keeping its timer.
      tree.metaRepo.setMeta(getSessionRoomId(tree.openedSession.id), {
        ...tree.openedSession,
        snoozedUntil: Date.now() + 60_000,
      });
      const runtime = createRuntime({ repo: tree.metaRepo.repo });
      // Work in an opened Session's own Tab makes that sub-conversation working.
      const settle = await renderConfirmedAction('settle', runtime, [tree.openedTab.id]);

      const { result } = await startConfirmation(settle, tree.rootSession.id);
      expect(confirmationDialog()?.textContent).toContain(
        'This conversation opened 2 active sub-conversations.'
      );
      expect(confirmationDialog()?.textContent).toContain('1 is still working.');
      // Nothing is written while the user decides.
      expect(tree.metaRepo.getSession(tree.rootSession.id)?.settledAt).toBeUndefined();

      await answerConfirmation('Mark all as completed');
      await expect(result).resolves.toBe(true);
      // Opened Sessions settle; contained Tabs keep no status fields of their own.
      for (const session of [tree.rootSession, tree.openedSession, tree.openedFromTabSession]) {
        expect(tree.metaRepo.getSession(session.id)?.settledAt).toBeGreaterThan(0);
        expect(tree.metaRepo.getSession(session.id)?.snoozedUntil).toBeUndefined();
      }
      for (const session of [tree.tabSession, tree.openedTab]) {
        expect(tree.metaRepo.getSession(session.id)?.settledAt).toBeUndefined();
      }
      expect(confirmationDialog()).toBeNull();
    });

    it('settles only the conversation, or nothing on cancel', async () => {
      const tree = createOpenedSubTree('settle-only');
      const runtime = createRuntime({ repo: tree.metaRepo.repo });
      const settle = await renderConfirmedAction('settle', runtime, []);

      const { result: cancelled } = await startConfirmation(settle, tree.rootSession.id);
      expect(confirmationDialog()?.textContent).toContain('None of them is working right now.');
      await answerConfirmation('Cancel');
      await expect(cancelled).resolves.toBe(false);
      for (const session of [tree.rootSession, tree.openedSession]) {
        expect(tree.metaRepo.getSession(session.id)?.settledAt).toBeUndefined();
      }

      const { result: onlyThis } = await startConfirmation(settle, tree.rootSession.id);
      await answerConfirmation('Mark this only');
      await expect(onlyThis).resolves.toBe(true);
      expect(tree.metaRepo.getSession(tree.rootSession.id)?.settledAt).toBeGreaterThan(0);
      for (const session of [tree.openedSession, tree.openedFromTabSession]) {
        expect(tree.metaRepo.getSession(session.id)?.settledAt).toBeUndefined();
      }
    });

    it('settles directly when there are no active sub-conversations', async () => {
      const tree = createOpenedSubTree('settle-none');
      const runtime = createRuntime({ repo: tree.metaRepo.repo });
      const settle = await renderConfirmedAction('settle', runtime, []);

      await act(async () => {
        await expect(settle(tree.archivedOpened.id)).resolves.toBe(true);
      });
      expect(confirmationDialog()).toBeNull();
      expect(tree.metaRepo.getSession(tree.archivedOpened.id)?.settledAt).toBeGreaterThan(0);
    });
  });

  describe.each([
    {
      action: 'snooze' as const,
      labels: {
        title: 'Snooze sub-conversations too?',
        only: 'Snooze this only',
        all: 'Snooze all',
      },
      applied: (meta: SessionMeta | undefined) => meta?.snoozedUntil === SNOOZE_UNTIL,
    },
    {
      action: 'focus' as const,
      labels: {
        title: 'Move sub-conversations to Focus too?',
        only: 'Move this only',
        all: 'Move all to Focus',
      },
      applied: (meta: SessionMeta | undefined) => meta?.focusRestoredAt !== undefined,
    },
  ])('$action confirmation for opened sub-conversations', ({ action, labels, applied }) => {
    it('asks, then applies to every opened sub-conversation on "all"', async () => {
      const tree = createOpenedSubTree(`${action}-all`);
      const runtime = createRuntime({ repo: tree.metaRepo.repo });
      const confirmed = await renderConfirmedAction(action, runtime, []);

      const { result } = await startConfirmation(confirmed, tree.rootSession.id);
      expect(confirmationDialog()?.textContent).toContain(labels.title);
      // Nothing is written while the user decides.
      expect(applied(tree.metaRepo.getSession(tree.rootSession.id))).toBe(false);

      await answerConfirmation(labels.all);
      await expect(result).resolves.toBe(true);
      // Opened Sessions follow; contained Tabs keep no status fields of their own.
      for (const session of [tree.rootSession, tree.openedSession, tree.openedFromTabSession]) {
        expect(applied(tree.metaRepo.getSession(session.id))).toBe(true);
      }
      for (const session of [tree.tabSession, tree.openedTab]) {
        expect(applied(tree.metaRepo.getSession(session.id))).toBe(false);
      }
      expect(confirmationDialog()).toBeNull();
    });

    it('applies only to the conversation, or nothing on cancel', async () => {
      const tree = createOpenedSubTree(`${action}-only`);
      const runtime = createRuntime({ repo: tree.metaRepo.repo });
      const confirmed = await renderConfirmedAction(action, runtime, []);

      const { result: cancelled } = await startConfirmation(confirmed, tree.rootSession.id);
      await answerConfirmation('Cancel');
      await expect(cancelled).resolves.toBe(false);
      for (const session of [tree.rootSession, tree.openedSession]) {
        expect(applied(tree.metaRepo.getSession(session.id))).toBe(false);
      }

      const { result: onlyThis } = await startConfirmation(confirmed, tree.rootSession.id);
      await answerConfirmation(labels.only);
      await expect(onlyThis).resolves.toBe(true);
      expect(applied(tree.metaRepo.getSession(tree.rootSession.id))).toBe(true);
      for (const session of [tree.openedSession, tree.openedFromTabSession]) {
        expect(applied(tree.metaRepo.getSession(session.id))).toBe(false);
      }
    });

    it('applies directly when there are no active sub-conversations', async () => {
      const tree = createOpenedSubTree(`${action}-none`);
      const runtime = createRuntime({ repo: tree.metaRepo.repo });
      const confirmed = await renderConfirmedAction(action, runtime, []);

      await act(async () => {
        await expect(confirmed(tree.archivedOpened.id)).resolves.toBe(true);
      });
      expect(confirmationDialog()).toBeNull();
      expect(applied(tree.metaRepo.getSession(tree.archivedOpened.id))).toBe(true);
    });
  });

  it('a send in a contained Tab brings its snoozed conversation back to Focus', async () => {
    const tree = createOpenedSubTree('send-in-tab');
    tree.metaRepo.setMeta(getSessionRoomId(tree.rootSession.id), {
      ...tree.rootSession,
      snoozedUntil: Date.now() + 60 * 60_000,
    });
    const actions = await renderActions(createRuntime({ repo: tree.metaRepo.repo }));

    await actions.touchSessionActivity(tree.tabSession.id);

    expect(tree.metaRepo.getSession(tree.rootSession.id)?.snoozedUntil).toBeUndefined();
  });

  it("reading a contained Tab clears its conversation's woken unread mark", async () => {
    const tree = createOpenedSubTree('read-in-tab');
    const wokeAt = Date.now() - 60_000;
    const root = {
      ...tree.rootSession,
      lastMessageAt: wokeAt - 10 * 60_000,
      lastReadAt: wokeAt - 10 * 60_000,
      snoozedUntil: wokeAt,
    };
    const tab = { ...tree.tabSession, lastMessageAt: wokeAt - 5 * 60_000 };
    tree.metaRepo.setMeta(getSessionRoomId(root.id), root);
    tree.metaRepo.setMeta(getSessionRoomId(tab.id), tab);
    const actions = await renderActions(createRuntime({ repo: tree.metaRepo.repo }), {
      sessionMetaCache: { [getSessionRoomId(root.id)]: root, [getSessionRoomId(tab.id)]: tab },
    });

    await actions.markSessionRead(tab.id, tab.lastMessageAt);

    expect(tree.metaRepo.getSession(root.id)?.lastReadAt).toBeGreaterThanOrEqual(wokeAt);
  });

  it('status actions on an opened tree leave archived sub-conversations alone', async () => {
    const tree = createOpenedSubTree('tree-archived');
    const until = Date.now() + 60 * 60_000;
    const actions = await renderActions(createRuntime({ repo: tree.metaRepo.repo }));

    await actions.snoozeSession(tree.rootSession.id, until, { includeOpenedSessions: true });

    expect(tree.metaRepo.getSession(tree.openedSession.id)?.snoozedUntil).toBe(until);
    expect(tree.metaRepo.getSession(tree.openedFromTabSession.id)?.snoozedUntil).toBe(until);
    expect(tree.metaRepo.getSession(tree.archivedOpened.id)?.snoozedUntil).toBeUndefined();
  });

  it('restores opened sub-conversations when the parent row is dragged into Focus', async () => {
    const tree = createOpenedSubTree('drag-focus');
    tree.metaRepo.setMeta(getSessionRoomId(tree.openedSession.id), {
      ...tree.openedSession,
      snoozedUntil: Date.now() + 60_000,
    });
    const actions = await renderActions(createRuntime({ repo: tree.metaRepo.repo }));

    // The list shows the root settled; its opened sub-conversations are not listed.
    await actions.runStatusViewCommand(
      { type: 'move', sessionId: tree.rootSession.id, to: { area: 'focus' }, beforeId: null },
      {
        sessions: [
          {
            ...statusViewSessionFromMeta(tree.rootSession, null),
            settledAt: Date.now(),
          },
        ],
        sections: [],
        sectionsLoaded: true,
        canManageSections: true,
        nowMs: Date.now(),
      }
    );

    const root = tree.metaRepo.getSession(tree.rootSession.id);
    expect(isPinOrderKey(root?.orderKey)).toBe(true);
    expect(root?.settledAt).toBeUndefined();
    expect(root?.focusRestoredAt).toBeGreaterThan(0);
    // The dropped parent's opened sub-conversations restore without order keys.
    for (const session of [tree.openedSession, tree.openedFromTabSession]) {
      const meta = tree.metaRepo.getSession(session.id);
      expect(meta?.focusRestoredAt).toBeGreaterThan(0);
      expect(meta?.snoozedUntil).toBeUndefined();
      expect(meta?.orderKey).toBeUndefined();
    }
    // Contained Tabs are never status targets.
    expect(tree.metaRepo.getSession(tree.tabSession.id)?.focusRestoredAt).toBeUndefined();
  });

  it.each([
    ['archiveSession', 'finish'],
    ['archiveSession', 'fail'],
    ['deleteArchivedSession', 'finish'],
    ['deleteArchivedSession', 'fail'],
  ] as const)(
    '%s drops held sends of its targets; a preparation that settles late (%s) never writes',
    async (action, settle) => {
      const tree = createContainmentSessions(
        `held-${action}-${settle}`,
        action !== 'archiveSession'
      );
      tree.openedSession.isArchived = false;
      const metaRepo = createSessionMetaRepo(tree.sessions);
      const runtime = createRuntime({ repo: metaRepo.repo });
      const actions = await renderActions(runtime);
      // The root's upload ignores cancellation, so the action must join it.
      preparationsIgnoringAbort.add(tree.rootSession.id);
      const rootSend = await actions.addSessionHistory(tree.rootSession.id, userInput('root'), {
        dispatch: true,
        attachments: [imageDraft('att-root')],
      });
      const tabSend = await actions.addSessionHistory(tree.tabSession.id, userInput('tab'), {
        dispatch: true,
        attachments: [imageDraft('att-tab')],
      });
      const openedSend = await actions.addSessionHistory(
        tree.openedSession.id,
        userInput('opened'),
        {
          dispatch: true,
          attachments: [imageDraft('att-opened')],
        }
      );
      const [rootPreparation, , openedPreparation] = heldPreparations;

      const running = actions[action](tree.rootSession.id);
      await whenAborted(rootPreparation.signal);
      rootPreparation[settle]();
      await expect(running).resolves.toBeUndefined();

      expect(runtime.pendingSends?.getSnapshot().map((send) => send.id)).toEqual([openedSend.id]);
      expect(openedPreparation.signal.aborted).toBe(false);
      expect(metaRepo.getSession(tree.openedSession.id)).toEqual(tree.openedSession);
      const written = await readHistory(runtime, tree.rootSession.id);
      expect(written.map((turn) => turn.id)).not.toContain(rootSend.id);
      expect(written.map((turn) => turn.id)).not.toContain(tabSend.id);
      for (const session of [tree.rootSession, tree.tabSession]) {
        if (action === 'archiveSession') {
          expect(metaRepo.getSession(session.id)).toMatchObject({ isArchived: true });
          expect(metaRepo.getSession(session.id)?.latestUserMsgId).toBeUndefined();
        } else expect(metaRepo.getSession(session.id)).toBeUndefined();
      }
      openedPreparation.finish();
      await whenSessionDrained(runtime.pendingSends!, tree.openedSession.id);
      expect((await readHistory(runtime, tree.openedSession.id)).map((turn) => turn.id)).toContain(
        openedSend.id
      );
    }
  );

  it('archives a conversation that exists only as a held creation, and drops held child creations', async () => {
    const tree = createContainmentSessions('held-creation-archive', false);
    const metaRepo = createSessionMetaRepo(tree.sessions);
    const runtime = createRuntime({ repo: metaRepo.repo });
    const actions = await renderActions(runtime);
    const unwrittenId = 'held-creation-only' as SessionId;
    const childId = 'held-creation-child' as SessionId;

    await actions.startSession(createSessionPayload(unwrittenId), userInput('new'), [
      imageDraft('att-new'),
    ]);
    await actions.startSession(
      { ...createSessionPayload(childId), parentSessionId: tree.rootSession.id },
      userInput('child'),
      [imageDraft('att-child')]
    );
    expect(runtime.pendingSends?.getSnapshot().map((send) => send.sessionId)).toEqual([
      unwrittenId,
      childId,
    ]);

    await expect(actions.archiveSession(unwrittenId)).resolves.toBeUndefined();
    expect(runtime.pendingSends?.hasSession(unwrittenId)).toBe(false);
    expect(metaRepo.getSession(unwrittenId)).toBeUndefined();

    await actions.archiveSession(tree.rootSession.id);
    expect(runtime.pendingSends?.getSnapshot()).toEqual([]);
    expect(metaRepo.getSession(childId)).toBeUndefined();
    expect(metaRepo.getSession(tree.rootSession.id)).toMatchObject({ isArchived: true });
    for (const preparation of heldPreparations) preparation.finish();
    expect(await readHistory(runtime, childId)).toEqual([]);
  });

  it('deletes a conversation together with its held send', async () => {
    const tree = createContainmentSessions('delete-held', false);
    const repo = await LoroRepo.create({});
    try {
      await repo.upsertDocMeta(getSessionRoomId(tree.rootSession.id), tree.rootSession);
      const runtime = createRuntime({ repo });
      const actions = await renderActions(runtime);
      preparationsIgnoringAbort.add(tree.rootSession.id);
      const held = await actions.addSessionHistory(tree.rootSession.id, userInput('delete me'), {
        dispatch: true,
        attachments: [imageDraft('att-delete')],
      });
      const [preparation] = heldPreparations;

      const deleting = actions.deleteSessions([tree.rootSession.id]);
      await whenAborted(preparation.signal);
      preparation.finish();
      await deleting;

      expect(
        isLoroRepoDocDeleted(await repo.getDocMeta(getSessionRoomId(tree.rootSession.id)))
      ).toBe(true);
      expect(runtime.pendingSends?.has(held.id)).toBe(false);
      expect(await readHistory(runtime, tree.rootSession.id)).toEqual([]);
    } finally {
      await repo.destroy();
    }
  });

  it('archives an already archived root again to repair tabs without following opener cycles', async () => {
    const {
      rootSession,
      tabSession,
      openedSession,
      openedFromTabSession,
      sessions,
      sessionMetaCache,
    } = createContainmentSessions('retry', false);
    rootSession.isArchived = true;
    rootSession.openedBySessionId = openedSession.id;
    const metaRepo = createSessionMetaRepo(sessions);
    const actions = await renderActions(createRuntime({ repo: metaRepo.repo }), {
      sessionMetaCache,
    });

    await actions.archiveSession(rootSession.id);
    await actions.archiveSession(rootSession.id);

    for (const session of [rootSession, tabSession]) {
      expect(metaRepo.getSession(session.id)).toMatchObject({ isArchived: true });
    }
    for (const session of [openedSession, openedFromTabSession]) {
      expect(metaRepo.getSession(session.id)).toEqual(session);
    }
  });

  it('restores child tabs without restoring independently opened session workspaces', async () => {
    const { rootSession, tabSession, openedSession, openedFromTabSession, sessionMetaCache } =
      createContainmentSessions('restore', true);
    openedSession.machineId = rootSession.machineId;
    const metaRepo = createSessionMetaRepo(Object.values(sessionMetaCache));
    metaRepo.setMeta(getMachineRoomId(rootSession.machineId), {
      needToArchiveSessions: {
        [rootSession.id]: true,
        [openedSession.id]: true,
      },
      needToDeleteSessions: {
        [rootSession.id]: true,
        [openedSession.id]: true,
      },
    });
    metaRepo.setMeta(getMachineRoomId(openedFromTabSession.machineId), {
      needToArchiveSessions: { [openedFromTabSession.id]: true },
      needToDeleteSessions: { [openedFromTabSession.id]: true },
    });
    const runtime = createRuntime({ repo: metaRepo.repo });
    const actions = await renderActions(runtime, { sessionMetaCache });

    await actions.restoreSession(rootSession.id);

    for (const session of [rootSession, tabSession]) {
      expect(metaRepo.getSession(session.id)).toMatchObject({ isArchived: false });
    }
    for (const session of [openedSession, openedFromTabSession]) {
      expect(metaRepo.getSession(session.id)).toMatchObject({ isArchived: true });
    }
    // Restore is a state change only; legacy queue entries written by older
    // clients are left for the daemon to discard.
    expect(metaRepo.getMeta(getMachineRoomId(rootSession.machineId))).toMatchObject({
      needToArchiveSessions: { [rootSession.id]: true, [openedSession.id]: true },
      needToDeleteSessions: { [rootSession.id]: true, [openedSession.id]: true },
    });
    expect(runtime.writer.flockRowDelete).not.toHaveBeenCalled();
  });

  it('deletes exactly the requested Session before metadata hydration completes', async () => {
    const { rootSession, tabSession, openedSession, openedFromTabSession, sessionMetaCache } =
      createContainmentSessions('exact-delete', false);
    const metaRepo = createSessionMetaRepo(Object.values(sessionMetaCache));
    const runtime = createRuntime({
      repo: metaRepo.repo,
      readSessionOperationTargets: async () => {
        throw new Error('Session metadata is still loading');
      },
    });
    const store = createStore();
    const targetLease = editRunConfigDraft(store, tabSession.id);
    editRunConfigDraft(store, rootSession.id);
    editRunConfigDraft(store, tabSession.id, 'other-workspace');
    const actions = await renderActions(runtime, {
      store,
      sessionMetaCache,
      docMetaCacheReady: false,
    });

    await actions.deleteSessions([tabSession.id]);

    expect(metaRepo.getSession(rootSession.id)).toMatchObject({ isArchived: false });
    expect(metaRepo.getSession(tabSession.id)).toBeUndefined();
    expect(
      [...store.get(sessionRunConfigDraftsAtom).values()].map(({ scope }) => [
        scope.workspaceId,
        scope.sessionId,
      ])
    ).toEqual([
      ['workspace-1', rootSession.id],
      ['other-workspace', tabSession.id],
    ]);
    expect(targetLease.active).toBe(false);
    store.set(editSessionRunConfigDraftAtom, {
      lease: targetLease,
      edit: { type: 'config', configId: 'fast', value: true },
    });
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(2);
    expect(metaRepo.getSession(openedSession.id)).toMatchObject({
      isArchived: false,
      openedBySessionId: rootSession.id,
    });
    expect(metaRepo.getSession(openedFromTabSession.id)).toMatchObject({
      isArchived: false,
      openedBySessionId: tabSession.id,
      openedByRootSessionId: rootSession.id,
    });
    for (const session of [openedSession, openedFromTabSession]) {
      expect(runtime.writer.deleteDoc).not.toHaveBeenCalledWith(getSessionRoomId(session.id));
      expect(runtime.writer.flockRowDelete).not.toHaveBeenCalledWith(
        expect.any(String),
        machineFlockKeys.sessionLaunchConfig(session.id)
      );
    }
  });

  it('keeps active opened Sessions and their machine queues after archive then delete', async () => {
    const { rootSession, tabSession, openedSession, openedFromTabSession, sessionMetaCache } =
      createContainmentSessions('archive-delete', false);
    for (const session of [openedSession, openedFromTabSession]) {
      session.machineId = rootSession.machineId;
      session.repoFullName = 'loro-dev/lody';
      session.branchName = `lody/${session.id}`;
      session.baseBranch = 'main';
      session.isWorktree = true;
    }
    const metaRepo = createSessionMetaRepo(Object.values(sessionMetaCache));
    metaRepo.setMeta(getMachineRoomId(rootSession.machineId), {
      needToArchiveSessions: {
        [openedSession.id]: true,
        [openedFromTabSession.id]: true,
      },
      needToDeleteSessions: {
        [openedSession.id]: true,
        [openedFromTabSession.id]: true,
      },
    });
    const runtime = createRuntime({ repo: metaRepo.repo });
    const store = createStore();
    editRunConfigDraft(store, rootSession.id);
    editRunConfigDraft(store, tabSession.id);
    editRunConfigDraft(store, openedSession.id);
    const drafts = store.get(sessionRunConfigDraftsAtom);
    const actions = await renderActions(runtime, {
      store,
      docMetaCacheReady: true,
      sessionMetaCache,
    });

    await actions.archiveSession(rootSession.id);
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(drafts);
    for (const session of [openedSession, openedFromTabSession]) {
      expect(metaRepo.getSession(session.id)).toMatchObject({ isArchived: false });
    }
    vi.mocked(runtime.writer.flockRowPut).mockClear();
    vi.mocked(runtime.writer.flockRowDelete).mockClear();
    vi.mocked(runtime.writer.deleteDoc).mockClear();

    await actions.deleteArchivedSession(rootSession.id);
    expect(
      [...store.get(sessionRunConfigDraftsAtom).values()].map(({ scope }) => scope.sessionId)
    ).toEqual([openedSession.id]);

    expect(metaRepo.getSession(rootSession.id)).toBeUndefined();
    expect(metaRepo.getSession(tabSession.id)).toBeUndefined();
    expect(metaRepo.getSession(openedSession.id)).toMatchObject({
      isArchived: false,
      openedBySessionId: rootSession.id,
    });
    expect(metaRepo.getSession(openedFromTabSession.id)).toMatchObject({
      isArchived: false,
      openedBySessionId: tabSession.id,
      openedByRootSessionId: rootSession.id,
    });
    for (const session of [openedSession, openedFromTabSession]) {
      expect(runtime.writer.deleteDoc).not.toHaveBeenCalledWith(getSessionRoomId(session.id));
      expect(runtime.writer.flockRowPut).not.toHaveBeenCalledWith(
        expect.any(String),
        machineFlockKeys.deleteSessionCommand(session.id),
        expect.any(Object)
      );
      expect(runtime.writer.flockRowDelete).not.toHaveBeenCalledWith(
        expect.any(String),
        machineFlockKeys.sessionLaunchConfig(session.id)
      );
    }
    expect(metaRepo.getMeta(getMachineRoomId(rootSession.machineId))).toMatchObject({
      needToArchiveSessions: {
        [openedSession.id]: true,
        [openedFromTabSession.id]: true,
      },
      needToDeleteSessions: {
        [openedSession.id]: true,
        [openedFromTabSession.id]: true,
      },
    });
  });
});

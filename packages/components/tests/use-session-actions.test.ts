// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FREE_SESSION_LIMIT_PER_WORKSPACE,
  getMachineRoomId,
  getSessionRoomId,
  machineFlockKeys,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type SessionToCreate,
  type WorkspaceId,
} from '@lody/shared';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStaticStore,
  type CloudApi,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';

vi.mock('@/lib/auth-bootstrap', () => ({
  readBootstrappedCurrentUser: () => null,
  readStoredAuthToken: () => null,
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
  useQuery: () => billingEntitlementState,
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
import { docMetaCacheReadyAtom, sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import {
  countSessionMentions,
  SessionCreateBillingError,
  resolveSessionChatType,
  useSessionActions,
  type SessionActions,
} from '../src/hooks/use-session-actions';
import { buildResendInputBlocks } from '../src/lib/undelivered-user-turn';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function createDeferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve: (() => void) | undefined;
  let reject: (() => void) | undefined;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = () => nextReject(new Error('stream failed'));
  });
  if (!resolve || !reject) {
    throw new Error('Failed to create deferred');
  }
  return { promise, resolve, reject };
}

function ActionsProbe({ onReady }: { onReady: (actions: SessionActions) => void }) {
  const actions = useSessionActions();
  useEffect(() => {
    onReady(actions);
  }, [actions, onReady]);
  return null;
}

const createRuntime = (
  overrides: Partial<
    Pick<WorkspaceRuntime, 'ensureDocStream' | 'repo' | 'workspaceId' | 'workspaceSlug' | 'writer'>
  >
): WorkspaceRuntime => {
  const repo =
    overrides.repo ??
    ({
      upsertDocMeta: vi.fn(async () => undefined),
    } as unknown as WorkspaceRuntime['repo']);

  const sessionHistory: unknown[] = [];

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

  return {
    workspaceSlug: overrides.workspaceSlug ?? 'workspace-slug',
    workspaceId: overrides.workspaceId ?? ('workspace-1' as WorkspaceId),
    repo,
    writer,
    ensureDocStream: overrides.ensureDocStream ?? vi.fn(async () => undefined),
    releaseSessionStore: vi.fn(async () => undefined),
    withSessionStore: vi.fn(async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
      fn({
        getState: vi.fn(() => ({ history: sessionHistory })),
        setState: vi.fn((updater: (draft: { history: unknown[] }) => void) => {
          updater({ history: sessionHistory });
        }),
        waitUntilSynced: vi.fn(async () => undefined),
      })
    ),
  } as unknown as WorkspaceRuntime;
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
  }) as SessionToCreate;

describe('useSessionActions', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    recordMyWorkspaceDailyActiveUser.mockClear();
    requestAuthRecovery.mockClear();
    convexAuthState.isAuthenticated = true;
    billingEntitlementState.effectivePlanTier = 'plus';
    billingEntitlementState.checkoutPending = false;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  const renderActions = async (
    runtime: WorkspaceRuntime,
    options: {
      workspaceId?: WorkspaceId | null;
      workspaceSlug?: string | null;
      docMetaCacheReady?: boolean;
      sessionMetaCache?: Record<string, SessionMeta>;
    } = {}
  ): Promise<SessionActions> => {
    const jotaiStore = createStore();
    jotaiStore.set(runtimeAtom, runtime);
    jotaiStore.set(docMetaCacheReadyAtom, options.docMetaCacheReady ?? false);
    jotaiStore.set(sessionMetaCacheAtom, options.sessionMetaCache ?? {});
    jotaiStore.set(currentWorkspaceIdAtom, options.workspaceId ?? ('workspace-1' as WorkspaceId));
    jotaiStore.set(currentWorkspaceSlugAtom, options.workspaceSlug ?? 'workspace-slug');

    let actions: SessionActions | null = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          PlatformContext.Provider,
          { value: testPlatform },
          createElement(
            Provider,
            { store: jotaiStore },
            createElement(ActionsProbe, {
              onReady: (nextActions) => {
                actions = nextActions;
              },
            })
          )
        )
      );
    });

    if (!actions) {
      throw new Error('Session actions were not initialized');
    }
    return actions;
  };

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

    const result = await Promise.race([
      actions.createSession(createSessionPayload(sessionId)),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 20)),
    ]);

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
    ).rejects.toMatchObject<Partial<SessionCreateBillingError>>({
      code: 'free_session_limit_reached',
      current: FREE_SESSION_LIMIT_PER_WORKSPACE,
      limit: FREE_SESSION_LIMIT_PER_WORKSPACE,
    });
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

  it('allows creation while workspace id atom is pending if runtime matches the route slug', async () => {
    const sessionId = 'session-create-workspace-id-pending' as SessionId;
    const upsertDocMeta = vi.fn(async () => undefined);
    const runtime = createRuntime({
      repo: { upsertDocMeta } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime, {
      workspaceId: null,
      workspaceSlug: 'workspace-slug',
    });

    await expect(actions.createSession(createSessionPayload(sessionId))).resolves.toEqual(
      expect.objectContaining({
        sessionId,
        sessionMeta: expect.objectContaining({ id: sessionId }),
      })
    );
    expect(upsertDocMeta).toHaveBeenCalledWith(
      getSessionRoomId(sessionId),
      expect.objectContaining({ id: sessionId })
    );
  });

  it('records daily active user when creating a child session', async () => {
    const sessionId = 'session-child-create' as SessionId;
    const upsertDocMeta = vi.fn(async () => undefined);
    const runtime = createRuntime({
      repo: { upsertDocMeta } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime);

    await actions.createSession({
      ...createSessionPayload(sessionId),
      parentSessionId: 'parent-session-id' as SessionId,
    });

    expect(recordMyWorkspaceDailyActiveUser).toHaveBeenCalledWith({
      workspaceId: runtime.workspaceId,
    });
  });

  it('does not record daily activity while Convex authentication is recovering', async () => {
    convexAuthState.isAuthenticated = false;
    const runtime = createRuntime({});
    const actions = await renderActions(runtime);

    await actions.createSession(createSessionPayload('session-auth-recovery' as SessionId));

    expect(recordMyWorkspaceDailyActiveUser).not.toHaveBeenCalled();
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
    const runtime = createRuntime({
      repo: {
        // The sidebar's rendered cache can lead the async repo read during
        // hydration; the visible row's action must still work in that window.
        getDocMeta: vi.fn(async () => undefined),
        upsertDocMeta,
      } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime, {
      sessionMetaCache: { [getSessionRoomId(sessionId)]: sessionMeta },
    });

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
    const setState = vi.fn();
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
    expect(setState).not.toHaveBeenCalled();
    expect(waitUntilSynced).toHaveBeenCalledTimes(1);

    metaWrite.resolve();
    await dispatchPromise;
    expect(requestSessionDispatchTurn).toHaveBeenCalledTimes(1);
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
      disposition: 'rejected' as const,
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

  it('authors the pending user turn through the writer seam on send', async () => {
    const sessionId = 'session-append-turn-writer' as SessionId;
    const appendSessionTurn = vi.fn(async () => 'direct' as const);
    const runtime = createRuntime({
      writer: {
        modeForMachine: () => 'direct' as const,
        modeForSession: async () => 'direct' as const,
        upsertDocMeta: vi.fn(async () => undefined),
        appendSessionTurn,
        appendSessionHistory: vi.fn(async () => undefined),
      } as unknown as WorkspaceRuntime['writer'],
    });
    const actions = await renderActions(runtime);

    const entry = await actions.addSessionHistory(sessionId, {
      role: 'user',
      userId: 'user-1',
      items: [{ type: 'text', text: 'hi' }],
      timestamp: '2026-07-05T00:00:00.000Z',
      status: 'pending',
      read: false,
      finished: true,
    } as unknown as Parameters<SessionActions['addSessionHistory']>[1]);

    expect(appendSessionTurn).toHaveBeenCalledTimes(1);
    expect(appendSessionTurn).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ id: entry.id, role: 'user' }),
      undefined
    );
  });

  it('mints a fresh turn id when identical content is sent again (undelivered-turn resend)', async () => {
    const sessionId = 'session-resend-new-turn-id' as SessionId;
    const appendSessionTurn = vi.fn(async () => 'direct' as const);
    const runtime = createRuntime({
      writer: {
        modeForMachine: () => 'direct' as const,
        modeForSession: async () => 'direct' as const,
        upsertDocMeta: vi.fn(async () => undefined),
        appendSessionTurn,
        appendSessionHistory: vi.fn(async () => undefined),
      } as unknown as WorkspaceRuntime['writer'],
    });
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
    expect(appendSessionTurn).toHaveBeenCalledTimes(2);
    const resentEntry = appendSessionTurn.mock.calls[1]?.[1] as {
      inputConfig?: { inputBlocks?: unknown };
    };
    expect(resentEntry.inputConfig?.inputBlocks).toEqual(inputBlocks);
  });

  it('starts a session through one aggregate writer call', async () => {
    const sessionId = 'session-aggregate-start' as SessionId;
    const startSession = vi.fn(async () => 'direct' as const);
    const runtime = createRuntime({
      writer: {
        modeForMachine: () => 'direct' as const,
        modeForSession: async () => 'direct' as const,
        startSession,
      } as unknown as WorkspaceRuntime['writer'],
    });
    const actions = await renderActions(runtime);

    const result = await actions.startSession(createSessionPayload(sessionId), {
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
    } as unknown as Parameters<SessionActions['startSession']>[1]);

    expect(startSession).toHaveBeenCalledOnce();
    expect(startSession).toHaveBeenCalledWith(
      sessionId,
      // lastMessageAt rides the accept unit itself: the meta always carries
      // the first message's activity, so a close racing the first turn can
      // never mistake the session for an empty, deletable one.
      expect.objectContaining({
        id: sessionId,
        machineId: 'machine-1',
        lastMessageAt: expect.any(Number),
      }),
      expect.objectContaining({ id: result.historyEntry.id, role: 'user' }),
      expect.objectContaining({ userTurnId: result.historyEntry.id })
    );
    expect(runtime.withSessionStore).not.toHaveBeenCalled();
  });

  it('keeps a local branch selector out of baseBranch until the target machine resolves it', async () => {
    const sessionId = 'session-local-selector' as SessionId;
    const startSession = vi.fn(async () => 'direct' as const);
    const runtime = createRuntime({
      writer: {
        modeForMachine: () => 'direct' as const,
        modeForSession: async () => 'direct' as const,
        startSession,
      } as unknown as WorkspaceRuntime['writer'],
    });
    const actions = await renderActions(runtime);
    const selector = 'lody:branch:remote:origin:foo';

    await actions.startSession(
      {
        ...createSessionPayload(sessionId),
        project: {
          kind: 'local',
          localProjectId: 'project-1',
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

    const meta = startSession.mock.calls[0]![1];
    expect(meta).not.toHaveProperty('baseBranch');
    expect(meta.project).toMatchObject({ branch: selector });
  });

  it('fires the Machine RPC fast path and still authors the durable dispatch pointer', async () => {
    const sessionId = 'session-dispatch-fast-path' as SessionId;
    const userTurnId = 'user-turn-fast-path';
    const machineId = 'machine-1' as MachineId;
    const history = [
      {
        id: userTurnId,
        role: 'user',
        userId: 'user-1',
        timestamp: '2026-07-05T00:00:00.000Z',
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
    const writerUpsertDocMeta = vi.fn(async () => undefined);
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
        upsertDocMeta: vi.fn(async () => undefined),
      } as unknown as WorkspaceRuntime['repo'],
      writer: {
        modeForMachine: () => 'direct' as const,
        modeForSession: async () => 'direct' as const,
        upsertDocMeta: writerUpsertDocMeta,
        appendSessionTurn: vi.fn(async () => 'direct' as const),
        appendSessionHistory: vi.fn(async () => undefined),
      } as unknown as WorkspaceRuntime['writer'],
    }) as WorkspaceRuntime & {
      withSessionStore: WorkspaceRuntime['withSessionStore'];
      requestSessionDispatchTurn: WorkspaceRuntime['requestSessionDispatchTurn'];
    };
    runtime.withSessionStore = vi.fn(async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
      fn({
        getState: vi.fn(() => ({ history })),
        setState: vi.fn(),
        waitUntilSynced: vi.fn(async () => undefined),
      })
    ) as unknown as WorkspaceRuntime['withSessionStore'];
    runtime.requestSessionDispatchTurn =
      requestSessionDispatchTurn as WorkspaceRuntime['requestSessionDispatchTurn'];
    const actions = await renderActions(runtime);

    await actions.requestSessionDispatch(sessionId, userTurnId, { machineId });

    // The facade routes local machines over the local socket RPC and remote
    // machines over the cloud stream; the durable pointer remains recovery truth.
    expect(requestSessionDispatchTurn).toHaveBeenCalledTimes(1);
    expect(writerUpsertDocMeta).toHaveBeenCalledWith(
      getSessionRoomId(sessionId),
      expect.objectContaining({ latestUserMsgId: userTurnId })
    );
  });

  it('dispatches a guide as a normal follow-up when its target turn already ended', async () => {
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
    const upsertDocMeta = vi.fn(async () => undefined);
    const requestSessionSteer = vi.fn(async () => ({
      type: 'session/steer_response' as const,
      sessionId,
      userTurnId,
      applied: false,
      disposition: 'no-active-turn' as const,
    }));
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
      requestSessionSteer: WorkspaceRuntime['requestSessionSteer'];
      requestSessionDispatchTurn: WorkspaceRuntime['requestSessionDispatchTurn'];
    };
    runtime.withSessionStore = vi.fn(async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
      fn({
        getState: vi.fn(() => state),
        setState,
        waitUntilSynced,
      })
    ) as unknown as WorkspaceRuntime['withSessionStore'];
    runtime.requestSessionSteer = requestSessionSteer as WorkspaceRuntime['requestSessionSteer'];
    runtime.requestSessionDispatchTurn =
      requestSessionDispatchTurn as WorkspaceRuntime['requestSessionDispatchTurn'];
    const actions = await renderActions(runtime);

    await expect(
      actions.requestSessionSteer(sessionId, 'assistant:user-1', userTurnId, { machineId })
    ).resolves.toBe(false);

    expect(history[0]).toMatchObject({ status: 'pending', read: false });
    expect(requestSessionDispatchTurn).toHaveBeenCalledWith(
      machineId,
      expect.objectContaining({ sessionId, userTurnId })
    );
    expect(upsertDocMeta).toHaveBeenCalledWith(
      getSessionRoomId(sessionId),
      expect.objectContaining({ latestUserMsgId: userTurnId })
    );
    expect(waitUntilSynced).toHaveBeenCalledOnce();
  });

  it('does not redispatch a steer rejected for a reason other than an ended turn', async () => {
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
    runtime.withSessionStore = vi.fn(async (_sessionId: unknown, fn: (store: unknown) => unknown) =>
      fn({
        getState: vi.fn(() => ({ history })),
        setState,
        waitUntilSynced: vi.fn(async () => undefined),
      })
    ) as unknown as WorkspaceRuntime['withSessionStore'];
    runtime.requestSessionSteer = vi.fn(async () => ({
      type: 'session/steer_response' as const,
      sessionId,
      userTurnId,
      applied: false,
      disposition: 'stale-turn' as const,
    })) as WorkspaceRuntime['requestSessionSteer'];
    runtime.requestSessionDispatchTurn =
      requestSessionDispatchTurn as WorkspaceRuntime['requestSessionDispatchTurn'];
    const actions = await renderActions(runtime);

    await expect(
      actions.requestSessionSteer(sessionId, 'assistant:user-1', userTurnId, { machineId })
    ).resolves.toBe(false);

    expect(history[0]).toMatchObject({ status: 'pending_apply' });
    expect(setState).not.toHaveBeenCalled();
    expect(requestSessionDispatchTurn).not.toHaveBeenCalled();
  });

  it('writes legacy archive queue for mixed-version machine rollout', async () => {
    const sessionId = 'session-archive-legacy-queue' as SessionId;
    const machineId = 'machine-1';
    const sessionMeta = {
      id: sessionId,
      machineId,
      userId: 'user-1',
      cliType: 'builtin',
      createdAt: new Date().toISOString(),
    } as SessionMeta;
    const upsertDocMeta = vi.fn(async () => undefined);
    const getDocMeta = vi.fn(async (roomId: string) => {
      if (roomId === getSessionRoomId(sessionId)) return { meta: sessionMeta };
      if (roomId === getMachineRoomId(machineId)) {
        return { meta: { needToArchiveSessions: {}, needToDeleteSessions: {} } };
      }
      return { meta: {} };
    });
    const runtime = createRuntime({
      repo: {
        getDocMeta,
        upsertDocMeta,
        openFlockDoc: vi.fn(async () => ({
          flock: { scan: () => [], set: vi.fn(), delete: vi.fn(), commit: vi.fn() },
          syncOnce: vi.fn(async () => undefined),
        })),
        flush: vi.fn(async () => undefined),
      } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime);

    await actions.archiveSession(sessionId);

    expect(upsertDocMeta).toHaveBeenCalledWith(
      getMachineRoomId(machineId),
      expect.objectContaining({
        needToArchiveSessions: { [sessionId]: true },
      })
    );
  });

  it('archives from the rendered meta cache when repo meta has not hydrated', async () => {
    const sessionId = 'session-archive-known-meta' as SessionId;
    const renderedMeta = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      cliType: 'builtin',
      createdAt: new Date().toISOString(),
      parentSessionId: 'parent-session-1' as SessionId,
    } as SessionMeta;
    const upsertDocMeta = vi.fn(async () => undefined);
    // The repo cannot read the doc meta yet (child session still hydrating).
    const getDocMeta = vi.fn(async () => undefined);
    const runtime = createRuntime({
      repo: { getDocMeta, upsertDocMeta } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime, {
      sessionMetaCache: { [getSessionRoomId(sessionId)]: renderedMeta },
    });

    await actions.archiveSession(sessionId);

    expect(upsertDocMeta).toHaveBeenCalledWith(
      getSessionRoomId(sessionId),
      expect.objectContaining({ isArchived: true })
    );

    // A session neither the repo nor the UI knows still fails loudly.
    await expect(actions.archiveSession('session-unknown-meta' as SessionId)).rejects.toThrow(
      'Session metadata missing'
    );
  });

  it('archives child tabs and independently opened session workspaces together', async () => {
    const rootSession = {
      id: 'archive-root' as SessionId,
      machineId: 'machine-root' as MachineId,
      createdAt: '2026-08-24T00:00:00.000Z',
    } as SessionMeta;
    const tabSession = {
      id: 'archive-tab' as SessionId,
      machineId: rootSession.machineId,
      parentSessionId: rootSession.id,
      openedBySessionId: rootSession.id,
      createdAt: '2026-08-24T00:01:00.000Z',
    } as SessionMeta;
    const openedSession = {
      id: 'archive-opened' as SessionId,
      machineId: 'machine-opened' as MachineId,
      openedBySessionId: rootSession.id,
      createdAt: '2026-08-24T00:02:00.000Z',
    } as SessionMeta;
    const openedFromTabSession = {
      id: 'archive-opened-from-tab' as SessionId,
      machineId: 'machine-opened-from-tab' as MachineId,
      openedBySessionId: tabSession.id,
      openedByRootSessionId: rootSession.id,
      createdAt: '2026-08-24T00:03:00.000Z',
    } as SessionMeta;
    const sessionMetaCache = Object.fromEntries(
      [rootSession, tabSession, openedSession, openedFromTabSession].map((session) => [
        getSessionRoomId(session.id),
        session,
      ])
    );
    const upsertDocMeta = vi.fn(async () => undefined);
    const getDocMeta = vi.fn(async (roomId: string) => {
      const session = sessionMetaCache[roomId];
      return { meta: session ?? {} };
    });
    const runtime = createRuntime({
      repo: { getDocMeta, upsertDocMeta } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime, { sessionMetaCache });

    await actions.archiveSession(rootSession.id);

    for (const session of [rootSession, tabSession, openedSession, openedFromTabSession]) {
      expect(upsertDocMeta).toHaveBeenCalledWith(
        getSessionRoomId(session.id),
        expect.objectContaining({ isArchived: true, status: { type: 'idle' } })
      );
    }
    expect(runtime.writer.flockRowPut).toHaveBeenCalledTimes(3);
    expect(runtime.writer.flockRowPut).toHaveBeenCalledWith(
      expect.any(String),
      machineFlockKeys.archiveSessionCommand(rootSession.id),
      expect.any(Object)
    );
    expect(runtime.writer.flockRowPut).not.toHaveBeenCalledWith(
      expect.any(String),
      machineFlockKeys.archiveSessionCommand(tabSession.id),
      expect.any(Object)
    );
  });

  it('writes legacy delete queue before deleting archived code sessions', async () => {
    const sessionId = 'session-delete-legacy-queue' as SessionId;
    const machineId = 'machine-1';
    const sessionMeta = {
      id: sessionId,
      machineId,
      userId: 'user-1',
      cliType: 'builtin',
      createdAt: new Date().toISOString(),
      isArchived: true,
      repoFullName: 'loro-dev/lody',
      branchName: 'lody/session-delete-legacy-queue',
      baseBranch: 'main',
      isWorktree: true,
    } as SessionMeta;
    const upsertDocMeta = vi.fn(async () => undefined);
    const deleteDoc = vi.fn(async () => undefined);
    const getDocMeta = vi.fn(async (roomId: string) => {
      if (roomId === getSessionRoomId(sessionId)) return { meta: sessionMeta };
      if (roomId === getMachineRoomId(machineId)) {
        return {
          meta: {
            needToArchiveSessions: { [sessionId]: true },
            needToDeleteSessions: {},
          },
        };
      }
      return { meta: {} };
    });
    const runtime = createRuntime({
      repo: {
        getDocMeta,
        upsertDocMeta,
        deleteDoc,
        openFlockDoc: vi.fn(async () => ({
          flock: {
            scan: () => [
              {
                key: machineFlockKeys.archiveSessionCommand(sessionId),
                value: { v: 1, requestedAt: 1 },
              },
            ],
            set: vi.fn(),
            delete: vi.fn(),
            commit: vi.fn(),
          },
          syncOnce: vi.fn(async () => undefined),
        })),
        flush: vi.fn(async () => undefined),
      } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime);

    await actions.deleteArchivedSession(sessionId);

    expect(upsertDocMeta).toHaveBeenCalledWith(
      getMachineRoomId(machineId),
      expect.objectContaining({
        needToArchiveSessions: {},
        needToDeleteSessions: expect.objectContaining({
          [sessionId]: expect.objectContaining({
            repoFullName: 'loro-dev/lody',
            branchName: 'lody/session-delete-legacy-queue',
            baseBranchName: 'main',
            isWorktree: true,
          }),
        }),
      })
    );
    expect(deleteDoc).toHaveBeenCalledWith(getSessionRoomId(sessionId));
  });

  it('allows permanent deletion without a browser connection', async () => {
    const sessionId = 'session-delete-offline' as SessionId;
    const getDocMeta = vi.fn(async () => ({ meta: {} }));
    const deleteDoc = vi.fn(async () => undefined);
    const upsertDocMeta = vi.fn(async () => undefined);
    const runtime = createRuntime({
      repo: {
        getDocMeta,
        deleteDoc,
        upsertDocMeta,
      } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime);

    await expect(actions.deleteArchivedSession(sessionId)).resolves.toBeUndefined();
    await expect(actions.deleteSessions([sessionId])).resolves.toBeUndefined();

    expect(getDocMeta).toHaveBeenCalled();
    expect(deleteDoc).toHaveBeenCalledWith(getSessionRoomId(sessionId));
    expect(upsertDocMeta).not.toHaveBeenCalled();
    expect(recordMyWorkspaceDailyActiveUser).not.toHaveBeenCalled();
  });

  it('clears legacy archive queue when archived session does not need machine delete', async () => {
    const sessionId = 'session-delete-local-no-cleanup' as SessionId;
    const machineId = 'machine-1';
    const sessionMeta = {
      id: sessionId,
      machineId,
      userId: 'user-1',
      cliType: 'builtin',
      createdAt: new Date().toISOString(),
      isArchived: true,
      project: { kind: 'local' },
    } as SessionMeta;
    const upsertDocMeta = vi.fn(async () => undefined);
    const deleteDoc = vi.fn(async () => undefined);
    const getDocMeta = vi.fn(async (roomId: string) => {
      if (roomId === getSessionRoomId(sessionId)) return { meta: sessionMeta };
      if (roomId === getMachineRoomId(machineId)) {
        return {
          meta: {
            needToArchiveSessions: { [sessionId]: true },
            needToDeleteSessions: {},
          },
        };
      }
      return { meta: {} };
    });
    const runtime = createRuntime({
      repo: {
        getDocMeta,
        upsertDocMeta,
        deleteDoc,
        openFlockDoc: vi.fn(async () => ({
          flock: {
            scan: () => [
              {
                key: machineFlockKeys.archiveSessionCommand(sessionId),
                value: { v: 1, requestedAt: 1 },
              },
            ],
            set: vi.fn(),
            delete: vi.fn(),
            commit: vi.fn(),
          },
          syncOnce: vi.fn(async () => undefined),
        })),
        flush: vi.fn(async () => undefined),
      } as unknown as WorkspaceRuntime['repo'],
    });
    const actions = await renderActions(runtime);

    await actions.deleteArchivedSession(sessionId);

    expect(upsertDocMeta).toHaveBeenCalledWith(
      getMachineRoomId(machineId),
      expect.objectContaining({
        needToArchiveSessions: {},
      })
    );
    expect(deleteDoc).toHaveBeenCalledWith(getSessionRoomId(sessionId));
  });
});

describe('resolveSessionChatType', () => {
  it('distinguishes side chats from regular sessions', () => {
    expect(resolveSessionChatType({ childSessionPlacement: 'side-panel' })).toBe('side_chat');
    expect(resolveSessionChatType({})).toBe('regular');
    expect(resolveSessionChatType(undefined)).toBe('regular');
  });
});

describe('countSessionMentions', () => {
  it('counts each sent mention kind and ignores pasted-text spans', () => {
    expect(
      countSessionMentions([
        {
          type: 'text',
          text: '@src @dir #12 $review /test @session @role pasted',
          spans: [
            { start: 0, end: 4, kind: 'file', label: '@src' },
            { start: 5, end: 9, kind: 'dir', label: '@dir' },
            { start: 10, end: 13, kind: 'issue', label: '#12' },
            { start: 14, end: 21, kind: 'skill', label: '$review' },
            { start: 22, end: 27, kind: 'command', label: '/test' },
            { start: 28, end: 36, kind: 'session', label: '@session' },
            { start: 37, end: 42, kind: 'agent_role', label: '@role' },
            { start: 43, end: 49, kind: 'pasted_text', label: 'pasted' },
          ],
        },
        {
          type: 'text',
          text: '#34 pull request',
          spans: [{ start: 0, end: 3, kind: 'pr', label: '#34' }],
        },
      ])
    ).toEqual({
      mention_count: 8,
      mention_types: ['file', 'dir', 'issue', 'pr', 'skill', 'session', 'command', 'agent_role'],
      mention_file_count: 1,
      mention_dir_count: 1,
      mention_issue_count: 1,
      mention_pr_count: 1,
      mention_skill_count: 1,
      mention_session_count: 1,
      mention_command_count: 1,
      mention_agent_role_count: 1,
    });
  });

  it('returns zero counts when the message has no mentions', () => {
    expect(countSessionMentions(undefined)).toMatchObject({
      mention_count: 0,
      mention_types: [],
    });
  });
});

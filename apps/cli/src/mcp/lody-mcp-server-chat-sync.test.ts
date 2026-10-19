import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LoroDoc } from 'loro-crdt';
import { createLoroSessionData } from '@lody/shared/session-data';
import {
  createHistoryWriter,
  getSessionRoomId,
  type LodyOperationCompletion,
  type LodyOperationItemResult,
  type SessionId,
} from '@lody/shared';
import type { LodyOperationStore } from '@/orchestration/operation-store';
import type { SessionToolHandlers } from './session-tool-router';

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  operationInbox: vi.fn(),
  activeInvocation: vi.fn(),
  createSessionResult: vi.fn(),
  sendSessionChatResult: vi.fn(),
  finish: vi.fn(),
  get: vi.fn(),
  findMatchingRetry: vi.fn(),
  getDocMeta: vi.fn(),
  snapshot: vi.fn(),
  markItemInputDurable: vi.fn(),
  validateSessionChatTarget: vi.fn(),
  validateSessionCreateOptions: vi.fn(),
  readTurn: vi.fn(),
}));

vi.mock('@/lib/command-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/command-runtime')>();
  return {
    ...actual,
    getAuthContextOrThrow: vi.fn(() => ({ token: 'token', userId: 'requester-user-id' })),
    resolveWorkspaceOrThrow: vi.fn(async () => ({ id: 'workspace-id' })),
    syncWorkspaceMetaForRead: vi.fn(async () => undefined),
    withWorkspaceManager: vi.fn(
      async (
        _auth: unknown,
        _workspace: unknown,
        _source: unknown,
        fn: (manager: unknown) => Promise<unknown>
      ) =>
        await fn({
          repo: { getDocMeta: mocks.getDocMeta },
          getOnlineMachineIds: vi.fn(async () => new Set(['machine-id'])),
          getOrCreateSessionDoc: vi.fn(async () => ({})),
        })
    ),
  };
});

vi.mock('@/commands/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/commands/session')>();
  return {
    ...actual,
    createSessionResult: mocks.createSessionResult,
    sendSessionChatResult: mocks.sendSessionChatResult,
    validateSessionChatTarget: mocks.validateSessionChatTarget,
    validateSessionCreateOptions: mocks.validateSessionCreateOptions,
  };
});

vi.mock('@/orchestration/operation-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/orchestration/operation-store')>();
  return {
    ...actual,
    LodyOperationStore: class {
      get inbox() {
        return mocks.operationInbox();
      }
      findMatchingRetry = mocks.findMatchingRetry;
      accept = mocks.accept;
      finish = mocks.finish;
      get = mocks.get;
      snapshot = mocks.snapshot;
      markItemInputDurable = mocks.markItemInputDurable;
    },
    runWithOperationStoreBusyRetry: vi.fn(async (fn: () => unknown) => await fn()),
  };
});

vi.mock('@/session/session-backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/session/session-backend')>();
  return {
    ...actual,
    createSessionBackend: vi.fn(async (doc, meta) =>
      doc?.sessionData
        ? actual.createSessionBackend(doc, meta)
        : { history: { readTurn: mocks.readTurn } }
    ),
  };
});

vi.mock('@lody/shared/node/local-ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lody/shared/node/local-ipc')>();
  const { Effect } = await import('effect');
  return {
    ...actual,
    makeLocalControlClientAuto: vi.fn(() => ({
      machineRpc: vi.fn(() =>
        Effect.sync(() => ({
          ok: true as const,
          result: mocks.activeInvocation(),
        }))
      ),
    })),
  };
});

import {
  WORKSPACE_SYNC_UNAVAILABLE_MESSAGE,
  WorkspaceSyncUnavailableError,
} from '@/lib/command-runtime';

import {
  MachineFlockReadUnavailableError,
  resolveEffectiveSessionCreateDispatchConfig,
} from '@/commands/session';
import { LoroRepo, RepoTransportError } from 'loro-repo';
import { StreamsTransportAdapter } from 'loro-repo/transport/streams';
import { LoroDocumentManager } from '@/lib/loro/doc';
import { getLogger } from '@/utils/logger';
import type { AgentConfigMeta, WorkspaceId } from '@lody/shared';
import { MachineAccessVerificationError } from '@/session/session-access-retry';
import { FlockSyncTimeoutError } from '@/lib/loro/timeout-utils';

import { __lodyMcpServerInternals, buildSessionToolServer } from './lody-mcp-server';

const {
  mcpErrorResult,
  startSessionChatOperation,
  startSessionChatManyOperation,
  startSessionCreateOperation,
  startSessionCreateManyOperation,
} = __lodyMcpServerInternals;

const requesterSession = {
  id: 'requester-session-id',
  machineId: 'machine-id',
  userId: 'requester-user-id',
  cliType: 'codex',
  agentType: 'codex',
};

const targetSession = {
  id: 'target-session-id',
  machineId: 'machine-id',
  userId: 'target-user-id',
  cliType: 'codex',
  agentType: 'codex',
};

const expectSyncErrorResult = (
  result: ReturnType<typeof mcpErrorResult>,
  message = WORKSPACE_SYNC_UNAVAILABLE_MESSAGE,
  retryable = true
): void => {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('expected text result');
  expect(JSON.parse(content.text)).toEqual({
    ok: false,
    error: {
      code: 'SYNC_UNAVAILABLE',
      message,
      retryable,
    },
  });
};

const callAndMapMcpError = async (call: () => Promise<unknown>) => {
  try {
    await call();
    throw new Error('expected prevalidation to fail');
  } catch (error) {
    return mcpErrorResult(error);
  }
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.stubEnv('LODY_MCP_MACHINE_ID', 'machine-id');
  vi.stubEnv('LODY_MCP_WORKSPACE_ID', 'workspace-id');
  vi.stubEnv('LODY_MCP_SESSION_ID', requesterSession.id);
  mocks.activeInvocation.mockReturnValue({
    type: 'session/active-invocation-context' as const,
    sessionId: requesterSession.id,
    active: true as const,
    requesterUserId: requesterSession.userId,
    sourceTurnId: 'requester-turn-id',
    inputConfig: {},
  });
  mocks.findMatchingRetry.mockReturnValue(undefined);
  mocks.readTurn.mockImplementation(async (id: string) => ({
    state: 'ready',
    turn: {
      role: id.startsWith('assistant:') ? 'assistant' : 'user',
      author: id.startsWith('assistant:')
        ? {
            v: 1,
            kind: 'agent',
            sessionId: requesterSession.id,
            turnId: 'requester-turn-id',
            name: 'Codex',
          }
        : { v: 1, kind: 'human', userId: requesterSession.userId },
    },
  }));
  mocks.getDocMeta.mockImplementation(async (roomId: string) => {
    const session = [requesterSession, targetSession].find(
      (candidate) => getSessionRoomId(candidate.id as SessionId) === roomId
    );
    return session ? { meta: session } : undefined;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('session chat prevalidation sync failures', () => {
  beforeEach(() => {
    mocks.validateSessionChatTarget.mockRejectedValue(
      new WorkspaceSyncUnavailableError({
        message: 'prewrite sync failed',
        cause: new Error('transport unavailable'),
      })
    );
  });

  it('preserves retryable sync semantics through single chat before accepting an operation', async () => {
    const result = await callAndMapMcpError(() =>
      startSessionChatOperation({
        operationId: 'single-chat-operation',
        sessionId: targetSession.id,
        prompt: 'continue',
      })
    );

    expectSyncErrorResult(result);
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('does not persist a batch operation when chat prevalidation sync is unavailable', async () => {
    const result = await callAndMapMcpError(() =>
      startSessionChatManyOperation({
        operationId: 'batch-chat-operation',
        items: [{ sessionId: targetSession.id, prompt: 'continue' }],
      })
    );

    expectSyncErrorResult(result);
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('fails closed when the active execution runtime has already been released', async () => {
    mocks.activeInvocation.mockReturnValue({
      type: 'session/active-invocation-context' as const,
      sessionId: requesterSession.id,
      active: false as const,
    });

    const result = await callAndMapMcpError(() =>
      startSessionChatOperation({
        operationId: 'inactive-runtime-operation',
        sessionId: targetSession.id,
        prompt: 'continue',
      })
    );
    const content = result.content[0];
    if (!content || content.type !== 'text') throw new Error('expected text result');
    expect(JSON.parse(content.text)).toEqual({
      ok: false,
      error: {
        code: 'INVOKING_TURN_NOT_FOUND',
        message: 'The exact Turn driving this MCP invocation is no longer active.',
        retryable: false,
      },
    });
    expect(mocks.validateSessionChatTarget).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});

describe('turn-scoped reverse chat rejection', () => {
  let sessionData: ReturnType<typeof createLoroSessionData>;
  let store: LodyOperationStore;
  let root: string;
  let writer: ReturnType<typeof createHistoryWriter>;
  let delivered: { sessionId: string; prompt: string }[];

  const setInput = (turnId: string, senderSessionId?: string) => {
    writer.append({
      id: turnId,
      role: 'user',
      timestamp: '2026-10-12T00:00:00Z',
      userId: requesterSession.userId,
      author: senderSessionId
        ? {
            v: 1,
            kind: 'agent',
            sessionId: senderSessionId,
            turnId: 'sender-turn',
            name: 'Agent A',
          }
        : { v: 1, kind: 'human', userId: requesterSession.userId },
      items: [{ type: 'text', text: 'Synthetic delegated work' }],
      fileDiff: [],
    });
    writer.append({
      id: `assistant:${turnId}`,
      role: 'assistant',
      timestamp: '2026-10-12T00:00:00Z',
      author: { v: 1, kind: 'agent', sessionId: requesterSession.id, turnId, name: 'Agent B' },
      items: [],
      fileDiff: [],
    });
    mocks.activeInvocation.mockReturnValue({
      type: 'session/active-invocation-context',
      sessionId: requesterSession.id,
      active: true,
      requesterUserId: requesterSession.userId,
      sourceTurnId: turnId,
      inputConfig: {},
    });
  };

  const storedOperations = () =>
    store.listForRequester({
      workspaceId: 'workspace-id' as WorkspaceId,
      requesterSessionId: requesterSession.id as SessionId,
      requesterUserId: requesterSession.userId,
    }).items;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lody-reverse-chat-'));
    const actual = await vi.importActual<typeof import('@/orchestration/operation-store')>(
      '@/orchestration/operation-store'
    );
    store = new actual.LodyOperationStore(path.join(root, 'operations.sqlite3'));
    mocks.accept.mockImplementation(store.accept.bind(store));
    mocks.findMatchingRetry.mockImplementation(store.findMatchingRetry.bind(store));
    mocks.snapshot.mockImplementation(store.snapshot.bind(store));
    mocks.get.mockImplementation(store.get.bind(store));
    mocks.finish.mockImplementation(store.finish.bind(store));
    mocks.markItemInputDurable.mockImplementation(store.markItemInputDurable.bind(store));
    const doc = new LoroDoc();
    writer = createHistoryWriter(doc);
    const data = createLoroSessionData({
      sessionId: requesterSession.id as SessionId,
      doc,
      writer,
    });
    sessionData = data;
    mocks.readTurn.mockImplementation(data.history.readTurn.bind(data.history));
    setInput('requester-turn-id', targetSession.id);
    delivered = [];
    mocks.sendSessionChatResult.mockImplementation(
      async (
        _auth,
        _workspace,
        _manager,
        sessionId: string,
        prompt: string,
        _config,
        _output,
        _wait,
        options
      ) => {
        delivered.push({ sessionId, prompt });
        return { sessionId, userTurnId: options?.userTurnId ?? 'legacy-target-turn' };
      }
    );
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each(['session_chat', 'session_create'] as const)(
    'keeps missing-snapshot %s recovery Agent-authored and rejects chat back to its source',
    async (kind) => {
      const actualStore = await vi.importActual<typeof import('@/orchestration/operation-store')>(
        '@/orchestration/operation-store'
      );
      const commands =
        await vi.importActual<typeof import('@/commands/session')>('@/commands/session');
      store.accept({
        workspaceId: 'workspace-id' as never,
        ownerMachineId: 'machine-id' as never,
        requesterSessionId: targetSession.id as SessionId,
        requesterUserId: requesterSession.userId,
        operationId: 'incoming-without-display-snapshot',
        kind,
        canonicalCommand: { prompt: 'Recovered work' },
        frozenContinuationConfig: { sourceTurnId: 'source-a-turn', inputConfig: {} },
        initiatorChainDepth: 0,
        createdAt: '2026-10-12T00:00:00Z',
        deadlineAt: '2099-01-01T00:00:00Z',
        items: [
          {
            status: 'active',
            target: { sessionId: requesterSession.id as SessionId, userTurnId: 'recovered-input' },
            inputDurable: false,
          },
        ],
      });
      store.close();
      store = new actualStore.LodyOperationStore(path.join(root, 'operations.sqlite3'));
      mocks.accept.mockImplementation(store.accept.bind(store));
      mocks.get.mockImplementation(store.get.bind(store));
      mocks.findMatchingRetry.mockImplementation(store.findMatchingRetry.bind(store));
      mocks.snapshot.mockImplementation(store.snapshot.bind(store));
      const recovered = store.get(
        targetSession.id as SessionId,
        'incoming-without-display-snapshot'
      );
      expect(recovered.author).toEqual({
        v: 1,
        kind: 'agent',
        sessionId: targetSession.id,
        turnId: 'source-a-turn',
        name: 'Agent',
      });
      const delegatedRequester = { userId: recovered.requesterUserId, author: recovered.author };
      let input: import('@lody/shared').SessionHistoryInput;
      if (kind === 'session_create') {
        const prepared = await commands.prepareSessionInput(
          {
            userId: recovered.requesterUserId,
            machineId: 'machine-id',
            token: '',
            userName: 'User',
            userEmail: 'user@example.test',
            machineName: 'Local',
          } as never,
          { id: 'workspace-id', name: 'Workspace', slug: 'workspace', role: 'owner' },
          {} as never,
          'Recovered work',
          {
            workspaceMetaPrewriteSatisfied: true,
            bypassSessionQuota: true,
            historyBackend: 'loro',
            userTurnId: 'recovered-input',
            delegatedRequester,
          },
          { inheritSessionDefaults: false },
          {
            targetMachine: { id: 'machine-id', ownerUserId: recovered.requesterUserId },
            agentConfig: {
              id: 'agent-id',
              machineId: 'machine-id',
              cliType: 'registry',
              agentType: 'fixture',
            },
          } as never
        );
        input = prepared.userTurn;
        writer.append(input as never);
      } else {
        await commands.appendUserPromptHistory({
          sessionDoc: {
            sessionData,
            sessionId: requesterSession.id,
            getMetaState: async () => ({ historyBackend: 'loro' }),
            appendUserTurn: async (entry: import('@lody/shared').SessionHistoryInput) => {
              writer.append(entry as never);
            },
          } as never,
          prompt: 'Recovered work',
          userId: delegatedRequester.userId,
          author: delegatedRequester.author,
          preallocatedId: 'recovered-input',
        });
        input = writer
          .readStored()
          .find(
            (entry) => entry.id === 'recovered-input'
          ) as import('@lody/shared').SessionHistoryInput;
      }
      expect(input.author).toEqual(recovered.author);
      expect(input.userId).toBe(recovered.requesterUserId);
      mocks.activeInvocation.mockReturnValue({
        type: 'session/active-invocation-context',
        sessionId: requesterSession.id,
        active: true,
        requesterUserId: recovered.requesterUserId,
        sourceTurnId: input.id,
        inputConfig: {},
      });
      const result = await callAndMapMcpError(() =>
        startSessionChatOperation({
          sessionId: targetSession.id,
          prompt: 'Acknowledge',
          operationId: 'forbidden-recovered-reply',
        })
      );
      const content = result.content[0];
      if (!content || content.type !== 'text') throw new Error('expected error');
      expect(JSON.parse(content.text)).toMatchObject({
        ok: false,
        error: { code: 'REVERSE_CHAT_FORBIDDEN', retryable: false },
      });
      expect(storedOperations()).toEqual([]);
      expect(delivered).toEqual([]);
    }
  );

  it.each(['single', 'batch', 'legacy'] as const)(
    'rejects a %s chat back to the current input sender without durable work or target input',
    async (kind) => {
      const args = { sessionId: targetSession.id, prompt: 'Please acknowledge' };
      let result: ReturnType<typeof mcpErrorResult>;
      if (kind === 'legacy') {
        const handlers: SessionToolHandlers = new Map();
        const server = buildSessionToolServer(handlers);
        try {
          const handler = handlers.get('lody_session_chat');
          if (!handler) throw new Error('chat handler missing');
          result = await handler({ ...args, wait: true });
        } finally {
          await server.close();
        }
      } else {
        result = await callAndMapMcpError(() =>
          kind === 'single'
            ? startSessionChatOperation({ ...args, operationId: 'reverse-single' })
            : startSessionChatManyOperation({
                operationId: 'reverse-batch',
                defaults: args,
                items: [{}, {}],
              })
        );
      }
      const content = result.content[0];
      if (!content || content.type !== 'text') throw new Error('expected error');
      expect(JSON.parse(content.text)).toMatchObject({
        ok: false,
        error: { code: 'REVERSE_CHAT_FORBIDDEN', retryable: false },
      });
      expect(storedOperations()).toEqual([]);
      expect(delivered).toEqual([]);
    }
  );

  it('rejects only the reverse item in a mixed batch and persists the unrelated target once', async () => {
    const thirdSession = { ...targetSession, id: 'third-session-id' };
    mocks.getDocMeta.mockImplementation(async (roomId: string) => {
      const session = [requesterSession, targetSession, thirdSession].find(
        (candidate) => getSessionRoomId(candidate.id as SessionId) === roomId
      );
      return session ? { meta: session } : undefined;
    });
    const args = {
      operationId: 'mixed-batch',
      items: [
        { sessionId: targetSession.id, prompt: 'Reply to A' },
        { sessionId: thirdSession.id, prompt: 'Work for C' },
      ],
    };
    await startSessionChatManyOperation(args);
    const accepted = store.get(requesterSession.id as SessionId, args.operationId);
    expect(accepted.items[0]).toMatchObject({
      status: 'failed',
      error: { code: 'REVERSE_CHAT_FORBIDDEN', retryable: false },
    });
    expect(accepted.items[1]).toMatchObject({
      status: 'active',
      inputDurable: true,
      target: { sessionId: thirdSession.id },
    });
    expect(delivered).toEqual([{ sessionId: thirdSession.id, prompt: 'Work for C' }]);
    await startSessionChatManyOperation(args);
    expect(delivered).toEqual([{ sessionId: thirdSession.id, prompt: 'Work for C' }]);
  });

  it.each(['human', 'another-agent'] as const)(
    'allows a later %s input to chat to A despite the earlier delegated turn',
    async (source) => {
      setInput('fresh-turn', source === 'another-agent' ? 'another-sender' : undefined);
      await startSessionChatOperation({
        operationId: 'human-followup',
        sessionId: targetSession.id,
        prompt: 'New user-authorized work',
      });
      expect(storedOperations().map((operation) => operation.operationId)).toEqual([
        'human-followup',
      ]);
      expect(delivered).toEqual([
        { sessionId: targetSession.id, prompt: 'New user-authorized work' },
      ]);
    }
  );

  it.each([false, true])(
    'freezes exact pending input provenance before Operation acceptance (delegated=%s)',
    async (delegated) => {
      setInput('pending-provenance', delegated ? 'sender-session' : undefined);
      mocks.activeInvocation.mockReturnValue({
        ...mocks.activeInvocation(),
        notificationOriginTurnIds: [],
        notificationProvenancePending: true,
      });
      await startSessionChatOperation({
        operationId: 'provenance-operation',
        sessionId: targetSession.id,
        prompt: 'Work',
      });
      expect(
        store.get(requesterSession.id as SessionId, 'provenance-operation').frozenContinuationConfig
          .notificationOriginTurnIds
      ).toEqual(delegated ? [] : ['pending-provenance']);
    }
  );

  it('rejects unsynchronized provenance before acceptance and accepts the same id after sync', async () => {
    const active = {
      type: 'session/active-invocation-context',
      sessionId: requesterSession.id,
      active: true,
      requesterUserId: requesterSession.userId,
      sourceTurnId: 'late-input',
      inputConfig: {},
      notificationOriginTurnIds: [],
      notificationProvenancePending: true,
    };
    mocks.activeInvocation.mockReturnValue(active);
    const args = { operationId: 'late-provenance', sessionId: targetSession.id, prompt: 'Work' };
    const result = await callAndMapMcpError(() => startSessionChatOperation(args));
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      error: { code: 'INVOKING_INPUT_NOT_READY', retryable: true },
    });
    expect(storedOperations()).toEqual([]);
    expect(delivered).toEqual([]);
    setInput('late-input');
    mocks.activeInvocation.mockReturnValue(active);
    await startSessionChatOperation(args);
    expect(
      store.get(requesterSession.id as SessionId, args.operationId).frozenContinuationConfig
        .notificationOriginTurnIds
    ).toEqual(['late-input']);
    expect(delivered).toHaveLength(1);
  });

  it('does not fall back to earlier history when the exact active input is unavailable', async () => {
    mocks.activeInvocation.mockReturnValue({
      type: 'session/active-invocation-context',
      sessionId: requesterSession.id,
      active: true,
      requesterUserId: requesterSession.userId,
      sourceTurnId: 'missing-input',
      inputConfig: {},
    });
    const result = await callAndMapMcpError(() =>
      startSessionChatOperation({
        operationId: 'missing-source',
        sessionId: targetSession.id,
        prompt: 'Must not dispatch',
      })
    );
    const content = result.content[0];
    if (!content || content.type !== 'text') throw new Error('expected error');
    expect(JSON.parse(content.text)).toMatchObject({
      error: { code: 'INVOKING_TURN_NOT_FOUND', retryable: false },
    });
    expect(storedOperations()).toEqual([]);
    expect(delivered).toEqual([]);
  });
});

describe('Machine catalog retry guidance and accepted chat recovery', () => {
  it('exposes a bounded caller budget without changing the strict error wire shape', () => {
    const error = new MachineFlockReadUnavailableError({
      message: 'private transport details',
      cause: new FlockSyncTimeoutError('private timeout details'),
      selection: { kind: 'ACP model', id: 'missing-model' },
    });
    expectSyncErrorResult(
      mcpErrorResult(error),
      'Machine catalog synchronization was not confirmed. Cannot validate ACP model "missing-model" from the local replica.' +
        ' If no active Operation handle was returned, wait at least 5 seconds between attempts, make at most 3 total attempts (the initial call plus 2 retries), and reuse the identical request and operationId when present. Then stop and report the catalog blocker; do not create a new operationId to retry. If an active Operation handle was returned, let the daemon recover it and await automatic completion.'
    );
  });

  it('recovers the same accepted chat target after catalog failure without appending again', async () => {
    const args = {
      operationId: 'accepted-chat-catalog-failure',
      sessionId: targetSession.id,
      prompt: 'continue',
    };
    let accepted: { state: string; items: LodyOperationItemResult[] } | undefined;
    mocks.accept.mockImplementation((input: { items: LodyOperationItemResult[] }) => {
      accepted = { state: 'active', items: input.items };
      return { operation: accepted, claimedItemIndexes: [0] };
    });
    const error = new MachineFlockReadUnavailableError({
      message: 'missing model',
      cause: new FlockSyncTimeoutError('catalog unavailable'),
    });
    mocks.sendSessionChatResult.mockRejectedValue(error);
    const first = await callAndMapMcpError(() => startSessionChatOperation(args));
    expectSyncErrorResult(first, error.toLodyError().message);
    expect(accepted).toEqual({
      state: 'active',
      items: [
        expect.objectContaining({
          status: 'active',
          target: { sessionId: targetSession.id, userTurnId: expect.any(String) },
        }),
      ],
    });
    mocks.findMatchingRetry.mockReturnValue(accepted);
    mocks.snapshot.mockImplementation((operation) => operation);
    mocks.sendSessionChatResult.mockImplementation(() => {
      throw new Error('an accepted retry must not append another prompt');
    });
    expect(await startSessionChatOperation(args)).toEqual(accepted);
  });
});

describe('session create prevalidation failures', () => {
  const syncFailures = [
    {
      name: 'workspace sync',
      retryable: true,
      error: new WorkspaceSyncUnavailableError({
        message: 'prewrite sync failed',
        cause: new Error('transport unavailable'),
      }),
    },
    {
      name: 'timed-out machine Flock read',
      retryable: true,
      error: new MachineFlockReadUnavailableError({
        message: 'machine Flock read failed',
        cause: new FlockSyncTimeoutError('synthetic deadline'),
      }),
    },
    {
      name: 'unclassified machine Flock read',
      retryable: false,
      error: new MachineFlockReadUnavailableError({
        message: 'machine Flock read failed',
        cause: new Error('unclassified failure'),
      }),
    },
  ];

  it.each([
    { field: 'builtinDefaultModeId', value: 'agent-auto-review' },
    { field: 'inheritedBuiltinDefaultModeId', value: 'agent-auto-review' },
    { field: 'inheritedDispatchConfig', value: { modelId: 'stale-model' } },
  ])(
    'does not accept internal $field provenance from public MCP create inputs',
    ({ field, value }) => {
      expect(
        __lodyMcpServerInternals.SessionCreateToolInputSchema.safeParse({
          operationId: 'explicit-marker',
          prompt: 'start',
          [field]: value,
        }).success
      ).toBe(false);
      expect(
        __lodyMcpServerInternals.SessionCreateManyToolInputSchema.safeParse({
          operationId: 'explicit-marker-batch',
          items: [{ prompt: 'start', [field]: value }],
        }).success
      ).toBe(false);
    }
  );

  it.each(syncFailures)(
    'preserves $name error classification through single create before acceptance',
    async ({ error, retryable }) => {
      mocks.validateSessionCreateOptions.mockRejectedValue(error);

      const result = await callAndMapMcpError(() =>
        startSessionCreateOperation({
          operationId: 'single-create-operation',
          prompt: 'start a new session',
          agentConfigId: 'agent-config-id',
        })
      );

      expectSyncErrorResult(result, error.toLodyError().message, retryable);
      expect(mocks.accept).not.toHaveBeenCalled();
      expect(mocks.createSessionResult).not.toHaveBeenCalled();
    }
  );

  it.each(syncFailures.filter((failure) => failure.retryable))(
    'aborts a mixed create batch before acceptance or dispatch when $name is unavailable',
    async ({ error, retryable }) => {
      mocks.validateSessionCreateOptions.mockResolvedValueOnce({}).mockRejectedValueOnce(error);

      const result = await callAndMapMcpError(() =>
        startSessionCreateManyOperation({
          operationId: 'batch-create-operation',
          items: [
            { label: 'valid', prompt: 'first session', agentConfigId: 'valid-config' },
            { label: 'unavailable', prompt: 'second session', agentConfigId: 'unavailable-config' },
          ],
        })
      );

      expectSyncErrorResult(
        result,
        `Create item 2 ("unavailable"): ${error.toLodyError().message}`,
        retryable
      );
      expect(mocks.accept).not.toHaveBeenCalled();
      expect(mocks.createSessionResult).not.toHaveBeenCalled();
    }
  );

  it.each([
    new Error('private unknown transport failure'),
    new RepoTransportError('private permanent transport failure', {
      code: 'internal',
      phase: 'sync',
      retryable: false,
    }),
  ])(
    'keeps permanent or unknown catalog failures per-item and dispatches valid siblings',
    async (cause) => {
      const error = new MachineFlockReadUnavailableError({
        message: 'private diagnostic',
        cause,
        selection: { kind: 'ACP model', id: 'missing-model' },
      });
      let operation: { state: string; items: LodyOperationItemResult[] } | undefined;
      mocks.accept.mockImplementation((input: { items: LodyOperationItemResult[] }) => {
        operation = { state: 'active', items: input.items };
        return { operation, claimedItemIndexes: [0] };
      });
      mocks.markItemInputDurable.mockImplementation(
        (_requester: string, _operation: string, index: number) => {
          const item = operation?.items[index];
          if (item?.status === 'active') item.inputDurable = true;
        }
      );
      mocks.get.mockImplementation(() => operation);
      mocks.snapshot.mockImplementation((stored: typeof operation) => stored);
      mocks.createSessionResult.mockResolvedValue({ sessionId: 'created-session' });
      mocks.validateSessionCreateOptions.mockResolvedValueOnce({}).mockRejectedValueOnce(error);
      const result = await startSessionCreateManyOperation({
        operationId: 'mixed-permanent-create',
        items: [
          { label: 'valid', prompt: 'first session', agentConfigId: 'valid-config' },
          { label: 'unavailable', prompt: 'second session', agentConfigId: 'unavailable-config' },
        ],
      });
      expect(result).toMatchObject({
        state: 'active',
        items: [
          { status: 'active', label: 'valid', inputDurable: true },
          {
            status: 'failed',
            label: 'unavailable',
            error: {
              code: 'SYNC_UNAVAILABLE',
              retryable: false,
              message: `Create item 2 ("unavailable"): ${error.toLodyError().message}`,
            },
          },
        ],
      });
      expect(mocks.createSessionResult).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).toContain('missing-model');
      expect(JSON.stringify(result)).not.toContain('private');
    }
  );

  it('maps a real Repo HTTP server_error through ACP prevalidation to retryable MCP output', async () => {
    vi.stubEnv('LODY_LORO_AUTO_RECONNECT_INTERVAL_MS', '0');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('private-body-sentinel', {
            status: 503,
            headers: { 'x-request-id': 'synthetic-request' },
          })
      )
    );
    const repo = await LoroRepo.create({});
    const workspaceId = 'workspace-id' as WorkspaceId;
    const agentConfig: AgentConfigMeta = {
      id: 'unavailable-config',
      machineId: 'machine-id',
      name: 'Synthetic',
      cliType: 'builtin',
      agentType: 'codex',
    };
    const adapter = new StreamsTransportAdapter({
      bucketId: 'test-bucket',
      baseUrl: 'https://streams.invalid',
      auth: async () => 'private-token-sentinel',
      persistence: { mode: 'ephemeral' },
      flockDocStreamId: (id) => id,
    });
    let manager: LoroDocumentManager | undefined;
    try {
      await repo.addTransport('streams', adapter);
      const sync = vi.spyOn(repo, 'sync');
      manager = new LoroDocumentManager({
        repo,
        workspaceId,
        userId: 'requester-user-id',
        metaSub: null,
        remoteStreamsAttached: true,
        logger: getLogger('catalog-http-503-test'),
      });
      const activeManager = manager;
      mocks.validateSessionCreateOptions.mockImplementation(() =>
        resolveEffectiveSessionCreateDispatchConfig({
          manager: activeManager,
          workspaceId,
          agentConfig,
          dispatchConfig: { modelId: 'missing-model' },
        })
      );
      const result = await callAndMapMcpError(() =>
        startSessionCreateManyOperation({
          operationId: 'real-server-error-create',
          items: [{ label: 'server-error', prompt: 'start', agentConfigId: agentConfig.id }],
        })
      );
      const transportError = await sync.mock.results[0]?.value.catch((error: unknown) => error);
      expect(transportError).toBeInstanceOf(RepoTransportError);
      expect(transportError).toMatchObject({
        code: 'internal',
        streamsCode: 'server_error',
        retryable: true,
        streamsContext: { source: 'http', status: 503 },
      });
      const response = JSON.parse(result.content[0].text);
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'SYNC_UNAVAILABLE', retryable: true },
      });
      expect(response.error.message).toContain('Create item 1 ("server-error")');
      expect(response.error.message).toContain('missing-model');
      expect(response.error.message).not.toContain('private');
      expect(mocks.accept).not.toHaveBeenCalled();
      expect(mocks.createSessionResult).not.toHaveBeenCalled();
    } finally {
      if (manager) await manager.cleanUp({ fast: true });
      else await repo.destroy();
    }
  });

  it.each([
    {
      name: 'unsupported model',
      error: new Error('Unsupported ACP model for the selected agent: unsupported-model.'),
      code: 'INVALID_ITEM',
    },
    {
      name: 'denied access verification',
      error: new MachineAccessVerificationError(false, 1, new Error('Unauthorized')),
      code: 'MACHINE_ACCESS_CHECK_FAILED',
    },
  ])('keeps $name failures as permanent batch item results', async ({ error, code }) => {
    let operation:
      | {
          state: 'active' | 'finished';
          items: LodyOperationItemResult[];
          completion?: LodyOperationCompletion;
        }
      | undefined;
    mocks.accept.mockImplementation((input: { items: LodyOperationItemResult[] }) => {
      operation = { state: 'active', items: input.items };
      return { operation, claimedItemIndexes: [] };
    });
    mocks.finish.mockImplementation(
      (_sessionId: string, _operationId: string, completion: LodyOperationCompletion) => {
        if (!operation) throw new Error('cannot finish an unaccepted operation');
        operation.state = 'finished';
        operation.completion = completion;
      }
    );
    mocks.get.mockImplementation(() => operation);
    mocks.snapshot.mockImplementation((stored: NonNullable<typeof operation>) => ({
      state: stored.state,
      completion: stored.completion,
    }));
    mocks.validateSessionCreateOptions.mockRejectedValue(error);

    const result = await startSessionCreateManyOperation({
      operationId: 'permanent-create-operation',
      items: [{ label: 'invalid', prompt: 'start a session', agentConfigId: 'agent-config-id' }],
    });

    expect(result).toEqual({
      state: 'finished',
      completion: {
        type: 'result',
        value: {
          items: [
            {
              status: 'failed',
              label: 'invalid',
              error: { code, message: error.message, retryable: false },
            },
          ],
        },
      },
    });
    expect(mocks.createSessionResult).not.toHaveBeenCalled();
  });
});

describe('scoped completed work batch reader', () => {
  it('reads only the invoking user fixed batch and rejects cross-batch cursors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-batch-reader-'));
    const actual = await vi.importActual<typeof import('@/orchestration/operation-store')>(
      '@/orchestration/operation-store'
    );
    const store = new actual.LodyOperationStore(path.join(root, 'operations.sqlite3'));
    const handlers: SessionToolHandlers = new Map();
    const server = buildSessionToolServer(handlers);
    const input = {
      workspaceId: 'workspace-id',
      sessionId: requesterSession.id,
      userId: requesterSession.userId,
      inputId: 'requester-turn-id',
      kind: 'human' as const,
      config: { prompt: 'new request' },
    };
    try {
      store.inbox.activate(input.workspaceId, 'owner');
      for (let n = 0; n < 3; n++) {
        store.accept({
          workspaceId: input.workspaceId as WorkspaceId,
          ownerMachineId: 'machine-id' as never,
          requesterSessionId: input.sessionId as SessionId,
          requesterUserId: input.userId,
          operationId: `read-${n}`,
          kind: 'session_chat',
          canonicalCommand: { n },
          frozenContinuationConfig: { inputConfig: {} },
          initiatorChainDepth: 0,
          createdAt: '2026-10-12T00:00:00Z',
          deadlineAt: '2026-10-13T00:00:00Z',
          items: [],
        });
        store.finish(input.sessionId as SessionId, `read-${n}`, {
          type: 'result',
          value: { items: [] },
        });
      }
      store.inbox.accept(input);
      const batch = store.inbox.prepare(input, 'owner')!;
      mocks.operationInbox.mockReturnValue(store.inbox);
      const handler = handlers.get('lody_operation_batch_get')!;
      const decode = (result: Awaited<ReturnType<typeof handler>>) =>
        JSON.parse((result.content[0] as { text: string }).text);
      const first = decode(await handler({ batchId: batch.batchId, limit: 1 }));
      expect(first.items.map((i: { operationId: string }) => i.operationId)).toEqual(['read-0']);
      const second = decode(
        await handler({ batchId: batch.batchId, limit: 1, cursor: first.nextCursor })
      );
      expect(second.items.map((i: { operationId: string }) => i.operationId)).toEqual(['read-1']);
      store.inbox.abandonInput(input.workspaceId, input.sessionId, input.inputId);
      const nextInput = { ...input, inputId: 'next-user-turn' };
      store.inbox.accept(nextInput);
      const nextBatch = store.inbox.prepare(nextInput, 'owner')!;
      const invalid = decode(
        await handler({ batchId: nextBatch.batchId, limit: 1, cursor: first.nextCursor })
      );
      expect(invalid.ok).toBe(false);
      expect(JSON.stringify(invalid)).toContain('CURSOR_INVALID');
      mocks.activeInvocation.mockReturnValue({
        type: 'session/active-invocation-context',
        sessionId: input.sessionId,
        active: true,
        requesterUserId: 'other-user',
        sourceTurnId: input.inputId,
        inputConfig: {},
      });
      expect(decode(await handler({ batchId: batch.batchId }))).toMatchObject({
        ok: false,
        error: { code: 'BATCH_NOT_FOUND' },
      });
      expect(store.inbox.getBatch(batch.batchId, input)?.state).toBe('superseded');
      expect(store.inbox.members(batch)).toHaveLength(3);
    } finally {
      await server.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

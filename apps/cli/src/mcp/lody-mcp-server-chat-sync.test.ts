import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSessionRoomId,
  type LodyOperationCompletion,
  type LodyOperationItemResult,
  type SessionId,
} from '@lody/shared';

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
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
    createSessionBackend: vi.fn(async () => ({
      history: {
        readTurn: vi.fn(async () => ({
          state: 'ready',
          turn: {
            author: {
              v: 1,
              kind: 'agent',
              sessionId: 'requester-session-id',
              turnId: 'requester-turn-id',
              name: 'Codex',
            },
          },
        })),
      },
    })),
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

import { __lodyMcpServerInternals } from './lody-mcp-server';

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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  activeInvocation: vi.fn(),
  findMatchingRetry: vi.fn(),
  getDocMeta: vi.fn(),
  validateSessionChatTarget: vi.fn(),
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
        })
    ),
  };
});

vi.mock('@/commands/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/commands/session')>();
  return {
    ...actual,
    validateSessionChatTarget: mocks.validateSessionChatTarget,
  };
});

vi.mock('@/orchestration/operation-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/orchestration/operation-store')>();
  return {
    ...actual,
    LodyOperationStore: class {
      findMatchingRetry = mocks.findMatchingRetry;
      accept = mocks.accept;
    },
    runWithOperationStoreBusyRetry: vi.fn(async (fn: () => unknown) => await fn()),
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

import { __lodyMcpServerInternals } from './lody-mcp-server';

const { mcpErrorResult, startSessionChatOperation, startSessionChatManyOperation } =
  __lodyMcpServerInternals;

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

const expectRetryableSyncResult = (result: ReturnType<typeof mcpErrorResult>): void => {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('expected text result');
  expect(JSON.parse(content.text)).toEqual({
    ok: false,
    error: {
      code: 'SYNC_UNAVAILABLE',
      message: WORKSPACE_SYNC_UNAVAILABLE_MESSAGE,
      retryable: true,
    },
  });
};

const callAndMapMcpError = async (call: () => Promise<unknown>) => {
  try {
    await call();
    throw new Error('expected chat prevalidation to fail');
  } catch (error) {
    return mcpErrorResult(error);
  }
};

describe('session chat prevalidation sync failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.getDocMeta
      .mockResolvedValueOnce({ meta: requesterSession })
      .mockResolvedValueOnce({ meta: targetSession });
    mocks.validateSessionChatTarget.mockRejectedValue(
      new WorkspaceSyncUnavailableError({
        message: 'prewrite sync failed',
        cause: new Error('transport unavailable'),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('preserves retryable sync semantics through single chat before accepting an operation', async () => {
    const result = await callAndMapMcpError(() =>
      startSessionChatOperation({
        operationId: 'single-chat-operation',
        sessionId: targetSession.id,
        prompt: 'continue',
      })
    );

    expectRetryableSyncResult(result);
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('does not persist a batch operation when chat prevalidation sync is unavailable', async () => {
    const result = await callAndMapMcpError(() =>
      startSessionChatManyOperation({
        operationId: 'batch-chat-operation',
        items: [{ sessionId: targetSession.id, prompt: 'continue' }],
      })
    );

    expectRetryableSyncResult(result);
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

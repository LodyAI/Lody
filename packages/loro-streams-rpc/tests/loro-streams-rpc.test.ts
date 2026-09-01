import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigId,
  CodeCollabV2RpcContentEnvelope,
  LocalProjectId,
  MachineId,
  RpcSecretEnvelope,
  SessionId,
  WorkspaceId,
} from '@lody/shared';
import { SessionIdSchema } from '@lody/shared';

const configId = 'config-1' as AgentConfigId;

type MockStreamsClientOptions = {
  url: URL | string;
  auth?: () => Promise<string>;
  fetch?: typeof fetch;
  timeout?: unknown;
};

type MockStreamsClientInstance = {
  options: MockStreamsClientOptions;
  create: ReturnType<typeof vi.fn>;
  head: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  readOnce: ReturnType<typeof vi.fn>;
  live: ReturnType<typeof vi.fn>;
};

const streamsClientMockFns = {
  create: vi.fn(),
  head: vi.fn(),
  append: vi.fn(),
  readOnce: vi.fn(),
  live: vi.fn(),
};

const streamsClientInstances: MockStreamsClientInstance[] = [];

vi.mock('@loro-dev/streams-client', () => ({
  StreamsClient: class {
    readonly options: MockStreamsClientOptions;
    readonly create = vi.fn((...args: unknown[]) => streamsClientMockFns.create(...args));
    readonly head = vi.fn((...args: unknown[]) => streamsClientMockFns.head(...args));
    readonly append = vi.fn((...args: unknown[]) => streamsClientMockFns.append(...args));
    readonly readOnce = vi.fn((...args: unknown[]) => streamsClientMockFns.readOnce(...args));
    readonly live = vi.fn((...args: unknown[]) => streamsClientMockFns.live(...args));

    constructor(options: MockStreamsClientOptions) {
      this.options = options;
      streamsClientInstances.push(this as unknown as MockStreamsClientInstance);
    }
  },
}));

import {
  LoroStreamsGatewayError,
  LoroStreamsLiveModePolicy,
  LoroStreamsMachineRpcClient,
  LoroStreamsRpcResponseDispatcher,
  LoroStreamsRpcRequestSchema,
  createRpcSecretRecipient,
  createLoroStreamsJsonStreamClient,
  decryptCodeCollabV2RpcPayload,
  encryptCodeCollabV2RpcPayload,
  getMachineAcpAuthenticationInputSecretContext,
  getLoroWorkspaceRpcResponseStreamId,
  getMachineAcpAuthorizationCodeSecretContext,
  normalizeLoroGatewayBaseUrl,
  type LoroJsonLiveBatchHandler,
  type LoroJsonStreamBatch,
  type LoroStreamsJsonStreamClient,
} from '../src/index';

describe('session steer RPC schema', () => {
  it('parses the steer handoff payload', () => {
    const result = LoroStreamsRpcRequestSchema.safeParse({
      jsonrpc: '2.0',
      id: 'request-1',
      method: 'session/steer',
      rpcVersion: '1',
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      replyTo: 'workspace-1:rpc:res',
      sentAt: 1,
      expiresAt: 2,
      params: {
        sessionId: 'session-1',
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction' },
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('session preparation RPC schema', () => {
  const baseRequest = {
    jsonrpc: '2.0',
    id: 'request-prepare-1',
    rpcVersion: '1',
    workspaceId: 'workspace-1',
    machineId: 'machine-1',
    replyTo: 'workspace-1:rpc:res',
    sentAt: 1,
    expiresAt: 2,
  } as const;

  it('accepts identifier-only preparation and cancellation payloads', () => {
    expect(
      LoroStreamsRpcRequestSchema.safeParse({
        ...baseRequest,
        method: 'session/prepare',
        params: {
          preparationId: 'prepare-1',
          sessionId: 'session-1',
          requestedByUserId: 'user-1',
          agentConfigId: 'config-1',
          cliType: 'builtin',
          agentType: 'codex',
        },
      }).success
    ).toBe(true);
    expect(
      LoroStreamsRpcRequestSchema.safeParse({
        ...baseRequest,
        method: 'session/prepare-cancel',
        params: {
          preparationId: 'prepare-1',
          sessionId: 'session-1',
          requestedByUserId: 'user-1',
        },
      }).success
    ).toBe(true);
  });

  it('rejects preparation payloads containing draft content or secrets', () => {
    const result = LoroStreamsRpcRequestSchema.safeParse({
      ...baseRequest,
      method: 'session/prepare',
      params: {
        preparationId: 'prepare-1',
        sessionId: 'session-1',
        requestedByUserId: 'user-1',
        agentConfigId: 'config-1',
        cliType: 'builtin',
        agentType: 'codex',
        prompt: 'private draft',
        env: { API_KEY: 'secret' },
      },
    });

    expect(result.success).toBe(false);
  });
});

const codexProvider = { cliType: 'builtin', agentType: 'codex' } as const;

const getLastStreamsClientInstance = (): MockStreamsClientInstance => {
  const instance = streamsClientInstances.at(-1);
  if (!instance) {
    throw new Error('Expected a StreamsClient instance');
  }
  return instance;
};

const createMockStreamPart = (value: unknown) => ({
  json: <T = unknown>() => value as T,
});

beforeEach(() => {
  streamsClientInstances.length = 0;
  streamsClientMockFns.create.mockReset();
  streamsClientMockFns.head.mockReset();
  streamsClientMockFns.append.mockReset();
  streamsClientMockFns.readOnce.mockReset();
  streamsClientMockFns.live.mockReset();
});

const createFakeStreamClient = () => {
  const ensured: string[] = [];
  const appended: Array<{ streamId: string; value: unknown }> = [];
  const queuedBatches: LoroJsonStreamBatch[] = [];
  const waiters: Array<(batch: LoroJsonStreamBatch) => void> = [];
  const appendCountWaiters: Array<{ count: number; resolve: () => void }> = [];

  const streamClient: LoroStreamsJsonStreamClient = {
    ensureJsonStream: vi.fn(async (streamId: string) => {
      ensured.push(streamId);
    }),
    appendJson: vi.fn(async (streamId: string, value: unknown) => {
      appended.push({ streamId, value });
      for (let index = appendCountWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = appendCountWaiters[index];
        if (waiter && appended.length >= waiter.count) {
          appendCountWaiters.splice(index, 1);
          waiter.resolve();
        }
      }
      return 'next-offset';
    }),
    readJsonLive: vi.fn(
      async (
        _streamId: string,
        _state,
        onBatch: LoroJsonLiveBatchHandler,
        options?: { signal?: AbortSignal }
      ) => {
        while (!options?.signal?.aborted) {
          const batch =
            queuedBatches.shift() ??
            (await new Promise<LoroJsonStreamBatch>((resolve, reject) => {
              const onAbort = () => {
                reject(new Error('aborted'));
              };
              options?.signal?.addEventListener('abort', onAbort, { once: true });
              waiters.push((next) => {
                options?.signal?.removeEventListener('abort', onAbort);
                resolve(next);
              });
            }));
          await onBatch(batch);
        }
      }
    ),
  };

  return {
    ensured,
    appended,
    streamClient,
    async waitForAppendedCount(count: number): Promise<void> {
      if (appended.length >= count) return;
      await new Promise<void>((resolve) => appendCountWaiters.push({ count, resolve }));
    },
    pushBatch(batch: LoroJsonStreamBatch) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(batch);
        return;
      }
      queuedBatches.push(batch);
    },
  };
};

describe('LoroStreamsMachineRpcClient', () => {
  it('sends minimal session preparation requests and resolves the response', async () => {
    const fake = createFakeStreamClient();
    const sessionId = SessionIdSchema.parse('session-1');
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestSessionPrepare({
      preparationId: 'prepare-1',
      sessionId,
      requestedByUserId: 'user-1',
      agentConfigId: configId,
      cliType: 'builtin',
      agentType: 'codex',
      timeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1));

    const request = fake.appended[0]?.value as { id: string; params: Record<string, unknown> };
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        method: 'session/prepare',
        params: {
          preparationId: 'prepare-1',
          sessionId: 'session-1',
          requestedByUserId: 'user-1',
          agentConfigId: 'config-1',
          cliType: 'builtin',
          agentType: 'codex',
          project: undefined,
        },
      })
    );
    expect(request.params).not.toHaveProperty('prompt');
    expect(request.params).not.toHaveProperty('env');

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'session/prepare',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'session/prepare_response',
            preparationId: 'prepare-1',
            sessionId: 'session-1',
            accepted: true,
            disposition: 'accepted',
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual({
      type: 'session/prepare_response',
      preparationId: 'prepare-1',
      sessionId: 'session-1',
      accepted: true,
      disposition: 'accepted',
    });
    client.stop();
  });

  it('sends session terminate requests and resolves the response', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestSessionTerminate({
      sessionId: 'session-1',
      timeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1));

    const request = fake.appended[0]?.value as { id: string; replyTo: string };
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        method: 'session/terminate',
        params: { sessionId: 'session-1' },
      })
    );

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'session/terminate',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'session/terminate_response',
            sessionId: 'session-1',
            success: true,
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual({
      type: 'session/terminate_response',
      sessionId: 'session-1',
      success: true,
    });
    client.stop();
  });

  it('sends side-panel placement in session fork requests', async () => {
    const fake = createFakeStreamClient();
    const sourceSessionId = 'source-session' as SessionId;
    const targetSessionId = 'side-session' as SessionId;
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestSessionFork({
      sourceSessionId,
      sourceTurnId: 'assistant-turn',
      targetSessionId,
      requestedByUserId: 'user-1',
      targetPlacement: 'side-panel',
      timeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1));

    const request = fake.appended[0]?.value as { id: string };
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        method: 'session/fork',
        params: {
          sourceSessionId: 'source-session',
          sourceTurnId: 'assistant-turn',
          targetSessionId: 'side-session',
          requestedByUserId: 'user-1',
          targetPlacement: 'side-panel',
        },
      })
    );

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'session/fork',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'session/fork_response',
            sourceSessionId: 'source-session',
            targetSessionId: 'side-session',
            success: true,
            partial: false,
            warnings: [],
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual({
      type: 'session/fork_response',
      sourceSessionId: 'source-session',
      targetSessionId: 'side-session',
      success: true,
      partial: false,
      warnings: [],
    });
    client.stop();
  });

  it('round-trips session edit-and-resend requests', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });
    const responsePromise = client.requestSessionEditAndResend({
      sessionId: 'session-1' as SessionId,
      expectedUserTurnId: 'user-old',
      replacementUserTurnId: 'user-new',
      requestedByUserId: 'user-1',
      timestamp: '2026-08-03T00:00:00.000Z',
      inputConfig: { prompt: 'replacement', cliType: 'builtin', agentType: 'codex' },
      timeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1));

    const request = fake.appended[0]?.value as { id: string };
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        method: 'session/edit-and-resend',
        params: expect.objectContaining({
          sessionId: 'session-1',
          expectedUserTurnId: 'user-old',
          replacementUserTurnId: 'user-new',
        }),
      })
    );

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'session/edit-and-resend',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'session/edit-and-resend_response',
            sessionId: 'session-1',
            replacementUserTurnId: 'user-new',
            success: true,
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toMatchObject({
      success: true,
      replacementUserTurnId: 'user-new',
    });
    client.stop();
  });

  it('sends machine status requests and resolves matching RPC responses', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestMachineStatus({ timeoutMs: 5000 });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as { id: string; replyTo: string; method: string };
    expect(request.method).toBe('machine/status');
    expect(fake.appended[0]?.streamId).toBe('workspace-1:rpc:req:machine-1');
    expect(fake.ensured).toEqual([]);

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/status',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/status_response',
            machineId: 'machine-1',
            success: true,
            resources: {
              totalMemoryGB: 16,
              usedMemoryGB: 8,
              freeMemoryGB: 8,
              totalCpus: 8,
              cpuUsagePercent: 25,
            },
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual(
      expect.objectContaining({
        type: 'machine/status_response',
        success: true,
      })
    );

    client.stop();
  });

  it('requests live session status', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const livePromise = client.requestSessionLiveStatus({
      sessionId: 'session-1',
      timeoutMs: 5000,
    });
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1));
    const liveRequest = fake.appended[0]?.value as { id: string; method: string; params: unknown };
    expect(liveRequest).toMatchObject({
      method: 'session/live-status',
      params: { sessionId: 'session-1' },
    });
    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: liveRequest.id,
          method: 'session/live-status',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'session/live-status_response',
            machineId: 'machine-1',
            sessionId: 'session-1',
            success: true,
            state: 'waiting',
            observedAtMs: 123,
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: true,
    });
    await expect(livePromise).resolves.toMatchObject({ success: true, state: 'waiting' });

    client.stop();
  });

  it('shares one workspace response stream across multiple machine clients', async () => {
    const fake = createFakeStreamClient();
    const responseDispatcher = new LoroStreamsRpcResponseDispatcher({
      workspaceId: 'workspace-1',
      streamClient: fake.streamClient,
      responseStreamId: 'workspace-1:rpc:res:client-1',
    });
    const machineOne = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
      responseDispatcher,
    });
    const machineTwo = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-2',
      streamClient: fake.streamClient,
      responseDispatcher,
    });

    const machineOneResponse = machineOne.requestMachineStatus({ timeoutMs: 5000 });
    const machineTwoResponse = machineTwo.requestMachineStatus({ timeoutMs: 5000 });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(2);
    });
    await vi.waitFor(() => {
      expect(fake.streamClient.readJsonLive).toHaveBeenCalledTimes(1);
    });

    const machineOneRequest = fake.appended[0]?.value as {
      id: string;
      replyTo: string;
      method: string;
    };
    const machineTwoRequest = fake.appended[1]?.value as {
      id: string;
      replyTo: string;
      method: string;
    };
    expect(fake.appended.map((entry) => entry.streamId)).toEqual([
      'workspace-1:rpc:req:machine-1',
      'workspace-1:rpc:req:machine-2',
    ]);
    expect(machineOneRequest.replyTo).toBe('workspace-1:rpc:res:client-1');
    expect(machineTwoRequest.replyTo).toBe('workspace-1:rpc:res:client-1');

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: machineTwoRequest.id,
          method: 'machine/status',
          rpcVersion: '1',
          machineId: 'machine-2',
          result: {
            type: 'machine/status_response',
            machineId: 'machine-2',
            success: true,
            resources: {
              totalMemoryGB: 32,
              usedMemoryGB: 12,
              freeMemoryGB: 20,
              totalCpus: 12,
              cpuUsagePercent: 30,
            },
          },
        },
        {
          jsonrpc: '2.0',
          id: machineOneRequest.id,
          method: 'machine/status',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/status_response',
            machineId: 'machine-1',
            success: true,
            resources: {
              totalMemoryGB: 16,
              usedMemoryGB: 8,
              freeMemoryGB: 8,
              totalCpus: 8,
              cpuUsagePercent: 25,
            },
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: true,
    });

    await expect(machineOneResponse).resolves.toEqual(
      expect.objectContaining({ machineId: 'machine-1', success: true })
    );
    await expect(machineTwoResponse).resolves.toEqual(
      expect.objectContaining({ machineId: 'machine-2', success: true })
    );

    machineOne.stop();
    machineTwo.stop();
    expect(fake.streamClient.readJsonLive).toHaveBeenCalledTimes(1);
    responseDispatcher.stop();
  });

  it('builds workspace-level response stream bases without machine ids', () => {
    expect(getLoroWorkspaceRpcResponseStreamId('workspace-1')).toBe('workspace-1:rpc:res');
  });

  it('cancels only the stopped client pending requests when sharing a response dispatcher', async () => {
    const fake = createFakeStreamClient();
    const responseDispatcher = new LoroStreamsRpcResponseDispatcher({
      workspaceId: 'workspace-1',
      streamClient: fake.streamClient,
      responseStreamId: 'workspace-1:rpc:res:client-1',
    });
    const machineOne = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
      responseDispatcher,
    });
    const machineTwo = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-2',
      streamClient: fake.streamClient,
      responseDispatcher,
    });

    const machineOneResponse = machineOne.requestMachineStatus({ timeoutMs: 5000 });
    const machineTwoResponse = machineTwo.requestMachineStatus({ timeoutMs: 5000 });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(2);
    });

    const machineOneRequest = fake.appended[0]?.value as { id: string };
    const machineTwoRequest = fake.appended[1]?.value as { id: string };
    machineOne.stop();
    await expect(machineOneResponse).resolves.toBeNull();

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: machineOneRequest.id,
          method: 'machine/status',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/status_response',
            machineId: 'machine-1',
            success: true,
            resources: {
              totalMemoryGB: 16,
              usedMemoryGB: 8,
              freeMemoryGB: 8,
              totalCpus: 8,
              cpuUsagePercent: 25,
            },
          },
        },
        {
          jsonrpc: '2.0',
          id: machineTwoRequest.id,
          method: 'machine/status',
          rpcVersion: '1',
          machineId: 'machine-2',
          result: {
            type: 'machine/status_response',
            machineId: 'machine-2',
            success: true,
            resources: {
              totalMemoryGB: 32,
              usedMemoryGB: 12,
              freeMemoryGB: 20,
              totalCpus: 12,
              cpuUsagePercent: 30,
            },
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: true,
    });

    await expect(machineTwoResponse).resolves.toEqual(
      expect.objectContaining({ machineId: 'machine-2', success: true })
    );

    machineTwo.stop();
    responseDispatcher.stop();
  });

  it('wraps remote Code Collab request and response payloads in the owner session envelope', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestCodeCollabOpenText({
      sessionId: 'session-child',
      ownerSessionId: 'session-parent',
      path: 'src/app.ts',
      timeoutMs: 5000,
    });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as {
      id: string;
      replyTo: string;
      method: string;
      params: unknown;
    };
    expect(request.method).toBe('code-collab/open-text');
    expect(request.params).toEqual(
      expect.objectContaining({
        type: 'code-collab-v2-content-envelope',
        ownerSessionId: 'session-parent',
      })
    );
    await expect(
      decryptCodeCollabV2RpcPayload(
        request.params as CodeCollabV2RpcContentEnvelope,
        'session-parent'
      )
    ).resolves.toEqual({
      sessionId: 'session-child',
      path: 'src/app.ts',
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'code-collab/open-text',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: await encryptCodeCollabV2RpcPayload('session-parent', {
            status: 'ok',
            path: 'src/app.ts',
            digest: `sha256:${'0'.repeat(64)}`,
            text: {
              encoding: 'plain',
              text: 'hi',
              rawBytes: 2,
            },
          }),
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual({
      status: 'ok',
      path: 'src/app.ts',
      digest: `sha256:${'0'.repeat(64)}`,
      text: {
        encoding: 'plain',
        text: 'hi',
        rawBytes: 2,
      },
    });

    client.stop();
  });

  it('decrypts remote Code Collab error payload data from the owner session envelope', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestCodeCollabOpenText({
      sessionId: 'session-child',
      ownerSessionId: 'session-parent',
      path: 'src/app.ts',
      timeoutMs: 5000,
    });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as { id: string };
    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'code-collab/open-text',
          rpcVersion: '1',
          machineId: 'machine-1',
          error: {
            code: 'permission_denied',
            message: 'Denied',
            data: await encryptCodeCollabV2RpcPayload('session-parent', {
              status: 'error',
              code: 'permission_denied',
              message: 'Denied',
            }),
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual({
      status: 'error',
      code: 'permission_denied',
      message: 'Denied',
    });

    client.stop();
  });

  it('sends machine ping requests and resolves pong responses', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestMachinePing({
      requestId: 'ping-1',
      timeoutMs: 5000,
    });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as { id: string; method: string; params: unknown };
    expect(request.method).toBe('machine/ping');
    expect(request.params).toEqual({ requestId: 'ping-1' });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/ping',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/ping_response',
            machineId: 'machine-1',
            requestId: 'ping-1',
            success: true,
            message: 'pong',
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual({
      type: 'machine/ping_response',
      machineId: 'machine-1',
      requestId: 'ping-1',
      success: true,
      message: 'pong',
    });

    client.stop();
  });

  it('sends machine upgrade requests and resolves ack responses', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestMachineUpgrade({
      requesterUserId: 'user-1',
      requestToken: 'signed-token',
      requestId: 'upgrade-1',
      targetVersion: 'latest',
      timeoutMs: 5000,
    });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as { id: string; method: string; params: unknown };
    expect(request.method).toBe('machine/upgrade');
    expect(request.params).toEqual({
      requesterUserId: 'user-1',
      requestToken: 'signed-token',
      requestId: 'upgrade-1',
      targetVersion: 'latest',
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/upgrade',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/upgrade_response',
            machineId: 'machine-1',
            requestId: 'upgrade-1',
            success: true,
            accepted: true,
            disposition: 'accepted',
            currentVersion: '0.66.1',
            targetVersion: 'latest',
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual({
      type: 'machine/upgrade_response',
      machineId: 'machine-1',
      requestId: 'upgrade-1',
      success: true,
      accepted: true,
      disposition: 'accepted',
      currentVersion: '0.66.1',
      targetVersion: 'latest',
    });

    client.stop();
  });

  it('rounds calibrated timestamps before appending RPC requests', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
      now: () => 1234.56,
    });

    const responsePromise = client.requestMachineStatus({ timeoutMs: 1000 });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as { sentAt: number; expiresAt: number };
    expect(request.sentAt).toBe(1235);
    expect(request.expiresAt).toBe(2235);
    expect(Number.isInteger(request.sentAt)).toBe(true);
    expect(Number.isInteger(request.expiresAt)).toBe(true);

    client.stop();
    await expect(responsePromise).resolves.toBeNull();
  });

  it('accepts fractional timestamps from already appended RPC requests', () => {
    const parsed = LoroStreamsRpcRequestSchema.safeParse({
      jsonrpc: '2.0',
      id: 'request-1',
      method: 'local-project/git-state',
      rpcVersion: '1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      replyTo: 'workspace-1:rpc:res:machine-1:client-1',
      sentAt: 1234.56,
      expiresAt: 2234.56,
      params: {
        localProjectId: 'local-project-1',
        requestedByUserId: 'user-1',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('appends first RPC without pre-ensuring streams from the Web client', async () => {
    const events: string[] = [];
    const streamClient: LoroStreamsJsonStreamClient = {
      ensureJsonStream: vi.fn(async (streamId: string) => {
        events.push(`ensure:${streamId}`);
      }),
      appendJson: vi.fn(async (streamId: string) => {
        events.push(`append:${streamId}`);
        return 'next-offset';
      }),
      readJsonLive: vi.fn(
        async (_streamId, _state, _onBatch, options?: { signal?: AbortSignal }) => {
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => reject(new Error('aborted'));
            options?.signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
      ),
    };
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient,
    });

    const responsePromise = client.requestMachineStatus({ timeoutMs: 1 });

    await vi.waitFor(() => {
      expect(streamClient.appendJson).toHaveBeenCalled();
    });

    expect(events).toEqual(['append:workspace-1:rpc:req:machine-1']);
    expect(streamClient.appendJson).toHaveBeenCalledWith(
      'workspace-1:rpc:req:machine-1',
      expect.objectContaining({
        method: 'machine/status',
        replyTo: expect.stringMatching(/^workspace-1:rpc:res:machine-1:/),
      })
    );

    client.stop();
    await expect(responsePromise).resolves.toBeNull();
  });

  it('preserves refresh request context when RPC returns an error envelope', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestMachineAcpCapabilitiesRefresh({
      configId,
      timeoutMs: 5000,
    });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as {
      id: string;
      params?: {
        configId?: string;
      };
    };
    expect(request.params?.configId).toBe(configId);
    expect(request.params).toEqual({ configId });
    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/acp-capabilities-refresh',
          rpcVersion: '1',
          machineId: 'machine-1',
          error: {
            code: 'rpc_version_mismatch',
            message: 'Expected rpcVersion=1, got 0',
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual(
      expect.objectContaining({
        type: 'machine/acp-capabilities-refresh_response',
        configId,
        cliType: 'builtin',
        agentType: 'unknown',
        success: false,
      })
    );

    client.stop();
  });

  it('emits ACP binary progress without resolving the refresh request early', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });
    const onProgress = vi.fn();

    const responsePromise = client.requestMachineAcpCapabilitiesRefresh({
      configId,
      onProgress,
      timeoutMs: 5000,
    });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as { id: string };
    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/acp-capabilities-refresh',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-binary-progress',
            machineId: 'machine-1',
            agentType: 'codex',
            status: 'downloading',
            downloadedBytes: 10,
            totalBytes: 100,
            percent: 10,
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: false,
    });

    await vi.waitFor(() => {
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'machine/acp-binary-progress',
          status: 'downloading',
          percent: 10,
        })
      );
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/acp-capabilities-refresh',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-capabilities-refresh_response',
            machineId: 'machine-1',
            configId,
            cliType: 'builtin',
            agentType: 'codex',
            success: true,
            modes: [],
            models: [],
            availableCommands: [],
          },
        },
      ],
      nextOffset: '3',
      cursor: 'cursor-3',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual(
      expect.objectContaining({
        type: 'machine/acp-capabilities-refresh_response',
        success: true,
      })
    );

    client.stop();
  });

  it('cancels the exact capability refresh pending and ignores its late progress', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });
    const controller = new AbortController();
    const onProgress = vi.fn();

    const responsePromise = client.requestMachineAcpCapabilitiesRefresh({
      configId,
      onProgress,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    await fake.waitForAppendedCount(1);

    const request = fake.appended[0]?.value as { id: string };
    controller.abort();

    await expect(responsePromise).resolves.toBeNull();
    await fake.waitForAppendedCount(2);
    expect(fake.appended[1]?.value).toEqual(
      expect.objectContaining({
        method: 'machine/acp-capabilities-refresh-cancel',
        params: { requestId: request.id },
      })
    );

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/acp-capabilities-refresh',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-binary-progress',
            machineId: 'machine-1',
            agentType: 'codex',
            status: 'downloading',
            percent: 25,
          },
        },
      ],
      nextOffset: '3',
      cursor: 'cursor-3',
      upToDate: true,
    });
    await Promise.resolve();
    expect(onProgress).not.toHaveBeenCalled();

    client.stop();
  });

  it('cancels the exact capability refresh after its response timeout', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeStreamClient();
      let markOriginalAppendStarted!: () => void;
      const originalAppendStarted = new Promise<void>((resolve) => {
        markOriginalAppendStarted = resolve;
      });
      let releaseOriginalAppend!: () => void;
      const originalAppendCanFinish = new Promise<void>((resolve) => {
        releaseOriginalAppend = resolve;
      });
      let markCancellationAppended!: () => void;
      const cancellationAppended = new Promise<void>((resolve) => {
        markCancellationAppended = resolve;
      });
      fake.streamClient.appendJson = vi.fn(async (streamId: string, value: unknown) => {
        fake.appended.push({ streamId, value });
        const method = (value as { method?: string }).method;
        if (method === 'machine/acp-capabilities-refresh') {
          markOriginalAppendStarted();
          await originalAppendCanFinish;
        } else if (method === 'machine/acp-capabilities-refresh-cancel') {
          markCancellationAppended();
        }
        return 'next-offset';
      });
      const client = new LoroStreamsMachineRpcClient({
        workspaceId: 'workspace-1',
        machineId: 'machine-1',
        streamClient: fake.streamClient,
      });

      const responsePromise = client.requestMachineAcpCapabilitiesRefresh({
        configId,
        timeoutMs: 1_000,
      });
      await originalAppendStarted;

      const request = fake.appended[0]?.value as { id: string };
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(responsePromise).resolves.toBeNull();
      expect(fake.appended).toHaveLength(1);

      releaseOriginalAppend();
      await cancellationAppended;
      expect(fake.appended[1]?.value).toEqual(
        expect.objectContaining({
          method: 'machine/acp-capabilities-refresh-cancel',
          params: { requestId: request.id },
        })
      );

      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the exact capability refresh when its owning client stops', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestMachineAcpCapabilitiesRefresh({
      configId,
      timeoutMs: 5_000,
    });
    await fake.waitForAppendedCount(1);
    const request = fake.appended[0]?.value as { id: string };

    client.stop();

    await expect(responsePromise).resolves.toBeNull();
    await fake.waitForAppendedCount(2);
    expect(fake.appended[1]?.value).toEqual(
      expect.objectContaining({
        method: 'machine/acp-capabilities-refresh-cancel',
        params: { requestId: request.id },
      })
    );
  });

  it('does not append a capability refresh when its owning client stops immediately', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestMachineAcpCapabilitiesRefresh({
      configId,
      timeoutMs: 5_000,
    });
    client.stop();

    await expect(responsePromise).resolves.toBeNull();
    expect(fake.appended).toEqual([]);
  });

  it('streams structured ACP authorization before resolving the final response', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });
    const onProgress = vi.fn();

    const responsePromise = client.requestMachineAcpAuthenticate({
      requestId: 'auth-1',
      action: 'start',
      configId,
      onProgress,
      timeoutMs: 5000,
    });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as { id: string; params?: unknown };
    expect(request.params).toEqual(
      expect.objectContaining({
        requestId: 'auth-1',
        action: 'start',
        configId,
      })
    );
    expect(request.params).toEqual({ requestId: 'auth-1', action: 'start', configId });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/acp-authenticate',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-authentication-progress',
            machineId: 'machine-1',
            requestId: 'auth-1',
            agentType: 'kimi',
            status: 'authorization',
            authorizationUrl: 'https://www.kimi.com/code/authorize_device?user_code=GI5T-ACD0',
            userCode: 'GI5T-ACD0',
            expiresInSeconds: 1800,
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: false,
    });

    await vi.waitFor(() => {
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'authorization',
          authorizationUrl: 'https://www.kimi.com/code/authorize_device?user_code=GI5T-ACD0',
          userCode: 'GI5T-ACD0',
        })
      );
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/acp-authenticate',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-authenticate_response',
            machineId: 'machine-1',
            requestId: 'auth-1',
            agentType: 'kimi',
            success: true,
            disposition: 'authenticated',
          },
        },
      ],
      nextOffset: '3',
      cursor: 'cursor-3',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual(
      expect.objectContaining({ disposition: 'authenticated', success: true })
    );

    client.stop();
  });

  it('persists only ciphertext when submitting a browser authorization code', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });
    const recipient = await createRpcSecretRecipient();
    let resolveProgressReceived: () => void = () => {};
    const progressReceived = new Promise<void>((resolve) => {
      resolveProgressReceived = resolve;
    });
    const startPromise = client.requestMachineAcpAuthenticate({
      requestId: 'auth-claude',
      action: 'start',
      configId,
      timeoutMs: 5000,
      onProgress: () => resolveProgressReceived(),
    });
    await fake.waitForAppendedCount(1);
    const startRequest = fake.appended[0]?.value as { id: string };
    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: startRequest.id,
          method: 'machine/acp-authenticate',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-authentication-progress',
            machineId: 'machine-1',
            requestId: 'auth-claude',
            agentType: 'claude',
            status: 'authorization',
            authorizationUrl: 'https://claude.ai/oauth/authorize',
            acceptsAuthorizationCode: true,
            authorizationCodePublicKey: recipient.publicKey,
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: false,
    });
    await progressReceived;

    const responsePromise = client.requestMachineAcpAuthenticate({
      requestId: 'auth-code-ack',
      action: 'submit-code',
      authenticationRequestId: 'auth-claude',
      authorizationCode: 'browser-returned-code',
      timeoutMs: 5000,
    });

    await fake.waitForAppendedCount(2);

    const request = fake.appended[1]?.value as {
      id: string;
      params?: { authorizationCodeEnvelope?: RpcSecretEnvelope };
    };
    expect(JSON.stringify(request)).not.toContain('browser-returned-code');
    expect(request.params).toEqual(
      expect.objectContaining({
        requestId: 'auth-code-ack',
        action: 'submit-code',
        authenticationRequestId: 'auth-claude',
        authorizationCodeEnvelope: expect.objectContaining({
          type: 'rpc-secret-envelope-v1',
          algorithm: 'ECDH-P256-AES-256-GCM',
        }),
      })
    );
    await expect(
      recipient.decrypt(
        request.params!.authorizationCodeEnvelope!,
        getMachineAcpAuthorizationCodeSecretContext({
          workspaceId: 'workspace-1',
          machineId: 'machine-1',
          authenticationRequestId: 'auth-claude',
        })
      )
    ).resolves.toBe('browser-returned-code');

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/acp-authenticate',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-authenticate_response',
            machineId: 'machine-1',
            requestId: 'auth-code-ack',
            agentType: 'claude',
            success: true,
            disposition: 'input-accepted',
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual(
      expect.objectContaining({ disposition: 'input-accepted', success: true })
    );

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: startRequest.id,
          method: 'machine/acp-authenticate',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-authenticate_response',
            machineId: 'machine-1',
            requestId: 'auth-claude',
            agentType: 'claude',
            success: true,
            disposition: 'authenticated',
          },
        },
      ],
      nextOffset: '4',
      cursor: 'cursor-4',
      upToDate: true,
    });
    await expect(startPromise).resolves.toEqual(
      expect.objectContaining({ disposition: 'authenticated', success: true })
    );

    client.stop();
  });

  it('binds encrypted form input to the authentication request and interaction', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });
    const recipient = await createRpcSecretRecipient();
    let resolveProgressReceived: () => void = () => {};
    const progressReceived = new Promise<void>((resolve) => {
      resolveProgressReceived = resolve;
    });
    const startPromise = client.requestMachineAcpAuthenticate({
      requestId: 'auth-custom',
      action: 'start',
      configId,
      timeoutMs: 5000,
      onProgress: () => resolveProgressReceived(),
    });
    await fake.waitForAppendedCount(1);
    const startRequest = fake.appended[0]?.value as { id: string };
    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: startRequest.id,
          method: 'machine/acp-authenticate',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-authentication-progress',
            machineId: 'machine-1',
            requestId: 'auth-custom',
            agentType: 'custom-agent',
            status: 'input-required',
            interactionId: 'form-1',
            message: 'Complete sign-in',
            form: {
              fields: [{ id: 'code', type: 'secret', label: 'Code', required: true }],
            },
            authenticationInputPublicKey: recipient.publicKey,
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: false,
    });
    await progressReceived;

    const authenticationInput = JSON.stringify({
      action: 'accept',
      content: { code: 'secret-code' },
    });
    const responsePromise = client.requestMachineAcpAuthenticate({
      requestId: 'auth-input-ack',
      action: 'submit-input',
      authenticationRequestId: 'auth-custom',
      interactionId: 'form-1',
      authenticationInput,
      timeoutMs: 5000,
    });
    await fake.waitForAppendedCount(2);
    const inputRequest = fake.appended[1]?.value as {
      id: string;
      params?: { authenticationInputEnvelope?: RpcSecretEnvelope };
    };
    expect(JSON.stringify(inputRequest)).not.toContain('secret-code');
    await expect(
      recipient.decrypt(
        inputRequest.params!.authenticationInputEnvelope!,
        getMachineAcpAuthenticationInputSecretContext({
          workspaceId: 'workspace-1',
          machineId: 'machine-1',
          authenticationRequestId: 'auth-custom',
          interactionId: 'form-1',
        })
      )
    ).resolves.toBe(authenticationInput);

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: inputRequest.id,
          method: 'machine/acp-authenticate',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-authenticate_response',
            machineId: 'machine-1',
            requestId: 'auth-input-ack',
            agentType: 'custom-agent',
            success: true,
            disposition: 'input-accepted',
          },
        },
      ],
      nextOffset: '3',
      cursor: 'cursor-3',
      upToDate: true,
    });
    await expect(responsePromise).resolves.toMatchObject({ disposition: 'input-accepted' });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: startRequest.id,
          method: 'machine/acp-authenticate',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/acp-authenticate_response',
            machineId: 'machine-1',
            requestId: 'auth-custom',
            agentType: 'custom-agent',
            success: true,
            disposition: 'authenticated',
          },
        },
      ],
      nextOffset: '4',
      cursor: 'cursor-4',
      upToDate: true,
    });
    await expect(startPromise).resolves.toMatchObject({ disposition: 'authenticated' });
    client.stop();
  });

  it('sends local project control requests and resolves matching RPC responses', async () => {
    const fake = createFakeStreamClient();
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const localProjectId = 'local-project-1' as LocalProjectId;
    const client = new LoroStreamsMachineRpcClient({
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestLocalProjectControl({
      request: {
        type: 'local-project/sync-history',
        machineId,
        workspaceId,
        localProjectId,
        provider: codexProvider,
      },
      timeoutMs: 5000,
    });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as {
      id: string;
      replyTo: string;
      method: string;
      params?: { request?: { type?: string } };
    };
    expect(request.method).toBe('local-project/control');
    expect(request.params?.request?.type).toBe('local-project/sync-history');

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'local-project/control',
          rpcVersion: '1',
          machineId,
          result: {
            ok: true,
            type: 'local-project/sync-history',
            result: {
              listed: 0,
              lastListedAt: 1,
              sessions: [],
            },
          },
        },
      ],
      nextOffset: '3',
      cursor: 'cursor-3',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        type: 'local-project/sync-history',
      })
    );

    client.stop();
  });

  it('sends session preview create requests and resolves preview responses', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestSessionPreviewCreate({
      sessionId: 'session-1',
      requestedByUserId: 'user-1',
      target: { protocol: 'http', host: '127.0.0.1', port: 5173 },
      approval: {
        source: 'browser_address',
        targetClass: 'loopback',
        target: { protocol: 'http', host: '127.0.0.1', port: 5173 },
        confirmedByUserId: 'user-1',
        confirmedAt: 1000,
      },
      timeoutMs: 5000,
    });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as {
      id: string;
      method: string;
      params?: { sessionId?: string; requestedByUserId?: string };
    };
    expect(request.method).toBe('session/preview-create');
    expect(request.params).toEqual({
      sessionId: 'session-1',
      requestedByUserId: 'user-1',
      target: { protocol: 'http', host: '127.0.0.1', port: 5173 },
      approval: {
        source: 'browser_address',
        targetClass: 'loopback',
        target: { protocol: 'http', host: '127.0.0.1', port: 5173 },
        confirmedByUserId: 'user-1',
        confirmedAt: 1000,
      },
      replaceExisting: undefined,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'session/preview-create',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'session/preview-create_response',
            sessionId: 'session-1',
            success: false,
            error: 'tunnel_not_configured',
            message: 'Preview gateway is not configured.',
          },
        },
      ],
      nextOffset: '3',
      cursor: 'cursor-3',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual(
      expect.objectContaining({
        type: 'session/preview-create_response',
        sessionId: 'session-1',
        success: false,
        error: 'tunnel_not_configured',
      })
    );

    client.stop();
  });

  it('sends local project git state requests and resolves git state responses', async () => {
    const fake = createFakeStreamClient();
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient: fake.streamClient,
    });

    const responsePromise = client.requestLocalProjectGitState({
      localProjectId: 'local-project-1' as LocalProjectId,
      requestedByUserId: 'user-1',
      timeoutMs: 5000,
    });

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const request = fake.appended[0]?.value as {
      id: string;
      method: string;
      params?: { localProjectId?: string; requestedByUserId?: string };
    };
    expect(request.method).toBe('local-project/git-state');
    expect(request.params).toEqual({
      localProjectId: 'local-project-1',
      requestedByUserId: 'user-1',
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: request.id,
          method: 'local-project/git-state',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'local-project/git-state_response',
            machineId: 'machine-1',
            workspaceId: 'workspace-1',
            localProjectId: 'local-project-1',
            success: true,
            observedAtMs: 123.5,
            state: {
              git: true,
              currentBranch: 'feature/a',
              defaultBranch: 'main',
              branches: ['main', 'feature/a'],
              githubRepoFullName: 'owner/repo',
              workingTree: {
                clean: true,
                staged: false,
                unstaged: false,
                untracked: false,
                conflicted: false,
              },
            },
          },
        },
      ],
      nextOffset: '4',
      cursor: 'cursor-4',
      upToDate: true,
    });

    await expect(responsePromise).resolves.toEqual(
      expect.objectContaining({
        type: 'local-project/git-state_response',
        success: true,
        observedAtMs: 123.5,
        state: expect.objectContaining({ git: true, currentBranch: 'feature/a' }),
      })
    );

    client.stop();
  });

  it('replays the first response even when it lands before the live reader starts', async () => {
    let queuedResponse: Record<string, unknown> | null = null;
    let firstPollState: string | undefined;
    let resolveAppend: (() => void) | null = null;
    const appendDone = new Promise<void>((resolve) => {
      resolveAppend = resolve;
    });

    const streamClient: LoroStreamsJsonStreamClient = {
      ensureJsonStream: vi.fn(async () => {}),
      appendJson: vi.fn(async (_streamId: string, value: unknown) => {
        const request = value as { id: string };
        queuedResponse = {
          jsonrpc: '2.0',
          id: request.id,
          method: 'machine/status',
          rpcVersion: '1',
          machineId: 'machine-1',
          result: {
            type: 'machine/status_response',
            machineId: 'machine-1',
            success: true,
            resources: {
              totalMemoryGB: 16,
              usedMemoryGB: 8,
              freeMemoryGB: 8,
              totalCpus: 8,
              cpuUsagePercent: 25,
            },
          },
        };
        resolveAppend?.();
        return '1';
      }),
      readJsonLive: vi.fn(async (_streamId: string, state, onBatch, options) => {
        firstPollState ??= state.nextOffset;
        await appendDone;
        await onBatch({
          messages: queuedResponse && state.nextOffset === '-1' ? [queuedResponse] : [],
          nextOffset: '1',
          cursor: 'cursor-1',
          upToDate: true,
        });
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          options?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      }),
    };

    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient,
    });

    await expect(client.requestMachineStatus({ timeoutMs: 5000 })).resolves.toEqual(
      expect.objectContaining({
        type: 'machine/status_response',
        success: true,
      })
    );
    expect(firstPollState).toBe('-1');

    client.stop();
  });
});

describe('createLoroStreamsJsonStreamClient', () => {
  it('defaults to the proxy gateway', () => {
    expect(() => normalizeLoroGatewayBaseUrl(undefined)).toThrow(/must be provided/);
  });

  it('creates JSON streams through StreamsClient and forwards TTL', async () => {
    streamsClientMockFns.create.mockResolvedValue({
      ok: true,
      result: {
        created: true,
        contentType: 'application/json',
        nextOffset: '-1',
        closed: false,
      },
    });

    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com/',
    });

    await client.ensureJsonStream('workspace-1:rpc:req:machine-1', 61.8);

    const instance = getLastStreamsClientInstance();
    expect(String(instance.options.url)).toBe(
      'https://streams.example.com/ds/bucket-1/workspace-1%3Arpc%3Areq%3Amachine-1'
    );
    expect(await instance.options.auth?.()).toBe('token-1');
    expect(streamsClientMockFns.create).toHaveBeenCalledWith({
      contentType: 'application/json',
      ttlSeconds: 61,
    });
  });

  it('forwards timeout config to StreamsClient', async () => {
    streamsClientMockFns.create.mockResolvedValue({
      ok: true,
      result: {
        created: true,
        contentType: 'application/json',
        nextOffset: '-1',
        closed: false,
      },
    });

    const timeout = { connectTimeoutMs: 30_000, pollTimeoutMs: 45_000 };
    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
      timeout,
    });

    await client.ensureJsonStream('workspace-1:rpc:req:machine-1');

    const instance = getLastStreamsClientInstance();
    expect(instance.options.timeout).toEqual(timeout);
  });

  it('adds request context to stream ensure errors', async () => {
    streamsClientMockFns.create.mockResolvedValue({
      ok: false,
      result: {
        code: 'timeout',
        phase: 'connect',
        timeoutMs: 30_000,
        message: 'TIMEOUT: connect request exceeded 30000ms',
      },
    });

    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
      timeout: { connectTimeoutMs: 30_000 },
    });

    await expect(client.ensureJsonStream('workspace-1:rpc:req:machine-1')).rejects.toThrow(
      'Failed to ensure stream workspace-1:rpc:req:machine-1 (operation=json.ensure, method=PUT, url=https://streams.example.com/ds/bucket-1/workspace-1%3Arpc%3Areq%3Amachine-1, code=timeout, phase=connect, timeoutMs=30000): TIMEOUT: connect request exceeded 30000ms'
    );
  });

  it('reuses legacy JSON streams without TTL when ensure hits a 409 conflict', async () => {
    streamsClientMockFns.create.mockResolvedValue({
      ok: false,
      result: {
        code: 'conflict',
        status: 409,
        message:
          "create failed with status 409: stream already exists with stream-ttl 'None' (request '3600')",
      },
    });
    streamsClientMockFns.head.mockResolvedValue({
      ok: true,
      result: {
        contentType: 'application/json',
        nextOffset: '17',
        closed: false,
      },
    });

    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });

    await expect(client.ensureJsonStream('workspace-1:rpc:req:machine-1', 3600)).resolves.toBe(
      undefined
    );
    expect(streamsClientMockFns.head).toHaveBeenCalledWith();
  });

  it('keeps rejecting 409 conflicts when the existing JSON stream has a different TTL', async () => {
    streamsClientMockFns.create.mockResolvedValue({
      ok: false,
      result: {
        code: 'conflict',
        status: 409,
        message: "create failed with status 409: stream already exists with stream-ttl '120'",
      },
    });
    streamsClientMockFns.head.mockResolvedValue({
      ok: true,
      result: {
        contentType: 'application/json',
        nextOffset: '17',
        closed: false,
        ttlSeconds: 120,
      },
    });

    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });

    await expect(client.ensureJsonStream('workspace-1:rpc:req:machine-1', 3600)).rejects.toThrow(
      LoroStreamsGatewayError
    );
    expect(streamsClientMockFns.head).toHaveBeenCalledWith();
  });

  it('serializes JSON payloads before appending', async () => {
    streamsClientMockFns.append.mockResolvedValue({
      ok: true,
      result: {
        status: 204,
        nextOffset: '42',
        closed: false,
      },
    });

    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });

    await expect(client.appendJson('workspace-1:rpc:req:machine-1', { id: 'msg-1' })).resolves.toBe(
      '42'
    );
    expect(streamsClientMockFns.append).toHaveBeenCalledWith({
      part: {
        contentType: 'application/json',
        body: JSON.stringify({ id: 'msg-1' }),
      },
    });
  });

  it('routes JSON RPC ensure requests through other shard origins', async () => {
    streamsClientMockFns.create.mockResolvedValue({
      ok: true,
      result: {
        status: 201,
        nextOffset: '0',
        closed: false,
      },
    });

    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.invalid',
      shardUrls: {
        other: ['https://api-a.streams.invalid', 'https://api-b.streams.invalid'],
      },
    });

    await client.ensureJsonStream('workspace-1:rpc:req:machine-1');
    const instance = getLastStreamsClientInstance();
    expect(new URL(String(instance.options.url)).hostname).toMatch(/^api-[ab]\.streams\.invalid$/);
  });

  it('routes hot JSON RPC appends and live reads through shard origins', async () => {
    streamsClientMockFns.append.mockResolvedValue({
      ok: true,
      result: {
        status: 204,
        nextOffset: '42',
        closed: false,
      },
    });
    streamsClientMockFns.live.mockReturnValue(
      (async function* () {
        yield {
          type: 'up_to_date',
          mode: 'sse',
          nextOffset: '42',
          cursor: 'cursor-2',
        };
      })()
    );

    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.invalid',
      shardUrls: {
        catchup: ['https://control-a.streams.invalid', 'https://control-b.streams.invalid'],
        largePost: [
          'https://write-a.streams.invalid',
          'https://write-b.streams.invalid',
          'https://write-c.streams.invalid',
        ],
      },
    });

    await client.appendJson('workspace-1:rpc:req:machine-1', { id: 'msg-1' });
    const appendInstance = getLastStreamsClientInstance();
    expect(new URL(String(appendInstance.options.url)).hostname).toMatch(
      /^write-[abc]\.streams\.invalid$/
    );

    await client.readJsonLive('workspace-1:rpc:res:client-1', { nextOffset: 'now' }, () => {});
    const liveInstance = getLastStreamsClientInstance();
    expect(new URL(String(liveInstance.options.url)).hostname).toMatch(
      /^control-[ab]\.streams\.invalid$/
    );
  });

  it('opens SSE live reads from the requested offset and cursor', async () => {
    streamsClientMockFns.live.mockReturnValue(
      (async function* () {
        yield {
          type: 'data',
          mode: 'sse',
          nextOffset: '42',
          cursor: 'cursor-2',
          payload: createMockStreamPart([{ id: 'msg-1' }]),
        };
        yield {
          type: 'eof',
          mode: 'sse',
          nextOffset: '42',
        };
      })()
    );
    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });
    const batches: LoroJsonStreamBatch[] = [];

    await client.readJsonLive(
      'workspace-1:rpc:req:machine-1',
      {
        nextOffset: '41',
        cursor: 'cursor-1',
      },
      (batch) => {
        batches.push(batch);
      }
    );

    expect(streamsClientMockFns.live).toHaveBeenCalledWith({
      offset: '41',
      mode: 'sse',
      // readJsonLive wraps the caller signal in an idle watchdog, so the live
      // read always receives a (non-undefined) AbortSignal.
      signal: expect.any(AbortSignal),
    });
    expect(batches).toEqual([
      {
        messages: [{ id: 'msg-1' }],
        nextOffset: '42',
        cursor: 'cursor-2',
        upToDate: false,
      },
      {
        messages: [],
        nextOffset: '42',
        cursor: undefined,
        upToDate: true,
      },
    ]);
  });

  it('can read JSON live streams through long-poll for RPC response streams', async () => {
    streamsClientMockFns.live.mockReturnValue(
      (async function* () {
        yield {
          type: 'up_to_date',
          mode: 'long-poll',
          nextOffset: '42',
          cursor: 'cursor-2',
        };
      })()
    );
    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
      liveMode: 'long-poll',
    });
    const batches: LoroJsonStreamBatch[] = [];

    await client.readJsonLive(
      'workspace-1:rpc:res:client-1',
      {
        nextOffset: '41',
        cursor: 'cursor-1',
      },
      (batch) => {
        batches.push(batch);
      }
    );

    expect(streamsClientMockFns.live).toHaveBeenCalledWith({
      offset: '41',
      mode: 'long-poll',
      // readJsonLive wraps the caller signal in an idle watchdog, so the live
      // read always receives a (non-undefined) AbortSignal.
      signal: expect.any(AbortSignal),
    });
    expect(batches).toEqual([
      {
        messages: [],
        nextOffset: '42',
        cursor: 'cursor-2',
        upToDate: true,
      },
    ]);
  });

  it('delivers live data events before up_to_date', async () => {
    streamsClientMockFns.live.mockReturnValue(
      (async function* () {
        yield {
          type: 'data',
          mode: 'sse',
          nextOffset: '42',
          cursor: 'cursor-2',
          payload: createMockStreamPart([{ id: 'msg-1' }]),
        };
        yield {
          type: 'data',
          mode: 'sse',
          nextOffset: '42',
          cursor: 'cursor-2',
          payload: createMockStreamPart({ id: 'msg-2' }),
        };
        yield {
          type: 'up_to_date',
          mode: 'sse',
          nextOffset: '42',
          cursor: 'cursor-2',
        };
      })()
    );

    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });
    const batches: LoroJsonStreamBatch[] = [];

    await client.readJsonLive(
      'workspace-1:rpc:req:machine-1',
      {
        nextOffset: '41',
        cursor: 'cursor-1',
      },
      (batch) => {
        batches.push(batch);
      }
    );

    expect(streamsClientMockFns.live).toHaveBeenCalledWith({
      offset: '41',
      mode: 'sse',
      // readJsonLive wraps the caller signal in an idle watchdog, so the live
      // read always receives a (non-undefined) AbortSignal.
      signal: expect.any(AbortSignal),
    });
    expect(batches).toEqual([
      {
        messages: [{ id: 'msg-1' }],
        nextOffset: '42',
        cursor: 'cursor-2',
        upToDate: false,
      },
      {
        messages: [{ id: 'msg-2' }],
        nextOffset: '42',
        cursor: 'cursor-2',
        upToDate: false,
      },
      {
        messages: [],
        nextOffset: '42',
        cursor: 'cursor-2',
        upToDate: true,
      },
    ]);
  });

  it('maps status errors from StreamsClient back to LoroStreamsGatewayError', async () => {
    streamsClientMockFns.live.mockReturnValue(
      (async function* () {
        yield {
          type: 'error',
          mode: 'sse',
          error: {
            code: 'not_found',
            status: 404,
            message: 'live read failed with status 404',
          },
        };
      })()
    );

    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });

    await expect(
      client.readJsonLive('workspace-1:rpc:req:missing-machine', { nextOffset: '41' }, () => {})
    ).rejects.toBeInstanceOf(LoroStreamsGatewayError);
  });

  it('routes repeated appends for one stream to a single stable shard host', async () => {
    streamsClientMockFns.append.mockResolvedValue({
      ok: true,
      result: { status: 204, nextOffset: '1', closed: false },
    });
    const client = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.invalid',
      shardUrls: {
        largePost: [
          'https://write-a.streams.invalid',
          'https://write-b.streams.invalid',
          'https://write-c.streams.invalid',
          'https://write-d.streams.invalid',
        ],
      },
    });

    const hosts = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      await client.appendJson('workspace-1:rpc:req:machine-1', { id: `msg-${index}` });
      hosts.add(new URL(String(getLastStreamsClientInstance().options.url)).hostname);
    }

    // Stable (not random) shard selection: every append for the same request
    // stream must target the same host so the browser reuses the warm connection
    // and keeps its CORS preflight cached. Random selection would have spread
    // these across the four write shards.
    expect(hosts.size).toBe(1);
    expect([...hosts][0]).toMatch(/^write-[abcd]\.streams\.invalid$/);
  });

  describe('readJsonLive idle watchdog', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Flush the microtask queue without advancing the (faked) clock, so a
    // mock live generator can make progress between timer advances.
    const flushMicrotasks = async (): Promise<void> => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    };

    // A live generator that emits `events` then holds the connection open until
    // aborted, then ends cleanly — mirroring the streams client returning "done"
    // on an AbortError.
    const liveEmittingThenIdle = (events: ReadonlyArray<Record<string, unknown>>) =>
      vi.fn((input: { signal?: AbortSignal }) =>
        (async function* () {
          for (const event of events) {
            yield event;
          }
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted) {
              resolve();
              return;
            }
            input.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        })()
      );

    const lastLiveSignal = (): AbortSignal => {
      const [firstCall] = streamsClientMockFns.live.mock.calls;
      if (!firstCall) {
        throw new Error('expected streams client live() to have been called');
      }
      return (firstCall[0] as { signal: AbortSignal }).signal;
    };

    it('aborts and returns cleanly when a live read is idle past the timeout', async () => {
      streamsClientMockFns.live.mockImplementation(liveEmittingThenIdle([]));
      const client = createLoroStreamsJsonStreamClient({
        bucketId: 'bucket-1',
        getToken: async () => 'token-1',
        baseUrl: 'https://streams.example.com',
        liveIdleTimeoutMs: 1000,
      });

      let settled = false;
      const read = client
        .readJsonLive('workspace-1:rpc:res:client-1', { nextOffset: 'now' }, () => {})
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);

      // Crossing the idle timeout aborts the read; it resolves (never throws) so
      // the caller's read loop reconnects from the saved offset.
      await vi.advanceTimersByTimeAsync(1);
      await read;
      expect(settled).toBe(true);
      expect(lastLiveSignal().aborted).toBe(true);
    });

    it('resets the idle timer on each event so an active stream is not aborted', async () => {
      let releaseSecondEvent: () => void = () => {};
      const secondEvent = new Promise<void>((resolve) => {
        releaseSecondEvent = resolve;
      });
      streamsClientMockFns.live.mockImplementation((input: { signal?: AbortSignal }) =>
        (async function* () {
          yield { type: 'up_to_date', mode: 'sse', nextOffset: '1', cursor: 'c1' };
          await secondEvent;
          yield { type: 'up_to_date', mode: 'sse', nextOffset: '2', cursor: 'c2' };
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        })()
      );
      const client = createLoroStreamsJsonStreamClient({
        bucketId: 'bucket-1',
        getToken: async () => 'token-1',
        baseUrl: 'https://streams.example.com',
        liveIdleTimeoutMs: 1000,
      });

      const batches: LoroJsonStreamBatch[] = [];
      let settled = false;
      const read = client
        .readJsonLive('workspace-1:rpc:res:client-1', { nextOffset: 'now' }, (batch) => {
          batches.push(batch);
        })
        .then(() => {
          settled = true;
        });

      // First event (t~=0) armed the timer to fire at t=1000. Advance close to it.
      await flushMicrotasks();
      expect(batches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(900);
      expect(settled).toBe(false);

      // Deliver the second event at t=900: it must reset the timer to fire at
      // t=1900, not the original t=1000.
      releaseSecondEvent();
      await flushMicrotasks();
      expect(batches).toHaveLength(2);

      // t=1800: past the original deadline but before the reset one — still alive.
      await vi.advanceTimersByTimeAsync(900);
      expect(settled).toBe(false);

      // t=1900: 1000ms of silence after the last event — now it aborts.
      await vi.advanceTimersByTimeAsync(100);
      await read;
      expect(settled).toBe(true);
    });

    it('does not arm the idle watchdog when liveIdleTimeoutMs is 0', async () => {
      streamsClientMockFns.live.mockImplementation(liveEmittingThenIdle([]));
      const client = createLoroStreamsJsonStreamClient({
        bucketId: 'bucket-1',
        getToken: async () => 'token-1',
        baseUrl: 'https://streams.example.com',
        liveIdleTimeoutMs: 0,
      });

      const parent = new AbortController();
      let settled = false;
      const read = client
        .readJsonLive('workspace-1:rpc:res:client-1', { nextOffset: 'now' }, () => {}, {
          signal: parent.signal,
        })
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(settled).toBe(false);

      // The caller's stop signal still tears the read down even with no watchdog.
      parent.abort();
      await flushMicrotasks();
      await read;
      expect(settled).toBe(true);
    });

    it('aborts the live read when the caller stop signal aborts', async () => {
      streamsClientMockFns.live.mockImplementation(liveEmittingThenIdle([]));
      const client = createLoroStreamsJsonStreamClient({
        bucketId: 'bucket-1',
        getToken: async () => 'token-1',
        baseUrl: 'https://streams.example.com',
        liveIdleTimeoutMs: 60_000,
      });

      const parent = new AbortController();
      let settled = false;
      const read = client
        .readJsonLive('workspace-1:rpc:res:client-1', { nextOffset: 'now' }, () => {}, {
          signal: parent.signal,
        })
        .then(() => {
          settled = true;
        });

      await flushMicrotasks();
      expect(settled).toBe(false);

      parent.abort();
      await flushMicrotasks();
      await read;
      expect(settled).toBe(true);
      expect(lastLiveSignal().aborted).toBe(true);
    });
  });
});

// Regression coverage for cf80d2c12, which pinned the browser Machine RPC
// response dispatcher to long-poll after an SSE-only attempt lost responses.
// SSE-only is unsafe because the streams client's `auto` mode only downgrades on
// an explicit "SSE unsupported" 400: an SSE read that fails (or connects and
// then never delivers) after startup ends the live iterator and every pending
// call waits out its timeout. These drive the real stream client and dispatcher
// over a mocked streams transport, with no sleeps or wall-clock races.
describe('machine RPC response live transport fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    streamsClientMockFns.append.mockResolvedValue({
      ok: true,
      result: { status: 204, nextOffset: '1', closed: false },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const flushMicrotasks = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  };

  type LiveCall = { offset: string; mode: string };

  const untilAborted = async (signal: AbortSignal | undefined): Promise<void> => {
    if (signal?.aborted !== false) {
      return;
    }
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };

  /**
   * Mocks the streams transport so SSE always ends with a retry-exhausted error
   * while long-poll works, and records what each live read asked for.
   */
  const mockBrokenSseTransport = () => {
    const calls: LiveCall[] = [];
    let deliverOverLongPoll: ((messages: unknown[]) => void) | null = null;

    streamsClientMockFns.live.mockImplementation(
      (input: { offset: string; mode: string; signal?: AbortSignal }) => {
        calls.push({ offset: input.offset, mode: input.mode });
        if (input.mode !== 'long-poll') {
          return (async function* () {
            yield {
              type: 'error',
              mode: 'sse',
              error: { code: 'timeout', message: 'live sse read timed out' },
              attempt: 3,
              maxAttempts: 3,
              retryExhausted: true,
            };
          })();
        }
        return (async function* () {
          yield { type: 'up_to_date', mode: 'long-poll', nextOffset: '7', cursor: 'lp-cursor' };
          const messages = await new Promise<unknown[] | null>((resolve) => {
            deliverOverLongPoll = resolve;
            void untilAborted(input.signal).then(() => resolve(null));
          });
          if (messages === null) {
            return;
          }
          yield {
            type: 'data',
            mode: 'long-poll',
            nextOffset: '8',
            cursor: 'lp-cursor',
            payload: createMockStreamPart(messages),
          };
          await untilAborted(input.signal);
        })();
      }
    );

    return {
      calls,
      deliver(messages: unknown[]) {
        if (!deliverOverLongPoll) {
          throw new Error('expected a long-poll live read to be waiting');
        }
        deliverOverLongPoll(messages);
      },
    };
  };

  const machineStatusResponse = (id: string, machineId: string) => ({
    jsonrpc: '2.0',
    id,
    method: 'machine/status',
    rpcVersion: '1',
    machineId,
    result: {
      type: 'machine/status_response',
      machineId,
      success: true,
      resources: {
        totalMemoryGB: 16,
        usedMemoryGB: 8,
        freeMemoryGB: 8,
        totalCpus: 8,
        cpuUsagePercent: 25,
      },
    },
  });

  it('falls back to long-poll when SSE reads keep failing, and still answers pending calls', async () => {
    const transport = mockBrokenSseTransport();
    const traced: Array<{ event: string; details: Record<string, unknown> }> = [];
    const streamClient = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });
    const dispatcher = new LoroStreamsRpcResponseDispatcher({
      workspaceId: 'workspace-1',
      streamClient,
      responseStreamId: 'workspace-1:rpc:res:client-1',
      liveModePolicy: new LoroStreamsLiveModePolicy({ sseReadFailureLimit: 3 }),
      trace: (event, details) => traced.push({ event, details }),
    });
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient,
      responseDispatcher: dispatcher,
    });

    const first = client.requestMachineStatus({ timeoutMs: 60_000 });
    const second = client.requestMachineStatus({ timeoutMs: 60_000 });
    await flushMicrotasks();
    await vi.waitFor(() => expect(streamsClientMockFns.append).toHaveBeenCalledTimes(2));

    const requestIds = streamsClientMockFns.append.mock.calls.map(
      (call) => (JSON.parse((call[0] as { part: { body: string } }).part.body) as { id: string }).id
    );

    // Three SSE reads fail (each separated by the loop's 1s backoff) before the
    // policy gives up on SSE; the read loop keeps retrying SSE until then.
    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatcher.getLiveModeDiagnostics()).toMatchObject({ transport: 'sse' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatcher.getLiveModeDiagnostics()).toMatchObject({ transport: 'long-poll' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(dispatcher.getLiveModeDiagnostics()).toMatchObject({
      transport: 'long-poll',
      reason: 'sse-read-failures',
      transportSwitches: 1,
    });
    expect(transport.calls.map((call) => call.mode)).toEqual(['auto', 'auto', 'auto', 'long-poll']);
    // Every attempt resumed from the same saved offset; nothing was rewound or skipped.
    expect(transport.calls.map((call) => call.offset)).toEqual(['-1', '-1', '-1', '-1']);

    transport.deliver([
      machineStatusResponse(requestIds[0] ?? '', 'machine-1'),
      machineStatusResponse(requestIds[1] ?? '', 'machine-1'),
    ]);
    await vi.advanceTimersByTimeAsync(0);

    // Both calls registered before the switch are still pending afterwards and
    // resolve with their own response.
    await expect(first).resolves.toEqual(expect.objectContaining({ success: true }));
    await expect(second).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(traced.filter((entry) => entry.event === 'machine rpc live transport changed')).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ transport: 'long-poll', reason: 'sse-read-failures' }),
      }),
    ]);

    dispatcher.stop();
  });

  it('resumes long-poll from the offset the failed SSE reads had already reached', async () => {
    const calls: LiveCall[] = [];
    // Created eagerly so the test controls exactly when the open SSE read dies.
    let releaseSse: () => void = () => {};
    const sseFailure = new Promise<void>((resolve) => {
      releaseSse = resolve;
    });
    streamsClientMockFns.live.mockImplementation(
      (input: { offset: string; mode: string; signal?: AbortSignal }) => {
        calls.push({ offset: input.offset, mode: input.mode });
        if (input.mode !== 'long-poll') {
          return (async function* () {
            // SSE connects and advances the offset, then dies.
            yield { type: 'up_to_date', mode: 'sse', nextOffset: '42', cursor: 'sse-cursor' };
            await sseFailure;
            yield {
              type: 'error',
              mode: 'sse',
              error: { code: 'timeout', message: 'live sse read timed out' },
              retryExhausted: true,
            };
          })();
        }
        return (async function* () {
          yield { type: 'up_to_date', mode: 'long-poll', nextOffset: '42', cursor: 'lp-cursor' };
          await untilAborted(input.signal);
        })();
      }
    );

    const streamClient = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });
    const dispatcher = new LoroStreamsRpcResponseDispatcher({
      workspaceId: 'workspace-1',
      streamClient,
      responseStreamId: 'workspace-1:rpc:res:client-1',
      // The read delivered a batch before failing, so it takes two failures here.
      liveModePolicy: new LoroStreamsLiveModePolicy({ sseReadFailureLimit: 1 }),
    });

    await dispatcher.start();
    await flushMicrotasks();
    releaseSse();
    await vi.advanceTimersByTimeAsync(1000);

    expect(dispatcher.getLiveModeDiagnostics()).toMatchObject({ transport: 'long-poll' });
    expect(calls).toEqual([
      { offset: '-1', mode: 'auto' },
      { offset: '42', mode: 'long-poll' },
    ]);

    dispatcher.stop();
  });

  it('falls back when SSE stays connected but pending responses keep timing out', async () => {
    const calls: LiveCall[] = [];
    streamsClientMockFns.live.mockImplementation(
      (input: { offset: string; mode: string; signal?: AbortSignal }) => {
        calls.push({ offset: input.offset, mode: input.mode });
        return (async function* () {
          // A transport-level healthy read: connects, reports up to date, then
          // holds the connection open — but never delivers the responses.
          yield {
            type: 'up_to_date',
            mode: input.mode === 'long-poll' ? 'long-poll' : 'sse',
            nextOffset: '5',
            cursor: 'cursor-5',
          };
          await untilAborted(input.signal);
        })();
      }
    );

    const streamClient = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });
    const dispatcher = new LoroStreamsRpcResponseDispatcher({
      workspaceId: 'workspace-1',
      streamClient,
      responseStreamId: 'workspace-1:rpc:res:client-1',
      liveModePolicy: new LoroStreamsLiveModePolicy({ sseResponseTimeoutLimit: 2 }),
    });
    const client = new LoroStreamsMachineRpcClient({
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      streamClient,
      responseDispatcher: dispatcher,
    });

    const first = client.requestMachineStatus({ timeoutMs: 5_000 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toBeNull();
    expect(dispatcher.getLiveModeDiagnostics()).toMatchObject({
      transport: 'sse',
      sseResponseTimeouts: 1,
    });

    const second = client.requestMachineStatus({ timeoutMs: 5_000 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(second).resolves.toBeNull();

    expect(dispatcher.getLiveModeDiagnostics()).toMatchObject({
      transport: 'long-poll',
      reason: 'sse-response-starvation',
    });
    // The stalled SSE read was cut short so the fallback applies now, and it
    // resumed from the offset SSE had reached.
    await flushMicrotasks();
    expect(calls).toEqual([
      { offset: '-1', mode: 'auto' },
      { offset: '5', mode: 'long-poll' },
    ]);

    dispatcher.stop();
  });

  it('sticks to long-poll when the server reports SSE unsupported', async () => {
    const calls: LiveCall[] = [];
    streamsClientMockFns.live.mockImplementation(
      (input: { offset: string; mode: string; signal?: AbortSignal }) => {
        calls.push({ offset: input.offset, mode: input.mode });
        const isFirstRead = calls.length === 1;
        return (async function* () {
          // `auto` downgraded inside the streams client: the events report
          // long-poll even though the read asked for auto.
          yield { type: 'up_to_date', mode: 'long-poll', nextOffset: '3', cursor: 'lp-cursor' };
          if (isFirstRead) {
            // Server closed the poll cycle; the loop reconnects.
            yield { type: 'eof', mode: 'long-poll', nextOffset: '3' };
            return;
          }
          await untilAborted(input.signal);
        })();
      }
    );

    const streamClient = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });
    const dispatcher = new LoroStreamsRpcResponseDispatcher({
      workspaceId: 'workspace-1',
      streamClient,
      responseStreamId: 'workspace-1:rpc:res:client-1',
      liveModePolicy: new LoroStreamsLiveModePolicy({ sseRetryCooldownMs: 1_000 }),
    });

    await dispatcher.start();
    await flushMicrotasks();

    expect(dispatcher.getLiveModeDiagnostics()).toMatchObject({
      transport: 'long-poll',
      reason: 'sse-unsupported',
      nextSseProbeAtMs: undefined,
    });

    // Well past the retry cooldown: an unsupported server is a capability, not
    // a transient failure, so SSE is never probed again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.slice(1).every((call) => call.mode === 'long-poll')).toBe(true);

    dispatcher.stop();
  });

  it('keeps the pinned transport when configuration disables the policy', async () => {
    const calls: LiveCall[] = [];
    streamsClientMockFns.live.mockImplementation(
      (input: { offset: string; mode: string; signal?: AbortSignal }) => {
        calls.push({ offset: input.offset, mode: input.mode });
        return (async function* () {
          yield { type: 'up_to_date', mode: 'long-poll', nextOffset: '2', cursor: 'lp-cursor' };
          await untilAborted(input.signal);
        })();
      }
    );

    const streamClient = createLoroStreamsJsonStreamClient({
      bucketId: 'bucket-1',
      getToken: async () => 'token-1',
      baseUrl: 'https://streams.example.com',
    });
    const dispatcher = new LoroStreamsRpcResponseDispatcher({
      workspaceId: 'workspace-1',
      streamClient,
      responseStreamId: 'workspace-1:rpc:res:client-1',
      liveModePolicy: new LoroStreamsLiveModePolicy({ pin: 'long-poll' }),
    });

    await dispatcher.start();
    await flushMicrotasks();

    expect(calls).toEqual([{ offset: '-1', mode: 'long-poll' }]);
    expect(dispatcher.getLiveModeDiagnostics()).toMatchObject({
      transport: 'long-poll',
      pinned: 'long-poll',
    });

    dispatcher.stop();
  });
});

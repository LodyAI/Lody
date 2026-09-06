import { describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigId,
  LocalProjectControlResponse,
  LocalProjectId,
  CodeCollabV2OpenCurrentDiffResponse,
  CodeCollabV2OpenTextOk,
  CodeCollabV2OpenTurnDiffResponse,
  CodeCollabV2RpcContentEnvelope,
  MachineAcpAuthenticateResponse,
  MachineAcpBinaryProgressMessage,
  MachineAcpCapabilitiesRefreshResponse,
  MachineId,
  MachinePingResponse,
  RpcSecretPublicKey,
  SessionForkSpec,
  SessionForkResponse,
  SessionId,
  SessionPreviewCreateResponse,
  MachineStatusResponse,
  WorkspaceId,
} from '@lody/shared';
import { LoroStreamsTokenAuthError } from '@lody/shared';
import {
  decryptCodeCollabV2RpcPayload,
  encryptCodeCollabV2RpcPayload,
  encryptRpcSecret,
  getMachineAcpAuthorizationCodeSecretContext,
  LoroStreamsGatewayError,
  LoroStreamsMachineRpcServer,
  type LoroJsonLiveBatchHandler,
  type LoroJsonStreamBatch,
  type LoroStreamsJsonStreamClient,
} from '../src/index';

const codexProvider = { cliType: 'builtin', agentType: 'codex' } as const;
const configId = 'config-1' as AgentConfigId;

const createSilentLogger = () => ({
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
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
              const onAbort = () => reject(new Error('aborted'));
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

describe('LoroStreamsMachineRpcServer', () => {
  it('redacts invalid authorization-code requests from warning logs', async () => {
    const fake = createFakeStreamClient();
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const server = new LoroStreamsMachineRpcServer({
      logger,
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'invalid-auth-code',
          method: 'machine/acp-authenticate',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {
            requestId: 'auth-code-ack',
            action: 'start',
            authorizationCode: 'secret-browser-code',
            authenticationInput: 'secret-form-input',
            authorizationCodeEnvelope: { ciphertext: 'secret-code-ciphertext' },
            authenticationInputEnvelope: { ciphertext: 'secret-form-ciphertext' },
            env: { PROVIDER_TOKEN: 'secret-provider-token' },
            cliType: 'builtin',
            agentType: 'claude',
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());
    expect(logger.warn.mock.calls[0]?.[0]).toContain('"authorizationCode":"[REDACTED]"');
    expect(logger.warn.mock.calls[0]?.[0]).toContain('"authenticationInput":"[REDACTED]"');
    expect(logger.warn.mock.calls[0]?.[0]).toContain('"authorizationCodeEnvelope":"[REDACTED]"');
    expect(logger.warn.mock.calls[0]?.[0]).toContain('"authenticationInputEnvelope":"[REDACTED]"');
    expect(logger.warn.mock.calls[0]?.[0]).toContain('"env":"[REDACTED]"');
    expect(logger.warn.mock.calls[0]?.[0]).not.toContain('secret-browser-code');
    expect(logger.warn.mock.calls[0]?.[0]).not.toContain('secret-form-input');
    expect(logger.warn.mock.calls[0]?.[0]).not.toContain('secret-code-ciphertext');
    expect(logger.warn.mock.calls[0]?.[0]).not.toContain('secret-form-ciphertext');
    expect(logger.warn.mock.calls[0]?.[0]).not.toContain('secret-provider-token');
    server.stop();
  });

  it('dispatches session terminate on the control lane', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const terminateSession = vi.fn(async ({ sessionId }: { sessionId: SessionId }) => ({
      type: 'session/terminate_response' as const,
      sessionId,
      success: true,
    }));
    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      terminateSession,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'terminate-1',
          method: 'session/terminate',
          rpcVersion: '1',
          machineId,
          workspaceId,
          replyTo: 'workspace-1:rpc:res:client-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5_000,
          params: { sessionId: 'session-1' },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1));
    expect(terminateSession).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        id: 'terminate-1',
        method: 'session/terminate',
        result: {
          type: 'session/terminate_response',
          sessionId: 'session-1',
          success: true,
        },
      })
    );
    server.stop();
  });

  it('forwards side-panel placement when dispatching a session fork', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const forkSession = vi.fn(
      async (args: SessionForkSpec): Promise<SessionForkResponse> => ({
        type: 'session/fork_response',
        sourceSessionId: args.sourceSessionId,
        targetSessionId: args.targetSessionId,
        success: true,
        partial: false,
        warnings: [],
      })
    );
    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      forkSession,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'fork-side-1',
          method: 'session/fork',
          rpcVersion: '1',
          machineId,
          workspaceId,
          replyTo: 'workspace-1:rpc:res:client-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5_000,
          params: {
            sourceSessionId: 'source-session',
            sourceTurnId: 'assistant-turn',
            targetSessionId: 'side-session',
            requestedByUserId: 'user-1',
            targetPlacement: 'side-panel',
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1));
    expect(forkSession).toHaveBeenCalledWith({
      sourceSessionId: 'source-session',
      sourceTurnId: 'assistant-turn',
      targetSessionId: 'side-session',
      requestedByUserId: 'user-1',
      targetPlacement: 'side-panel',
    });
    server.stop();
  });

  it('decrypts auth code input on the target machine without waiting for the active login', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let resolveSubmittedCode: (code: string | undefined) => void = () => {};
    const submittedCode = new Promise<string | undefined>((resolve) => {
      resolveSubmittedCode = resolve;
    });
    const authenticateMachineAcp = vi.fn(async (args): Promise<MachineAcpAuthenticateResponse> => {
      if (args.action === 'start') {
        args.onProgress?.({
          type: 'machine/acp-authentication-progress',
          machineId,
          requestId: 'auth-claude',
          agentType: 'claude',
          status: 'authorization',
          authorizationUrl: 'https://claude.ai/oauth/authorize',
          acceptsAuthorizationCode: true,
        });
        await startGate;
        return {
          type: 'machine/acp-authenticate_response',
          machineId,
          requestId: 'auth-claude',
          agentType: 'claude',
          success: true,
          disposition: 'authenticated',
        };
      }
      resolveSubmittedCode(args.authorizationCode);
      return {
        type: 'machine/acp-authenticate_response',
        machineId,
        requestId: 'auth-code-ack',
        agentType: 'claude',
        success: true,
        disposition: 'input-accepted',
      };
    });
    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      maxConcurrentRequests: 1,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      authenticateMachineAcp,
    });
    const base = {
      jsonrpc: '2.0' as const,
      rpcVersion: '1',
      machineId,
      workspaceId,
      replyTo: 'workspace-1:rpc:res:machine-1',
      sentAt: Date.now(),
      expiresAt: Date.now() + 5000,
    };

    fake.pushBatch({
      messages: [
        {
          ...base,
          id: 'auth-start',
          method: 'machine/acp-authenticate',
          params: {
            requestId: 'auth-claude',
            action: 'start',
            configId,
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();
    await fake.waitForAppendedCount(1);
    const authorizationProgress = (
      fake.appended[0]!.value as {
        result: {
          authorizationCodePublicKey: RpcSecretPublicKey;
          authenticationInputPublicKey?: RpcSecretPublicKey;
        };
      }
    ).result;
    const publicKey = authorizationProgress.authorizationCodePublicKey;
    // Preserve the old built-in OAuth progress shape for strict older clients.
    // The generic key is advertised only by the new interactive protocol flows.
    expect(authorizationProgress.authenticationInputPublicKey).toBeUndefined();
    const authorizationCodeEnvelope = await encryptRpcSecret(
      publicKey,
      'browser-returned-code',
      getMachineAcpAuthorizationCodeSecretContext({
        workspaceId,
        machineId,
        authenticationRequestId: 'auth-claude',
      })
    );
    fake.pushBatch({
      messages: [
        {
          ...base,
          id: 'auth-code',
          method: 'machine/acp-authenticate',
          params: {
            requestId: 'auth-code-ack',
            action: 'submit-code',
            authenticationRequestId: 'auth-claude',
            authorizationCodeEnvelope,
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: true,
    });

    await expect(submittedCode).resolves.toBe('browser-returned-code');
    await fake.waitForAppendedCount(2);
    expect((fake.appended[1]!.value as { id?: string }).id).toBe('auth-code');

    releaseStart();
    await fake.waitForAppendedCount(3);
    server.stop();
  });

  it('carries only the persisted config reference when starting authentication', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const authenticateMachineAcp = vi.fn(
      async (args): Promise<MachineAcpAuthenticateResponse> => ({
        type: 'machine/acp-authenticate_response',
        machineId,
        requestId: args.requestId,
        agentType: 'antigravity-acp',
        success: true,
        disposition: 'authenticated',
      })
    );
    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      maxConcurrentRequests: 1,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      authenticateMachineAcp,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0' as const,
          rpcVersion: '1',
          machineId,
          workspaceId,
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          id: 'auth-pick',
          method: 'machine/acp-authenticate',
          params: {
            requestId: 'auth-antigravity',
            action: 'start',
            configId,
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();
    await fake.waitForAppendedCount(1);
    expect(authenticateMachineAcp).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'auth-antigravity', action: 'start', configId })
    );
    server.stop();
  });

  it('routes identifier-only session preparation requests on the control lane', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const prepareSession = vi.fn(async (spec) => ({
      type: 'session/prepare_response' as const,
      preparationId: spec.preparationId,
      sessionId: spec.sessionId,
      accepted: true,
      disposition: 'accepted' as const,
    }));
    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      prepareSession,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'prepare-1',
          method: 'session/prepare',
          rpcVersion: '1',
          machineId,
          workspaceId,
          replyTo: 'workspace-1:rpc:res:client-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5_000,
          params: {
            preparationId: 'preparation-1',
            sessionId: 'session-1',
            requestedByUserId: 'user-1',
            agentConfigId: configId,
            cliType: 'builtin',
            agentType: 'codex',
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();
    await fake.waitForAppendedCount(1);
    expect(prepareSession).toHaveBeenCalledWith({
      preparationId: 'preparation-1',
      sessionId: 'session-1',
      requestedByUserId: 'user-1',
      agentConfigId: 'config-1',
      cliType: 'builtin',
      agentType: 'codex',
    });
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        id: 'prepare-1',
        method: 'session/prepare',
        result: {
          type: 'session/prepare_response',
          preparationId: 'preparation-1',
          sessionId: 'session-1',
          accepted: true,
          disposition: 'accepted',
        },
      })
    );
    server.stop();
  });

  it('logs when the request listener starts', async () => {
    const fake = createFakeStreamClient();
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const server = new LoroStreamsMachineRpcServer({
      logger,
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
    });

    await server.start();

    expect(logger.info).toHaveBeenCalledWith(
      '[rpc-server:machine-1] ensuring request stream workspace-1:rpc:req:machine-1 for workspace workspace-1 (retentionSeconds=86400)'
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[rpc-server:machine-1\] listening on request stream workspace-1:rpc:req:machine-1 for workspace workspace-1 \(ensureElapsedMs=\d+\)$/
      )
    );

    server.stop();
  });

  it('throttles repeated request loop errors and summarizes recovery', async () => {
    vi.useFakeTimers();
    let now = 0;
    let server: LoroStreamsMachineRpcServer | null = null;
    let readCount = 0;
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const streamClient: LoroStreamsJsonStreamClient = {
      ensureJsonStream: vi.fn(async () => {}),
      appendJson: vi.fn(async () => 'next-offset'),
      readJsonLive: vi.fn(async () => {
        readCount += 1;
        if (readCount <= 3) {
          throw new Error('fetch failed');
        }
        server?.stop();
      }),
    };

    try {
      server = new LoroStreamsMachineRpcServer({
        logger,
        workspaceId: 'workspace-1' as WorkspaceId,
        machineId: 'machine-1' as MachineId,
        streamClient,
        now: () => now,
        getMachineStatus: vi.fn(),
        refreshMachineAcpCapabilities: vi.fn(),
      });

      await server.start();
      await Promise.resolve();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenLastCalledWith(
        '[rpc-server:machine-1] request loop error: fetch failed (consecutiveFailures=1 nextRetryMs=1000)'
      );

      await vi.advanceTimersByTimeAsync(1000);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      now = 31_000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenLastCalledWith(
        '[rpc-server:machine-1] request loop error repeated: fetch failed (consecutiveFailures=3 firstSeenMsAgo=31000 nextRetryMs=1000)'
      );

      now = 32_000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(logger.info).toHaveBeenCalledWith(
        '[rpc-server:machine-1] request loop recovered after 32000ms (consecutiveFailures=3 lastError=fetch failed)'
      );
    } finally {
      server?.stop();
      vi.useRealTimers();
    }
  });

  it('dispatches requests concurrently so a slow handler does not block others', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();

    // Reassigned synchronously by the Promise executor below; the no-op default
    // keeps the type non-null so the release call site stays simple.
    let releaseStatus: () => void = () => {};
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    let statusStarted = false;

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: async (): Promise<MachineStatusResponse> => {
        statusStarted = true;
        // Block until released. With sequential processing this would also stall the
        // ping queued behind it; with concurrent dispatch the ping must still reply.
        await statusGate;
        return {
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
        };
      },
      refreshMachineAcpCapabilities: vi.fn(),
      pingMachine: async ({ requestId }): Promise<MachinePingResponse> => ({
        type: 'machine/ping_response',
        machineId,
        requestId,
        success: true,
        message: 'pong',
      }),
    });

    const base = {
      jsonrpc: '2.0' as const,
      rpcVersion: '1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      replyTo: 'workspace-1:rpc:res:machine-1',
      sentAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    fake.pushBatch({
      messages: [
        { ...base, id: 'req-status', method: 'machine/status', params: {} },
        { ...base, id: 'req-ping', method: 'machine/ping', params: { requestId: 'ping-1' } },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    const appendedIds = (): string[] =>
      fake.appended.map((entry) => (entry.value as { id: string }).id);

    // The fast ping reply lands while the slow status handler is still blocked.
    await vi.waitFor(() => {
      expect(appendedIds()).toContain('req-ping');
    });
    expect(statusStarted).toBe(true);
    expect(appendedIds()).not.toContain('req-status');

    releaseStatus();

    await vi.waitFor(() => {
      expect(appendedIds()).toContain('req-status');
    });

    server.stop();
  });

  it('handles machine status RPC requests and appends a success response', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const getMachineStatus = vi.fn(
      async (): Promise<MachineStatusResponse> => ({
        type: 'machine/status_response' as const,
        machineId,
        success: true,
        resources: {
          totalMemoryGB: 16,
          usedMemoryGB: 8,
          freeMemoryGB: 8,
          totalCpus: 8,
          cpuUsagePercent: 25,
        },
      })
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus,
      refreshMachineAcpCapabilities: vi.fn(),
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'machine/status',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {},
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(getMachineStatus).toHaveBeenCalledTimes(1);
    expect(fake.appended[0]?.streamId).toBe('workspace-1:rpc:res:machine-1');
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'machine/status',
        result: expect.objectContaining({
          type: 'machine/status_response',
          success: true,
        }),
      })
    );

    server.stop();
  });

  it('dispatches live session status requests', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const getSessionLiveStatus = vi.fn(async ({ sessionId }: { sessionId: SessionId }) => ({
      type: 'session/live-status_response' as const,
      machineId,
      sessionId,
      success: true as const,
      state: 'running' as const,
      observedAtMs: 123,
    }));
    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      getSessionLiveStatus,
    });
    const base = {
      jsonrpc: '2.0' as const,
      rpcVersion: '1',
      machineId,
      workspaceId,
      replyTo: 'workspace-1:rpc:res:client-1',
      sentAt: Date.now(),
      expiresAt: Date.now() + 5000,
    };
    fake.pushBatch({
      messages: [
        {
          ...base,
          id: 'live-1',
          method: 'session/live-status',
          params: { sessionId: 'session-1' },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();
    await vi.waitFor(() => expect(fake.appended).toHaveLength(1));

    expect(getSessionLiveStatus).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(fake.appended.map((entry) => entry.value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'live-1',
          result: expect.objectContaining({ state: 'running' }),
        }),
      ])
    );

    server.stop();
  });

  it('appends responses to workspace-level replyTo streams for new clients', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const getMachineStatus = vi.fn(
      async (): Promise<MachineStatusResponse> => ({
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
      })
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus,
      refreshMachineAcpCapabilities: vi.fn(),
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'machine/status',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:client-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {},
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(fake.appended[0]?.streamId).toBe('workspace-1:rpc:res:client-1');
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'machine/status',
        result: expect.objectContaining({
          type: 'machine/status_response',
          success: true,
        }),
      })
    );

    server.stop();
  });

  it('handles machine ping RPC requests and appends pong', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const pingMachine = vi.fn(
      async ({ requestId }: { requestId: string }): Promise<MachinePingResponse> => ({
        type: 'machine/ping_response',
        machineId,
        requestId,
        success: true,
        message: 'pong',
      })
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      pingMachine,
      refreshMachineAcpCapabilities: vi.fn(),
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'machine/ping',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: { requestId: 'ping-1' },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(pingMachine).toHaveBeenCalledWith({ requestId: 'ping-1' });
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        id: 'req-1',
        method: 'machine/ping',
        result: {
          type: 'machine/ping_response',
          machineId: 'machine-1',
          requestId: 'ping-1',
          success: true,
          message: 'pong',
        },
      })
    );

    server.stop();
  });

  it('handles machine restart RPC requests and fires lifecycle hook after append', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const appendedAtHook: unknown[] = [];
    const onMachineLifecycleResponseAppended = vi.fn(() => {
      appendedAtHook.push(...fake.appended.map((entry) => entry.value));
    });
    const restartMachine = vi.fn(async () => ({
      type: 'machine/restart_response' as const,
      machineId,
      requestId: 'restart-1',
      success: true,
      accepted: true,
      disposition: 'accepted' as const,
    }));

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      restartMachine,
      onMachineLifecycleResponseAppended,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'machine/restart',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {
            requesterUserId: 'user-1',
            requestToken: 'signed-token',
            requestId: 'restart-1',
          },
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(onMachineLifecycleResponseAppended).toHaveBeenCalledTimes(1);
    });

    expect(restartMachine).toHaveBeenCalledWith({
      requesterUserId: 'user-1',
      requestToken: 'signed-token',
      requestId: 'restart-1',
    });
    expect(appendedAtHook).toEqual([
      expect.objectContaining({
        id: 'req-1',
        method: 'machine/restart',
        result: expect.objectContaining({
          type: 'machine/restart_response',
          requestId: 'restart-1',
          accepted: true,
        }),
      }),
    ]);

    server.stop();
  });

  it('decrypts Code Collab requests and encrypts Code Collab results by owner session', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const openCodeCollabText = vi.fn(
      async (): Promise<CodeCollabV2OpenTextOk> => ({
        status: 'ok',
        path: 'src/app.ts',
        digest: `sha256:${'1'.repeat(64)}`,
        text: {
          encoding: 'plain',
          text: 'hello',
          rawBytes: 5,
        },
      })
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      openCodeCollabText,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'code-collab/open-text',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: await encryptCodeCollabV2RpcPayload('session-parent', {
            sessionId: 'session-child',
            path: 'src/app.ts',
          }),
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(openCodeCollabText).toHaveBeenCalledWith({
      sessionId: 'session-child',
      path: 'src/app.ts',
    });
    expect(fake.appended[0]?.streamId).toBe('workspace-1:rpc:res:machine-1');
    const response = fake.appended[0]?.value as {
      result: unknown;
    };
    expect(response.result).toEqual(
      expect.objectContaining({
        type: 'code-collab-v2-content-envelope',
        ownerSessionId: 'session-parent',
      })
    );
    await expect(
      decryptCodeCollabV2RpcPayload(
        response.result as CodeCollabV2RpcContentEnvelope,
        'session-parent'
      )
    ).resolves.toEqual({
      status: 'ok',
      path: 'src/app.ts',
      digest: `sha256:${'1'.repeat(64)}`,
      text: {
        encoding: 'plain',
        text: 'hello',
        rawBytes: 5,
      },
    });

    server.stop();
  });

  it('serves file/preview through the owner-scoped encrypted envelope', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const previewFile = vi.fn(async () => ({
      status: 'ok' as const,
      v: 3 as const,
      path: 'assets/logo.png',
      digest: `sha256:${'2'.repeat(64)}` as `sha256:${string}`,
      kind: 'binary' as const,
      content: { encoding: 'base64' as const, data: 'iVBO', rawBytes: 3 },
      mimeType: 'image/png',
      sizeBytes: 3,
      readonly: true,
    }));
    const resolveCodeCollabOwnerSessionId = vi.fn(
      async (): Promise<SessionId> => 'session-parent' as SessionId
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      resolveCodeCollabOwnerSessionId,
      previewFile,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'file/preview',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: await encryptCodeCollabV2RpcPayload('session-parent', {
            v: 3,
            sessionId: 'session-child',
            path: 'assets/logo.png',
          }),
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(previewFile).toHaveBeenCalledWith({
      v: 3,
      sessionId: 'session-child',
      path: 'assets/logo.png',
    });
    const response = fake.appended[0]?.value as { result: unknown };
    await expect(
      decryptCodeCollabV2RpcPayload(
        response.result as CodeCollabV2RpcContentEnvelope,
        'session-parent'
      )
    ).resolves.toMatchObject({ status: 'ok', kind: 'binary', mimeType: 'image/png' });

    server.stop();
  });

  it('rejects a file/preview request whose envelope owner is not the session owner', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const previewFile = vi.fn();
    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      resolveCodeCollabOwnerSessionId: vi.fn(
        async (): Promise<SessionId> => 'session-parent' as SessionId
      ),
      previewFile,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'file/preview',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: await encryptCodeCollabV2RpcPayload('session-wrong-owner', {
            v: 3,
            sessionId: 'session-child',
            path: 'src/app.ts',
          }),
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    // The read must not run at all: swapping the session id is exactly how a
    // client would try to read another session's workspace.
    expect(previewFile).not.toHaveBeenCalled();
    const response = fake.appended[0]?.value as { error: { code: string; data?: unknown } };
    expect(response.error.code).toBe('permission_denied');
    await expect(
      decryptCodeCollabV2RpcPayload(
        response.error.data as CodeCollabV2RpcContentEnvelope,
        'session-wrong-owner'
      )
    ).resolves.toMatchObject({ status: 'error', v: 3, code: 'permission_denied' });

    server.stop();
  });

  it('decrypts Code Collab current diff requests and encrypts current diff results', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const openCodeCollabCurrentDiff = vi.fn(
      async (): Promise<CodeCollabV2OpenCurrentDiffResponse> => ({
        status: 'ok',
        path: 'src/app.ts',
        oldSnapshot: {
          kind: 'text',
          text: {
            encoding: 'plain',
            text: 'old\n',
            rawBytes: 4,
          },
        },
        newSnapshot: {
          kind: 'text',
          text: {
            encoding: 'plain',
            text: 'new\n',
            rawBytes: 4,
          },
        },
        add: 1,
        del: 1,
      })
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      openCodeCollabCurrentDiff,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'code-collab/open-current-diff',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: await encryptCodeCollabV2RpcPayload('session-parent', {
            sessionId: 'session-child',
            path: 'src/app.ts',
          }),
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(openCodeCollabCurrentDiff).toHaveBeenCalledWith({
      sessionId: 'session-child',
      path: 'src/app.ts',
    });
    const response = fake.appended[0]?.value as {
      result: unknown;
    };
    await expect(
      decryptCodeCollabV2RpcPayload(
        response.result as CodeCollabV2RpcContentEnvelope,
        'session-parent'
      )
    ).resolves.toEqual({
      status: 'ok',
      path: 'src/app.ts',
      oldSnapshot: {
        kind: 'text',
        text: {
          encoding: 'plain',
          text: 'old\n',
          rawBytes: 4,
        },
      },
      newSnapshot: {
        kind: 'text',
        text: {
          encoding: 'plain',
          text: 'new\n',
          rawBytes: 4,
        },
      },
      add: 1,
      del: 1,
    });

    server.stop();
  });

  it('decrypts Code Collab turn diff requests and encrypts turn diff results', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const openCodeCollabTurnDiff = vi.fn(
      async (): Promise<CodeCollabV2OpenTurnDiffResponse> => ({
        status: 'ok',
        path: 'src/app.ts',
        turnId: 'turn-1',
        oldSnapshot: {
          kind: 'text',
          text: {
            encoding: 'plain',
            text: 'old\n',
            rawBytes: 4,
          },
        },
        newSnapshot: {
          kind: 'text',
          text: {
            encoding: 'plain',
            text: 'new\n',
            rawBytes: 4,
          },
        },
        add: 1,
        del: 1,
      })
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      openCodeCollabTurnDiff,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'code-collab/open-turn-diff',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: await encryptCodeCollabV2RpcPayload('session-parent', {
            sessionId: 'session-child',
            turnId: 'turn-1',
            path: 'src/app.ts',
          }),
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(openCodeCollabTurnDiff).toHaveBeenCalledWith({
      sessionId: 'session-child',
      turnId: 'turn-1',
      path: 'src/app.ts',
    });
    const response = fake.appended[0]?.value as {
      result: unknown;
    };
    await expect(
      decryptCodeCollabV2RpcPayload(
        response.result as CodeCollabV2RpcContentEnvelope,
        'session-parent'
      )
    ).resolves.toEqual({
      status: 'ok',
      path: 'src/app.ts',
      turnId: 'turn-1',
      oldSnapshot: {
        kind: 'text',
        text: {
          encoding: 'plain',
          text: 'old\n',
          rawBytes: 4,
        },
      },
      newSnapshot: {
        kind: 'text',
        text: {
          encoding: 'plain',
          text: 'new\n',
          rawBytes: 4,
        },
      },
      add: 1,
      del: 1,
    });

    server.stop();
  });

  it('rejects Code Collab requests when the envelope owner does not match the business session owner', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const openCodeCollabText = vi.fn(
      async (): Promise<CodeCollabV2OpenTextOk> => ({
        status: 'ok',
        path: 'src/app.ts',
        digest: `sha256:${'1'.repeat(64)}`,
        text: {
          encoding: 'plain',
          text: 'hello',
          rawBytes: 5,
        },
      })
    );
    const resolveCodeCollabOwnerSessionId = vi.fn(
      async (): Promise<SessionId> => 'session-parent' as SessionId
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      resolveCodeCollabOwnerSessionId,
      openCodeCollabText,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'code-collab/open-text',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: await encryptCodeCollabV2RpcPayload('session-wrong-owner', {
            sessionId: 'session-child',
            path: 'src/app.ts',
          }),
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(resolveCodeCollabOwnerSessionId).toHaveBeenCalledWith('session-child');
    expect(openCodeCollabText).not.toHaveBeenCalled();
    const response = fake.appended[0]?.value as {
      error: { code: string; message: string; data?: unknown };
    };
    expect(response.error).toMatchObject({
      code: 'permission_denied',
      message: 'Code Collab RPC owner session mismatch.',
    });
    expect(response.error.data).toEqual(
      expect.objectContaining({
        type: 'code-collab-v2-content-envelope',
        ownerSessionId: 'session-wrong-owner',
      })
    );
    await expect(
      decryptCodeCollabV2RpcPayload(
        response.error.data as CodeCollabV2RpcContentEnvelope,
        'session-wrong-owner'
      )
    ).resolves.toMatchObject({
      status: 'error',
      code: 'permission_denied',
      message: 'Code Collab RPC owner session mismatch.',
    });

    server.stop();
  });

  it('encrypts Code Collab error payload data by owner session', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const serviceError = Object.assign(new Error('Denied'), {
      code: 'permission_denied',
      toRpcError: () => ({
        status: 'error' as const,
        code: 'permission_denied' as const,
        message: 'Denied',
      }),
    });
    const openCodeCollabText = vi.fn(async () => {
      throw serviceError;
    });

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      openCodeCollabText,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'code-collab/open-text',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: await encryptCodeCollabV2RpcPayload('session-parent', {
            sessionId: 'session-child',
            path: 'src/app.ts',
          }),
        },
      ],
      nextOffset: '1',
      cursor: 'cursor-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    const response = fake.appended[0]?.value as {
      error: { code: string; message: string; data?: unknown };
    };
    expect(response.error).toMatchObject({
      code: 'permission_denied',
      message: 'Denied',
    });
    expect(response.error.data).toEqual(
      expect.objectContaining({
        type: 'code-collab-v2-content-envelope',
        ownerSessionId: 'session-parent',
      })
    );
    await expect(
      decryptCodeCollabV2RpcPayload(
        response.error.data as CodeCollabV2RpcContentEnvelope,
        'session-parent'
      )
    ).resolves.toEqual({
      status: 'error',
      code: 'permission_denied',
      message: 'Denied',
    });

    server.stop();
  });

  it('handles local project control RPC requests and appends a success response', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const localProjectId = 'local-project-1' as LocalProjectId;
    const fake = createFakeStreamClient();
    const dispatchLocalProjectControl = vi.fn(
      async (): Promise<LocalProjectControlResponse> => ({
        ok: true,
        type: 'local-project/sync-history',
        result: {
          listed: 0,
          lastListedAt: 1,
          sessions: [],
        },
      })
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      dispatchLocalProjectControl,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-project-1',
          method: 'local-project/control',
          rpcVersion: '1',
          machineId,
          workspaceId,
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {
            request: {
              type: 'local-project/sync-history',
              machineId,
              workspaceId,
              localProjectId,
              provider: codexProvider,
            },
          },
        },
      ],
      nextOffset: 'project-1',
      cursor: 'cursor-project-1',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(dispatchLocalProjectControl).toHaveBeenCalledWith({
      type: 'local-project/sync-history',
      machineId,
      workspaceId,
      localProjectId,
      provider: codexProvider,
    });
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 'req-project-1',
        method: 'local-project/control',
        result: expect.objectContaining({
          ok: true,
          type: 'local-project/sync-history',
        }),
      })
    );

    server.stop();
  });

  it('returns rpc_version_mismatch when request version is unsupported', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-2',
          method: 'machine/acp-capabilities-refresh',
          rpcVersion: '0',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {
            configId,
          },
        },
      ],
      nextOffset: '2',
      cursor: 'cursor-2',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'machine/acp-capabilities-refresh',
        error: expect.objectContaining({
          code: 'rpc_version_mismatch',
        }),
      })
    );

    server.stop();
  });

  it('handles machine ACP capability refresh requests with the explicit refresh branch', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const refreshMachineAcpCapabilities = vi.fn(
      async (): Promise<MachineAcpCapabilitiesRefreshResponse> => ({
        type: 'machine/acp-capabilities-refresh_response' as const,
        machineId,
        configId,
        cliType: 'custom' as const,
        agentType: 'custom-agent' as const,
        success: true,
        modes: [{ id: 'agent', name: 'Agent' }],
        models: [{ modelId: 'gpt-5', name: 'GPT-5' }],
        configOptions: [],
      })
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-3',
          method: 'machine/acp-capabilities-refresh',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {
            configId,
          },
        },
      ],
      nextOffset: '3',
      cursor: 'cursor-3',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(refreshMachineAcpCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        configId,
        onAcpBinaryProgress: expect.any(Function),
      })
    );
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 'req-3',
        method: 'machine/acp-capabilities-refresh',
        result: expect.objectContaining({
          type: 'machine/acp-capabilities-refresh_response',
          success: true,
        }),
      })
    );

    server.stop();
  });

  it('aborts capability work and suppresses progress after an exact cancel request', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const keptConfigId = 'config-2' as AgentConfigId;
    const fake = createFakeStreamClient();
    const pendingRefreshes = new Map<
      AgentConfigId,
      {
        signal: AbortSignal;
        onProgress?: (message: MachineAcpBinaryProgressMessage) => void;
        resolve: (response: MachineAcpCapabilitiesRefreshResponse) => void;
      }
    >();
    const refreshMachineAcpCapabilities = vi.fn(
      ({ configId: requestConfigId, signal, onAcpBinaryProgress }) =>
        new Promise<MachineAcpCapabilitiesRefreshResponse>((resolve) => {
          pendingRefreshes.set(requestConfigId, {
            signal,
            onProgress: onAcpBinaryProgress,
            resolve,
          });
        })
    );
    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities,
    });

    const baseRefreshRequest = {
      jsonrpc: '2.0' as const,
      method: 'machine/acp-capabilities-refresh' as const,
      rpcVersion: '1',
      machineId,
      workspaceId,
      replyTo: 'workspace-1:rpc:res:machine-1',
      sentAt: Date.now(),
      expiresAt: Date.now() + 5000,
      params: {},
    };
    fake.pushBatch({
      messages: [
        {
          ...baseRefreshRequest,
          id: 'refresh-to-cancel',
          params: { ...baseRefreshRequest.params, configId },
        },
        {
          ...baseRefreshRequest,
          id: 'refresh-to-keep',
          params: { ...baseRefreshRequest.params, configId: keptConfigId },
        },
      ],
      nextOffset: '4',
      cursor: 'cursor-4',
      upToDate: false,
    });
    await server.start();
    await vi.waitFor(() => expect(pendingRefreshes.size).toBe(2));

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'cancel-refresh',
          method: 'machine/acp-capabilities-refresh-cancel',
          rpcVersion: '1',
          machineId,
          workspaceId,
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: { requestId: 'refresh-to-cancel' },
        },
      ],
      nextOffset: '5',
      cursor: 'cursor-5',
      upToDate: true,
    });

    await vi.waitFor(() => expect(pendingRefreshes.get(configId)?.signal.aborted).toBe(true));
    expect(pendingRefreshes.get(keptConfigId)?.signal.aborted).toBe(false);

    const lateProgress: MachineAcpBinaryProgressMessage = {
      type: 'machine/acp-binary-progress',
      machineId,
      agentType: 'codex',
      status: 'downloading',
      percent: 50,
    };
    pendingRefreshes.get(configId)?.onProgress?.(lateProgress);
    pendingRefreshes.get(keptConfigId)?.onProgress?.(lateProgress);
    pendingRefreshes.get(configId)?.resolve({
      type: 'machine/acp-capabilities-refresh_response',
      machineId,
      configId,
      cliType: 'builtin',
      agentType: 'codex',
      success: true,
      modes: [],
      models: [],
      availableCommands: [],
    });
    pendingRefreshes.get(keptConfigId)?.resolve({
      type: 'machine/acp-capabilities-refresh_response',
      machineId,
      configId: keptConfigId,
      cliType: 'builtin',
      agentType: 'codex',
      success: true,
      modes: [],
      models: [],
      availableCommands: [],
    });

    await vi.waitFor(() => expect(fake.appended).toHaveLength(2));
    expect(fake.appended.map((entry) => entry.value)).toEqual([
      expect.objectContaining({
        id: 'refresh-to-keep',
        result: expect.objectContaining({ type: 'machine/acp-binary-progress' }),
      }),
      expect.objectContaining({
        id: 'refresh-to-keep',
        result: expect.objectContaining({ type: 'machine/acp-capabilities-refresh_response' }),
      }),
    ]);

    server.stop();
  });

  it('appends ACP binary progress before the final refresh response', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    fake.streamClient.appendJson = vi.fn(async (streamId: string, value: unknown) => {
      const resultType = (value as { result?: { type?: string } }).result?.type;
      if (resultType === 'machine/acp-binary-progress') {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      fake.appended.push({ streamId, value });
      return 'next-offset';
    });
    const refreshMachineAcpCapabilities = vi.fn(
      async ({ onAcpBinaryProgress }): Promise<MachineAcpCapabilitiesRefreshResponse> => {
        onAcpBinaryProgress?.({
          type: 'machine/acp-binary-progress',
          machineId,
          agentType: 'codex',
          status: 'downloading',
          percent: 10,
        });
        return {
          type: 'machine/acp-capabilities-refresh_response',
          machineId,
          configId,
          cliType: 'builtin',
          agentType: 'codex',
          success: true,
          modes: [],
          models: [],
        };
      }
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-progress',
          method: 'machine/acp-capabilities-refresh',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {
            configId,
          },
        },
      ],
      nextOffset: '4',
      cursor: 'cursor-4',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(2);
    });

    expect(
      fake.appended.map((entry) => (entry.value as { result?: { type?: string } }).result?.type)
    ).toEqual(['machine/acp-binary-progress', 'machine/acp-capabilities-refresh_response']);

    server.stop();
  });

  it('appends structured ACP authorization before the final auth response', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const fake = createFakeStreamClient();
    const authenticateMachineAcp = vi.fn(
      async ({ onProgress }): Promise<MachineAcpAuthenticateResponse> => {
        onProgress?.({
          type: 'machine/acp-authentication-progress',
          machineId,
          requestId: 'auth-1',
          agentType: 'kimi',
          status: 'authorization',
          authorizationUrl: 'https://www.kimi.com/code/authorize_device?user_code=GI5T-ACD0',
          userCode: 'GI5T-ACD0',
          expiresInSeconds: 1800,
        });
        return {
          type: 'machine/acp-authenticate_response',
          machineId,
          requestId: 'auth-1',
          agentType: 'kimi',
          success: true,
          disposition: 'authenticated',
        };
      }
    );
    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      authenticateMachineAcp,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-auth',
          method: 'machine/acp-authenticate',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {
            requestId: 'auth-1',
            action: 'start',
            configId,
          },
        },
      ],
      nextOffset: '5',
      cursor: 'cursor-5',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(2);
    });

    expect(authenticateMachineAcp).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'auth-1',
        action: 'start',
        configId,
        onProgress: expect.any(Function),
      })
    );
    expect(
      fake.appended.map((entry) => (entry.value as { result?: { type?: string } }).result?.type)
    ).toEqual(['machine/acp-authentication-progress', 'machine/acp-authenticate_response']);

    server.stop();
  });

  it('handles session preview create RPC requests', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const sessionId = 'session-1' as SessionId;
    const fake = createFakeStreamClient();
    const createSessionPreview = vi.fn(
      async (): Promise<SessionPreviewCreateResponse> => ({
        type: 'session/preview-create_response',
        sessionId,
        success: false,
        error: 'tunnel_not_configured',
        message: 'Preview gateway is not configured.',
      })
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      createSessionPreview,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-preview',
          method: 'session/preview-create',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {
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
          },
        },
      ],
      nextOffset: '4',
      cursor: 'cursor-4',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(createSessionPreview).toHaveBeenCalledWith({
      sessionId,
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
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 'req-preview',
        method: 'session/preview-create',
        result: expect.objectContaining({
          type: 'session/preview-create_response',
          success: false,
          error: 'tunnel_not_configured',
        }),
      })
    );

    server.stop();
  });

  it('handles local project git state RPC requests', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const localProjectId = 'local-project-1' as LocalProjectId;
    const fake = createFakeStreamClient();
    const getLocalProjectGitState = vi.fn(async () => ({
      type: 'local-project/git-state_response' as const,
      machineId,
      workspaceId,
      localProjectId,
      success: true as const,
      observedAtMs: 123,
      state: { git: false as const },
    }));

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: fake.streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      getLocalProjectGitState,
    });

    fake.pushBatch({
      messages: [
        {
          jsonrpc: '2.0',
          id: 'req-local-git',
          method: 'local-project/git-state',
          rpcVersion: '1',
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          replyTo: 'workspace-1:rpc:res:machine-1',
          sentAt: Date.now(),
          expiresAt: Date.now() + 5000,
          params: {
            localProjectId: 'local-project-1',
            requestedByUserId: 'user-1',
          },
        },
      ],
      nextOffset: '5',
      cursor: 'cursor-5',
      upToDate: true,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(fake.appended).toHaveLength(1);
    });

    expect(getLocalProjectGitState).toHaveBeenCalledWith({
      localProjectId,
      requestedByUserId: 'user-1',
    });
    expect(fake.appended[0]?.value).toEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 'req-local-git',
        method: 'local-project/git-state',
        result: expect.objectContaining({
          type: 'local-project/git-state_response',
          success: true,
          state: { git: false },
        }),
      })
    );

    server.stop();
  });

  it('resumes request streaming from the retained head after cursor expiration', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const appended: Array<{ streamId: string; value: unknown }> = [];
    const seenOffsets: string[] = [];
    let readCount = 0;

    const streamClient: LoroStreamsJsonStreamClient = {
      ensureJsonStream: vi.fn(async () => {}),
      appendJson: vi.fn(async (streamId: string, value: unknown) => {
        appended.push({ streamId, value });
        return 'next-offset';
      }),
      readJsonLive: vi.fn(
        async (_streamId: string, state, onBatch, options?: { signal?: AbortSignal }) => {
          readCount += 1;
          seenOffsets.push(state.nextOffset ?? 'missing');

          if (readCount === 1) {
            throw new LoroStreamsGatewayError('cursor expired', 410);
          }

          if (readCount === 2) {
            await onBatch({
              messages: [
                {
                  jsonrpc: '2.0',
                  id: 'req-expired',
                  method: 'machine/status',
                  rpcVersion: '1',
                  machineId: 'machine-1',
                  workspaceId: 'workspace-1',
                  replyTo: 'workspace-1:rpc:res:machine-1',
                  sentAt: Date.now(),
                  expiresAt: Date.now() + 5000,
                  params: {},
                },
              ],
              nextOffset: '5',
              cursor: 'cursor-5',
              upToDate: true,
            });
          }

          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => reject(new Error('aborted'));
            options?.signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
      ),
    };

    const getMachineStatus = vi.fn(
      async (): Promise<MachineStatusResponse> => ({
        type: 'machine/status_response' as const,
        machineId,
        success: true,
        resources: {
          totalMemoryGB: 16,
          usedMemoryGB: 8,
          freeMemoryGB: 8,
          totalCpus: 8,
          cpuUsagePercent: 25,
        },
      })
    );

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient,
      getMachineStatus,
      refreshMachineAcpCapabilities: vi.fn(),
    });

    await server.start();

    await vi.waitFor(() => {
      expect(appended).toHaveLength(1);
    });

    expect(seenOffsets.slice(0, 2)).toEqual(['-1', '-1']);
    expect(getMachineStatus).toHaveBeenCalledTimes(1);

    server.stop();
  });

  it('stops the request loop and notifies on a non-retriable token auth failure', async () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const authError = new LoroStreamsTokenAuthError(
      'Failed to fetch Loro Streams token (status=403 detail={"error":"Forbidden"})',
      403,
      '{"error":"Forbidden"}'
    );

    let readCount = 0;
    const streamClient: LoroStreamsJsonStreamClient = {
      ensureJsonStream: vi.fn(async () => {}),
      appendJson: vi.fn(async () => 'next-offset'),
      readJsonLive: vi.fn(async () => {
        readCount += 1;
        throw authError;
      }),
    };

    const onFatalAuthFailure = vi.fn();

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      onFatalAuthFailure,
    });

    await server.start();

    await vi.waitFor(() => {
      expect(onFatalAuthFailure).toHaveBeenCalledTimes(1);
    });

    expect(onFatalAuthFailure).toHaveBeenCalledWith(authError);

    // Give the loop a chance to retry — it must not, because a revoked
    // token will never succeed and spamming 403s was the original bug.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readCount).toBe(1);

    server.stop();
  });
});

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { ACP_AUTHORIZATION_URL_MAX_LENGTH } from '@lody/shared';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@/utils/logger';
import { createStdinWritableStream, createStdoutReadableStream } from '@/utils/stream';
import { AcpAuthenticationManager, probeBuiltinAuthentication } from './acp-authentication';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function createFakeChild(options: { ignoreSigterm?: boolean } = {}) {
  const child = new EventEmitter() as ChildProcess;
  child.exitCode = null;
  child.pid = undefined;
  child.stdout = null;
  child.stderr = null;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === 'SIGTERM' && options.ignoreSigterm) return true;
    child.exitCode = signal === 'SIGKILL' ? 137 : 0;
    queueMicrotask(() => child.emit('exit', child.exitCode, signal));
    return true;
  });
  return child;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('AcpAuthenticationManager', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reserves the login slot before asynchronous launch preparation', async () => {
    const loginShellEnv = createDeferred<Record<string, string>>();
    const successfulChild = createFakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        successfulChild.exitCode = 0;
        successfulChild.emit('exit', 0, null);
      });
      return successfulChild;
    });
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: spawnProcess as never,
      resolveLoginShellEnv: vi.fn(() => loginShellEnv.promise),
    });
    const input = {
      cliType: 'builtin' as const,
      agentType: 'kimi',
      runtimeOverrides: { kimiPath: '/test/kimi' },
    };

    const firstAttempt = manager.authenticate({ requestId: 'auth-1', ...input });
    await expect(manager.authenticate({ requestId: 'auth-2', ...input })).resolves.toEqual({
      success: false,
      disposition: 'error',
      error: 'Kimi Code authentication is already running',
    });

    loginShellEnv.resolve({});
    await expect(firstAttempt).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it.each([
    {
      agentType: 'claude',
      runtimeOverrides: { claudeCodeExecutable: '/test/claude' },
      command: '/test/claude',
      args: ['auth', 'login', '--claudeai'],
    },
    {
      agentType: 'codex',
      runtimeOverrides: { codexPath: '/test/codex' },
      command: '/test/codex',
      args: ['login', '--device-auth'],
    },
    {
      agentType: 'grok',
      runtimeOverrides: { grokPath: '/test/grok' },
      command: '/test/grok',
      args: ['login', '--device-auth'],
    },
  ])(
    'runs the official $agentType login flow',
    async ({ agentType, runtimeOverrides, command, args }) => {
      const successfulChild = createFakeChild();
      const spawnProcess = vi.fn(() => {
        queueMicrotask(() => {
          successfulChild.exitCode = 0;
          successfulChild.emit('exit', 0, null);
        });
        return successfulChild;
      });
      const manager = new AcpAuthenticationManager(createSilentLogger(), {
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      });

      await expect(
        manager.authenticate({
          requestId: `auth-${agentType}`,
          cliType: 'builtin',
          agentType,
          runtimeOverrides,
        })
      ).resolves.toEqual({ success: true, disposition: 'authenticated' });
      expect(spawnProcess).toHaveBeenCalledWith(
        command,
        args,
        expect.objectContaining({ cwd: expect.any(String) })
      );
    }
  );

  it('emits a Claude browser authorization event and accepts the fallback code through stdin', async () => {
    const child = createFakeChild();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdoutListening = createDeferred<void>();
    stdout.once('newListener', (event) => {
      if (event === 'data') stdoutListening.resolve();
    });
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    const receivedInput: string[] = [];
    stdin.on('data', (chunk) => receivedInput.push(String(chunk)));
    stdin.on('finish', () => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
    });
    const authorizationReceived = createDeferred<void>();
    const progress = vi.fn((event: { status: string }) => {
      if (event.status === 'authorization') authorizationReceived.resolve();
    });
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => child) as never,
      resolveLoginShellEnv: async () => ({}),
    });
    const authentication = manager.authenticate({
      requestId: 'auth-claude',
      cliType: 'builtin',
      agentType: 'claude',
      runtimeOverrides: { claudeCodeExecutable: '/test/claude' },
      onProgress: progress,
    });

    await stdoutListening.promise;
    stdout.write(
      'If the browser did not open, visit: ' +
        'https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=test\n' +
        'Paste code here if prompted > '
    );
    await authorizationReceived.promise;
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'authorization',
        authorizationUrl:
          'https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=test',
        acceptsAuthorizationCode: true,
      })
    );

    expect(manager.submitAuthorizationCode('claude', 'auth-claude', 'browser-code')).toEqual({
      success: true,
      disposition: 'input-accepted',
    });
    await expect(authentication).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
    expect(receivedInput).toEqual(['browser-code\n']);
  });

  it('explains the ChatGPT device-code setting when Codex login exits unsuccessfully', async () => {
    const failedChild = createFakeChild();
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => {
          failedChild.exitCode = 1;
          failedChild.emit('exit', 1, null);
        });
        return failedChild;
      }) as never,
      resolveLoginShellEnv: async () => ({}),
    });

    await expect(
      manager.authenticate({
        requestId: 'auth-codex',
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: { codexPath: '/test/codex' },
      })
    ).resolves.toEqual({
      success: false,
      disposition: 'error',
      error:
        'Codex authentication exited with code 1. Make sure device-code login is enabled in your ChatGPT security settings or workspace permissions, then try again.',
    });
  });

  it('cancels launch preparation without spawning and allows an immediate retry', async () => {
    const firstLoginShellEnv = createDeferred<Record<string, string>>();
    const preparationStarted = createDeferred<void>();
    let preparationCalls = 0;
    const resolveLoginShellEnv = vi.fn(() => {
      preparationCalls += 1;
      if (preparationCalls === 1) {
        preparationStarted.resolve();
        return firstLoginShellEnv.promise;
      }
      return Promise.resolve({});
    });
    const successfulChild = createFakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        successfulChild.exitCode = 0;
        successfulChild.emit('exit', 0, null);
      });
      return successfulChild;
    });
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: spawnProcess as never,
      resolveLoginShellEnv,
    });
    const input = {
      cliType: 'builtin' as const,
      agentType: 'kimi',
      runtimeOverrides: { kimiPath: '/test/kimi' },
    };

    const firstAttempt = manager.authenticate({ requestId: 'auth-1', ...input });
    await preparationStarted.promise;
    expect(resolveLoginShellEnv).toHaveBeenCalledOnce();
    expect(manager.cancel('kimi', 'auth-1')).toEqual({
      success: true,
      disposition: 'cancelled',
    });

    const retryAttempt = manager.authenticate({ requestId: 'auth-2', ...input });
    await expect(retryAttempt).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });

    firstLoginShellEnv.resolve({});
    await expect(firstAttempt).resolves.toEqual({
      success: true,
      disposition: 'cancelled',
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it('times out, escalates termination, and releases the login slot for retry', async () => {
    vi.useFakeTimers();
    const stuckChild = createFakeChild({ ignoreSigterm: true });
    const successfulChild = createFakeChild();
    const firstProcessStarted = createDeferred<void>();
    const spawnProcess = vi
      .fn()
      .mockImplementationOnce(() => {
        firstProcessStarted.resolve();
        return stuckChild;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          successfulChild.exitCode = 0;
          successfulChild.emit('exit', 0, null);
        });
        return successfulChild;
      });
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      authenticationTimeoutMs: 10,
      terminationGraceMs: 2,
      spawnProcess: spawnProcess as never,
      resolveLoginShellEnv: async () => ({}),
    });
    const input = {
      cliType: 'builtin' as const,
      agentType: 'kimi',
      runtimeOverrides: { kimiPath: '/test/kimi' },
    };

    const firstAttempt = manager.authenticate({ requestId: 'auth-1', ...input });
    await firstProcessStarted.promise;
    await vi.advanceTimersByTimeAsync(12);
    await expect(firstAttempt).resolves.toEqual({
      success: false,
      disposition: 'error',
      error: 'Kimi Code authentication timed out. Please try again.',
    });
    expect(stuckChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(stuckChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    await expect(manager.authenticate({ requestId: 'auth-2', ...input })).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
  });

  it('bridges request-scoped ACP form elicitation for a custom provider', async () => {
    const child = createFakeChild();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    const elicitationReply = createDeferred<acp.CreateElicitationResponse>();
    const agent = acp
      .agent({ name: 'test-auth-agent' })
      .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
        protocolVersion: params.protocolVersion,
        authMethods: [{ id: 'oauth', name: 'OAuth' }],
      }))
      .onRequest(acp.methods.agent.authenticate, async ({ client, requestId }) => {
        const reply = await client.request(acp.methods.client.elicitation.create, {
          mode: 'form',
          requestId,
          message: 'Complete provider sign-in',
          requestedSchema: {
            type: 'object',
            properties: {
              token: {
                type: 'string',
                title: 'Token',
                default: 'must-not-cross-machine-rpc',
                _meta: { secret: true },
              },
              account: {
                type: 'string',
                title: 'Account',
                enum: ['work', 'personal'],
                default: 'work',
              },
            },
            required: ['token', 'account'],
          },
        });
        elicitationReply.resolve(reply);
        return {};
      });
    agent.connect(
      acp.ndJsonStream(createStdinWritableStream(stdout), createStdoutReadableStream(stdin))
    );

    const formReceived = createDeferred<{ interactionId: string }>();
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => child) as never,
      resolveLoginShellEnv: async () => ({}),
    });
    const authentication = manager.authenticate({
      requestId: 'auth-custom',
      cliType: 'custom',
      agentType: 'custom-test',
      customAcp: { command: '/test/custom-acp', args: [] },
      onProgress: (event) => {
        if (event.status === 'input-required') {
          expect(event.form.fields).toEqual([
            { id: 'token', type: 'secret', label: 'Token', required: true },
            {
              id: 'account',
              type: 'select',
              label: 'Account',
              required: true,
              options: [
                { value: 'work', label: 'work' },
                { value: 'personal', label: 'personal' },
              ],
              defaultValue: 'work',
            },
          ]);
          formReceived.resolve({ interactionId: event.interactionId });
        }
      },
    });

    const { interactionId } = await formReceived.promise;
    expect(
      manager.submitAuthenticationInput(
        'custom-test',
        'auth-custom',
        interactionId,
        JSON.stringify({
          action: 'accept',
          content: { token: 'secret-value', account: 'work' },
        })
      )
    ).toEqual({ success: true, disposition: 'input-accepted' });
    await expect(elicitationReply.promise).resolves.toEqual({
      action: 'accept',
      content: { token: 'secret-value', account: 'work' },
    });
    await expect(authentication).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
  });

  it('selects between advertised agent-driven authentication methods', async () => {
    const child = createFakeChild();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    const authenticatedWith = createDeferred<string>();
    const agent = acp
      .agent({ name: 'test-method-auth-agent' })
      .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
        protocolVersion: params.protocolVersion,
        authMethods: [
          { id: 'oauth', name: 'OAuth' },
          { id: 'api-key', name: 'API key' },
        ],
      }))
      .onRequest(acp.methods.agent.authenticate, async ({ params }) => {
        authenticatedWith.resolve(params.methodId);
        return {};
      });
    agent.connect(
      acp.ndJsonStream(createStdinWritableStream(stdout), createStdoutReadableStream(stdin))
    );
    const methodsReceived = createDeferred<{ interactionId: string }>();
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => child) as never,
      resolveLoginShellEnv: async () => ({}),
    });
    const authentication = manager.authenticate({
      requestId: 'auth-method-choice',
      cliType: 'custom',
      agentType: 'custom-methods',
      customAcp: { command: '/test/custom-acp', args: [] },
      onProgress: (event) => {
        if (event.status === 'auth-methods') {
          expect(event.authMethods.map((method) => method.id)).toEqual(['oauth', 'api-key']);
          methodsReceived.resolve({ interactionId: event.interactionId });
        }
      },
    });

    const { interactionId } = await methodsReceived.promise;
    expect(
      manager.submitAuthenticationInput(
        'custom-methods',
        'auth-method-choice',
        interactionId,
        JSON.stringify({ action: 'accept', methodId: 'api-key' })
      )
    ).toEqual({ success: true, disposition: 'input-accepted' });
    await expect(authenticatedWith.promise).resolves.toBe('api-key');
    await expect(authentication).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
  });

  it('cancels a pending custom ACP elicitation and terminates its process', async () => {
    const child = createFakeChild();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    const agent = acp
      .agent({ name: 'test-cancel-auth-agent' })
      .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
        protocolVersion: params.protocolVersion,
        authMethods: [{ id: 'oauth', name: 'OAuth' }],
      }))
      .onRequest(acp.methods.agent.authenticate, async ({ client, requestId }) => {
        await client.request(acp.methods.client.elicitation.create, {
          mode: 'form',
          requestId,
          message: 'Waiting for input',
          requestedSchema: {
            type: 'object',
            properties: { token: { type: 'string', title: 'Token' } },
          },
        });
        return {};
      });
    agent.connect(
      acp.ndJsonStream(createStdinWritableStream(stdout), createStdoutReadableStream(stdin))
    );
    const inputReceived = createDeferred<void>();
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => child) as never,
      resolveLoginShellEnv: async () => ({}),
    });
    const authentication = manager.authenticate({
      requestId: 'auth-cancel-custom',
      cliType: 'custom',
      agentType: 'custom-cancel',
      customAcp: { command: '/test/custom-acp', args: [] },
      onProgress: (event) => {
        if (event.status === 'input-required') inputReceived.resolve();
      },
    });

    await inputReceived.promise;
    expect(manager.cancel('custom-cancel', 'auth-cancel-custom')).toEqual({
      success: true,
      disposition: 'cancelled',
    });
    await expect(authentication).resolves.toEqual({
      success: true,
      disposition: 'cancelled',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('bridges ACP URL consent without retaining authentication process output', async () => {
    const child = createFakeChild();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    const elicitationReply = createDeferred<acp.CreateElicitationResponse>();
    const agent = acp
      .agent({ name: 'test-url-auth-agent' })
      .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
        protocolVersion: params.protocolVersion,
        authMethods: [{ id: 'oauth', name: 'OAuth' }],
      }))
      .onRequest(acp.methods.agent.authenticate, async ({ client, requestId }) => {
        child.stderr?.write('authorization-code=must-not-cross-machine-rpc\n');
        const reply = await client.request(acp.methods.client.elicitation.create, {
          mode: 'url',
          requestId,
          elicitationId: 'oauth-url',
          message: 'Open the provider login page',
          url: 'https://provider.example.test/oauth',
        });
        elicitationReply.resolve(reply);
        return {};
      });
    agent.connect(
      acp.ndJsonStream(createStdinWritableStream(stdout), createStdoutReadableStream(stdin))
    );

    const authorizationReceived = createDeferred<{ interactionId: string }>();
    const progress = vi.fn((event: { status: string; interactionId?: string }) => {
      if (event.status === 'authorization' && event.interactionId) {
        authorizationReceived.resolve({ interactionId: event.interactionId });
      }
    });
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => child) as never,
      resolveLoginShellEnv: async () => ({}),
    });
    const authentication = manager.authenticate({
      requestId: 'auth-url',
      cliType: 'custom',
      agentType: 'custom-url',
      customAcp: { command: '/test/custom-acp', args: [] },
      onProgress: progress,
    });

    const { interactionId } = await authorizationReceived.promise;
    expect(
      manager.submitAuthenticationInput(
        'custom-url',
        'auth-url',
        interactionId,
        JSON.stringify({ action: 'accept' })
      )
    ).toEqual({ success: true, disposition: 'input-accepted' });
    await expect(elicitationReply.promise).resolves.toEqual({ action: 'accept' });
    await expect(authentication).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'authorization',
        authorizationUrl: 'https://provider.example.test/oauth',
        requiresAuthorizationConsent: true,
      })
    );
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'output' }));
  });

  it('declines non-HTTP ACP authorization URLs without forwarding them to the renderer', async () => {
    const child = createFakeChild();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    const elicitationReply = createDeferred<acp.CreateElicitationResponse>();
    const agent = acp
      .agent({ name: 'test-unsafe-url-auth-agent' })
      .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
        protocolVersion: params.protocolVersion,
        authMethods: [{ id: 'oauth', name: 'OAuth' }],
      }))
      .onRequest(acp.methods.agent.authenticate, async ({ client, requestId }) => {
        const reply = await client.request(acp.methods.client.elicitation.create, {
          mode: 'url',
          requestId,
          elicitationId: 'unsafe-url',
          message: 'Open this page',
          url: 'javascript:alert(1)',
        });
        elicitationReply.resolve(reply);
        return {};
      });
    agent.connect(
      acp.ndJsonStream(createStdinWritableStream(stdout), createStdoutReadableStream(stdin))
    );
    const progress = vi.fn();
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => child) as never,
      resolveLoginShellEnv: async () => ({}),
    });

    const authentication = manager.authenticate({
      requestId: 'auth-unsafe-url',
      cliType: 'custom',
      agentType: 'custom-unsafe-url',
      customAcp: { command: '/test/custom-acp', args: [] },
      onProgress: progress,
    });

    await expect(elicitationReply.promise).resolves.toEqual({ action: 'decline' });
    await expect(authentication).resolves.toEqual(
      expect.objectContaining({
        success: false,
        disposition: 'error',
        error: expect.stringContaining('unsafe authentication URL'),
      })
    );
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'authorization' }));
  });

  it('does not forward an oversized fallback authorization URL from ACP stderr', async () => {
    const child = createFakeChild();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = new PassThrough();
    const authorizationUrl = `https://provider.example.test/oauth?state=${'x'.repeat(
      ACP_AUTHORIZATION_URL_MAX_LENGTH
    )}`;
    expect(authorizationUrl.length).toBeGreaterThan(ACP_AUTHORIZATION_URL_MAX_LENGTH);
    const agent = acp
      .agent({ name: 'test-oversized-stderr-url-agent' })
      .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
        protocolVersion: params.protocolVersion,
        authMethods: [{ id: 'oauth', name: 'OAuth' }],
      }))
      .onRequest(acp.methods.agent.authenticate, async () => {
        child.stderr?.write(`Open ${authorizationUrl}\n`);
        return {};
      });
    agent.connect(
      acp.ndJsonStream(createStdinWritableStream(stdout), createStdoutReadableStream(stdin))
    );
    const progress = vi.fn();
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => child) as never,
      resolveLoginShellEnv: async () => ({}),
    });

    await expect(
      manager.authenticate({
        requestId: 'auth-oversized-stderr-url',
        cliType: 'custom',
        agentType: 'custom-oversized-stderr-url',
        customAcp: { command: '/test/custom-acp', args: [] },
        onProgress: progress,
      })
    ).resolves.toEqual({ success: true, disposition: 'authenticated' });
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'authorization' }));
  });

  it.each([
    {
      method: { id: 'legacy-env', name: 'Legacy environment', type: 'env_var' as const },
      expected: 'only advertised the deprecated ACP env_var authentication method',
    },
    {
      method: { id: 'terminal', name: 'Terminal login', type: 'terminal' as const },
      expected: 'only advertised terminal authentication',
    },
  ])(
    'rejects unsupported $method.type ACP authentication methods',
    async ({ method, expected }) => {
      const child = createFakeChild();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = new PassThrough();
      const initialize = vi.fn(async ({ params }: { params: acp.InitializeRequest }) => ({
        protocolVersion: params.protocolVersion,
        authMethods: [method],
      }));
      const agent = acp
        .agent({ name: 'test-unsupported-auth-agent' })
        .onRequest(acp.methods.agent.initialize, initialize);
      agent.connect(
        acp.ndJsonStream(createStdinWritableStream(stdout), createStdoutReadableStream(stdin))
      );
      const manager = new AcpAuthenticationManager(createSilentLogger(), {
        spawnProcess: vi.fn(() => child) as never,
        resolveLoginShellEnv: async () => ({}),
      });

      const result = await manager.authenticate({
        requestId: `auth-${method.id}`,
        cliType: 'custom',
        agentType: 'custom-unsupported',
        customAcp: { command: '/test/custom-acp', args: [] },
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          disposition: 'error',
          error: expect.stringContaining(expected),
        })
      );
      expect(initialize.mock.calls[0]?.[0].params.clientCapabilities.auth).toEqual({
        terminal: false,
      });
    }
  );

  it.each([
    {
      name: 'field type',
      expectedError: 'text, secret, and single-select',
      requestedSchema: {
        type: 'object' as const,
        properties: { attempts: { type: 'number' as const, title: 'Attempts' } },
      },
    },
    {
      name: 'empty field id',
      expectedError: 'text, secret, and single-select',
      requestedSchema: {
        type: 'object' as const,
        properties: { '': { type: 'string' as const, title: 'Token' } },
      },
    },
    {
      name: 'serialized size',
      expectedError: '256 KiB limit',
      requestedSchema: {
        type: 'object' as const,
        properties: {
          account: {
            type: 'string' as const,
            title: 'Account',
            enum: Array.from(
              { length: 20 },
              (_, index) => `${String(index).padStart(2, '0')}-${'x'.repeat(16_380)}`
            ),
          },
        },
      },
    },
  ])(
    'reports and declines an unsupported ACP form $name',
    async ({ requestedSchema, expectedError }) => {
      const child = createFakeChild();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = new PassThrough();
      const elicitationReply = createDeferred<acp.CreateElicitationResponse>();
      const agent = acp
        .agent({ name: 'test-unsupported-form-agent' })
        .onRequest(acp.methods.agent.initialize, async ({ params }) => ({
          protocolVersion: params.protocolVersion,
          authMethods: [{ id: 'oauth', name: 'OAuth' }],
        }))
        .onRequest(acp.methods.agent.authenticate, async ({ client, requestId }) => {
          const reply = await client.request(acp.methods.client.elicitation.create, {
            mode: 'form',
            requestId,
            message: 'Unsupported form',
            requestedSchema,
          });
          elicitationReply.resolve(reply);
          return {};
        });
      agent.connect(
        acp.ndJsonStream(createStdinWritableStream(stdout), createStdoutReadableStream(stdin))
      );
      const progress = vi.fn();
      const manager = new AcpAuthenticationManager(createSilentLogger(), {
        spawnProcess: vi.fn(() => child) as never,
        resolveLoginShellEnv: async () => ({}),
      });

      const authentication = manager.authenticate({
        requestId: 'auth-unsupported-form',
        cliType: 'custom',
        agentType: 'custom-form',
        customAcp: { command: '/test/custom-acp', args: [] },
        onProgress: progress,
      });

      await expect(elicitationReply.promise).resolves.toEqual({ action: 'decline' });
      await expect(authentication).resolves.toEqual(
        expect.objectContaining({
          success: false,
          disposition: 'error',
          error: expect.stringContaining('unsupported authentication form'),
        })
      );
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          error: expect.stringContaining(expectedError),
        })
      );
    }
  );
});

describe('probeBuiltinAuthentication', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('recognizes an authenticated Claude credential store', async () => {
    const child = createFakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      return child;
    });

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        runtimeOverrides: { claudeCodeExecutable: '/test/claude' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      })
    ).resolves.toEqual({ status: 'authenticated' });
    expect(spawnProcess).toHaveBeenCalledWith(
      '/test/claude',
      ['auth', 'status', '--json'],
      expect.objectContaining({ stdio: 'ignore' })
    );
  });

  it('leaves Codex authentication requirements to the ACP adapter', async () => {
    const spawnProcess = vi.fn();

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: { codexPath: '/test/codex' },
        env: { CODEX_API_KEY: '', OPENAI_API_KEY: '' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      })
    ).resolves.toEqual({ status: 'unknown' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('returns the Claude subscription method when local credentials are missing', async () => {
    const child = createFakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
      return child;
    });

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        runtimeOverrides: { claudeCodeExecutable: '/test/claude' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      })
    ).resolves.toMatchObject({
      status: 'unauthenticated',
      authMethods: [
        expect.objectContaining({ id: 'claude-ai-login', name: 'Claude subscription' }),
      ],
    });
  });

  it.each(['CODEX_API_KEY', 'OPENAI_API_KEY'])(
    'defers to Codex ACP when %s is set',
    async (key) => {
      const spawnProcess = vi.fn();

      await expect(
        probeBuiltinAuthentication({
          cliType: 'builtin',
          agentType: 'codex',
          runtimeOverrides: { codexPath: '/test/codex' },
          env: { [key]: 'test-key' },
          logger: createSilentLogger(),
          spawnProcess: spawnProcess as never,
          resolveLoginShellEnv: async () => ({}),
        })
      ).resolves.toEqual({ status: 'unknown' });
      expect(spawnProcess).not.toHaveBeenCalled();
    }
  );

  it.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ])('defers to Claude ACP when %s is set', async (key) => {
    const spawnProcess = vi.fn();

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        runtimeOverrides: { claudeCodeExecutable: '/test/claude' },
        env: { [key]: 'configured' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      })
    ).resolves.toEqual({ status: 'unknown' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('detects API-key authentication inherited from the login shell', async () => {
    const spawnProcess = vi.fn();

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: { codexPath: '/test/codex' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({ OPENAI_API_KEY: 'shell-key' }),
      })
    ).resolves.toEqual({ status: 'unknown' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('leaves Kimi credential detection to the ACP adapter', async () => {
    const spawnProcess = vi.fn();

    await expect(
      probeBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'kimi',
        runtimeOverrides: { kimiPath: '/test/kimi' },
        logger: createSilentLogger(),
        spawnProcess: spawnProcess as never,
      })
    ).resolves.toEqual({ status: 'unknown' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

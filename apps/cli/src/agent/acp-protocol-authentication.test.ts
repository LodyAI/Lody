import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@/utils/logger';
import { AcpAuthenticationManager } from './acp-authentication';

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

type JsonRpcRequest = { id: number; method: string; params?: Record<string, unknown> };

/**
 * A registry/custom ACP agent, driven straight on the ndjson wire so the test
 * exercises the same JSON-RPC exchange a real agent would answer.
 */
function createFakeAcpAgent(options: {
  authMethods: unknown[];
  authenticateResult?: { error: { code: number; message: string } } | Record<string, unknown>;
  stderr?: string;
}) {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.exitCode = null;
  child.pid = undefined;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => {
    if (child.exitCode === null) {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
    }
    return true;
  });

  const requests: JsonRpcRequest[] = [];
  let buffer = '';
  const write = (message: Record<string, unknown>): void => {
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  stdin.on('data', (chunk: Buffer) => {
    buffer += String(chunk);
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (!line) continue;
      const request = JSON.parse(line) as JsonRpcRequest;
      requests.push(request);
      if (request.method === 'initialize') {
        write({
          id: request.id,
          result: {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {},
            authMethods: options.authMethods,
          },
        });
        if (options.stderr) stderr.write(options.stderr);
      } else if (request.method === 'authenticate') {
        const result = options.authenticateResult ?? {};
        write('error' in result ? { id: request.id, ...result } : { id: request.id, result });
      }
    }
  });

  return { child, requests };
}

const spawnedEnvs: NodeJS.ProcessEnv[] = [];

const authenticateCustomAgent = async (
  agent: { child: ChildProcess },
  overrides: { methodId?: string } = {}
) => {
  const manager = new AcpAuthenticationManager(createSilentLogger(), {
    spawnProcess: vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        spawnedEnvs.push(options.env);
        return agent.child;
      }
    ) as never,
    resolveLoginShellEnv: async () => ({}),
  });
  return await manager.authenticate({
    requestId: 'auth-custom',
    cliType: 'custom',
    agentType: 'antigravity-acp',
    customAcp: { command: '/test/agy_acp_server.par', args: [] },
    ...overrides,
  });
};

describe('ACP protocol authentication', () => {
  const originalTerm = process.env.TERM;

  afterEach(() => {
    spawnedEnvs.length = 0;
    if (originalTerm === undefined) delete process.env.TERM;
    else process.env.TERM = originalTerm;
    vi.restoreAllMocks();
  });

  it('runs initialize then authenticate for a single advertised method', async () => {
    const agent = createFakeAcpAgent({
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
    });

    await expect(authenticateCustomAgent(agent)).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
    expect(agent.requests.map((request) => request.method)).toEqual(['initialize', 'authenticate']);
    expect(agent.requests[1]?.params).toEqual({ methodId: 'oauth-personal' });
  });

  it('asks the user to choose when the agent advertises several methods', async () => {
    const agent = createFakeAcpAgent({
      authMethods: [
        { id: 'oauth-personal', name: 'Log in with Google' },
        { id: 'gemini-api-key', name: 'Gemini API key', description: 'Use an API key' },
      ],
    });

    await expect(authenticateCustomAgent(agent)).resolves.toEqual({
      success: true,
      disposition: 'method-required',
      authMethods: [
        { type: 'agent', id: 'oauth-personal', name: 'Log in with Google' },
        {
          type: 'agent',
          id: 'gemini-api-key',
          name: 'Gemini API key',
          description: 'Use an API key',
        },
      ],
    });
    // Nothing is signed into until the user picks.
    expect(agent.requests.map((request) => request.method)).toEqual(['initialize']);
  });

  it('authenticates with the method the user picked', async () => {
    const agent = createFakeAcpAgent({
      authMethods: [
        { id: 'oauth-personal', name: 'Log in with Google' },
        { id: 'gemini-api-key', name: 'Gemini API key' },
      ],
    });

    await expect(authenticateCustomAgent(agent, { methodId: 'gemini-api-key' })).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
    expect(agent.requests[1]?.params).toEqual({ methodId: 'gemini-api-key' });
  });

  it('reports the agent error when authenticate is rejected', async () => {
    const agent = createFakeAcpAgent({
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
      authenticateResult: { error: { code: -32603, message: 'Browser flow was declined' } },
    });

    await expect(authenticateCustomAgent(agent)).resolves.toMatchObject({
      success: false,
      disposition: 'error',
      error: expect.stringContaining('Browser flow was declined'),
    });
  });

  it('names the variables to set when the method is environment based', async () => {
    const agent = createFakeAcpAgent({
      authMethods: [
        {
          type: 'env_var',
          id: 'api-key',
          name: 'API key',
          vars: [{ name: 'ANTIGRAVITY_API_KEY' }],
        },
      ],
    });

    await expect(authenticateCustomAgent(agent)).resolves.toMatchObject({
      success: false,
      disposition: 'error',
      error: expect.stringContaining('ANTIGRAVITY_API_KEY'),
    });
    expect(agent.requests.map((request) => request.method)).toEqual(['initialize']);
  });

  it('explains that no sign-in exists when the agent advertises no method', async () => {
    const agent = createFakeAcpAgent({ authMethods: [] });

    await expect(authenticateCustomAgent(agent)).resolves.toMatchObject({
      success: false,
      disposition: 'error',
      error: expect.stringContaining('does not advertise an authentication method'),
    });
  });

  it('does not let the agent render a terminal browser onto the protocol channel', async () => {
    const agent = createFakeAcpAgent({
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
    });
    process.env.TERM = 'xterm-256color';

    await expect(authenticateCustomAgent(agent)).resolves.toEqual({
      success: true,
      disposition: 'authenticated',
    });
    // With TERM set and no display, a browser sign-in falls back to w3m/lynx,
    // which renders the consent page onto stdout — and one rendered empty form
    // field, `[    ]`, parses as a JSON-RPC batch and closes the connection.
    expect(spawnedEnvs).toHaveLength(1);
    expect(spawnedEnvs[0]).not.toHaveProperty('TERM');
  });

  it('surfaces an authorization URL the agent prints instead of opening', async () => {
    const agent = createFakeAcpAgent({
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
      stderr:
        'Open this URL to continue: https://accounts.google.com/o/oauth2/auth?client_id=test\n',
    });
    const progress = vi.fn();
    const manager = new AcpAuthenticationManager(createSilentLogger(), {
      spawnProcess: vi.fn(() => agent.child) as never,
      resolveLoginShellEnv: async () => ({}),
    });

    await expect(
      manager.authenticate({
        requestId: 'auth-custom',
        cliType: 'custom',
        agentType: 'antigravity-acp',
        customAcp: { command: '/test/agy_acp_server.par', args: [] },
        onProgress: progress,
      })
    ).resolves.toEqual({ success: true, disposition: 'authenticated' });
    expect(progress).toHaveBeenCalledWith({
      status: 'authorization',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=test',
    });
  });
});

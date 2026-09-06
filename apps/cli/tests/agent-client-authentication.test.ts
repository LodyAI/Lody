import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, SessionId } from '@lody/shared';
import type { AuthMethod, InitializeResponse, NewSessionResponse } from '@agentclientprotocol/sdk';

const connectionMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  newSession: vi.fn(),
  loadSession: vi.fn(),
  resumeSession: vi.fn(),
  request: vi.fn(),
}));

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentclientprotocol/sdk')>();
  return {
    ...actual,
    ClientSideConnection: class MockClientSideConnection {
      initialize = connectionMocks.initialize;
      newSession = connectionMocks.newSession;
      loadSession = connectionMocks.loadSession;
      resumeSession = connectionMocks.resumeSession;
      request = connectionMocks.request;
    },
  };
});

import {
  AcpAuthenticationRequiredError,
  AcpTimeoutError,
  AgentClient,
} from '../src/agent/agent-client';
import { isAccountHandoffResumeUnavailable } from '../src/session/acp-error-classification';
import type { Logger } from '../src/utils/logger';

const terminalAuthMethod: AuthMethod = {
  id: 'kimi-login',
  name: 'Sign in to Kimi',
  description: 'Authenticate in the terminal',
  type: 'terminal',
  args: ['--login'],
};

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

function createClient(agentType = 'kimi'): AgentClient {
  return new AgentClient({
    sessionId: 'agent-client-auth-test' as SessionId,
    logger: createSilentLogger(),
    terminalManager: {} as never,
    agentConfig: { cliType: 'builtin', agentType },
    onUpdateMessage: vi.fn(),
    onRequestPermission: vi.fn(async () => ({
      outcome: { outcome: 'cancelled' as const },
    })),
  });
}

function initializeResponse(): InitializeResponse {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
    },
    authMethods: [terminalAuthMethod],
  } as InitializeResponse;
}

describe('AgentClient Kimi authentication and resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionMocks.initialize.mockResolvedValue(initializeResponse());
    connectionMocks.newSession.mockResolvedValue({
      sessionId: 'new-session',
    } satisfies NewSessionResponse);
    connectionMocks.loadSession.mockResolvedValue({});
    connectionMocks.resumeSession.mockResolvedValue({});
    connectionMocks.request.mockResolvedValue({});
  });

  it('retains terminal auth methods and surfaces -32000 as a structured error', async () => {
    const protocolError = Object.assign(new Error('Authentication required'), { code: -32000 });
    connectionMocks.newSession.mockRejectedValue(protocolError);
    const client = createClient();

    const rejection = await client.startSession({} as never, '/tmp').catch((error) => error);

    expect(rejection).toBeInstanceOf(AcpAuthenticationRequiredError);
    expect(rejection).toMatchObject({
      code: -32000,
      data: { authMethods: [terminalAuthMethod] },
    });
    expect(client.getAuthMethods()).toEqual([terminalAuthMethod]);
    expect(client.isAuthenticationRequired()).toBe(true);
    expect(connectionMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: expect.objectContaining({
          terminal: true,
          auth: { terminal: true },
        }),
      })
    );
  });

  it('uses resumeSession instead of loadSession for builtin Kimi', async () => {
    const client = createClient();

    const response = await client.startSession({} as never, '/tmp', 'existing-session' as never);

    expect(connectionMocks.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'existing-session' })
    );
    expect(connectionMocks.loadSession).not.toHaveBeenCalled();
    expect(response.sessionId).toBe('existing-session');
  });

  it('keeps loadSession preference for other builtin agents', async () => {
    const client = createClient('claude');

    await client.startSession({} as never, '/tmp', 'existing-session' as never);

    expect(connectionMocks.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'existing-session' })
    );
    expect(connectionMocks.resumeSession).not.toHaveBeenCalled();
  });

  it.each(['claude', 'kimi'])(
    'requires a definitive native-resume rejection through the actual %s client wrapper',
    async (agentType) => {
      const operation =
        agentType === 'claude' ? connectionMocks.loadSession : connectionMocks.resumeSession;
      const failures = [
        { cause: new AcpTimeoutError('resume', 25, 'test-session'), unavailable: false },
        { cause: new Error('ACP connection closed'), unavailable: false },
        { cause: new Error('provider process crashed'), unavailable: false },
        { cause: new DOMException('Startup cancelled', 'AbortError'), unavailable: false },
        { cause: Object.assign(new Error('Internal error'), { code: -32603 }), unavailable: false },
        {
          cause: Object.assign(new Error('Resource not found'), {
            code: -32002,
            data: { path: 'config.toml' },
          }),
          unavailable: false,
        },
        {
          cause: Object.assign(new Error('Resource not found'), {
            code: -32002,
            data: { uri: 'native-session' },
          }),
          unavailable: false,
        },
        { cause: Object.assign(new Error('Process exited'), { code: 1001 }), unavailable: false },
        {
          cause: Object.assign(new Error('Method not found'), { code: -32601 }),
          unavailable: true,
        },
        {
          cause: Object.assign(new Error('Internal error'), {
            code: -32603,
            data: { details: 'Session not found' },
          }),
          unavailable: true,
        },
      ];
      for (const { cause, unavailable } of failures) {
        operation.mockRejectedValueOnce(cause);
        const failure: unknown = await createClient(agentType)
          .startSession({} as never, '/tmp', 'existing-session' as never)
          .catch((error: unknown) => error);
        expect(failure).toMatchObject({
          message: expect.stringContaining('[ACP_RESUME_FAILED]'),
          cause,
        });
        expect(isAccountHandoffResumeUnavailable(failure)).toBe(unavailable);
      }
      expect(connectionMocks.newSession).not.toHaveBeenCalled();
    }
  );

  it('lets builtin Grok use its local terminal runner', async () => {
    const client = createClient('grok');

    await client.startSession({} as never, '/tmp');

    expect(connectionMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: expect.objectContaining({
          terminal: false,
          auth: { terminal: true },
        }),
      })
    );
  });

  it('negotiates legacy model state into a session/set_model request', async () => {
    connectionMocks.newSession.mockResolvedValue({
      sessionId: 'legacy-session',
      models: {
        currentModelId: 'grok-4.5',
        availableModels: [
          { modelId: 'grok-4.5', name: 'Grok 4.5' },
          { modelId: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
        ],
      },
    } as unknown as NewSessionResponse);
    const client = createClient('grok');

    const response = await client.startSession({} as never, '/tmp');
    expect(client.currentModel).toEqual({ modelId: 'grok-4.5', name: 'Grok 4.5' });

    await client.unstable_setSessionModel(
      response.sessionId as unknown as ACPSessionId,
      'grok-code-fast-1'
    );

    expect(connectionMocks.request).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'legacy-session',
      modelId: 'grok-code-fast-1',
    });
    expect(client.currentModel).toEqual({
      modelId: 'grok-code-fast-1',
      name: 'Grok Code Fast 1',
    });
  });
});

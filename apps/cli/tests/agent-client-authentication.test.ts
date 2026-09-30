import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_MCP_APP_MAX_RESPONSE_BYTES,
  type ACPSessionId,
  type AcpSessionNotification,
  type SessionId,
} from '@lody/shared';
import type { AuthMethod, InitializeResponse, NewSessionResponse } from '@agentclientprotocol/sdk';

const connectionMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  newSession: vi.fn(),
  loadSession: vi.fn(),
  resumeSession: vi.fn(),
  request: vi.fn(),
  abort: new AbortController(),
}));

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentclientprotocol/sdk')>();
  return {
    ...actual,
    ClientSideConnection: class MockClientSideConnection {
      signal = connectionMocks.abort.signal;
      initialize = connectionMocks.initialize;
      newSession = connectionMocks.newSession;
      loadSession = connectionMocks.loadSession;
      resumeSession = connectionMocks.resumeSession;
      request = connectionMocks.request;
    },
  };
});

import { AcpAuthenticationRequiredError, AgentClient } from '../src/agent/agent-client';
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
  trace: () => {},
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
    connectionMocks.abort = new AbortController();
    connectionMocks.initialize.mockResolvedValue(initializeResponse());
    connectionMocks.newSession.mockResolvedValue({
      sessionId: 'new-session',
    } satisfies NewSessionResponse);
    connectionMocks.loadSession.mockResolvedValue({});
    connectionMocks.resumeSession.mockResolvedValue({});
    connectionMocks.request.mockResolvedValue({});
  });

  it('marks live child observations unknown on transport loss and refuses orphan permissions', async () => {
    const notifications: AcpSessionNotification[] = [];
    const client = new AgentClient({
      sessionId: 'test' as SessionId,
      logger: createSilentLogger(),
      terminalManager: {} as never,
      onUpdateMessage: (event) => notifications.push(event),
      onRequestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
    });
    connectionMocks.initialize.mockResolvedValue({
      ...initializeResponse(),
      agentCapabilities: { _meta: { lody: { subagentEvents: { version: 1 } } } },
    });
    await client.startSession({} as never, '/tmp');
    const request = {
      sessionId: 'new-session',
      _meta: { lody: { subagentRunId: 'child' } },
      toolCall: { toolCallId: 'child-tool' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as const }],
    };
    expect(await client.requestPermission(request)).toEqual({ outcome: { outcome: 'cancelled' } });
    const snapshot = {
      name: 'Research',
      parentRunId: null,
      support: { stream: ['text'], progress: false, outputRead: 'none', cancel: false },
    };
    for (const state of ['completed', 'running']) {
      await client.extNotification?.('_lody/subagents/event', {
        version: 1,
        sessionId: 'new-session',
        runId: 'finished-child',
        type: 'snapshot',
        snapshot: { ...snapshot, state },
      });
    }
    expect(
      await client.requestPermission({
        ...request,
        _meta: { lody: { subagentRunId: 'finished-child' } },
      })
    ).toEqual({ outcome: { outcome: 'cancelled' } });
    await client.extNotification?.('_lody/subagents/event', {
      version: 1,
      sessionId: 'new-session',
      runId: 'child',
      type: 'snapshot',
      snapshot: {
        state: 'running',
        name: 'Research',
        parentRunId: null,
        support: { stream: ['text'], progress: false, outputRead: 'none', cancel: false },
      },
    });
    expect(await client.requestPermission(request)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    connectionMocks.abort.abort();
    const last = notifications.at(-1);
    expect(last).toMatchObject({
      update: {
        sessionUpdate: 'subagent_event',
        event: {
          runId: 'child',
          type: 'snapshot',
          snapshot: {
            state: 'unknown',
            name: 'Research',
            outputIncomplete: true,
            reason: { code: 'disconnected' },
          },
        },
      },
    });
    expect(await client.requestPermission(request)).toEqual({ outcome: { outcome: 'cancelled' } });
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

  it('advertises the Devin subagent capability only to the devin agent', async () => {
    await createClient('devin').startSession({} as never, '/tmp');

    expect(connectionMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: expect.objectContaining({
          _meta: {
            'cognition.ai/subagentSupport': true,
            lody: {
              elicitation: { version: 1, answerNotes: true },
              subagentEvents: { version: 1 },
              mcpApps: { version: 1 },
            },
          },
        }),
      })
    );

    connectionMocks.initialize.mockClear();
    await createClient('claude').startSession({} as never, '/tmp');

    const capabilities = connectionMocks.initialize.mock.calls[0]?.[0]?.clientCapabilities;
    expect(capabilities._meta).not.toHaveProperty('cognition.ai/subagentSupport');
    expect(capabilities).toMatchObject({
      elicitation: { form: {} },
      _meta: { lody: { elicitation: { version: 1, answerNotes: true } } },
    });
  });

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

describe('AgentClient MCP App bridge', () => {
  const target = { sessionId: 'lody-session', toolCallId: 'call-1', userId: 'user-1' } as const;
  const agentRequests: Array<{ method: string; params: unknown }> = [];

  const startClient = async (agentLody: Record<string, unknown>, reply: () => unknown) => {
    vi.clearAllMocks();
    agentRequests.length = 0;
    connectionMocks.abort = new AbortController();
    connectionMocks.initialize.mockResolvedValue({
      ...initializeResponse(),
      agentCapabilities: { _meta: { lody: agentLody } },
    });
    connectionMocks.newSession.mockResolvedValue({ sessionId: 'acp-session' });
    connectionMocks.request.mockImplementation(async (method: string, params: unknown) => {
      agentRequests.push({ method, params });
      return reply();
    });
    const client = createClient('codex');
    await client.startSession({} as never, '/tmp');
    return client;
  };
  const failure = (code: string) => ({
    type: 'session/mcp-app_response',
    sessionId: 'lody-session',
    toolCallId: 'call-1',
    ok: false,
    code,
    error: expect.any(String),
  });

  it('reports an agent without the mcpApps capability as unavailable', async () => {
    const client = await startClient({}, () => ({}));

    await expect(client.requestMcpApp({ op: 'load', ...target })).resolves.toEqual(
      failure('MCP_APP_UNAVAILABLE')
    );
    expect(agentRequests).toEqual([]);
  });

  it('forwards each op to the agent session and returns the validated result', async () => {
    const loaded = {
      app: { version: 1, server: 'apps', tool: 'graph', resourceUri: 'ui://apps/graph' },
      toolInput: { query: 'x' },
      toolResult: { content: [{ type: 'text', text: 'done' }] },
    };
    const client = await startClient({ mcpApps: { version: 1 } }, () => loaded);

    await expect(client.requestMcpApp({ op: 'load', ...target })).resolves.toEqual({
      type: 'session/mcp-app_response',
      sessionId: 'lody-session',
      toolCallId: 'call-1',
      ok: true,
      result: loaded,
    });
    await client.requestMcpApp({ op: 'resource_read', ...target, uri: 'ui://apps/graph' });
    await client.requestMcpApp({
      op: 'tool_call',
      ...target,
      name: 'expand',
      arguments: { id: 7 },
    });

    // The agent only ever sees its own session id, never the Lody user or session.
    expect(agentRequests).toEqual([
      { method: '_lody/mcp_apps/load', params: { sessionId: 'acp-session', toolCallId: 'call-1' } },
      {
        method: '_lody/mcp_apps/resource/read',
        params: { sessionId: 'acp-session', toolCallId: 'call-1', uri: 'ui://apps/graph' },
      },
      {
        method: '_lody/mcp_apps/tool/call',
        params: {
          sessionId: 'acp-session',
          toolCallId: 'call-1',
          name: 'expand',
          arguments: { id: 7 },
        },
      },
    ]);
  });

  it('serves an app document as large as a real MCP App once JSON-escaped', async () => {
    // Same raw size as a real app's single-file HTML; quotes and newlines grow it when escaped.
    const chunk = 'a="b";\n';
    const html = chunk.repeat(Math.ceil(7_091_831 / chunk.length));
    const contents = [
      { uri: 'ui://apps/graph', mimeType: 'text/html;profile=mcp-app', text: html },
    ];
    const client = await startClient({ mcpApps: { version: 1 } }, () => ({ contents }));

    const response = await client.requestMcpApp({
      op: 'resource_read',
      ...target,
      uri: 'ui://apps/graph',
    });

    expect(Buffer.byteLength(JSON.stringify(contents))).toBeGreaterThan(8 * 1024 * 1024);
    expect(response).toMatchObject({ ok: true, result: { contents } });
  });

  it.each([
    [
      'an agent error',
      () => {
        throw new Error('Tool is not visible to apps');
      },
      'MCP_APP_AGENT_ERROR',
    ],
    ['a malformed agent result', () => ({ content: 'not-a-list' }), 'MCP_APP_AGENT_ERROR'],
    [
      'an oversized agent result',
      () => ({ content: [{ type: 'text', text: 'x'.repeat(SESSION_MCP_APP_MAX_RESPONSE_BYTES) }] }),
      'MCP_APP_RESPONSE_TOO_LARGE',
    ],
  ])('turns %s into a typed failure', async (_label, reply, code) => {
    const client = await startClient({ mcpApps: { version: 1 } }, reply);

    await expect(
      client.requestMcpApp({ op: 'tool_call', ...target, name: 'expand' })
    ).resolves.toEqual(failure(code));
  });
});

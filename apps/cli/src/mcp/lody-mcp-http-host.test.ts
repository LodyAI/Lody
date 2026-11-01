import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import * as scheduleCommands from '@/lib/schedules/schedule-command-client';
import { __lodyMcpServerInternals } from './lody-mcp-server';
import { createMcpHttpServer } from './lody-mcp-http-host';
import {
  MCP_HTTP_MACHINE_ID_HEADER,
  MCP_HTTP_SESSION_ID_HEADER,
  MCP_HTTP_WORKDIR_B64_HEADER,
  MCP_HTTP_WORKSPACE_ID_HEADER,
} from './lody-mcp-http-protocol';

/**
 * Wire-level contract of the MCP HTTP host, driven the way Grok's Rust `rmcp`
 * client drives it. That client reports a never-completing response as a
 * transport failure rather than as an MCP error, so every request must reach a
 * terminated response — including the ones the host refuses to serve.
 */

const TOKEN = 'test-token-0123456789abcdef';

const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => NOOP_LOGGER,
  close: async () => {},
};

/** Grok/rmcp sends both media types on every request. */
const ACCEPT = 'application/json, text/event-stream';

const sessionContextHeaders = (): Record<string, string> => ({
  [MCP_HTTP_SESSION_ID_HEADER]: 'session-under-test',
  [MCP_HTTP_WORKSPACE_ID_HEADER]: 'workspace-under-test',
  [MCP_HTTP_MACHINE_ID_HEADER]: 'machine-under-test',
  [MCP_HTTP_WORKDIR_B64_HEADER]: Buffer.from('/tmp/workdir', 'utf8').toString('base64url'),
});

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'rmcp-like', version: '0.1.0' },
  },
});

const modernRequest = (id: number, method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  });

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('MCP HTTP host wire behavior', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createMcpHttpServer(TOKEN, NOOP_LOGGER);
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('did not bind a TCP port'));
          return;
        }
        resolve(address.port);
      });
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    vi.restoreAllMocks();
  });

  const callTool = (
    version: string,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    abort?: AbortSignal
  ) => {
    const params = { name, arguments: args };
    return fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: ACCEPT,
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'mcp-protocol-version': version,
        'mcp-method': 'tools/call',
        'mcp-name': name,
        ...sessionContextHeaders(),
        [MCP_HTTP_SESSION_ID_HEADER]: sessionId,
        [MCP_HTTP_WORKSPACE_ID_HEADER]: `workspace-${sessionId}`,
        [MCP_HTTP_MACHINE_ID_HEADER]: `machine-${sessionId}`,
        [MCP_HTTP_WORKDIR_B64_HEADER]: Buffer.from(`/tmp/${sessionId}`).toString('base64url'),
      },
      body:
        version === '2026-07-28'
          ? modernRequest(10, 'tools/call', params)
          : JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params }),
      signal: abort,
    });
  };

  it.each(['2025-06-18', '2026-07-28'])(
    'isolates concurrent contexts and survives an aborted %s request',
    async (version) => {
      const startedA = signal();
      const startedB = signal();
      const releaseA = signal();
      const releaseB = signal();
      const finishedA = signal();
      vi.spyOn(scheduleCommands, 'sendDaemonScheduleCommand').mockImplementation(
        async (command, target) => {
          const before = __lodyMcpServerInternals.getSessionContext();
          if (target.requesterSessionId === 'session-a') {
            startedA.resolve();
            await releaseA.promise;
            finishedA.resolve();
          } else if (target.requesterSessionId === 'session-b') {
            startedB.resolve();
            await releaseB.promise;
          }
          return { command, target, before, after: __lodyMcpServerInternals.getSessionContext() };
        }
      );
      const abort = new AbortController();
      const requestA = callTool(version, 'session-a', 'lody_schedule_list', {}, abort.signal);
      // Observe rejection immediately so an abort never becomes unhandled.
      const aborted = expect(requestA).rejects.toMatchObject({ name: 'AbortError' });
      try {
        await startedA.promise;
        const requestB = callTool(version, 'session-b', 'lody_schedule_list', { query: 'second' });
        await startedB.promise;
        abort.abort();
        await aborted;
        // Request close does not establish completion of uncooperative raw work.
        releaseA.resolve();
        await finishedA.promise;
        releaseB.resolve();
        const response = await requestB;
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.result.isError).not.toBe(true);
        const context = {
          sessionId: 'session-b',
          workspaceId: 'workspace-session-b',
          machineId: 'machine-session-b',
          workdir: '/tmp/session-b',
        };
        expect(JSON.parse(payload.result.content[0].text)).toMatchObject({
          command: { action: 'list', query: 'second', limit: 30 },
          target: {
            requesterSessionId: 'session-b',
            workspaceId: context.workspaceId,
            machineId: context.machineId,
          },
          before: context,
          after: context,
        });
        const next = await callTool(version, 'session-c', 'lody_schedule_propose', {
          requestId: 'proposal-c',
          title: '  Trimmed title  ',
          prompt: 'Synthetic task',
          rule: { kind: 'manual' },
        });
        const nextPayload = await next.json();
        expect(nextPayload.result.isError).not.toBe(true);
        expect(JSON.parse(nextPayload.result.content[0].text)).toMatchObject({
          command: { action: 'propose', title: 'Trimmed title', rule: { kind: 'manual' } },
          before: { sessionId: 'session-c' },
          after: { sessionId: 'session-c' },
        });
      } finally {
        abort.abort();
        releaseA.resolve();
        releaseB.resolve();
        await aborted;
      }
    }
  );

  it.each(['2025-06-18', '2026-07-28'])(
    'retains shared schema validation on the %s wire',
    async (version) => {
      const cases: [string, Record<string, unknown>][] = [
        ['lody_schedule_list', { limit: 0 }],
        ['lody_schedule_get', { scheduleId: 'bad/id' }],
        ['lody_schedule_pause', { scheduleId: 'valid', requestId: '' }],
        [
          'lody_schedule_propose',
          { requestId: 'valid', title: '   ', prompt: 'task', rule: { kind: 'manual' } },
        ],
        ['lody_agent_config_get', { id: '  ' }],
        ['lody_agent_role_get', { id: 'valid', unexpected: true }],
        ['lody_session_share', { requestId: 'valid', purpose: 'share', workspaceId: 'other' }],
        ['lody_operation_batch_get', { batchId: 'not-a-uuid' }],
      ];
      for (const [name, args] of cases) {
        const response = await callTool(version, 'validation-session', name, args);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          result: {
            isError: true,
            content: [
              expect.objectContaining({
                type: 'text',
                text: expect.stringContaining('Input validation error'),
              }),
            ],
          },
        });
      }
    }
  );

  it('answers a Grok-shaped initialize with a JSON-RPC result', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: ACCEPT,
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        ...sessionContextHeaders(),
      },
      body: INITIALIZE_BODY,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const payload = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result?: { serverInfo?: { name?: string } };
      error?: unknown;
    };
    expect(payload.error).toBeUndefined();
    expect(payload.jsonrpc).toBe('2.0');
    expect(payload.id).toBe(1);
    expect(payload.result?.serverInfo?.name).toBe('lody');
  });

  it('discovers the modern revision and lists tools without initialize', async () => {
    const headers = {
      accept: ACCEPT,
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': '2026-07-28',
      ...sessionContextHeaders(),
    };
    const discover = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'mcp-method': 'server/discover' },
      body: modernRequest(1, 'server/discover'),
    });
    expect(discover.status).toBe(200);
    expect(await discover.json()).toMatchObject({
      id: 1,
      result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
      },
    });

    const list = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'mcp-method': 'tools/list' },
      body: modernRequest(2, 'tools/list'),
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      result: {
        resultType: 'complete',
        tools: expect.arrayContaining([expect.objectContaining({ name: 'lody_feedback' })]),
      },
    });
  });

  it.each(['2025-06-18', '2025-11-25'])(
    'keeps %s tool results in the legacy wire shape',
    async (version) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          accept: ACCEPT,
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'mcp-protocol-version': version,
          ...sessionContextHeaders(),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toMatchObject({
        result: {
          tools: expect.arrayContaining([expect.objectContaining({ name: 'lody_feedback' })]),
        },
      });
      expect(payload.result).not.toHaveProperty('resultType');
    }
  );

  it('returns a modern tool validation error without executing the tool', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: ACCEPT,
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'lody_feedback',
        ...sessionContextHeaders(),
      },
      body: modernRequest(5, 'tools/call', { name: 'lody_feedback', arguments: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 5,
      result: {
        resultType: 'complete',
        isError: true,
        content: [
          expect.objectContaining({ type: 'text', text: expect.stringContaining('feedback') }),
        ],
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'lody', version: '0.1.0' } },
      },
    });
  });

  it('rejects a mismatched modern method header before dispatch', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: ACCEPT,
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
        ...sessionContextHeaders(),
      },
      body: modernRequest(3, 'tools/call', { name: 'lody_feedback', arguments: {} }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      id: 3,
      error: { code: -32020 },
    });
  });

  it('rejects GET with 405 instead of holding a stream open', async () => {
    // Awaiting the response IS the assertion: handed to the SDK, this request
    // becomes an SSE stream that never ends and this line never returns.
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        accept: ACCEPT,
        authorization: `Bearer ${TOKEN}`,
        ...sessionContextHeaders(),
      },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    await response.arrayBuffer();
  });

  it('answers 400 when the session context headers are missing', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: ACCEPT,
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: INITIALIZE_BODY,
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: { message?: string } };
    expect(payload.error?.message).toContain('session context headers');
  });

  it('answers 401 for a bad bearer token', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: ACCEPT,
        'content-type': 'application/json',
        authorization: 'Bearer not-the-token',
        ...sessionContextHeaders(),
      },
      body: INITIALIZE_BODY,
    });

    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error?: { message?: string } };
    expect(payload.error?.message).toBe('Unauthorized');
  });
});

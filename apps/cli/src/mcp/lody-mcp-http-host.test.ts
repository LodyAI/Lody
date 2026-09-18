import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@/utils/logger';
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
  });

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

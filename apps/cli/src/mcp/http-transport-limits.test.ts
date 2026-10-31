import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

describe('MCP HTTP body and batch limits', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const pending = closers.splice(0);
    for (const close of pending) {
      await close();
    }
  });

  async function startHost() {
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = new McpServer({ name: 'limit-probe', version: '0.0.0' });
    await mcp.connect(transport);
    const server = http.createServer((req, res) => {
      void transport.handleRequest(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('MCP limit probe did not bind a TCP port');
    }
    closers.push(async () => {
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
      await transport.close();
      await mcp.close();
    });
    return address.port;
  }

  function post(port: number, body: Buffer, contentLength = body.byteLength) {
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'content-length': String(contentLength),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('rejects a declared body over 4 MiB before parsing JSON-RPC', async () => {
    const port = await startHost();
    const response = await post(port, Buffer.from('{}'), MAX_BODY_BYTES + 1);
    expect(response.status).toBe(413);
    expect(response.text).toContain('Payload Too Large');
  });

  it('rejects a JSON-RPC batch longer than 100 messages', async () => {
    const port = await startHost();
    const body = Buffer.from(
      JSON.stringify(
        Array.from({ length: 101 }, (_, id) => ({
          jsonrpc: '2.0',
          id,
          method: 'ping',
        }))
      )
    );
    const response = await post(port, body);
    expect(response.status).toBe(400);
    expect(response.text).toContain('Batch must not exceed 100');
  });

  it('lets a small single JSON-RPC message through the size and batch gates', async () => {
    const port = await startHost();
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    const response = await post(port, body);
    expect(response.status).not.toBe(413);
    expect(response.text).not.toContain('Payload Too Large');
    expect(response.text).not.toContain('Batch must not exceed');
  });
});

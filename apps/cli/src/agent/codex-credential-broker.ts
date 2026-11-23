import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { normalizeCodexEndpoint } from '@lody/shared';

export type CodexCredentialBroker = {
  baseUrl: string;
  capability: string;
  close(): Promise<void>;
};

/** The native client's redirect policy must never receive the upstream credential. */
export async function startCodexCredentialBroker(options: {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<CodexCredentialBroker> {
  const upstream = normalizeCodexEndpoint(options.baseUrl);
  const capability = randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${capability}`);
  const controller = new AbortController();
  const forward = options.fetch ?? fetch;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end();
      return;
    }
    const allowed =
      (request.method === 'POST' &&
        (request.url === '/responses' || request.url === '/responses/compact')) ||
      (request.method === 'GET' && request.url === '/models');
    if (!allowed) {
      response.writeHead(404).end();
      return;
    }
    const aborted = new AbortController();
    const abort = () => aborted.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    response.once('close', abort);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      };
      for (const name of ['accept', 'content-encoding', 'openai-beta', 'x-codex-turn-state']) {
        const value = request.headers[name];
        if (typeof value === 'string' && value.length <= 4096) headers[name] = value;
      }
      // No incoming Host, provider-specific auth headers, cookies, or redirect policy is forwarded.
      const result = await forward(`${upstream}${request.url}`, {
        method: request.method,
        headers,
        body: request.method === 'POST' ? request : undefined,
        duplex: 'half',
        redirect: 'error',
        signal: aborted.signal,
      } as RequestInit);
      if (!result.ok) {
        await result.body?.cancel();
        response
          .writeHead(result.status >= 400 && result.status < 600 ? result.status : 502, {
            'content-type': 'application/json',
          })
          .end('{"error":{"message":"Codex endpoint rejected the request"}}');
        return;
      }
      const responseHeaders: Record<string, string> = {
        'content-type': result.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      };
      for (const name of ['x-codex-turn-state', 'x-request-id', 'openai-processing-ms']) {
        const value = result.headers.get(name);
        if (value && value.length <= 4096) responseHeaders[name] = value;
      }
      response.writeHead(result.status, responseHeaders);
      if (result.body) await pipeline(Readable.fromWeb(result.body as never), response);
      else response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"Codex endpoint request failed"}}');
    } finally {
      controller.signal.removeEventListener('abort', abort);
      response.removeListener('close', abort);
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => response.destroy());
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Codex endpoint bridge could not start');
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      controller.abort();
      server.close(() => resolve());
      server.closeAllConnections();
      options.signal?.removeEventListener('abort', onAbort);
    }));
  const onAbort = () => {
    void close();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) await close();
  return { baseUrl: `http://127.0.0.1:${address.port}`, capability, close };
}

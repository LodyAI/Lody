import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { SessionId } from '@lody/shared';
import { DEFAULT_RUNTIME_ARTIFACTS_BASE_URL } from '@lody/platform';
import {
  CLOUDFLARED_MANIFEST,
  ensureCloudflaredBinary,
} from '../../src/preview/cloudflared-binary';
import { QuickTunnelSession } from '../../src/preview/quick-tunnel-session';
import { startCloudflaredProcess } from '../../src/preview/cloudflared-process';
import { getCliHttpFetch, resetCliHttpTransportForTests } from '../../src/utils/http-transport';
import { createLogger } from '../../src/utils/logger';

// Deliberately separate from deterministic tests: allocates a real public tunnel
// exposing only this synthetic loopback fixture, never a project or user service.
describe.skipIf(process.env.LODY_QUICK_TUNNEL_E2E !== '1')('real Quick Tunnel transport', () => {
  it('forwards HTTP and binary WebSocket, rejects anonymous access, and preserves the dev server on close', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-quick-e2e-'));
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end(request.url);
    });
    const wsServer = new WebSocketServer({ server });
    wsServer.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
    });
    let session: QuickTunnelSession | undefined;
    let socket: WebSocket | undefined;
    const deadline = setTimeout(() => session?.cancel('session_ended'), 90_000);
    const fetcher = getCliHttpFetch();
    const upstream = process.env.LODY_QUICK_TUNNEL_E2E_USE_UPSTREAM === '1';
    try {
      const workerPath = join(rootDir, 'cloudflared-worker.mjs');
      await build({
        entryPoints: [
          fileURLToPath(new URL('../../src/preview/cloudflared-worker.ts', import.meta.url)),
        ],
        outfile: workerPath,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing synthetic server port');
      session = new QuickTunnelSession({
        sessionId: 'quick-tunnel-network-fixture' as SessionId,
        target: {
          protocol: 'http',
          host: '127.0.0.1',
          port: address.port,
          path: '/fixture?raw&x=1',
        },
        runtimeBaseUrl: DEFAULT_RUNTIME_ARTIFACTS_BASE_URL,
        now: () => Date.now(),
        logger: createLogger({ level: 'silent', transports: 'console' }),
        start: (options) => startCloudflaredProcess({ ...options, workerPath }),
        download: (options) =>
          ensureCloudflaredBinary({
            ...options,
            rootDir,
            // An explicit upstream-only test, not a runtime fallback. Both paths
            // pass the production manifest/hash/install verification.
            fetch: upstream
              ? (_url, init) => {
                  const artifact =
                    CLOUDFLARED_MANIFEST.artifacts[`${process.platform}-${process.arch}`];
                  if (!artifact) throw new Error('Unsupported smoke platform');
                  return fetcher(
                    `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_MANIFEST.version}/${artifact.fileName}`,
                    init
                  );
                }
              : fetcher,
          }),
      });
      const endpoint = await session.ready;
      const url = new URL(endpoint.viewerUrl);
      const page = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
      expect(page.status).toBe(200);
      expect(await page.text()).toBe('/fixture?raw&x=1');
      const anonymous = await fetcher(url.origin, { signal: AbortSignal.timeout(10_000) });
      expect(anonymous.status).toBe(403);
      await anonymous.body?.cancel();
      url.protocol = 'wss:';
      socket = new WebSocket(url, ['lody-quick-smoke'], { handshakeTimeout: 10_000 });
      await once(socket, 'open');
      expect(socket.protocol).toBe('lody-quick-smoke');
      const echoed = once(socket, 'message', { signal: AbortSignal.timeout(10_000) });
      const binary = Buffer.from([0, 1, 127, 128, 255]);
      socket.send(binary);
      const [data, isBinary] = await echoed;
      expect(isBinary).toBe(true);
      expect(data).toEqual(binary);
      await session.checkHealth();
      expect(session.active).toBe(true);
      const closed = once(socket, 'close', { signal: AbortSignal.timeout(10_000) });
      await session.close('revoked');
      await closed;
      expect(session.active).toBe(false);
      expect(await (await fetch(`http://127.0.0.1:${address.port}/still-local`)).text()).toBe(
        '/still-local'
      );
    } finally {
      socket?.terminate();
      try {
        await session?.close('session_ended');
      } finally {
        clearTimeout(deadline);
        for (const client of wsServer.clients) client.terminate();
        wsServer.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
        await resetCliHttpTransportForTests();
        await rm(rootDir, { recursive: true });
      }
    }
  }, 120_000);
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ local: false, userData: '' }));
vi.mock('../../../apps/electron/node_modules/electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => fixture.userData },
}));
vi.mock('../../../apps/electron/src/main/platform', () => ({
  isLocalPlatform: () => fixture.local,
}));
let server: Server;
let bodies: unknown[];
beforeEach(async () => {
  vi.resetModules();
  fixture.local = false;
  fixture.userData = await mkdtemp(join(tmpdir(), 'lody-telemetry-main-'));
  bodies = [];
  server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      bodies.push(
        JSON.parse(
          (request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString()
        )
      );
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    })().catch((error: Error) => response.destroy(error));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  vi.stubEnv('VITE_PUBLIC_POSTHOG_KEY', 'synthetic-key');
  vi.stubEnv('VITE_PUBLIC_POSTHOG_HOST', `http://127.0.0.1:${address.port}`);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(fixture.userData, { recursive: true, force: true });
});
it('sends a redacted main exception through the real SDK', async () => {
  const { captureElectronMainException } =
    await import('../../../apps/electron/src/main/posthog-error-reporting');
  await captureElectronMainException(new Error('PRIVATE_MESSAGE'), {
    component: 'PRIVATE_COMPONENT',
    extra: { error_code: 'forbidden', nested: { path: 'PRIVATE_PATH' } },
  });
  expect(bodies.length).toBeGreaterThan(0);
  expect(JSON.stringify(bodies)).toContain('forbidden');
  expect(JSON.stringify(bodies)).not.toContain('PRIVATE_');
});
it('keeps local main telemetry and its install-id file disabled', async () => {
  fixture.local = true;
  const { captureElectronMainException } =
    await import('../../../apps/electron/src/main/posthog-error-reporting');
  await captureElectronMainException(new Error('PRIVATE_LOCAL'));
  expect(bodies).toEqual([]);
  expect(await readdir(fixture.userData)).toEqual([]);
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';

vi.mock('../src/utils/const', () => ({ getSystemMachineId: () => 'synthetic-machine' }));
const analytics = vi.hoisted(() => ({
  captureCli: vi.fn(),
  flushCliAnalytics: vi.fn(async () => {}),
}));
vi.mock('../src/lib/analytics/posthog', () => analytics);
const originalEnv = { ...process.env };
let server: Server;
let bodies: unknown[];

describe('CLI exception ingestion using the real SDK', () => {
  beforeEach(async () => {
    vi.resetModules();
    bodies = [];
    server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        bodies.push(
          JSON.parse(
            (request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString()
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
    process.env.LODY_ENV = 'production';
    process.env.LODY_PLATFORM = 'cloud';
    process.env.LODY_POSTHOG_KEY = 'synthetic-key';
    process.env.POSTHOG_HOST = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    process.env = { ...originalEnv };
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it('sends only the fixed error vocabulary, excluding original errors and extra fields', async () => {
    const { captureException, isErrorReportingEnabled } = await import('../src/instrument');
    expect(isErrorReportingEnabled()).toBe(true);
    await captureException(new Error('PRIVATE_ATTACHMENT_NAME'), {
      component: 'PRIVATE_PATH',
      extra: { error_code: 'e2ee_feature_unavailable', nested: { path: 'PRIVATE_CODE' } },
    });
    expect(bodies.length).toBeGreaterThan(0);
    const wire = JSON.stringify(bodies);
    expect(wire).not.toContain('PRIVATE_');
    expect(wire).toContain('e2ee_feature_unavailable');
    expect(wire).toContain('$exception');
    await captureException('OTHER_PRIVATE_ERROR', {
      extra: { error_code: 'PRIVATE_UNRECOGNIZED_CODE' },
    });
    expect(JSON.stringify(bodies)).not.toContain('PRIVATE_');
    expect(JSON.stringify(bodies)).toContain('redacted_exception');
  });

  it('keeps local OSS telemetry disabled despite inherited cloud variables', async () => {
    process.env.LODY_PLATFORM = 'local';
    const { captureException, isErrorReportingEnabled } = await import('../src/instrument');
    expect(isErrorReportingEnabled()).toBe(false);
    await captureException(new Error('PRIVATE_LOCAL'));
    expect(bodies).toEqual([]);
  });

  it('keeps development telemetry disabled', async () => {
    process.env.LODY_ENV = 'dev';
    const { captureException, isErrorReportingEnabled } = await import('../src/instrument');
    expect(isErrorReportingEnabled()).toBe(false);
    await captureException(new Error('PRIVATE_DEV'));
    expect(bodies).toEqual([]);
  });
});

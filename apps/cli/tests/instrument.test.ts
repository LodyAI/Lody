import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';

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
    process.env.LODY_DATA_DIR = await mkdtemp(join(tmpdir(), 'lody-sharing-'));
    delete process.env.LODY_ELECTRON_BOOTSTRAP;
    delete process.env.LODY_REQUIRE_USAGE_SHARING_CHOICE;
    process.env.LODY_ENV = 'production';
    process.env.LODY_PLATFORM = 'cloud';
    process.env.LODY_POSTHOG_KEY = 'synthetic-key';
    process.env.POSTHOG_HOST = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await rm(process.env.LODY_DATA_DIR!, { recursive: true, force: true });
    process.env = { ...originalEnv };
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it('is enabled by default on cloud CLI and honors unified account usage sharing opt-out', async () => {
    const { syncAccountUsageSharing, writeUsageSharing } =
      await import('@lody/shared/node/usage-sharing');
    const { captureCli, initCliAnalytics, flushCliAnalytics } =
      await import('../src/lib/analytics/posthog');
    const { captureException, isErrorReportingEnabled } = await import('../src/instrument');
    initCliAnalytics();
    expect(isErrorReportingEnabled()).toBe(true);

    captureCli('app/active');
    syncAccountUsageSharing(false);
    expect(isErrorReportingEnabled()).toBe(false);
    await captureException(new Error('off'));
    captureCli('cli/diagnostic');
    await flushCliAnalytics();
    expect(bodies).toEqual([]);

    writeUsageSharing(true);
    expect(isErrorReportingEnabled()).toBe(true);
    captureCli('app/launch');
    await flushCliAnalytics();
    expect(bodies).toMatchObject([{ batch: [{ event: 'app/launch' }] }]);
  });

  it('sends only the fixed error vocabulary, excluding original errors and extra fields', async () => {
    const { writeUsageSharing } = await import('@lody/shared/node/usage-sharing');
    writeUsageSharing(true);
    const { captureException, isErrorReportingEnabled } = await import('../src/instrument');
    expect(isErrorReportingEnabled()).toBe(true);
    await captureException(new TypeError('PRIVATE_ATTACHMENT_NAME'), {
      component: 'PRIVATE_PATH',
      extra: { error_code: 'e2ee_feature_unavailable', nested: { path: 'PRIVATE_CODE' } },
    });
    expect(bodies.length).toBeGreaterThan(0);
    const wire = JSON.stringify(bodies);
    expect(wire).not.toContain('PRIVATE_');
    expect(wire).toContain('e2ee_feature_unavailable');
    expect(wire).toContain('$exception');
    expect(wire).toContain('TypeError');
    expect(wire).not.toContain('machine_id');
    await captureException('OTHER_PRIVATE_ERROR', {
      extra: { error_code: 'PRIVATE_UNRECOGNIZED_CODE' },
    });
    expect(JSON.stringify(bodies)).not.toContain('PRIVATE_');
    expect(JSON.stringify(bodies)).toContain('redacted_exception');
  });

  it('strips machine, command and error details from real CLI batches while retaining normalized agent provider', async () => {
    const { writeUsageSharing } = await import('@lody/shared/node/usage-sharing');
    writeUsageSharing(true);
    const { initCliAnalytics, captureCli, flushCliAnalytics } =
      await import('../src/lib/analytics/posthog');
    initCliAnalytics();
    captureCli('managed_runtime/install_failed', { error_message: 'PRIVATE_DROPPED_EVENT' });
    captureCli(
      'acp/agent_config_used',
      {
        machine_id: 'PRIVATE_MACHINE',
        error_message: 'PRIVATE_PATH',
        cli_type: 'builtin',
        agent_type: 'codex',
        nested: { command: 'PRIVATE_COMMAND' },
      },
      { tier: 'A', distinctId: 'PRIVATE_OVERRIDE' }
    );
    captureCli(
      'acp/agent_config_used',
      {
        cli_type: 'custom',
        agent_type: 'PRIVATE_CUSTOM_AGENT',
      },
      { tier: 'A' }
    );
    await flushCliAnalytics();
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies)).not.toContain('PRIVATE_');
    expect(bodies[0]).toMatchObject({
      batch: [
        {
          event: 'acp/agent_config_used',
          properties: {
            $lib: 'lody-cli',
            $process_person_profile: false,
            platform: 'cli',
            cli_type: 'builtin',
            agent_type: 'codex',
          },
        },
        {
          event: 'acp/agent_config_used',
          properties: {
            $lib: 'lody-cli',
            $process_person_profile: false,
            platform: 'cli',
            cli_type: 'custom',
            agent_type: 'other',
          },
        },
      ],
    });
  });

  it('honors DO_NOT_TRACK=1 for standalone cloud CLI telemetry', async () => {
    process.env.DO_NOT_TRACK = '1';
    const { syncAccountUsageSharing } = await import('@lody/shared/node/usage-sharing');
    syncAccountUsageSharing(true);
    const { initCliAnalytics, captureCli, flushCliAnalytics } =
      await import('../src/lib/analytics/posthog');
    const { captureException, isErrorReportingEnabled } = await import('../src/instrument');
    initCliAnalytics();
    expect(isErrorReportingEnabled()).toBe(false);
    captureCli('app/launch', {}, { tier: 'A' });
    await captureException(new Error('PRIVATE_DNT'));
    await flushCliAnalytics();
    expect(bodies).toEqual([]);
  });

  it('keeps local OSS telemetry disabled despite inherited cloud variables', async () => {
    process.env.LODY_PLATFORM = 'local';
    const { captureException, isErrorReportingEnabled } = await import('../src/instrument');
    expect(isErrorReportingEnabled()).toBe(false);
    await captureException(new Error('PRIVATE_LOCAL'));
    expect(bodies).toEqual([]);
  });

  it('keeps development telemetry disabled', async () => {
    process.env.LODY_DATA_DIR = await mkdtemp(join(tmpdir(), 'lody-sharing-'));
    process.env.LODY_ENV = 'dev';
    const { captureException, isErrorReportingEnabled } = await import('../src/instrument');
    expect(isErrorReportingEnabled()).toBe(false);
    await captureException(new Error('PRIVATE_DEV'));
    expect(bodies).toEqual([]);
  });
});

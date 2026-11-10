import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireLocalCliHostLease,
  inspectLocalCliHost,
  requestLocalCliHostShutdown,
  type LocalCliHostEndpoint,
  type LocalCliHostLease,
} from '../src/node/local-cli-host-lease';

const leases: LocalCliHostLease[] = [];
const require = createRequire(import.meta.url);

async function createEndpoint(): Promise<LocalCliHostEndpoint> {
  if (process.platform === 'win32') {
    return { kind: 'pipe', path: `\\\\.\\pipe\\lody-host-test-${randomUUID()}` };
  }
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { kind: 'tcp', host: '127.0.0.1', port: address.port };
}

afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.close();
});

describe('local CLI host lease', () => {
  it('uses the kernel endpoint bind as the single-owner boundary', async () => {
    const endpoint = await createEndpoint();
    const contenders = await Promise.all([
      acquireLocalCliHostLease({ endpoint, instanceId: 'a', mode: 'electron' }),
      acquireLocalCliHostLease({ endpoint, instanceId: 'b', mode: 'daemon' }),
    ]);
    const acquired = contenders.filter((result) => result.status === 'acquired');
    const occupied = contenders.filter((result) => result.status === 'occupied');

    expect(acquired).toHaveLength(1);
    expect(occupied).toHaveLength(1);
    if (acquired[0]?.status === 'acquired') leases.push(acquired[0].lease);
  });

  it.runIf(process.platform !== 'win32')(
    'keeps serving after a health probe resets its accepted socket',
    async () => {
      const endpoint = await createEndpoint();
      if (endpoint.kind !== 'tcp') throw new Error('Expected a TCP test endpoint');
      const result = await acquireLocalCliHostLease({
        endpoint,
        instanceId: 'reset-survivor',
        mode: 'electron',
      });
      expect(result.status).toBe('acquired');
      if (result.status !== 'acquired') return;
      leases.push(result.lease);

      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
      await new Promise<void>((resolve, reject) => {
        socket.once('data', () => {
          socket.resetAndDestroy();
          resolve();
        });
        socket.once('error', reject);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      await expect(inspectLocalCliHost(endpoint)).resolves.toMatchObject({
        instanceId: 'reset-survivor',
      });
    }
  );

  it('authenticates daemon shutdown control without exposing the token', async () => {
    const endpoint = await createEndpoint();
    const onRequest = vi.fn();
    const result = await acquireLocalCliHostLease({
      endpoint,
      instanceId: 'daemon-a',
      mode: 'daemon',
      shutdownControl: { token: 'secret-token', onRequest },
    });
    expect(result.status).toBe('acquired');
    if (result.status !== 'acquired') return;
    leases.push(result.lease);

    await expect(
      requestLocalCliHostShutdown({ endpoint, instanceId: 'daemon-a', token: 'wrong-token' })
    ).resolves.toEqual({ ok: false, error: 'unauthorized' });
    expect(onRequest).not.toHaveBeenCalled();

    const accepted = await requestLocalCliHostShutdown({
      endpoint,
      instanceId: 'daemon-a',
      token: 'secret-token',
    });
    expect(accepted).toMatchObject({ ok: true, record: { instanceId: 'daemon-a' } });
    await Promise.resolve();
    expect(onRequest).toHaveBeenCalledOnce();
  });

  // Windows reports a pipe whose DACL refuses the caller (an elevated or
  // service-session Host) as EPERM; an unreadable Unix socket is the same
  // kernel refusal as EACCES. Root bypasses socket permissions.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'reports a Host whose endpoint refuses this process as access denied',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-host-denied-'));
      const socketPath = path.join(dir, 'host.sock');
      const foreign = net.createServer((socket) => socket.end('{}\n'));
      await new Promise<void>((resolve) => foreign.listen(socketPath, resolve));
      fs.chmodSync(socketPath, 0o000);
      try {
        const endpoint: LocalCliHostEndpoint = { kind: 'pipe', path: socketPath };
        await expect(
          acquireLocalCliHostLease({ endpoint, instanceId: 'desktop', mode: 'electron' })
        ).resolves.toEqual({ status: 'occupied', record: null, accessDenied: true });

        const commonJs =
          require('../src/node/local-cli-host-lease.cjs') as typeof import('../src/node/local-cli-host-lease');
        await expect(
          commonJs.acquireLocalCliHostLease({ endpoint, instanceId: 'desktop', mode: 'electron' })
        ).resolves.toEqual({ status: 'occupied', record: null, accessDenied: true });
      } finally {
        await new Promise<void>((resolve) => foreign.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

it('a managed update requires the exact private host capability and keeps the lease while preparation is pending', async () => {
  const { requestLocalCliHostUpgrade } = await import('../src/node/local-cli-host-lease');
  const endpoint = await createEndpoint();
  let releasePreparation: () => void = () => {};
  let observedRequest: string | undefined;
  const prepared = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const result = await acquireLocalCliHostLease({
    endpoint,
    instanceId: 'managed-service',
    mode: 'daemon',
    shutdownControl: {
      token: 'private-host-capability',
      onRequest: () => {},
      onUpgrade: async (request) => {
        observedRequest = request.requestId;
        await prepared;
      },
    },
  });
  expect(result.status).toBe('acquired');
  if (result.status !== 'acquired') return;
  leases.push(result.lease);
  const options = {
    endpoint,
    instanceId: 'managed-service',
    expectedMode: 'daemon' as const,
    requestId: 'upgrade-1',
    targetVersion: '1.2.3',
    upgrade: {
      protocol: 1 as const,
      channel: 'stable' as const,
      switchPolicy: 'when-idle' as const,
      confirmChannelChange: false,
      confirmDowngrade: false,
    },
  };
  expect(await requestLocalCliHostUpgrade({ ...options, token: 'wrong-token' })).toMatchObject({
    ok: false,
  });
  expect(observedRequest).toBeUndefined();
  const queued = requestLocalCliHostUpgrade({ ...options, token: 'private-host-capability' });
  expect(await inspectLocalCliHost(endpoint)).toMatchObject({ instanceId: 'managed-service' });
  const other = await acquireLocalCliHostLease({
    endpoint,
    instanceId: 'electron',
    mode: 'electron',
  });
  expect(other.status).toBe('occupied');
  releasePreparation();
  expect(await queued).toMatchObject({ ok: true });
  expect(observedRequest).toBe('upgrade-1');
});

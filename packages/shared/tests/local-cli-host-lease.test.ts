import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireLocalCliHostLease,
  getLocalCliHostEndpoint,
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
  it('keeps the CommonJS node export in parity with the ESM module', () => {
    const commonJs =
      require('../src/node/local-cli-host-lease.cjs') as typeof import('../src/node/local-cli-host-lease');

    expect(commonJs.getLocalCliHostEndpoint('cloud')).toEqual(getLocalCliHostEndpoint('cloud'));
    expect(commonJs.getLocalCliHostEndpoint('local')).toEqual(getLocalCliHostEndpoint('local'));
    expect(commonJs.acquireLocalCliHostLease).toBeTypeOf('function');
    expect(commonJs.requestLocalCliHostShutdown).toBeTypeOf('function');
  });

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

  it('releases ownership only after the listening endpoint is closed', async () => {
    const endpoint = await createEndpoint();
    const first = await acquireLocalCliHostLease({
      endpoint,
      instanceId: 'first',
      mode: 'electron',
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    await first.lease.close();
    const replacement = await acquireLocalCliHostLease({
      endpoint,
      instanceId: 'replacement',
      mode: 'daemon',
    });
    expect(replacement.status).toBe('acquired');
    if (replacement.status === 'acquired') leases.push(replacement.lease);
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
    let requested!: () => void;
    const requestHandled = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const onRequest = vi.fn(requested);
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
    for (const expectedOwner of [
      { instanceId: 'other-owner' },
      { expectedPid: process.pid + 1 },
      { expectedMode: 'electron' as const },
    ]) {
      await expect(
        requestLocalCliHostShutdown({
          endpoint,
          instanceId: 'daemon-a',
          token: 'secret-token',
          ...expectedOwner,
        })
      ).resolves.toEqual({ ok: false, error: 'owner_mismatch' });
    }
    expect(onRequest).not.toHaveBeenCalled();

    const accepted = await requestLocalCliHostShutdown({
      endpoint,
      instanceId: 'daemon-a',
      token: 'secret-token',
    });
    expect(accepted).toMatchObject({ ok: true, record: { instanceId: 'daemon-a' } });
    await requestHandled;
    expect(onRequest).toHaveBeenCalledOnce();
  });

  it.each(['esm', 'commonjs'])(
    'rejects malformed shutdown responses without throwing (%s)',
    async (implementation) => {
      const request =
        implementation === 'esm'
          ? requestLocalCliHostShutdown
          : (
              require('../src/node/local-cli-host-lease.cjs') as typeof import('../src/node/local-cli-host-lease')
            ).requestLocalCliHostShutdown;
      for (const response of ['null', '[]', '"unexpected"', 'not-json']) {
        const endpoint = await createEndpoint();
        const server = net.createServer((socket) => {
          socket.on('error', () => socket.destroy());
          socket.write(
            JSON.stringify({
              version: 1,
              instanceId: 'fake-owner',
              pid: process.pid,
              mode: 'daemon',
              startedAtMs: 1,
            }) + '\n'
          );
          socket.once('data', () => socket.end(response + '\n'));
        });
        await new Promise<void>((resolve) => {
          if (endpoint.kind === 'pipe') server.listen(endpoint.path, resolve);
          else server.listen(endpoint.port, endpoint.host, resolve);
        });
        try {
          await expect(
            request({ endpoint, instanceId: 'fake-owner', token: 'synthetic' })
          ).resolves.toEqual({ ok: false, error: 'invalid_response' });
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          );
        }
      }
    }
  );
});

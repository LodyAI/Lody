import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  npmMigrationTrust,
  prepareManagedRelease,
  readManagedOperation,
  readSelectedInstallation,
  saveManagedOperation,
  writeManagedRecord,
  verifyDaemonRelease,
  type DaemonRelease,
  type SeaContext,
} from './managed-daemon-release';
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = Buffer.from('synthetic Lody executable');
const compressed = gzipSync(bytes);
const artifact = {
  file: 'daemon.gz',
  size: compressed.length,
  sha256: digest(compressed),
  contentSize: bytes.length,
  contentSha256: digest(bytes),
};
const release: DaemonRelease = {
  format: 1,
  product: 'lody-oss',
  distribution: 'lody-oss-daemon',
  version: '1.2.3',
  channel: 'stable',
  platform: `${process.platform}-${process.arch}` as DaemonRelease['platform'],
  serviceProtocol: 1,
  dataFormat: 1,
  source: 'a'.repeat(40),
  payloadSha256: 'b'.repeat(64),
  nodeVersion: '26.13.0',
  capsule: artifact,
  node: { ...artifact, file: 'node.gz' },
};
const manifestJson = (value: unknown) => JSON.stringify(value);
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-release-test-'));
  dirs.push(dir);
  vi.stubEnv('LODY_DATA_DIR', dir);
  const context: SeaContext = {
    metadata: {
      format: 1,
      product: 'lody-oss',
      distribution: 'lody-oss-daemon',
      version: '1.2.2',
      channel: 'stable',
      platform: release.platform,
      serviceProtocol: 1,
      payloadSha256: 'c'.repeat(64),
      node: { sha256: artifact.contentSha256, size: bytes.length, version: '26.13.0' },
    },
    capsulePath: '/fixed/service',
    releaseDir: '/original/payload',
    nodePath: '/original/node',
  };
  return { dir, context };
}
describe('checksummed managed daemon installation', () => {
  it('rejects foreign-product, foreign-platform and incompatible releases before installation', () => {
    const trust = { product: 'lody-oss' as const };
    expect(verifyDaemonRelease(manifestJson(release), trust).version).toBe('1.2.3');
    expect(() =>
      verifyDaemonRelease(manifestJson({ ...release, product: 'lody-cloud' }), trust)
    ).toThrow(/mismatch/);
    expect(() =>
      verifyDaemonRelease(
        manifestJson({
          ...release,
          platform: process.platform === 'linux' ? 'darwin-arm64' : 'linux-x64',
        }),
        trust
      )
    ).toThrow(/mismatch/);
    expect(() => verifyDaemonRelease(manifestJson({ ...release, dataFormat: 2 }), trust)).toThrow();
  });
  it('prepares checksummed bytes without changing the current service or selection, and reuses the exact Node cache', async () => {
    const { dir, context } = await fixture();
    const downloads: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      downloads.push(url);
      return new Response(
        url.endsWith('.json') ? manifestJson(release) : new Uint8Array(compressed)
      );
    });
    const prepared = await prepareManagedRelease(context, '1.2.3');
    expect(await fs.readFile(prepared.capsule)).toEqual(bytes);
    expect(await readSelectedInstallation(context)).toMatchObject({
      version: '1.2.2',
      bin: '/original/payload/index.js',
    });
    await prepareManagedRelease(context, '1.2.3');
    expect(downloads.filter((url) => url.endsWith('/node.gz'))).toHaveLength(1);
    expect(await fs.readdir(dir)).toEqual(['daemon-managed']);
  });
  it('an npm daemon without a SEA context downloads only its own product and channel distribution', async () => {
    await fixture();
    const urls: string[] = [];
    const cloudNext = {
      ...release,
      product: 'lody-cloud',
      distribution: 'lody-cloud-next-daemon',
      channel: 'next',
    };
    let served: unknown = cloudNext;
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(
        url.endsWith('.json') ? manifestJson(served) : new Uint8Array(compressed)
      );
    });
    const trust = npmMigrationTrust('lody-cloud', 'next');
    const prepared = await prepareManagedRelease(trust, '1.2.3');
    expect(prepared.release.version).toBe('1.2.3');
    expect(urls[0]).toContain(`/api/runtimes/lody-cloud-next-daemon/1.2.3/${release.platform}/`);
    served = { ...cloudNext, distribution: 'lody-cloud-daemon' };
    await expect(prepareManagedRelease(trust, '1.2.3')).rejects.toThrow(/mismatch/);
  });
  it.each(['compressed', 'extracted'] as const)(
    'a bad %s SHA never publishes an executable or a successful update record',
    async (stage) => {
      const badRelease =
        stage === 'extracted'
          ? { ...release, capsule: { ...artifact, contentSha256: '0'.repeat(64) } }
          : release;
      const badCompressed = Buffer.from(compressed);
      badCompressed[10] ^= 1;
      const { dir, context } = await fixture();
      vi.stubGlobal(
        'fetch',
        async (url: string) =>
          new Response(
            url.endsWith('.json')
              ? manifestJson(badRelease)
              : new Uint8Array(stage === 'extracted' ? compressed : badCompressed)
          )
      );
      await expect(prepareManagedRelease(context, '1.2.3')).rejects.toThrow(
        stage === 'extracted'
          ? 'Daemon executable digest mismatch'
          : 'Daemon artifact digest mismatch'
      );
      await expect(fs.access(path.join(dir, 'daemon-managed', 'selected.json'))).rejects.toThrow();
      expect(await readManagedOperation()).toBeNull();
    }
  );
  it('preserves a durable unknown operation and refuses corrupt state instead of treating it as a fresh install', async () => {
    const { dir, context } = await fixture();
    const operation = {
      format: 1 as const,
      requestId: 'update-1',
      machineId: 'synthetic-machine',
      serviceInstanceId: 'synthetic-service',
      targetVersion: '1.2.3',
      releaseDigest: artifact.contentSha256,
      previousVersion: '1.2.2',
      requestedTarget: '1.2.3',
      phase: 'observing' as const,
    };
    await saveManagedOperation(operation);
    expect(await readManagedOperation()).toEqual(operation);
    await writeManagedRecord(path.join(dir, 'daemon-managed', 'selected.json'), {
      format: 1,
      digest: null,
    });
    expect(await readSelectedInstallation(context)).toMatchObject({
      version: '1.2.2',
      bin: '/original/payload/index.js',
    });
    await fs.writeFile(path.join(dir, 'daemon-managed', 'selected.json'), 'broken');
    await expect(readSelectedInstallation(context)).rejects.toThrow();
    await fs.writeFile(path.join(dir, 'daemon-managed', 'operation.json'), 'broken');
    await expect(readManagedOperation()).rejects.toThrow();
  });
});

it('resumes interrupted checksummed transfers by byte range without changing the old installation', async () => {
  const { context } = await fixture();
  let capsuleRequests = 0;
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url.endsWith('.json')) return new Response(manifestJson(release));
    if (!url.endsWith('/daemon.gz')) return new Response(new Uint8Array(compressed));
    if (++capsuleRequests === 1) {
      let pulls = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(new Uint8Array(compressed.subarray(0, 10)));
            else controller.error(new Error('synthetic interruption'));
          },
        })
      );
    }
    expect(options?.headers).toEqual({ Range: 'bytes=10-' });
    return new Response(new Uint8Array(compressed.subarray(10)), {
      status: 206,
      headers: { 'Content-Range': `bytes 10-${compressed.length - 1}/${compressed.length}` },
    });
  });
  const result = await prepareManagedRelease(context, '1.2.3');
  expect(await fs.readFile(result.capsule)).toEqual(bytes);
  expect(await readSelectedInstallation(context)).toMatchObject({ version: '1.2.2' });
});
it('keeps terminal operation IDs after later updates, so an old authorized request cannot replay', async () => {
  await fixture();
  const first = {
    format: 1 as const,
    requestId: 'first',
    machineId: 'synthetic-machine',
    serviceInstanceId: 'service',
    targetVersion: '1.2.3',
    previousVersion: '1.2.2',
    requestedTarget: '1.2.3',
    releaseDigest: 'a'.repeat(64),
    phase: 'applied' as const,
  };
  await saveManagedOperation(first);
  await saveManagedOperation({
    ...first,
    requestId: 'second',
    targetVersion: '1.2.4',
    requestedTarget: '1.2.4',
    releaseDigest: 'b'.repeat(64),
  });
  expect(await readManagedOperation('first')).toEqual(first);
  await expect(saveManagedOperation({ ...first, targetVersion: '9.9.9' })).rejects.toThrow(
    /immutable/
  );
  expect((await readManagedOperation())?.requestId).toBe('second');
});
it('bounds a manifest before parsing or retaining its entire response', async () => {
  const { context } = await fixture();
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(131073)));
  await expect(prepareManagedRelease(context, '1.2.3')).rejects.toThrow(/Oversized/);
  expect(await readManagedOperation()).toBeNull();
});

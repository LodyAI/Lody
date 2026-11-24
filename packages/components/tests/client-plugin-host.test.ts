import { expect, it } from 'vitest';
import { computeClientDigest, packClientBundle } from '@lody/shared/plugins/digest';
import { pluginManifestSchema } from '@lody/shared/plugins/manifest-schema';
import { VerifiedBundleCache } from '../src/plugins/bundle-cache';
import { TrustedDevSessionStore } from '../src/plugins/trust';
import { PluginQueryRegistry } from '../src/plugins/query-registry';
const manifest = pluginManifestSchema.parse({
  id: 'test-example',
  sdk: '^1.0.0',
  title: 'Example',
  version: '1.0.0',
  client: 'client.js',
});
it('retries a corrupt bundle, then shares immutable verified content across installations', async () => {
  const file = async () => new Uint8Array(270000).fill(7);
  const bytes = (await packClientBundle(manifest, file))!;
  const digest = (await computeClientDigest(manifest, file))!;
  const cache = new VerifiedBundleCache();
  const page = async (offset: number) => ({
    bytes: bytes.slice(offset, offset + 262144),
    totalBytes: bytes.length,
  });
  bytes[bytes.length - 1] = 8;
  await expect(cache.load(manifest.id, digest, page)).rejects.toThrow(/digest/i);
  bytes[bytes.length - 1] = 7;
  const read = await cache.load(manifest.id, digest, page);
  read('client.js').fill(0);
  expect(
    (
      await cache.load(manifest.id, digest, async () => {
        throw Error('unexpected transfer');
      })
    )('client.js')[1]
  ).toBe(7);
});
it('revokes a dev lease on escalation and never resurrects it on downgrade or nonce reuse', () => {
  const store = new TrustedDevSessionStore();
  const entry = {
    workspaceId: 'w',
    machineId: 'm',
    manifest,
    devMode: true,
    owner: true,
    devSessionNonce: 'a'.repeat(32),
  };
  store.grant(entry);
  expect(store.allows(entry)).toBe(true);
  expect(store.allows({ ...entry, manifest: { ...manifest, machine: 'machine.js' } })).toBe(false);
  expect(store.allows(entry)).toBe(false);
  store.grant(entry);
  expect(store.allows({ ...entry, devSessionNonce: 'b'.repeat(32) })).toBe(false);
  expect(store.allows(entry)).toBe(false);
});
it('aborts subscribed reads on installation replacement and fences late results', async () => {
  const owner = new AbortController();
  const registry = new PluginQueryRegistry(owner.signal);
  let readSignal: AbortSignal | undefined;
  const handle = registry.query('status', 'machine', 'm', {}, async (signal) => {
    readSignal = signal;
    return 42;
  });
  handle.subscribe(() => {});
  await Promise.resolve();
  owner.abort();
  expect(readSignal?.aborted).toBe(true);
  await Promise.resolve();
  expect(handle.getSnapshot().status).toBe('loading');
});

it('evaluates identical plugin bytes with independent top-level state and shared host imports', async () => {
  const { evaluateModule } = await import('../src/plugins/module-runtime');
  const signal = new AbortController().signal;
  let serial = 0;
  const released = new Set<string>();
  const url = (s: string) => 'data:text/javascript,' + encodeURIComponent(s) + '#' + ++serial;
  const dependency = url('export const shared={count:0}');
  const evaluate = () =>
    evaluateModule(
      `import {shared} from 'react'; let local=0; export default {kind:'client-plugin',register:()=>[++local,++shared.count]}`,
      signal,
      () => dependency,
      url,
      (s) => released.add(s)
    );
  const [a, b] = await Promise.all([evaluate(), evaluate()]);
  expect(a.register({} as never)).toEqual([1, 1]);
  expect(b.register({} as never)).toEqual([1, 2]);
  expect(a.register({} as never)).toEqual([2, 3]);
  expect(released.size).toBe(2);
});

it('safe-mode startup bypasses transfer and registration after the router replaces the query', async () => {
  const { vi } = await import('vitest');
  vi.resetModules();
  vi.stubGlobal('location', { search: '?safeMode=1' });
  try {
    const { ClientPluginHost } = await import('../src/plugins/client-host');
    const host = new ClientPluginHost();
    vi.stubGlobal('location', { search: '' });
    const key = { workspaceId: 'w', sourceKey: 'local' as const, pluginId: 'recovery-example' };
    await host.reconcile(key, {
      ...key,
      digest: '0'.repeat(64),
      client: 'client.js',
      page: async () => {
        throw Error('read bundle in safe mode');
      },
      registry: () => {
        throw Error('registered in safe mode');
      },
    });
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

it('bounds hot-reload history without invalidating assets on a still-mounted installation', async () => {
  async function revision(n: number) {
    const file = async () => Uint8Array.of(n);
    const bytes = (await packClientBundle(manifest, file))!;
    const digest = (await computeClientDigest(manifest, file))!;
    return { size: bytes.length, digest, page: async () => ({ bytes, totalBytes: bytes.length }) };
  }
  const [one, two] = await Promise.all([revision(1), revision(2)]);
  const cache = new VerifiedBundleCache(one.size);
  const active = await cache.load(manifest.id, one.digest, one.page);
  await cache.load(manifest.id, two.digest, two.page);
  expect(active('client.js')).toEqual(Uint8Array.of(1));
  await expect(
    cache.load(manifest.id, one.digest, async () => {
      throw Error('machine offline');
    })
  ).rejects.toThrow('machine offline');
});

it('can disable one installation during a shared transfer; the last disable cancels the transfer', async () => {
  const cache = new VerifiedBundleCache();
  const a = new AbortController();
  const b = new AbortController();
  let transfer: AbortSignal | undefined;
  const page = (_offset: number, signal: AbortSignal) => {
    transfer = signal;
    return new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    );
  };
  const first = cache.load(manifest.id, '0'.repeat(64), page, a.signal);
  const second = cache.load(manifest.id, '0'.repeat(64), page, b.signal);
  a.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(transfer?.aborted).toBe(false);
  b.abort();
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  expect(transfer?.aborted).toBe(true);
});

it('delivers declared audio and revokes only the disabled installation’s playback URLs', async () => {
  const { createPluginAssets } = await import('../src/plugins/assets');
  const one = new AbortController();
  const two = new AbortController();
  const declared = ['assets/cue.mp3'];
  const files = () => Uint8Array.of(1, 2, 3);
  const a = createPluginAssets(declared, files, one.signal);
  const b = createPluginAssets(declared, files, two.signal);
  try {
    const first = a.url('./assets/cue.mp3');
    const second = b.url('assets/cue.mp3');
    expect(first).toBe(a.url('assets/cue.mp3'));
    expect(() => a.url('client.js')).toThrow('Undeclared');
    one.abort();
    await expect(fetch(first)).rejects.toThrow();
    const response = await fetch(second);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(files());
  } finally {
    one.abort();
    two.abort();
  }
});

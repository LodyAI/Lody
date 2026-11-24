import { describe, it, expect } from 'vitest';
import { pluginManifestSchema } from '../src/plugins/manifest-schema';
import { hostToChildSchema, childToHostSchema } from '../src/plugins/ipc-protocol';
import {
  computeClientDigest,
  packClientBundle,
  receiveClientBundle,
  PLUGIN_BUNDLE_CHUNK_BYTES,
} from '../src/plugins/digest';
const manifest = {
  id: 'sample',
  sdk: '^1.0.0' as const,
  version: '1.0.0',
  title: 'Sample',
  machine: 'machine.js',
};
describe('plugin wire boundaries', () => {
  it('matches SDK ranges against the packaged host version', () => {
    for (const [sdk, expected] of [
      ['1.x', true],
      ['>=0.9 <1.1 || ^2', true],
      ['~1.0.1', false],
      ['not-semver', false],
    ] as const)
      expect(pluginManifestSchema.safeParse({ ...manifest, sdk }).success).toBe(expected);
  });
  it('normalizes package-relative fixture entries before digest or file reads', () => {
    expect(pluginManifestSchema.parse({ ...manifest, client: './client.tsx' }).client).toBe(
      'client.tsx'
    );
  });
  it('rejects client-readable secrets and paths outside custody', () => {
    for (const extra of [
      { config: { token: { type: 'secret', label: 'Token', scope: 'both' } } },
      { assets: ['../secret'] },
      { client: 'C:\\secret' },
    ])
      expect(pluginManifestSchema.safeParse({ ...manifest, ...extra }).success).toBe(false);
  });
  it('rejects malformed or reversed completion messages', () => {
    const result = { type: 'result', callId: '1', ok: true, data: null };
    expect(childToHostSchema.safeParse(result).success).toBe(true);
    expect(hostToChildSchema.safeParse(result).success).toBe(false);
    expect(childToHostSchema.safeParse({ ...result, ok: false }).success).toBe(false);
  });
  it('admits a scoped SDK command only through the host execute operation', () => {
    const payload = {
      descriptorId: 'sessionSend',
      target: { sessionId: 's' },
      input: { prompt: 'hello' },
    };
    const call = {
      type: 'host_call',
      hostCallId: 'reply',
      contextId: 'invocation',
      op: 'lody.execute',
      payload,
    };
    expect(childToHostSchema.safeParse(call).success).toBe(true);
    expect(childToHostSchema.safeParse({ ...call, contextId: undefined }).success).toBe(false);
    expect(childToHostSchema.safeParse({ ...call, op: 'sessions.send' }).success).toBe(false);
  });
  it('rejects a corrupted final page before returning a remote bundle', async () => {
    const client = { ...manifest, client: 'client.js' };
    const read = async () => new Uint8Array(PLUGIN_BUNDLE_CHUNK_BYTES);
    const packed = (await packClientBundle(client, read))!;
    const digest = (await computeClientDigest(client, read))!;
    const download = () =>
      receiveClientBundle(digest, async (offset) => ({
        bytes: packed.subarray(offset, offset + PLUGIN_BUNDLE_CHUNK_BYTES),
        totalBytes: packed.length,
      }));
    expect((await download()).byteLength).toBe(packed.length);
    packed[packed.length - 1] = 1;
    await expect(download()).rejects.toThrow('digest mismatch');
  });
  it('hashes client paths and content independently of declaration order, excluding machine code', async () => {
    const read = async () => new Uint8Array([42]);
    const digest = (styles: string[]) => computeClientDigest({ ...manifest, styles }, read);
    expect(await computeClientDigest(manifest, read)).toBeUndefined();
    expect(await digest(['a', 'b'])).toEqual(await digest(['b', 'a']));
    expect(await digest(['a'])).not.toEqual(await digest(['b']));
  });
});

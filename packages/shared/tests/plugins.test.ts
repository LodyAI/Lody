import { describe, it, expect } from 'vitest';
import { pluginManifestSchema } from '../src/plugins/manifest-schema';
import { hostToChildSchema, childToHostSchema } from '../src/plugins/ipc-protocol';
import { computeClientDigest } from '../src/plugins/digest';
const manifest = {
  id: 'sample',
  sdk: '^1.0.0' as const,
  version: '1.0.0',
  title: 'Sample',
  machine: 'machine.js',
};
describe('plugin wire boundaries', () => {
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
  it('hashes client paths and content independently of declaration order, excluding machine code', async () => {
    const read = async () => new Uint8Array([42]);
    const digest = (styles: string[]) => computeClientDigest({ ...manifest, styles }, read);
    expect(await computeClientDigest(manifest, read)).toBeUndefined();
    expect(await digest(['a', 'b'])).toEqual(await digest(['b', 'a']));
    expect(await digest(['a'])).not.toEqual(await digest(['b']));
  });
});

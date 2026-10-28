import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { devinRuntimeContractPlugin } from '../scripts/devin-runtime-contract.mjs';

describe('bundled Devin runtime contract', () => {
  it('loads both contracts after relocation without a sibling manifest', async () => {
    const manifestUrl = new URL(
      '../../../packages/acp-extension-devin/runtime-manifest.json',
      import.meta.url
    );
    const moduleUrl = new URL(
      '../../../packages/acp-extension-devin/dist/manifest.js',
      import.meta.url
    );
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    const transformed = devinRuntimeContractPlugin().transform(
      readFileSync(moduleUrl, 'utf8'),
      fileURLToPath(moduleUrl)
    );
    // A data URL has no filesystem sibling: every manifest read must be inlined.
    const relocated = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`
    );
    expect(relocated.privateWireContract).toEqual(manifest.privateWireContract);
    expect(relocated.modelConfigCacheProtobuf).toEqual(manifest.modelConfigCacheProtobuf);
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STREAMS_SHA256 = 'a1314d8fbfaed381505001342d563993ae1f32c0682d9db8252c6f6eb97a391e';

describe('D0 pinned inputs', () => {
  it('vendors the continuationOffset streams-crdt tarball with the recorded digest', () => {
    const tarball = join(dirname(fileURLToPath(import.meta.url)), '../vendor/streams-crdt.tgz');
    const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    expect(actual).toBe(STREAMS_SHA256);
  });
});

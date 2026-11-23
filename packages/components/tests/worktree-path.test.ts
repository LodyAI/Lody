import { describe, expect, it } from 'vitest';

import { normalizeWorktreePathsInText } from '@/lib/worktree-path';

const ID = '9a29a27b-5e79-4667-84b2-8d81c7e1e132';
/** Deterministic PRNG (mulberry32) so failures reproduce from the seed. */
const createRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('normalizeWorktreePathsInText', () => {
  it('shortens worktree roots inside commands', () => {
    const root = `/Users/me/.lody/repos/app/worktrees/${ID}`;
    expect(normalizeWorktreePathsInText(`cd ${root} && cat ${root}/src/a.ts`)).toBe(
      'cd . && cat src/a.ts'
    );
    expect(normalizeWorktreePathsInText(`"${root}/"`)).toBe('"."');
    expect(normalizeWorktreePathsInText('no worktree here')).toBe('no worktree here');
  });

  it('handles a command carrying a large inline base64 image', () => {
    // The old regex took ~90s on a 460K-character token of this shape.
    const random = createRandom(7);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let base64 = '';
    for (let index = 0; index < 460_000; index += 1) {
      base64 += alphabet[Math.floor(random() * alphabet.length)];
    }
    const command = `cd /repo/worktrees/${ID} && echo data:image/png;base64,${base64} > out.png`;
    expect(normalizeWorktreePathsInText(command)).toBe(
      `cd . && echo data:image/png;base64,${base64} > out.png`
    );
  });
});

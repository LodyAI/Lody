import { describe, expect, it } from 'vitest';

import { resolvePrCompareRange } from '../src/lib/github-pr-diff';

const commits = [
  {
    sha: 'a',
    message: 'one',
    authorLogin: null,
    authoredAt: null,
    htmlUrl: null,
    parentSha: 'base',
  },
  { sha: 'b', message: 'two', authorLogin: null, authoredAt: null, htmlUrl: null, parentSha: 'a' },
  {
    sha: 'c',
    message: 'three',
    authorLogin: null,
    authoredAt: null,
    htmlUrl: null,
    parentSha: 'b',
  },
];

describe('PR diff commit ranges', () => {
  it('compares all commits from the immutable PR base to head', () => {
    expect(
      resolvePrCompareRange({
        baseRef: 'main',
        baseSha: 'base',
        headSha: 'c',
        commits,
        selection: { type: 'all' },
      })
    ).toEqual({ from: 'base', to: 'c', historical: false });
  });

  it('uses the commit parent for a single commit and range', () => {
    expect(
      resolvePrCompareRange({
        baseRef: 'main',
        baseSha: 'base',
        headSha: 'c',
        commits,
        selection: { type: 'commit', sha: 'b' },
      })
    ).toEqual({ from: 'a', to: 'b', historical: true });
    expect(
      resolvePrCompareRange({
        baseRef: 'main',
        baseSha: 'base',
        headSha: 'c',
        commits,
        selection: { type: 'range', startSha: 'b', endSha: 'c' },
      })
    ).toEqual({ from: 'a', to: 'c', historical: true });
  });

  it('falls back to all commits for an invalid or reversed range', () => {
    expect(
      resolvePrCompareRange({
        baseRef: 'main',
        baseSha: 'base',
        headSha: 'c',
        commits,
        selection: { type: 'range', startSha: 'c', endSha: 'b' },
      })
    ).toEqual({ from: 'base', to: 'c', historical: false });
    expect(
      resolvePrCompareRange({
        baseRef: 'main',
        baseSha: 'base',
        headSha: 'c',
        commits,
        selection: { type: 'commit', sha: 'missing' },
      })
    ).toEqual({ from: 'base', to: 'c', historical: false });
  });
});

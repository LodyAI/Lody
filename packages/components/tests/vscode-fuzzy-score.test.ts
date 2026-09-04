import { describe, expect, it } from 'vitest';

import { scoreFuzzy } from '../src/components/mentions/vscode-fuzzy-score';

const score = (target: string, query: string, allowNonContiguousMatches = true) =>
  scoreFuzzy(target, query, query.toLowerCase(), allowNonContiguousMatches);

describe('vendored VS Code fuzzy scorer', () => {
  it('preserves the upstream fuzzy scoring order', () => {
    const target = 'HelLo-World';
    const scores = [
      score(target, 'HelLo-World'),
      score(target, 'hello-world'),
      score(target, 'HW'),
      score(target, 'hw'),
      score(target, 'H'),
      score(target, 'h'),
      score(target, 'W'),
      score(target, 'Ld'),
      score(target, 'ld'),
      score(target, 'w'),
      score(target, 'L'),
      score(target, 'l'),
      score(target, '4'),
    ];

    expect(scores.map(([value]) => value)).toEqual(
      scores.map(([value]) => value).toSorted((left, right) => right - left)
    );
  });

  it('supports non-contiguous matches and restores their positions', () => {
    expect(score('file generated-name.ts', 'filename')[1]).toEqual([0, 1, 2, 3, 15, 16, 17, 18]);
    expect(score('HelLo-World', 'HW')[1]).toEqual([0, 6]);
  });

  it('requires a contiguous match when requested', () => {
    expect(score('HelLo-World', 'HW', false)[0]).toBe(0);
    expect(score('HelLo-World', 'ello', false)[0]).toBeGreaterThan(0);
  });

  it('treats Windows and POSIX path separators as equivalent', () => {
    expect(score('src/components/file.ts', 'src\\components')[0]).toBeGreaterThan(0);
  });
});

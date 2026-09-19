import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  computeLineCounts,
  computeTextLineCounts,
  countTextLines,
  prefixSuffixLineCounts,
} from './diff-line-counts';

/** Ground-truth `[add, del]` straight from git, for parity assertions. */
function gitNumstat(oldText: string, newText: string): [number, number] {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lody-diff-test-'));
  try {
    const oldPath = path.join(dir, 'old');
    const newPath = path.join(dir, 'new');
    writeFileSync(oldPath, oldText);
    writeFileSync(newPath, newText);
    const result = spawnSync('git', ['diff', '--no-index', '--numstat', '--', oldPath, newPath], {
      encoding: 'utf8',
    });
    const match = /^(\d+|-)\t(\d+|-)\t/m.exec(result.stdout ?? '');
    if (!match) return [0, 0];
    return [Number.parseInt(match[1] ?? '0', 10), Number.parseInt(match[2] ?? '0', 10)];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('computeTextLineCounts', () => {
  it('counts a single contiguous edit exactly', () => {
    const oldText = 'alpha\nbeta\ngamma\n';
    const newText = 'alpha\nBETA\ngamma\n';
    expect(computeTextLineCounts(oldText, newText)).toEqual([1, 1]);
  });

  it('counts scattered multi-hunk edits exactly (not the prefix/suffix over-count)', () => {
    const oldText = 'a\nb\nc\nd\ne\n';
    const newText = 'A\nb\nc\nd\nE\n';
    // First and last line changed: a real line diff sees 2 add / 2 del.
    expect(computeTextLineCounts(oldText, newText)).toEqual([2, 2]);
    // The old prefix/suffix estimate would have collapsed the whole file.
    expect(prefixSuffixLineCounts(oldText, newText)).toEqual([5, 5]);
  });

  it('counts pure insertions and deletions', () => {
    expect(computeTextLineCounts('a\nb\n', 'a\nx\ny\nb\n')).toEqual([2, 0]);
    expect(computeTextLineCounts('a\nx\ny\nb\n', 'a\nb\n')).toEqual([0, 2]);
  });

  it('returns [0,0] for identical text', () => {
    expect(computeTextLineCounts('a\nb\n', 'a\nb\n')).toEqual([0, 0]);
  });

  it('matches git diff --numstat across representative cases', () => {
    const cases: Array<[string, string]> = [
      ['a\nb\nc\nd\ne\n', 'A\nb\nc\nd\nE\n'],
      ['one\ntwo\nthree\n', 'one\ntwo\nthree\nfour\nfive\n'],
      ['keep\nremove me\nkeep\n', 'keep\nkeep\n'],
      ['x\n'.repeat(50), 'x\n'.repeat(20) + 'changed\n' + 'x\n'.repeat(20)],
      ['line\n', 'line'],
    ];
    for (const [oldText, newText] of cases) {
      expect(computeTextLineCounts(oldText, newText)).toEqual(gitNumstat(oldText, newText));
    }
  });
});

describe('computeLineCounts (nullable sides)', () => {
  it('treats a missing old side as a pure file creation', () => {
    expect(computeLineCounts(null, 'a\nb\nc\n')).toEqual([3, 0]);
  });

  it('treats a missing new side as a pure file deletion', () => {
    expect(computeLineCounts('a\nb\n', null)).toEqual([0, 2]);
  });

  it('returns [0,0] when both sides are missing', () => {
    expect(computeLineCounts(null, null)).toEqual([0, 0]);
  });

  it('returns [0,0] for empty-file creation and deletion', () => {
    expect(computeLineCounts(null, '')).toEqual([0, 0]);
    expect(computeLineCounts('', null)).toEqual([0, 0]);
  });

  it('returns [0,0] when an edit writes identical text', () => {
    expect(computeLineCounts('same\n', 'same\n')).toEqual([0, 0]);
  });
});

describe('countTextLines', () => {
  it('does not count a trailing newline as an extra line', () => {
    expect(countTextLines('a\nb\n')).toBe(2);
    expect(countTextLines('a\nb')).toBe(2);
    expect(countTextLines('')).toBe(0);
  });
});

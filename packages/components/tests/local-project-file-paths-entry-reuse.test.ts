import { describe, expect, it } from 'vitest';
import {
  areStringArraysEqual,
  resolveLoadedEntry,
  type LocalProjectFilePathsEntry,
} from '../src/hooks/use-local-project-file-paths';

const previous: LocalProjectFilePathsEntry = {
  paths: ['src/a.ts', 'src/b.ts'],
  truncated: false,
  fetchedAt: 1000,
};

describe('resolveLoadedEntry', () => {
  // The mention menu revalidates on every `@`, and `buildMentionFileIndex` is
  // memoised on the entry object. A new object for an unchanged listing
  // re-expands every path into its suggestion tokens, once per mention.
  it('keeps the same object when the machine reported an identical listing', () => {
    const resolved = resolveLoadedEntry(
      previous,
      { paths: ['src/a.ts', 'src/b.ts'], truncated: false },
      2000
    );

    expect(resolved).toBe(previous);
    expect(resolved.fetchedAt).toBe(1000);
  });

  it('returns a new entry when a path appeared', () => {
    const resolved = resolveLoadedEntry(
      previous,
      { paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'], truncated: false },
      2000
    );

    expect(resolved).not.toBe(previous);
    expect(resolved).toEqual({
      paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      truncated: false,
      fetchedAt: 2000,
    });
  });

  it('returns a new entry when a path disappeared', () => {
    const resolved = resolveLoadedEntry(previous, { paths: ['src/a.ts'], truncated: false }, 2000);

    expect(resolved).not.toBe(previous);
    expect(resolved.paths).toEqual(['src/a.ts']);
  });

  it('returns a new entry when only the truncation flag changed', () => {
    const resolved = resolveLoadedEntry(
      previous,
      { paths: ['src/a.ts', 'src/b.ts'], truncated: true },
      2000
    );

    expect(resolved).not.toBe(previous);
    expect(resolved.truncated).toBe(true);
  });

  it('builds an entry when nothing was cached', () => {
    const resolved = resolveLoadedEntry(undefined, { paths: ['src/a.ts'], truncated: false }, 2000);

    expect(resolved).toEqual({ paths: ['src/a.ts'], truncated: false, fetchedAt: 2000 });
  });
});

describe('areStringArraysEqual', () => {
  it('treats same-length reorderings as different', () => {
    expect(areStringArraysEqual(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('short-circuits on identity and compares element-wise otherwise', () => {
    const list = ['a', 'b'];
    expect(areStringArraysEqual(list, list)).toBe(true);
    expect(areStringArraysEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(areStringArraysEqual(['a'], ['a', 'b'])).toBe(false);
  });
});

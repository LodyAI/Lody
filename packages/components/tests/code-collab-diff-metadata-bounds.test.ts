import { parseDiffFromFile } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import {
  boundParsedFileDiffForMainThread,
  measureParsedFileDiffComplexity,
  compactParsedFileDiff,
  restoreParsedFileDiffContext,
} from '../src/lib/code-collab-diff-metadata-bounds';

describe('Code Collab parsed diff metadata bounds', () => {
  it('bounds indexed hunk complexity while retaining expansion context', () => {
    const fileDiff = parseDiffFromFile(
      { name: 'src/example.ts', contents: 'a\nb\nc\n', lang: 'ts' },
      { name: 'src/example.ts', contents: 'a\nchanged\nc\n', lang: 'ts' }
    );
    const complexity = measureParsedFileDiffComplexity(fileDiff);

    expect(complexity.changedLines).toBeGreaterThan(0);
    expect(complexity.hunkLines).toBeGreaterThan(0);
    expect(complexity.hunkTextLength).toBeGreaterThan(0);
    expect(
      boundParsedFileDiffForMainThread(fileDiff, {
        maxChangedLines: complexity.changedLines - 1,
      })
    ).toMatchObject({
      status: 'too-large',
      reason: 'parsed-changed-lines-too-large',
    });
    expect(
      boundParsedFileDiffForMainThread(fileDiff, {
        maxHunkLines: complexity.hunkLines - 1,
      })
    ).toMatchObject({
      status: 'too-large',
      reason: 'parsed-hunk-lines-too-large',
    });
    expect(
      boundParsedFileDiffForMainThread(fileDiff, {
        maxHunkTextLength: complexity.hunkTextLength - 1,
      })
    ).toMatchObject({
      status: 'too-large',
      reason: 'parsed-hunk-text-too-large',
    });

    const bounded = boundParsedFileDiffForMainThread(fileDiff, {
      maxChangedLines: complexity.changedLines,
      maxHunkLines: complexity.hunkLines,
      maxHunkTextLength: complexity.hunkTextLength,
    });
    expect(bounded.status).toBe('ready');
    if (bounded.status === 'ready') {
      expect(bounded.fileDiff.additionLines.join('')).toBe('a\nchanged\nc\n');
      expect(bounded.fileDiff.deletionLines.join('')).toBe('a\nb\nc\n');
    }
  });
});

describe('indexed diff context', () => {
  it('bounds worker payloads to hunks and restores exact indexes for expansion', () => {
    const oldText = Array.from({ length: 300 }, (_, i) => `line ${i}\r\n`).join('');
    const newText = oldText.replace('line 20', 'changed 20').replace('line 280', 'changed 280');
    const parsed = parseDiffFromFile(
      { name: 'test.ts', contents: oldText },
      { name: 'test.ts', contents: newText }
    );
    const compact = compactParsedFileDiff(parsed);
    expect(compact.isPartial).toBe(true);
    expect(compact.additionLines.length).toBeLessThan(30);
    expect(compact.deletionLines.length).toBeLessThan(30);
    expect(measureParsedFileDiffComplexity(compact)).toEqual(
      measureParsedFileDiffComplexity(parsed)
    );
    expect(
      restoreParsedFileDiffContext(compact, parsed.deletionLines, parsed.additionLines)
    ).toEqual(parsed);
    expect(compactParsedFileDiff(compact)).toBe(compact);
  });
});

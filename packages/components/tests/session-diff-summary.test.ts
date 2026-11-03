import { describe, expect, test } from 'vitest';

import {
  buildSessionDiffSummary,
  buildSessionDiffSummaryFromProviderChanges,
} from '../src/components/sessions/session-diff-summary';

describe('buildSessionDiffSummary', () => {
  test('deduplicates per-turn file paths without synthesizing All Changes entries', () => {
    const summary = buildSessionDiffSummary([
      {
        id: 'turn-1',
        fileDiff: [
          { filePath: 'src/a.ts', add: 2, del: 1 },
          { filePath: 'src/b.ts', add: 4, del: 0 },
          { filePath: 'src/a.ts', add: 1, del: 3 },
        ],
      },
      {
        id: 'turn-2',
        fileDiff: [{ filePath: 'src/a.ts', add: 5, del: 2 }],
      },
    ]);

    expect(summary.changeEntries).toEqual([]);
    expect(summary.changeFilePaths).toEqual([]);
    expect(summary.diffFilePathsByTurn).toEqual({
      'turn-1': ['src/a.ts', 'src/b.ts'],
      'turn-2': ['src/a.ts'],
    });
    expect(summary.diffEntriesByTurn).toEqual({
      'turn-1': [
        { filePath: 'src/a.ts', add: 3, del: 4 },
        { filePath: 'src/b.ts', add: 4, del: 0 },
      ],
      'turn-2': [{ filePath: 'src/a.ts', add: 5, del: 2 }],
    });
  });

  test('keeps provider stats unavailable when provider entries do not include line stats', () => {
    const summary = buildSessionDiffSummaryFromProviderChanges(
      [
        {
          fileId: 't:a',
          path: 'src/a.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
      {
        'turn-1': [
          {
            fileId: 't:a',
            path: 'src/a.ts',
            kind: 'text',
            sourceState: 'historical-turn',
          },
        ],
      }
    );

    expect(summary.changeEntries).toEqual([
      { filePath: 'src/a.ts', add: undefined, del: undefined },
    ]);
    expect(summary.changeFilePaths).toEqual(['src/a.ts']);
    expect(summary.diffFilePathsByTurn).toEqual({ 'turn-1': ['src/a.ts'] });
    expect(summary.diffEntriesByTurn).toEqual({
      'turn-1': [{ filePath: 'src/a.ts', add: undefined, del: undefined }],
    });
  });

  test('keeps provider 0/0 stats without session-level fallback', () => {
    const summary = buildSessionDiffSummaryFromProviderChanges(
      [
        {
          fileId: 't:a',
          path: 'README.md',
          kind: 'text',
          sourceState: 'live-collaborative',
          add: 0,
          del: 0,
        },
      ],
      {
        'turn-1': [
          {
            fileId: 't:a',
            path: 'README.md',
            kind: 'text',
            sourceState: 'historical-turn',
            add: 0,
            del: 0,
          },
        ],
      }
    );

    expect(summary.changeEntries).toEqual([{ filePath: 'README.md', add: 0, del: 0 }]);
    expect(summary.diffEntriesByTurn).toEqual({
      'turn-1': [{ filePath: 'README.md', add: 0, del: 0 }],
    });
  });
});

import { describe, expect, test, it } from 'vitest';
import {
  buildSessionDiffSummary,
  buildSessionDiffSummaryFromProviderChanges,
} from '../src/components/sessions/session-diff-summary';
import { shouldStartSessionDiffLoads } from '../src/components/sessions/use-session-conversation-diff-data';
import { describeSessionDiffSnapshot } from '../src/lib/session-diff-diagnostics';
import {
  buildProviderDiffSummaryFromChangedFileResults,
  collectReadyProviderChangedFilesByTurn,
} from '../src/components/sessions/use-session-diff-summary';

describe('session-diff-summary', () => {
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
});

describe('session-conversation-diff-data', () => {
  describe('shouldStartSessionDiffLoads', () => {
    const loadableInput = {
      useProviderDiff: true,
      waitForProviderDiff: false,
      loadPaused: false,
      fileDiffsPending: false,
      normalizedPathCount: 2,
      mode: 'conversation' as const,
      turnId: 'turn-1',
    };

    it('waits for conversation fileDiffs but not All Changes metadata', () => {
      // Regression: firing getDiff before the per-turn checkpoints arrive stores a
      // "requires a session-history fileDiff checkpoint" error for data that is in flight.
      expect(shouldStartSessionDiffLoads({ ...loadableInput, fileDiffsPending: true })).toBe(false);
      // All Changes reads the file-index currentChanges metadata directly; it must not wait for
      // session-history checkpoints.
      expect(
        shouldStartSessionDiffLoads({
          ...loadableInput,
          fileDiffsPending: true,
          mode: 'base',
          turnId: undefined,
        })
      ).toBe(true);
    });
  });
});

describe('session-diff-diagnostics', () => {
  describe('session diff diagnostics', () => {
    it('summarizes text snapshots by length instead of raw content', () => {
      expect(describeSessionDiffSnapshot({ kind: 'text', text: 'hello world' })).toEqual({
        kind: 'text',
        textLength: 11,
      });
    });
  });
});

describe('use-session-diff-summary', () => {
  describe('useSessionDiffSummary helpers', () => {
    test('keeps ready per-turn provider changes when another turn is unavailable', () => {
      expect(
        collectReadyProviderChangedFilesByTurn([
          [
            'assistant-no-marker',
            {
              status: 'unavailable',
              reason: 'metadata-only',
              message: 'Code Collab turn markers were not found: assistant-no-marker',
            },
          ],
          [
            'assistant-edit',
            {
              status: 'ready',
              files: [
                {
                  fileId: 't:readme',
                  path: 'README.md',
                  kind: 'text',
                  sourceState: 'historical-turn',
                  add: 1,
                  del: 1,
                },
              ],
            },
          ],
        ])
      ).toEqual({
        'assistant-edit': [
          {
            fileId: 't:readme',
            path: 'README.md',
            kind: 'text',
            sourceState: 'historical-turn',
            add: 1,
            del: 1,
          },
        ],
      });
    });

    test('keeps all-changes unavailable when only per-turn changes are readable', () => {
      const result = buildProviderDiffSummaryFromChangedFileResults(
        {
          status: 'unavailable',
          reason: 'metadata-only',
          message:
            'turn history doc sync failed: timeout: TIMEOUT: connect request exceeded 10000ms',
        },
        [
          [
            'assistant-edit',
            {
              status: 'ready',
              files: [
                {
                  fileId: 't:readme',
                  path: 'README.md',
                  kind: 'text',
                  sourceState: 'historical-turn',
                },
              ],
            },
          ],
        ]
      );

      expect(result).toEqual({
        summary: {
          changeEntries: [],
          changeFilePaths: [],
          diffFilePathsByTurn: { 'assistant-edit': ['README.md'] },
          diffEntriesByTurn: {
            'assistant-edit': [{ filePath: 'README.md', add: undefined, del: undefined }],
          },
          fileDiffsByTurn: {},
        },
        unavailableMessage:
          'turn history doc sync failed: timeout: TIMEOUT: connect request exceeded 10000ms',
      });
    });
  });
});

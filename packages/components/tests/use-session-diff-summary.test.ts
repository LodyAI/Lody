import { describe, expect, test } from 'vitest';

import {
  buildProviderDiffSummaryFromChangedFileResults,
  collectReadyProviderChangedFilesByTurn,
} from '../src/components/sessions/use-session-diff-summary';

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
        message: 'turn history doc sync failed: timeout: TIMEOUT: connect request exceeded 10000ms',
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

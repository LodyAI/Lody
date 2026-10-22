// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewRenderer } from '../src/react';
import type { ReviewBundle } from '../src/types';

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: ({
    fileDiff,
    lineAnnotations = [],
    renderAnnotation,
    options,
  }: {
    fileDiff?: {
      deletionLines?: unknown;
      additionLines?: unknown;
      hunks?: Array<{ collapsedBefore?: number }>;
    };
    lineAnnotations?: Array<{ metadata: unknown }>;
    renderAnnotation?: (annotation: { metadata: unknown }) => React.ReactNode;
    options?: {
      diffStyle?: 'unified' | 'split';
      onLineClick?: (props: {
        annotationSide: 'additions' | 'deletions';
        lineNumber: number;
        event: { preventDefault: () => void };
      }) => void;
    };
  }) => (
    <div
      data-testid="mock-file-diff"
      data-diff-style={options?.diffStyle}
      data-has-old-lines={String(fileDiff?.deletionLines !== undefined)}
      data-has-new-lines={String(fileDiff?.additionLines !== undefined)}
      data-collapsed-before={String(fileDiff?.hunks?.[0]?.collapsedBefore)}
    >
      <button
        type="button"
        onClick={() =>
          options?.onLineClick?.({
            annotationSide: 'additions',
            lineNumber: 2,
            event: { preventDefault: () => {} },
          })
        }
      >
        mock new line 2
      </button>
      {lineAnnotations.map((annotation, index) => (
        <div key={index}>{renderAnnotation?.(annotation)}</div>
      ))}
    </div>
  ),
}));

describe('ReviewRenderer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders fenced code blocks in summaries and findings without collapsing newlines', async () => {
    const rootElement = document.createElement('div');
    document.body.append(rootElement);
    const root = createRoot(rootElement);

    await act(async () => {
      root.render(<ReviewRenderer bundle={bundle} storageKey="test-review-code-blocks" />);
    });

    const codeBlocks = [...rootElement.querySelectorAll('pre.crh-markdown-code code')].map(
      (node) => node.textContent
    );

    expect(codeBlocks).toEqual(
      expect.arrayContaining([
        'pnpm test\npnpm build',
        'const summary = true;',
        'if (!value) {\n  return fallback;\n}',
      ])
    );
    expect(rootElement.querySelector('pre.crh-markdown-code[data-language="sh"]')).not.toBeNull();
    expect(rootElement.querySelector('pre.crh-markdown-code[data-language="ts"]')).not.toBeNull();
    expect(rootElement.textContent).not.toContain('```');
    expect(rootElement.textContent).not.toContain('new://src/a.ts:L1-L2');
    expect(rootElement.textContent).toContain('a.ts:1-2');
  });
});

const bundle: ReviewBundle = {
  reviewFilePath: '/tmp/sample.review.md',
  repoPath: '/tmp/repo',
  document: {
    sourcePath: '/tmp/sample.review.md',
    frontmatter: {
      reviewVersion: 1,
      mergeBase: '111111111111',
      currentCommit: '222222222222',
      lineBudget: 1500,
      raw: {},
    },
    overview: 'Run the smoke commands:\n\n```sh\npnpm test\npnpm build\n```',
    findings: [
      {
        id: 'finding-1',
        severity: 'p1',
        bodyMarkdown:
          'The branch loses the fallback. Use the same shape:\n\n```ts\nif (!value) {\n  return fallback;\n}\n```\n\nSee `new://src/a.ts:L1-L2`.',
        refs: [
          {
            path: 'src/a.ts',
            side: 'new',
            range: { start: 1, end: 2 },
            raw: 'new://src/a.ts:L1-L2',
          },
        ],
        line: 7,
      },
    ],
    groups: [],
    diagnostics: [],
  },
  commits: {},
  files: {
    'src/a.ts': {
      path: 'src/a.ts',
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      status: 'modified',
      oldText: 'export const value = 1;\n',
      newText: 'export const value = 2;\n',
      additions: 1,
      deletions: 1,
      diagnostics: [],
    },
  },
  diagnostics: [],
  groups: [
    {
      id: 'group-1',
      title: 'Test group',
      changedLines: 2,
      commits: ['abc123'],
      bodyMarkdown: 'Changed lines: 2\n\nParser shape:\n\n```ts\nconst summary = true;\n```',
      line: 8,
      diagnostics: [],
      blocks: [
        {
          id: 'group-1-block-1',
          path: 'src/a.ts',
          kind: 'change',
          line: 12,
          rawReference: 'changes://src/a.ts?new=L1-L1',
          newRange: { start: 1, end: 1 },
          notes: [
            {
              id: 'note-1',
              side: 'new',
              range: { start: 1, end: 1 },
              body: 'confirm new value',
              path: 'src/a.ts',
              blockId: 'group-1-block-1',
              line: 14,
            },
          ],
          file: {
            path: 'src/a.ts',
            oldPath: 'src/a.ts',
            newPath: 'src/a.ts',
            status: 'modified',
            oldText: 'export const value = 1;\n',
            newText: 'export const value = 2;\n',
            additions: 1,
            deletions: 1,
            diagnostics: [],
          },
          displayOldText: 'export const value = 1;\n',
          displayNewText: 'export const value = 2;\n',
          diagnostics: [],
        },
      ],
    },
  ],
};

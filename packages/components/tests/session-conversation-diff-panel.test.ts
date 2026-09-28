import { describe, expect, it } from 'vitest';
import type { FileDiff, SessionId } from '@lody/shared';
import {
  areFileDiffListsEqual,
  areSessionConversationDiffPanelPropsEqual,
  createConversationDiffViewerParseCacheKey,
  shouldOpenDiffFileByDefault,
  type SessionConversationDiffPanelProps,
} from '../src/components/sessions/session-conversation-diff-panel';

const checkpointFileDiff = (overrides: Partial<FileDiff> = {}): FileDiff => ({
  filePath: 'docs/README.md',
  add: 1,
  del: 0,
  cc: {
    v: 1,
    fileId: 't:000066',
    opId: '1:89',
    baseOpId: '2:89',
  },
  ...overrides,
});

describe('areFileDiffListsEqual', () => {
  it('compares by content so rebuilt arrays with identical checkpoints stay equal', () => {
    expect(areFileDiffListsEqual([checkpointFileDiff()], [checkpointFileDiff()])).toBe(true);
    expect(areFileDiffListsEqual([], [])).toBe(true);
    expect(areFileDiffListsEqual(undefined, undefined)).toBe(true);
  });

  it('detects checkpoint hydration and frontier changes', () => {
    expect(areFileDiffListsEqual([], [checkpointFileDiff()])).toBe(false);
    expect(areFileDiffListsEqual(undefined, [])).toBe(false);
    expect(
      areFileDiffListsEqual(
        [checkpointFileDiff()],
        [checkpointFileDiff({ cc: { v: 1, fileId: 't:000066', opId: '1:99', baseOpId: '2:89' } })]
      )
    ).toBe(false);
    expect(
      areFileDiffListsEqual([checkpointFileDiff()], [checkpointFileDiff({ cc: undefined })])
    ).toBe(false);
  });
});

describe('areSessionConversationDiffPanelPropsEqual', () => {
  const baseProps: SessionConversationDiffPanelProps = {
    sessionId: 'session-1' as SessionId,
    turnId: 'turn-1',
    filePaths: ['docs/README.md'],
    fileDiffs: [checkpointFileDiff()],
    fileDiffsPending: false,
  };

  it('treats content-equal rebuilt fileDiffs as equal', () => {
    expect(
      areSessionConversationDiffPanelPropsEqual(baseProps, {
        ...baseProps,
        filePaths: ['docs/README.md'],
        fileDiffs: [checkpointFileDiff()],
      })
    ).toBe(true);
  });

  it('re-renders when the open-file handler identity changes', () => {
    const onOpenFile = () => undefined;
    expect(areSessionConversationDiffPanelPropsEqual(baseProps, { ...baseProps, onOpenFile })).toBe(
      false
    );
    expect(
      areSessionConversationDiffPanelPropsEqual(
        { ...baseProps, onOpenFile },
        { ...baseProps, onOpenFile }
      )
    ).toBe(true);
  });

  it('re-renders when fileDiffs hydrate after the summary resolves', () => {
    // Regression: the comparator skipped fileDiffs, freezing a mount-time empty
    // checkpoint list (and its "requires a session-history fileDiff checkpoint"
    // error) inside the memoized panel.
    expect(
      areSessionConversationDiffPanelPropsEqual(
        { ...baseProps, fileDiffs: [] },
        { ...baseProps, fileDiffs: [checkpointFileDiff()] }
      )
    ).toBe(false);
    expect(
      areSessionConversationDiffPanelPropsEqual(
        { ...baseProps, fileDiffsPending: true },
        { ...baseProps, fileDiffsPending: false }
      )
    ).toBe(false);
  });
});

describe('createConversationDiffViewerParseCacheKey', () => {
  it('includes the file path so same-turn text-source diffs cannot share parsed output', () => {
    expect(
      createConversationDiffViewerParseCacheKey({
        mode: 'conversation',
        cacheKey: 'session:conversation:turn-1',
        filePath: 'src/a.ts',
      })
    ).toBe('session:conversation:turn-1:src/a.ts');
    expect(
      createConversationDiffViewerParseCacheKey({
        mode: 'conversation',
        cacheKey: 'session:conversation:turn-1',
        filePath: 'src/b.ts',
      })
    ).toBe('session:conversation:turn-1:src/b.ts');
    expect(
      createConversationDiffViewerParseCacheKey({
        mode: 'base',
        cacheKey: 'session:base:turn-1',
        filePath: 'src/a.ts',
      })
    ).toBeUndefined();
  });
});

describe('shouldOpenDiffFileByDefault', () => {
  it('opens only the focused file in All Changes mode', () => {
    expect(
      shouldOpenDiffFileByDefault({
        mode: 'base',
        filePath: 'src/target.ts',
        focusFilePath: 'src/target.ts',
      })
    ).toBe(true);
    expect(
      shouldOpenDiffFileByDefault({
        mode: 'base',
        filePath: 'src/other.ts',
        focusFilePath: 'src/target.ts',
      })
    ).toBe(false);
  });

  it('keeps conversation diffs expanded and All Changes without focus collapsed', () => {
    expect(
      shouldOpenDiffFileByDefault({
        mode: 'conversation',
        filePath: 'src/other.ts',
        focusFilePath: 'src/target.ts',
      })
    ).toBe(true);
    expect(shouldOpenDiffFileByDefault({ mode: 'base', filePath: 'src/other.ts' })).toBe(false);
  });

  it('matches equivalent workspace path spellings', () => {
    expect(
      shouldOpenDiffFileByDefault({
        mode: 'base',
        filePath: './src/target.ts',
        focusFilePath: 'src/target.ts',
      })
    ).toBe(true);
  });
});

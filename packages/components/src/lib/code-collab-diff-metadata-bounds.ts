import type { FileDiffMetadata } from '@pierre/diffs';

export const DEFAULT_CODE_COLLAB_FRONTIER_DIFF_MAX_PARSED_CHANGED_LINES = 20_000;
export const DEFAULT_CODE_COLLAB_FRONTIER_DIFF_MAX_PARSED_HUNK_LINES = 40_000;
export const DEFAULT_CODE_COLLAB_FRONTIER_DIFF_MAX_PARSED_HUNK_TEXT_LENGTH = 1024 * 1024;

export type CodeCollabFrontierDiffTooLargeReason =
  | 'source-text-too-large'
  | 'parsed-changed-lines-too-large'
  | 'parsed-hunk-lines-too-large'
  | 'parsed-hunk-text-too-large';

type ParsedFileDiffComplexity = {
  readonly hunkCount: number;
  readonly changedLines: number;
  readonly hunkLines: number;
  readonly hunkTextLength: number;
};

type ParsedFileDiffBounds = {
  readonly maxChangedLines?: number;
  readonly maxHunkLines?: number;
  readonly maxHunkTextLength?: number;
};

type BoundedParsedFileDiffResult =
  | {
      readonly status: 'ready';
      readonly fileDiff: FileDiffMetadata;
      readonly complexity: ParsedFileDiffComplexity;
    }
  | {
      readonly status: 'too-large';
      readonly reason: CodeCollabFrontierDiffTooLargeReason;
      readonly complexity: ParsedFileDiffComplexity;
    };

export function boundParsedFileDiffForMainThread(
  fileDiff: FileDiffMetadata,
  bounds: ParsedFileDiffBounds = {}
): BoundedParsedFileDiffResult {
  const complexity = measureParsedFileDiffComplexity(fileDiff);
  if (bounds.maxChangedLines !== undefined && complexity.changedLines > bounds.maxChangedLines) {
    return {
      status: 'too-large',
      reason: 'parsed-changed-lines-too-large',
      complexity,
    };
  }
  if (bounds.maxHunkLines !== undefined && complexity.hunkLines > bounds.maxHunkLines) {
    return {
      status: 'too-large',
      reason: 'parsed-hunk-lines-too-large',
      complexity,
    };
  }
  if (
    bounds.maxHunkTextLength !== undefined &&
    complexity.hunkTextLength > bounds.maxHunkTextLength
  ) {
    return {
      status: 'too-large',
      reason: 'parsed-hunk-text-too-large',
      complexity,
    };
  }
  return {
    status: 'ready',
    fileDiff: compactParsedFileDiff(fileDiff),
    complexity,
  };
}

export function measureParsedFileDiffComplexity(
  fileDiff: FileDiffMetadata
): ParsedFileDiffComplexity {
  let changedLines = 0;
  let hunkLines = 0;
  let hunkTextLength = 0;

  for (const hunk of fileDiff.hunks) {
    changedLines += Math.max(hunk.additionLines, hunk.deletionLines);
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        hunkLines += content.lines;
        hunkTextLength += countLinesTextLength(fileDiff.additionLines, content.additionLineIndex, content.lines);
      } else {
        hunkLines += content.additions + content.deletions;
        hunkTextLength +=
          countLinesTextLength(fileDiff.additionLines, content.additionLineIndex, content.additions) +
          countLinesTextLength(fileDiff.deletionLines, content.deletionLineIndex, content.deletions);
      }
    }
  }

  return {
    hunkCount: fileDiff.hunks.length,
    changedLines,
    hunkLines,
    hunkTextLength,
  };
}

function countLinesTextLength(lines: readonly string[], start: number, count: number): number {
  let length = 0;
  for (let index = start; index < start + count; index++) {
    length += lines[index]!.length;
  }
  return length;
}

/** Keep worker transfers bounded to hunks, including their context lines. */
export function compactParsedFileDiff(fileDiff: FileDiffMetadata): FileDiffMetadata {
  if (fileDiff.isPartial) return fileDiff;
  const deletionLines: string[] = [];
  const additionLines: string[] = [];
  const hunks = fileDiff.hunks.map((hunk) => {
    const deletionLineIndex = deletionLines.length;
    const additionLineIndex = additionLines.length;
    for (let i = 0; i < hunk.deletionCount; i++) {
      deletionLines.push(fileDiff.deletionLines[hunk.deletionLineIndex + i]!);
    }
    for (let i = 0; i < hunk.additionCount; i++) {
      additionLines.push(fileDiff.additionLines[hunk.additionLineIndex + i]!);
    }
    return rebaseHunk(hunk, deletionLineIndex, additionLineIndex);
  });
  return {
    ...fileDiff,
    isPartial: true,
    hunks,
    deletionLines,
    additionLines,
    deletionCharacterCount: countLinesTextLength(deletionLines, 0, deletionLines.length),
    additionCharacterCount: countLinesTextLength(additionLines, 0, additionLines.length),
  };
}

/** Restore expansion only for a caller that already owns the complete text. */
export function restoreParsedFileDiffContext(
  fileDiff: FileDiffMetadata,
  deletionLines: string[],
  additionLines: string[]
): FileDiffMetadata {
  if (!fileDiff.isPartial) return fileDiff;
  return {
    ...fileDiff,
    isPartial: false,
    hunks: fileDiff.hunks.map((hunk) =>
      rebaseHunk(hunk, Math.max(0, hunk.deletionStart - 1), Math.max(0, hunk.additionStart - 1))
    ),
    deletionLines,
    additionLines,
    deletionCharacterCount: countLinesTextLength(deletionLines, 0, deletionLines.length),
    additionCharacterCount: countLinesTextLength(additionLines, 0, additionLines.length),
  };
}

function rebaseHunk(
  hunk: FileDiffMetadata['hunks'][number],
  deletionLineIndex: number,
  additionLineIndex: number
): FileDiffMetadata['hunks'][number] {
  return {
    ...hunk,
    deletionLineIndex,
    additionLineIndex,
    hunkContent: hunk.hunkContent.map((content) => ({
      ...content,
      deletionLineIndex: content.deletionLineIndex - hunk.deletionLineIndex + deletionLineIndex,
      additionLineIndex: content.additionLineIndex - hunk.additionLineIndex + additionLineIndex,
    })),
  };
}

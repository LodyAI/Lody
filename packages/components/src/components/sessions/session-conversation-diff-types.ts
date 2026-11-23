import type { SessionFileDiffContentsLoader } from '@/lib/session-file-provider';
import type { CommentReferencePayload } from '@lody/shared';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { DiffTextChunkSource } from '@/lib/diff-text-chunk-source';

export type Snapshot =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'missing' }
  | { kind: 'large' }
  | { kind: 'filtered' };

export type FileDiffData =
  | { status: 'ready'; contentKey?: string; oldSnapshot: Snapshot; newSnapshot: Snapshot }
  | {
      status: 'ready-parsed';
      contentKey?: string;
      loadDiffFiles?: SessionFileDiffContentsLoader;
      fileDiff: FileDiffMetadata;
      oldTextLength: number;
      newTextLength: number;
    }
  | {
      status: 'ready-text-source';
      source: DiffTextChunkSource;
    }
  | { status: 'error'; message: string };

const getErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const getErrorField = (error: unknown, field: string): string | undefined => {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
};

export const isTagNotFoundError = (error: unknown): boolean =>
  getErrorCode(error) === 'tag_not_found' ||
  (error instanceof Error && error.message.startsWith('Tag not found:'));

export const isFileNotFoundError = (error: unknown): boolean =>
  getErrorCode(error) === 'file_not_found' ||
  getErrorCode(error) === 'github_file_not_found' ||
  (error instanceof Error && error.message.startsWith('File not found:')) ||
  (error instanceof Error && error.name === 'GitHubFileNotFoundError');

export const isBinaryBaseVersionUnavailableError = (error: unknown): boolean =>
  getErrorCode(error) === 'base_version_unavailable' &&
  getErrorField(error, 'fileType') === 'binary' &&
  getErrorField(error, 'reason') === 'missing baseVersion';

export const normalizePathForMatch = (filePath: string): string =>
  filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');

export const arePathsEquivalent = (left: string, right: string): boolean =>
  normalizePathForMatch(left) === normalizePathForMatch(right);

export type DiffCommentFocusTarget = {
  source: CommentReferencePayload['source'];
  path: string;
  lineNumber: number;
  side: CommentReferencePayload['side'];
  threadId?: string;
  githubThreadId?: number;
};

export const getDiffCommentFocusTargetFromReference = (
  reference: CommentReferencePayload
): DiffCommentFocusTarget => ({
  source: reference.source,
  path: reference.path,
  lineNumber: reference.lineNumber,
  side: reference.side,
  threadId: reference.threadId,
  githubThreadId: reference.githubThreadId,
});

export const areDiffCommentFocusTargetsEqual = (
  left?: DiffCommentFocusTarget | null,
  right?: DiffCommentFocusTarget | null
): boolean => {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.source === right.source &&
    left.path === right.path &&
    left.lineNumber === right.lineNumber &&
    left.side === right.side &&
    left.threadId === right.threadId &&
    left.githubThreadId === right.githubThreadId
  );
};

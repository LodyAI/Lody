import type { SessionFileDiffResult, SessionFileSnapshot } from './session-file-provider';
import type { FileDiffData, Snapshot } from '@/components/sessions/session-conversation-diff-types';

export function sessionFileProviderDiffResultToFileDiffData(
  result: SessionFileDiffResult
): FileDiffData {
  if (result.status === 'unavailable') {
    return {
      status: 'error',
      message: result.message ?? `Diff is unavailable: ${result.reason}`,
    };
  }
  if (result.status === 'ready-parsed') {
    return {
      status: 'ready-parsed',
      fileDiff: result.fileDiff,
      oldTextLength: result.oldTextLength,
      newTextLength: result.newTextLength,
    };
  }
  if (result.status === 'ready-text-source') {
    return {
      status: 'ready-text-source',
      source: result.source,
    };
  }

  const oldSnapshot = sessionFileProviderSnapshotToDiffSnapshot(result.oldSnapshot);
  if (oldSnapshot.status === 'error') {
    return oldSnapshot;
  }
  const newSnapshot = sessionFileProviderSnapshotToDiffSnapshot(result.newSnapshot);
  if (newSnapshot.status === 'error') {
    return newSnapshot;
  }

  return {
    status: 'ready',
    oldSnapshot: oldSnapshot.snapshot,
    newSnapshot: newSnapshot.snapshot,
  };
}

function sessionFileProviderSnapshotToDiffSnapshot(
  snapshot: SessionFileSnapshot
): { status: 'ready'; snapshot: Snapshot } | Extract<FileDiffData, { status: 'error' }> {
  switch (snapshot.kind) {
    case 'text':
      return { status: 'ready', snapshot: { kind: 'text', text: snapshot.text } };
    case 'paged-text':
      return { status: 'ready', snapshot: { kind: 'large' } };
    case 'binary':
      return { status: 'ready', snapshot: { kind: 'binary' } };
    case 'unavailable':
      if (snapshot.reason === 'deleted') {
        return { status: 'ready', snapshot: { kind: 'missing' } };
      }
      if (snapshot.reason === 'text-too-large' || snapshot.reason === 'blob-too-large') {
        return { status: 'ready', snapshot: { kind: 'large' } };
      }
      if (snapshot.reason === 'missing-blob-digest') {
        return { status: 'ready', snapshot: { kind: 'binary' } };
      }
      return {
        status: 'error',
        message: snapshot.message ?? `Diff content is unavailable: ${snapshot.reason}`,
      };
  }
  return assertNever(snapshot);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session file snapshot: ${String(value)}`);
}

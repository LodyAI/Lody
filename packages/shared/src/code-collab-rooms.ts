export const LORO_CODE_COLLAB_FILE_INDEX_STREAM_SEGMENT = 'fi';
export const LORO_CODE_COLLAB_FILE_INDEX_SIGNAL_STREAM_SEGMENT = 'fis';

export function isWorkspaceCodeCollabFlockDocId(workspaceId: string, id: string): boolean {
  const parts = id.split(':');
  return (
    parts.length === 3 &&
    parts[0] === workspaceId &&
    !!parts[2]?.trim() &&
    (parts[1] === LORO_CODE_COLLAB_FILE_INDEX_STREAM_SEGMENT ||
      parts[1] === LORO_CODE_COLLAB_FILE_INDEX_SIGNAL_STREAM_SEGMENT)
  );
}

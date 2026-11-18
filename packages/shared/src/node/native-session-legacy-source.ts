import { readFrozenLegacyLoroDocumentSqlite } from './legacy-loro-document-source';
/** Stable Session source identities and raw-part digests remain unchanged. */
export function readFrozenLegacySessionSqlite(options: {
  path: string;
  workspaceId: string;
  sessionId: string;
}) {
  return readFrozenLegacyLoroDocumentSqlite({
    path: options.path,
    roomId: `session-${options.sessionId}`,
    sourceId: `cli-sqlite:loro-doc-layout1:${options.workspaceId}:${options.sessionId}`,
    hashDomain: 'lody-legacy-session',
  });
}

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceId } from '../ids';
import { resolveLocalIndependentRepo } from './native-repo-independent-paths';
import { nativeLoroDocumentManifestSchema } from './native-loro-document-manifest';
export type LocalNativeSessionBinding = {
  readonly accountId: string;
  readonly workspaceId: WorkspaceId;
  readonly dataRoot: string;
};
export function resolveLocalNativeSessionPaths(options: LocalNativeSessionBinding) {
  const selected = resolveLocalIndependentRepo({ platform: 'local', ...options });
  return {
    ...selected,
    journalPath: join(selected.directory, 'session-routes.sqlite3'),
    migrationBinding: JSON.stringify([options.accountId, options.workspaceId]),
  };
}
/** Pure admission read: no engine launch, directory creation, migration or
 * fallback on corrupt/unknown journal state. Only explicitly selected bodies
 * change owner. Workspace Meta and Roost history remain independent. */
export function readLocalNativeSessionMigration(
  options: LocalNativeSessionBinding,
  roomId: string
):
  | {
      stage: 'legacy' | 'frozen' | 'native' | 'rollback';
      manifest: import('./native-loro-document-manifest').NativeLoroDocumentManifest;
    }
  | undefined {
  if (!roomId.startsWith('session-') || roomId.length === 8) return undefined;
  const selected = resolveLocalNativeSessionPaths(options);
  if (!existsSync(selected.journalPath)) return undefined;
  const db = new DatabaseSync(selected.journalPath, { readOnly: true, timeout: 0 });
  try {
    const row = db
      .prepare(
        'SELECT manifest,stage FROM native_loro_document_migrations WHERE binding=? AND room_id=?'
      )
      .get(selected.migrationBinding, roomId) as { manifest: string; stage: string } | undefined;
    if (!row) return undefined;
    const manifest = nativeLoroDocumentManifestSchema.parse(JSON.parse(row.manifest));
    if (
      manifest.family !== 'session' ||
      manifest.binding !== selected.migrationBinding ||
      manifest.namespace !== options.workspaceId ||
      manifest.roomId !== roomId
    )
      throw new Error('Native Session route identity mismatch');
    if (
      row.stage !== 'legacy' &&
      row.stage !== 'frozen' &&
      row.stage !== 'native' &&
      row.stage !== 'rollback'
    )
      throw new Error('Unsupported native Session route stage');
    return { stage: row.stage, manifest };
  } finally {
    db.close();
  }
}
/** Pure route admission shares the exact readonly manifest validation used by
 * recovery; malformed local state never grants the legacy writer. */
export function readLocalNativeSessionRoute(
  options: LocalNativeSessionBinding,
  roomId: string
): 'legacy' | 'frozen' | 'native' {
  const row = readLocalNativeSessionMigration(options, roomId);
  if (!row || row.stage === 'legacy') return 'legacy';
  return row.stage === 'native' ? 'native' : 'frozen';
}

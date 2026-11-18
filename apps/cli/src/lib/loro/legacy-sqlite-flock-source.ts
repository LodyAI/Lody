import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { Flock } from '@loro-dev/flock-wasm';

/**
 * Read-only compatibility boundary for loro-repo@0.25.0's default SQLite layout.
 * The caller must separately freeze/drain every legacy writer before using this
 * as a migration source. A consistent read alone does not establish ownership.
 */
export function readLegacySqliteFlockSource(options: {
  readonly databasePath: string;
  readonly room: { readonly kind: 'flock' | 'meta'; readonly id: string };
  readonly maxBytes?: number;
}): { readonly present: boolean; readonly snapshot: Uint8Array } {
  if (options.room.kind === 'meta' && options.room.id !== 'meta')
    throw new Error('Invalid legacy metadata room');
  if (!options.room.id || options.room.id.includes('\0')) throw new Error('Invalid legacy room');
  const limit = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error('Invalid migration source budget');
  const database = new Database(options.databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 0,
  });
  try {
    const parts = database.transaction(() => {
      const meta = options.room.kind === 'meta';
      const snapshots = meta ? 'meta_snapshot' : 'flock_docs';
      const updates = meta ? 'meta_updates' : 'flock_doc_updates';
      const expected = meta
        ? ['id', 'snapshot', 'updated_at', 'snapshot_digest']
        : ['flock_doc_id', 'snapshot', 'updated_at', 'snapshot_digest'];
      const expectedUpdates = meta
        ? ['id', 'update_data', 'created_at']
        : ['id', 'flock_doc_id', 'update_data', 'created_at'];
      for (const [table, names] of [
        [snapshots, expected],
        [updates, expectedUpdates],
      ] as const) {
        const actual = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
          name: string;
        }>;
        if (JSON.stringify(actual.map((column) => column.name)) !== JSON.stringify(names))
          throw new Error('Unsupported legacy Flock SQLite layout');
      }
      const sizes = (
        meta
          ? database
              .prepare(
                'SELECT COUNT(*) AS count, COALESCE(SUM(length(update_data)), 0) AS bytes FROM meta_updates'
              )
              .get()
          : database
              .prepare(
                'SELECT COUNT(*) AS count, COALESCE(SUM(length(update_data)), 0) AS bytes FROM flock_doc_updates WHERE flock_doc_id = ?'
              )
              .get(options.room.id)
      ) as { count: number; bytes: number };
      const baseSize = (
        meta
          ? database
              .prepare('SELECT length(snapshot) AS bytes FROM meta_snapshot WHERE id = 1')
              .get()
          : database
              .prepare('SELECT length(snapshot) AS bytes FROM flock_docs WHERE flock_doc_id = ?')
              .get(options.room.id)
      ) as { bytes: number } | undefined;
      if (sizes.count > 65536 || sizes.bytes + (baseSize?.bytes ?? 0) > limit)
        throw new Error('Legacy Flock migration source exceeds its budget');
      const base = (
        meta
          ? database
              .prepare('SELECT snapshot, snapshot_digest FROM meta_snapshot WHERE id = 1')
              .get()
          : database
              .prepare('SELECT snapshot, snapshot_digest FROM flock_docs WHERE flock_doc_id = ?')
              .get(options.room.id)
      ) as { snapshot: Buffer; snapshot_digest: string | null } | undefined;
      if (
        base?.snapshot_digest &&
        createHash('sha256').update(base.snapshot).digest('hex') !== base.snapshot_digest
      )
        throw new Error('Legacy Flock snapshot digest mismatch');
      const rows = (
        meta
          ? database.prepare('SELECT update_data FROM meta_updates ORDER BY id').all()
          : database
              .prepare(
                'SELECT update_data FROM flock_doc_updates WHERE flock_doc_id = ? ORDER BY id'
              )
              .all(options.room.id)
      ) as Array<{ update_data: Buffer }>;
      const raw = [...(base ? [base.snapshot] : []), ...rows.map((row) => row.update_data)];
      if (raw.reduce((size, bytes) => size + bytes.byteLength, 0) > limit)
        throw new Error('Legacy Flock migration source exceeds its budget');
      return raw.map((bytes) => Uint8Array.from(bytes));
    })();
    const flock = new Flock();
    for (const bytes of parts) {
      const magic = String.fromCharCode(...bytes.subarray(0, 4));
      if (magic === 'FLOK' || magic === 'FLK2' || magic === 'FLKD') flock.strictImportFile(bytes);
      else
        flock.importJson(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            (_key, value: unknown, context?: { source?: string }) => {
              if (typeof value !== 'number') return value;
              if (!Number.isFinite(value)) throw new Error('Invalid legacy JSON numeric value');
              if (!Number.isInteger(value) || Number.isSafeInteger(value)) return value;
              if (!context?.source || !/^-?\d+$/.test(context.source))
                throw new Error('Lossless legacy JSON integer parsing is unavailable');
              const exact = BigInt(context.source);
              if (exact < -(1n << 63n) || exact > (1n << 63n) - 1n)
                throw new Error('Legacy JSON integer exceeds signed i64');
              return exact;
            }
          )
        );
    }
    const snapshot = flock.exportFile();
    if (snapshot.byteLength > limit) throw new Error('Legacy Flock export exceeds its budget');
    return { present: parts.length > 0, snapshot };
  } finally {
    database.close();
  }
}

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LoroDoc } from 'loro-crdt';
/** Exact old loro-repo docs/doc_updates layout; BEGIN reads a consistent base
 * and complete update log, without writer lease, migration or compaction. */
export function readFrozenLegacyLoroDocumentSqlite(options: {
  path: string;
  roomId: string;
  sourceId: string;
  hashDomain?: string;
  maxBytes?: number;
}) {
  const sourceId = options.sourceId;
  if (!sourceId || !options.roomId) throw new Error('Legacy document identity required');
  const parts: Uint8Array[] = [];
  if (existsSync(options.path)) {
    const db = new DatabaseSync(options.path, { readOnly: true, timeout: 0 });
    try {
      db.exec('BEGIN');
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('docs','doc_updates')"
        )
        .all();
      if (tables.length !== 2) throw new Error('Unsupported legacy Session SQLite layout');
      if (options.maxBytes !== undefined) {
        if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
          throw new Error('Invalid document capture budget');
        const updatesSize = db
          .prepare(
            'SELECT COUNT(*) AS count, COALESCE(SUM(length(update_data)),0) AS bytes FROM doc_updates WHERE doc_id=?'
          )
          .get(options.roomId) as { count: number; bytes: number };
        const baseSize = db
          .prepare('SELECT length(snapshot) AS bytes FROM docs WHERE doc_id=?')
          .get(options.roomId) as { bytes: number } | undefined;
        if (
          updatesSize.count > 65536 ||
          updatesSize.bytes + (baseSize?.bytes ?? 0) > options.maxBytes
        )
          throw new Error('Legacy document source exceeds budget');
      }
      const base = db.prepare('SELECT snapshot FROM docs WHERE doc_id=?').get(options.roomId) as
        | { snapshot: Uint8Array }
        | undefined;
      const updates = db
        .prepare('SELECT update_data FROM doc_updates WHERE doc_id=? ORDER BY id')
        .all(options.roomId) as { update_data: Uint8Array }[];
      if (base) parts.push(Uint8Array.from(base.snapshot));
      for (const update of updates) parts.push(Uint8Array.from(update.update_data));
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (rollback) {
        throw new AggregateError([error, rollback], 'Legacy Session readonly transaction failed');
      }
      throw error;
    } finally {
      db.close();
    }
  }
  const byteLength = parts.reduce((size, bytes) => size + bytes.byteLength, 0);
  if (byteLength > (options.maxBytes ?? Number.MAX_SAFE_INTEGER))
    throw new Error('Legacy document source exceeds budget');
  const hash = createHash('sha256').update(
    `${options.hashDomain ?? 'lody-legacy-loro-document'}:${parts.length}:`
  );
  for (const bytes of parts) hash.update(`${bytes.byteLength}:`).update(bytes);
  let snapshot = new Uint8Array();
  if (parts.length) {
    const doc = new LoroDoc();
    try {
      const imported = doc.importBatch(parts);
      if (imported.pending?.size)
        throw new Error('Legacy Session persisted causal inventory is incomplete');
      snapshot = Uint8Array.from(doc.export({ mode: 'snapshot' }));
    } finally {
      doc.free();
    }
  }
  return { sourceId, present: parts.length > 0, sha256: hash.digest('hex'), byteLength, snapshot };
}

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { NativeFlockRoom } from './native-repo-migration';
const roomSchema = z.object({ kind: z.enum(['flock', 'meta']), id: z.string().min(1) }).strict();
const txSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export type NativeFlockSnapshot = {
  readonly namespace: string;
  readonly room: NativeFlockRoom;
  readonly roomTxId: number;
  readonly bytes: Uint8Array;
  readonly sha256: string;
};

/**
 * Read one consistent, fully compacted snapshot, including committed WAL pages.
 * Caller compacts through the engine first. An intervening write makes this fail
 * rather than return a stale snapshot. This does not stop or freeze any writer.
 * No engine is opened, SQL written, checkpoint copied, or room joined here.
 */
export function readNativeFlockSnapshot(args: {
  readonly dataDir: string;
  readonly namespace: string;
  readonly room: NativeFlockRoom;
}): NativeFlockSnapshot {
  const namespace = z.string().min(1).parse(args.namespace);
  const room = roomSchema.parse(args.room);
  const database = new Database(
    path.join(args.dataDir, 'namespaces', `ns_${Buffer.from(namespace).toString('hex')}.sqlite3`),
    { readonly: true, fileMustExist: true, timeout: 0 }
  );
  try {
    return database.transaction(() => {
      const version = z
        .object({ v: z.literal(1) })
        .safeParse(database.prepare("SELECT v FROM v2_meta WHERE k = 'schema_version'").get());
      if (!version.success) throw new Error('Unsupported native Repo migration schema');
      const row = z
        .object({
          head: txSchema,
          compacted: txSchema,
          snapshotTx: txSchema,
          encryption: z.literal(0),
          bytes: z.instanceof(Uint8Array),
        })
        .safeParse(
          database
            .prepare(`
        SELECT r.head_tx_id AS head, r.compacted_through_tx AS compacted,
               r.encryption, s.tx_id AS snapshotTx, s.snapshot AS bytes
        FROM v2_rooms r LEFT JOIN v2_room_snapshots s
          ON r.room_kind = s.room_kind AND r.room_id = s.room_id
        WHERE r.room_kind = ? AND r.room_id = ?
      `)
            .get(room.kind === 'flock' ? 2 : 3, room.id)
        );
      if (
        !row.success ||
        row.data.head !== row.data.compacted ||
        row.data.head !== row.data.snapshotTx ||
        row.data.bytes.length === 0
      ) {
        throw new Error('Native Flock snapshot is missing, protected, or not fully compacted');
      }
      const bytes = Uint8Array.from(row.data.bytes);
      return { namespace, room, roomTxId: row.data.head, bytes, sha256: digest(bytes) };
    })();
  } finally {
    database.close();
  }
}

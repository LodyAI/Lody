import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

// Acceptance probe for the exact 0.1.0 storage at source 1d80000.
// NOT a product storage API. Never writes SQL, opens an engine, copies a live
// database without its WAL, or treats a stale snapshot as the current room.
export function readCompactedFlock(dataDir, namespace, room) {
  if (room.kind !== 'flock' && room.kind !== 'meta') throw new Error('Flock room required')
  const path = join(dataDir, 'namespaces', `ns_${Buffer.from(namespace).toString('hex')}.sqlite3`)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('BEGIN')
    const version = db.prepare("SELECT v FROM v2_meta WHERE k = 'schema_version'").get()?.v
    if (version !== 1) throw new Error('Unsupported native Repo schema')
    const state = db
      .prepare(`
      SELECT r.head_tx_id AS head, r.compacted_through_tx AS compacted,
             s.tx_id AS snapshotTx, s.snapshot AS bytes
      FROM v2_rooms r LEFT JOIN v2_room_snapshots s
        ON r.room_kind = s.room_kind AND r.room_id = s.room_id
      WHERE r.room_kind = ? AND r.room_id = ?
    `)
      .get(room.kind === 'flock' ? 2 : 3, room.id)
    if (
      !state ||
      state.head !== state.compacted ||
      state.head !== state.snapshotTx ||
      !(state.bytes instanceof Uint8Array)
    ) {
      throw new Error('Room is not fully compacted; refusing incomplete Flock export')
    }
    const result = { roomTxId: state.head, bytes: Uint8Array.from(state.bytes) }
    db.exec('ROLLBACK')
    return result
  } finally {
    db.close()
  }
}

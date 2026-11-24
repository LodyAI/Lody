import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pluginStorageKey, storedJson } from '@lody/shared/plugins/storage';
import type { HostToChildFrame } from '@lody/shared/plugins/ipc-protocol';
import { z } from 'zod';
type Frame = Omit<Extract<HostToChildFrame, { type: 'event' }>, 'contextId'>;
export class PluginStateStore {
  private connection?: DatabaseSync;
  constructor(private readonly root: string) {}
  private get db() {
    if (!this.connection) {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(join(this.root, 'plugin-state.sqlite'));
      db.exec(
        `PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv(plugin TEXT NOT NULL,k TEXT NOT NULL,v TEXT NOT NULL,PRIMARY KEY(plugin,k)); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,frame TEXT NOT NULL);CREATE TABLE IF NOT EXISTS cursors(plugin TEXT NOT NULL,type TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(plugin,type))`
      );
      this.connection = db;
    }
    return this.connection;
  }
  storage(plugin: string, op: string, key: unknown, input: unknown) {
    const k = pluginStorageKey.parse(key),
      db = this.db;
    const read = () => db.prepare('SELECT v FROM kv WHERE plugin=? AND k=?').get(plugin, k)?.v;
    const put = (v: string) =>
      db
        .prepare('INSERT INTO kv VALUES (?,?,?) ON CONFLICT(plugin,k) DO UPDATE SET v=excluded.v')
        .run(plugin, k, v);
    switch (op) {
      case 'storage.get': {
        const v = read();
        return typeof v === 'string' ? { value: JSON.parse(v) } : {};
      }
      case 'storage.delete':
        db.prepare('DELETE FROM kv WHERE plugin=? AND k=?').run(plugin, k);
        return null;
      case 'storage.set':
        put(storedJson(z.strictObject({ value: z.json() }).parse(input).value));
        return null;
      case 'storage.update': {
        const args = z
          .strictObject({ expected: z.json().optional(), value: z.json().optional() })
          .parse(input);
        const expected = args.expected === undefined ? undefined : storedJson(args.expected);
        const value = args.value === undefined ? undefined : storedJson(args.value);
        db.exec('BEGIN IMMEDIATE');
        try {
          const ok = read() === expected;
          if (ok) {
            if (value === undefined)
              db.prepare('DELETE FROM kv WHERE plugin=? AND k=?').run(plugin, k);
            else put(value);
          }
          db.exec('COMMIT');
          return ok;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
      default:
        throw Error('Invalid plugin storage operation');
    }
  }
  record(frame: Frame) {
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO events(id,type,frame) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(
        frame.eventId,
        frame.eventType,
        storedJson(frame)
      );
      const seq = Number(db.prepare('SELECT seq FROM events WHERE id=?').get(frame.eventId)?.seq);
      db.prepare(
        'DELETE FROM events WHERE seq <= (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET 1024)'
      ).run();
      db.exec('COMMIT');
      return seq;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  subscribe(plugin: string, type: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO cursors SELECT ?,?,COALESCE(MAX(seq),0) FROM events')
      .run(plugin, type);
  }
  next(plugin: string, types: readonly string[]) {
    if (!types.length) return;
    const row = this.db
      .prepare(
        `SELECT e.seq,e.frame FROM events e JOIN cursors c ON c.type=e.type WHERE c.plugin=? AND e.seq>c.seq AND e.type IN (${types.map(() => '?').join(',')}) ORDER BY e.seq LIMIT 1`
      )
      .get(plugin, ...types);
    return row
      ? { seq: Number(row.seq), frame: JSON.parse(String(row.frame)) as Frame }
      : undefined;
  }
  ack(plugin: string, type: string, seq: number) {
    this.db
      .prepare('UPDATE cursors SET seq=max(seq,?) WHERE plugin=? AND type=?')
      .run(seq, plugin, type);
  }
  close() {
    this.connection?.close();
    this.connection = undefined;
  }
}

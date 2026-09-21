import { DatabaseSync } from 'node:sqlite';
import { randomBytes, toHex } from './bytes';
import type { Failpoint, IssuedCredential, JoinRequestWire, SpaceInfo } from './protocol';
import { MAX_LEASE_MS } from './protocol';

interface ClockRow {
  now: number | null;
}

export class HostMeta {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS clock (id INTEGER PRIMARY KEY CHECK (id = 1), now INTEGER);
      INSERT OR IGNORE INTO clock (id, now) VALUES (1, NULL);
      CREATE TABLE IF NOT EXISTS failpoints (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL
      );
      INSERT OR IGNORE INTO failpoints (id, name) VALUES (1, 'none');
      CREATE TABLE IF NOT EXISTS credentials (
        token TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        device_hex TEXT NOT NULL,
        genesis_hex TEXT,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        invalidated INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS spaces (
        genesis_hex TEXT PRIMARY KEY,
        owner_device_hex TEXT NOT NULL,
        genesis BLOB NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS join_requests (
        genesis_hex TEXT NOT NULL,
        request_id TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (genesis_hex, request_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS notes (
        genesis_hex TEXT NOT NULL,
        device_hex TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (genesis_hex, device_hex)
      ) STRICT;
    `);
  }

  close(): void {
    this.db.close();
  }

  now(fallback: () => number): number {
    const row = this.db.prepare('SELECT now FROM clock WHERE id = 1').get() as ClockRow | undefined;
    return row?.now == null ? fallback() : row.now;
  }

  setNow(value: number | null): void {
    this.db.prepare('UPDATE clock SET now = ? WHERE id = 1').run(value);
  }

  failpoint(): Failpoint {
    const row = this.db.prepare('SELECT name FROM failpoints WHERE id = 1').get() as
      | { name: string }
      | undefined;
    const name = row?.name ?? 'none';
    if (
      name === 'drop-control-ack' ||
      name === 'kill-after-commit' ||
      name === 'hang-control-ack' ||
      name === 'none'
    ) {
      return name;
    }
    return 'none';
  }

  setFailpoint(name: Failpoint): void {
    this.db.prepare('UPDATE failpoints SET name = ? WHERE id = 1').run(name);
  }

  issueCredential(input: {
    account: string;
    deviceHex: string;
    genesisHex: string | null;
    now: number;
    ttlMs?: number;
  }): IssuedCredential {
    const ttl = input.ttlMs ?? MAX_LEASE_MS;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_LEASE_MS) {
      throw new Error('invalid-lease-window');
    }
    const token = toHex(randomBytes(32));
    const issuedAt = input.now;
    const expiresAt = issuedAt + ttl;
    this.db
      .prepare(
        `INSERT INTO credentials (token, account, device_hex, genesis_hex, issued_at, expires_at, invalidated)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      )
      .run(token, input.account, input.deviceHex, input.genesisHex, issuedAt, expiresAt);
    return {
      token,
      account: input.account,
      deviceHex: input.deviceHex,
      genesisHex: input.genesisHex,
      issuedAt,
      expiresAt,
    };
  }

  credential(token: string): IssuedCredential | null {
    const row = this.db
      .prepare(
        `SELECT token, account, device_hex, genesis_hex, issued_at, expires_at, invalidated
         FROM credentials WHERE token = ?`
      )
      .get(token) as
      | {
          token: string;
          account: string;
          device_hex: string;
          genesis_hex: string | null;
          issued_at: number;
          expires_at: number;
          invalidated: number;
        }
      | undefined;
    if (!row || row.invalidated !== 0) return null;
    return {
      token: row.token,
      account: row.account,
      deviceHex: row.device_hex,
      genesisHex: row.genesis_hex,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
  }

  bindCredential(token: string, genesisHex: string): void {
    this.db
      .prepare('UPDATE credentials SET genesis_hex = ? WHERE token = ? AND genesis_hex IS NULL')
      .run(genesisHex, token);
  }

  invalidateCredential(token: string): void {
    this.db.prepare('UPDATE credentials SET invalidated = 1 WHERE token = ?').run(token);
  }

  putSpace(info: SpaceInfo, genesis: Uint8Array): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO spaces (genesis_hex, owner_device_hex, genesis) VALUES (?, ?, ?)'
      )
      .run(info.genesisHex, info.ownerDeviceHex, Buffer.from(genesis));
  }

  space(genesisHex: string): { info: SpaceInfo; genesis: Uint8Array } | null {
    const row = this.db
      .prepare('SELECT genesis_hex, owner_device_hex, genesis FROM spaces WHERE genesis_hex = ?')
      .get(genesisHex) as
      | { genesis_hex: string; owner_device_hex: string; genesis: Uint8Array }
      | undefined;
    if (!row) return null;
    return {
      info: { genesisHex: row.genesis_hex, ownerDeviceHex: row.owner_device_hex },
      genesis: new Uint8Array(row.genesis),
    };
  }

  putJoin(genesisHex: string, request: JoinRequestWire): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO join_requests (genesis_hex, request_id, body) VALUES (?, ?, ?)'
      )
      .run(genesisHex, request.requestId, JSON.stringify(request));
  }

  joins(genesisHex: string): JoinRequestWire[] {
    const rows = this.db
      .prepare('SELECT body FROM join_requests WHERE genesis_hex = ?')
      .all(genesisHex) as Array<{ body: string }>;
    return rows.map((row) => JSON.parse(row.body) as JoinRequestWire);
  }

  putNote(genesisHex: string, deviceHex: string, body: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO notes (genesis_hex, device_hex, body) VALUES (?, ?, ?)')
      .run(genesisHex, deviceHex, body);
  }

  notes(genesisHex: string): Array<{ deviceHex: string; body: string }> {
    return (
      this.db
        .prepare('SELECT device_hex, body FROM notes WHERE genesis_hex = ?')
        .all(genesisHex) as Array<{ device_hex: string; body: string }>
    ).map((row) => ({ deviceHex: row.device_hex, body: row.body }));
  }
}

/** Credential is expired at the original deadline, including equality. */
export function credentialExpired(now: number, expiresAt: number): boolean {
  return now >= expiresAt;
}

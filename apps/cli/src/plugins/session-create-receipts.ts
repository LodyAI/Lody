import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

type Json = null | string | boolean | number | Json[] | { [key: string]: Json };
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export class ActivePluginBusinessKey extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super('business_key_conflict');
    this.sessionId = sessionId;
  }
}
export interface CreateScope {
  workspaceId: string;
  callerUserId: string;
  canonicalTargetKey: string;
  pluginId: string;
}

/** Reserve the durable session identity before materializing the session document. */
export class SessionCreateReceipts {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS receipts (
        scope TEXT NOT NULL, request TEXT NOT NULL, digest TEXT NOT NULL,
        session TEXT NOT NULL UNIQUE, active_key TEXT,
        PRIMARY KEY(scope,request), UNIQUE(scope,active_key)
      ); CREATE TABLE IF NOT EXISTS receipt_roles(session TEXT PRIMARY KEY, role_json TEXT NOT NULL)`);
  }
  reserve(
    scope: CreateScope,
    requestId: string,
    businessKey: string | null,
    payload: Json,
    initialRole?: object
  ): string {
    const custody = JSON.stringify([
      scope.workspaceId,
      scope.callerUserId,
      scope.canonicalTargetKey,
      scope.pluginId,
    ]);
    const digest = createHash('sha256')
      .update(canonical([businessKey, payload]))
      .digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db
        .prepare('SELECT digest,session FROM receipts WHERE scope=? AND request=?')
        .get(custody, requestId);
      if (prior && prior.digest !== digest) throw new Error('idempotency_conflict');
      const session = prior ? String(prior.session) : randomUUID();
      if (!prior) {
        const active = this.db
          .prepare('SELECT session FROM receipts WHERE scope=? AND active_key=?')
          .get(custody, businessKey);
        if (active) throw new ActivePluginBusinessKey(String(active.session));
        this.db
          .prepare(
            'INSERT INTO receipts(scope,request,digest,session,active_key) VALUES(?,?,?,?,?)'
          )
          .run(custody, requestId, digest, session, businessKey);
        if (initialRole)
          this.db
            .prepare('INSERT INTO receipt_roles(session,role_json) VALUES(?,?)')
            .run(session, JSON.stringify(initialRole));
      }
      this.db.exec('COMMIT');
      return session;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  initialRole(session: string): unknown {
    const row = this.db.prepare('SELECT role_json FROM receipt_roles WHERE session=?').get(session);
    return row ? JSON.parse(String(row.role_json)) : undefined;
  }
  releaseArchived(workspaceId: string, sessionId: string): void {
    this.db
      .prepare(
        "UPDATE receipts SET active_key=NULL WHERE session=? AND json_extract(scope,'$[0]')=?"
      )
      .run(sessionId, workspaceId);
  }
  close(): void {
    this.db.close();
  }
}

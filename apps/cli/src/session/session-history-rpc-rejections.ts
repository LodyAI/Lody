import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { Effect } from 'effect';
import { z } from 'zod';
import {
  LoroStreamsRpcHandlerError,
  SESSION_HISTORY_PRECONDITION_CODES,
  type SessionHistoryRpcRequest,
  type SessionHistoryRpcRejection,
} from '@lody/loro-streams-rpc';

const rejectionSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  code: z.enum(SESSION_HISTORY_PRECONDITION_CODES),
  message: z.string().max(2048),
});
const unavailable = (cause: unknown) => {
  const error = new LoroStreamsRpcHandlerError(
    'session_history_request_state_unavailable',
    'Session history request state is unavailable on the target machine.'
  );
  error.cause = cause;
  return error;
};
const fingerprint = (request: SessionHistoryRpcRequest) =>
  createHash('sha256').update(JSON.stringify(request)).digest('hex');
const identityMismatch = () =>
  new LoroStreamsRpcHandlerError(
    'rpc_request_identity_mismatch',
    'RPC request ID was reused with different parameters.'
  );
const read = (db: Database.Database, request: SessionHistoryRpcRequest, now: number) => {
  const row = db
    .prepare(`SELECT fingerprint, code, message FROM history_rpc_rejections
    WHERE workspace_id = ? AND machine_id = ? AND request_id = ? AND expires_at > ?`)
    .get(request.workspaceId, request.machineId, request.id, now);
  if (!row) return null;
  const saved = rejectionSchema.parse(row);
  if (saved.fingerprint !== fingerprint(request)) throw identityMismatch();
  return { code: saved.code, message: saved.message };
};

/** Each operation owns its SQLite handle; no connection or timer survives a request. */
const withDatabase = <A>(filename: string, operation: (db: Database.Database) => A) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
        return new Database(filename, { timeout: 5_000 });
      },
      catch: unavailable,
    }),
    (db) =>
      Effect.try({
        try: () => {
          db.pragma('synchronous = FULL');
          db.exec(`CREATE TABLE IF NOT EXISTS history_rpc_rejections (
        workspace_id TEXT NOT NULL, machine_id TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL,
        code TEXT NOT NULL, message TEXT NOT NULL,
        PRIMARY KEY (workspace_id, machine_id, request_id)
      ) WITHOUT ROWID`);
          return operation(db);
        },
        catch: (cause) =>
          cause instanceof LoroStreamsRpcHandlerError ? cause : unavailable(cause),
      }),
    (db) => Effect.sync(() => db.close())
  );

export const getSessionHistoryRpcRejection = Effect.fn('getSessionHistoryRpcRejection')(
  (filename: string, request: SessionHistoryRpcRequest, now: number) =>
    withDatabase(filename, (db) => read(db, request, now))
);

export const putSessionHistoryRpcRejection = Effect.fn('putSessionHistoryRpcRejection')(
  (
    filename: string,
    request: SessionHistoryRpcRequest,
    rejection: SessionHistoryRpcRejection,
    now: number
  ) =>
    withDatabase(filename, (db) =>
      db
        .transaction(() => {
          db.prepare('DELETE FROM history_rpc_rejections WHERE expires_at <= ?').run(now);
          const saved = read(db, request, now);
          if (saved) return saved;
          const validated = rejectionSchema.parse({
            fingerprint: fingerprint(request),
            ...rejection,
          });
          db.prepare(`INSERT INTO history_rpc_rejections
        (workspace_id, machine_id, request_id, fingerprint, expires_at, code, message)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            request.workspaceId,
            request.machineId,
            request.id,
            validated.fingerprint,
            request.expiresAt,
            validated.code,
            validated.message
          );
          return { code: validated.code, message: validated.message };
        })
        .immediate()
    )
);

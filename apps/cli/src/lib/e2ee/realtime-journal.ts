import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';

const keySchema = z.object({
  genesis: z.string().min(1),
  workspaceId: z.string().min(1),
  targetMachineId: z.string().min(1),
  requestId: z.string().min(1),
});
const requestSchema = keySchema.extend({
  requester: z.string().min(1),
  expiresAt: z.number().int().nonnegative().safe(),
  frame: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0),
});
const rowSchema = z.object({
  requester: z.string().min(1),
  expires_at: z.number().int().nonnegative().safe(),
  frame: z.instanceof(Uint8Array),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(['received', 'started', 'completed']),
  claim: z.string().nullable(),
  outcome: z.instanceof(Uint8Array).nullable(),
  outcome_digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
const responseSchema = z.object({
  index: z.number().int().nonnegative().safe(),
  frame: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0),
});
const responseRowSchema = z.object({
  frame: z.instanceof(Uint8Array),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type RealtimeRequestKey = z.infer<typeof keySchema>;
/** Internal host input only. The caller must independently verify and authorize the frame. */
export type RealtimeJournalRequest = z.infer<typeof requestSchema>;
export type RealtimeJournalRecord = RealtimeJournalRequest & {
  readonly digest: string;
} & (
    | { readonly state: 'received' | 'uncertain' }
    | { readonly state: 'completed'; readonly outcome: Uint8Array }
  );

const permitBrand: unique symbol = Symbol('RealtimeStartPermit');
export type RealtimeStartPermit = { readonly [permitBrand]: true };

export class RealtimeJournalError extends Error {
  constructor(
    readonly code:
      | 'storage'
      | 'identity_conflict'
      | 'missing'
      | 'permit'
      | 'outcome_conflict'
      | 'response_conflict'
      | 'response_gap',
    cause?: unknown
  ) {
    super(`E2EE realtime journal: ${code}`, { cause });
    this.name = 'RealtimeJournalError';
  }
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sameBytes = (left: Uint8Array, right: Uint8Array) => Buffer.from(left).equals(right);
const copyRequest = (input: RealtimeJournalRequest): RealtimeJournalRequest => {
  const parsed = requestSchema.parse(input);
  return { ...parsed, frame: Uint8Array.from(parsed.frame) };
};
const keyValues = (key: RealtimeRequestKey) => [
  key.genesis,
  key.workspaceId,
  key.targetMachineId,
  key.requestId,
];
const whereKey = 'genesis = ? AND workspace_id = ? AND target_machine_id = ? AND request_id = ?';
// The position is a local storage slot, not an application wire sequence field.
const responseTable = `CREATE TABLE realtime_responses (
  genesis TEXT NOT NULL, workspace_id TEXT NOT NULL,
  target_machine_id TEXT NOT NULL, request_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(typeof(position) = 'integer' AND position >= 0),
  frame BLOB NOT NULL, digest TEXT NOT NULL,
  PRIMARY KEY (genesis, workspace_id, target_machine_id, request_id, position),
  FOREIGN KEY (genesis, workspace_id, target_machine_id, request_id)
    REFERENCES realtime_requests (genesis, workspace_id, target_machine_id, request_id)
) WITHOUT ROWID`;

/**
 * Host-only persistence leaf; intentionally unconnected to RPC and agent execution.
 * A started row is never made runnable again, including after crash/reopen. This
 * cannot replace fencing the dispatch watcher and its durable Meta fallback.
 */
export class RealtimeJournal {
  private readonly permits = new WeakMap<
    RealtimeStartPermit,
    {
      request: RealtimeJournalRequest;
      claim: string;
      outcome?: Uint8Array;
      pendingResponse?: { index: number; frame: Uint8Array };
    }
  >();
  private readonly pendingClose = new Map<Database.Database, unknown>();
  private readonly cleanupErrors: unknown[] = [];

  constructor(
    private readonly filename: string,
    private readonly now: () => number
  ) {}

  /** Explicit first provisioning only. Restart/open must use the constructor. */
  static create(filename: string, now: () => number): RealtimeJournal {
    try {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      const fd = openSync(filename, 'wx', 0o600);
      closeSync(fd);
    } catch (cause) {
      throw new RealtimeJournalError('storage', cause);
    }
    const journal = new RealtimeJournal(filename, now);
    journal.withDatabase(() => undefined, true);
    return journal;
  }

  /** Diagnostic causes stay in the host; consuming them does not release failed handles. */
  takeCleanupErrors(): unknown[] {
    return this.cleanupErrors.splice(0);
  }

  retryCleanup(): void {
    for (const db of this.pendingClose.keys()) {
      if (this.closeDatabase(db).closed) this.pendingClose.delete(db);
    }
  }

  private closeDatabase(
    db: Database.Database
  ): { closed: true } | { closed: false; cause: unknown } {
    try {
      if (db.open) db.close();
      return { closed: true };
    } catch (cause) {
      const original = this.pendingClose.has(db) ? this.pendingClose.get(db) : cause;
      this.pendingClose.set(db, original);
      if (this.cleanupErrors.length === 0) this.cleanupErrors.push(original);
      return { closed: false, cause: original };
    }
  }

  private withDatabase<A>(body: (db: Database.Database) => A, provision = false): A {
    this.retryCleanup();
    if (this.pendingClose.size > 0)
      throw new RealtimeJournalError('storage', this.pendingClose.values().next().value);
    let db: Database.Database | undefined;
    try {
      // Restart and I/O recovery never create a missing or empty replacement.
      db = new Database(this.filename, { timeout: 0, fileMustExist: true });
      // Native SQLite rollback/checkpoint may change physical files before this
      // read-only application validation. No application migration, replacement,
      // permission change or mutation setting is allowed for an unknown schema.
      if (!provision) this.ensureSchema(db);
      chmodSync(this.filename, 0o600);
      db.pragma('synchronous = FULL');
      db.pragma('foreign_keys = ON');
      if (provision) {
        const database = db;
        database
          .transaction(() =>
            database.exec(`CREATE TABLE realtime_requests (
        genesis TEXT NOT NULL, workspace_id TEXT NOT NULL,
        target_machine_id TEXT NOT NULL, request_id TEXT NOT NULL,
        requester TEXT NOT NULL, expires_at INTEGER NOT NULL,
        frame BLOB NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('received', 'started', 'completed')),
        claim TEXT, outcome BLOB, outcome_digest TEXT,
        PRIMARY KEY (genesis, workspace_id, target_machine_id, request_id),
        CHECK ((state = 'received' AND claim IS NULL AND outcome IS NULL AND outcome_digest IS NULL)
          OR (state = 'started' AND claim IS NOT NULL AND outcome IS NULL AND outcome_digest IS NULL)
          OR (state = 'completed' AND claim IS NOT NULL AND outcome IS NOT NULL AND outcome_digest IS NOT NULL))
      ) WITHOUT ROWID;
      CREATE TABLE realtime_clock (
        id INTEGER PRIMARY KEY CHECK(id = 1), observed_at INTEGER NOT NULL
      ); ${responseTable}; PRAGMA user_version = 2;`)
          )
          .immediate();
      }
      this.ensureSchema(db);
      return body(db);
    } catch (cause) {
      if (cause instanceof RealtimeJournalError) throw cause;
      throw new RealtimeJournalError('storage', cause);
    } finally {
      // A committed result stays successful; this owner retains cleanup.
      if (db) this.closeDatabase(db);
    }
  }

  private ensureSchema(db: Database.Database): void {
    const version = db.pragma('user_version', { simple: true });
    if (version !== 2) throw new Error('Unsupported or incomplete realtime journal');
    db.prepare(`SELECT genesis, workspace_id, target_machine_id, request_id,
      requester, expires_at, frame, digest, state, claim, outcome, outcome_digest
      FROM realtime_requests LIMIT 0`).all();
    db.prepare('SELECT id, observed_at FROM realtime_clock LIMIT 0').all();
    // No application migration, repair or reset. SQLite owns native recovery.
    db.prepare(`SELECT genesis, workspace_id, target_machine_id, request_id,
      position, frame, digest FROM realtime_responses LIMIT 0`).all();
  }

  private readRow(db: Database.Database, key: RealtimeRequestKey) {
    const raw = db
      .prepare(`SELECT requester, expires_at, frame, digest, state, claim, outcome, outcome_digest
        FROM realtime_requests WHERE ${whereKey}`)
      .get(...keyValues(key));
    if (raw === undefined) return null;
    const row = rowSchema.parse(raw);
    if (
      row.frame.byteLength === 0 ||
      row.digest !== digest(row.frame) ||
      (row.state === 'received' &&
        (row.claim !== null || row.outcome !== null || row.outcome_digest !== null)) ||
      (row.state === 'started' &&
        (!row.claim || row.outcome !== null || row.outcome_digest !== null)) ||
      (row.state === 'completed' &&
        (!row.claim || row.outcome === null || row.outcome_digest !== digest(row.outcome)))
    )
      throw new Error('Invalid realtime journal evidence');
    return row;
  }

  private record(key: RealtimeRequestKey, row: z.infer<typeof rowSchema>): RealtimeJournalRecord {
    const request = {
      ...key,
      requester: row.requester,
      expiresAt: row.expires_at,
      frame: Uint8Array.from(row.frame),
      digest: row.digest,
    };
    return row.state === 'completed' && row.outcome !== null
      ? { ...request, state: 'completed', outcome: Uint8Array.from(row.outcome) }
      : { ...request, state: row.state === 'received' ? 'received' : 'uncertain' };
  }

  private matching(db: Database.Database, request: RealtimeJournalRequest) {
    const row = this.readRow(db, request);
    if (!row) throw new RealtimeJournalError('missing');
    if (
      row.requester !== request.requester ||
      row.expires_at !== request.expiresAt ||
      !sameBytes(row.frame, request.frame)
    )
      throw new RealtimeJournalError('identity_conflict');
    return row;
  }

  private response(db: Database.Database, request: RealtimeRequestKey, index: number) {
    const raw = db
      .prepare(`SELECT frame, digest FROM realtime_responses WHERE ${whereKey} AND position = ?`)
      .get(...keyValues(request), index);
    if (raw === undefined) return null;
    const row = responseRowSchema.parse(raw);
    if (row.frame.byteLength === 0 || row.digest !== digest(row.frame))
      throw new Error('Invalid realtime response evidence');
    return Uint8Array.from(row.frame);
  }

  receive(input: RealtimeJournalRequest): RealtimeJournalRecord {
    const request = copyRequest(input);
    return this.withDatabase((db) =>
      db
        .transaction(() => {
          db.prepare(`INSERT OR IGNORE INTO realtime_requests
          (genesis, workspace_id, target_machine_id, request_id, requester,
           expires_at, frame, digest, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received')`).run(
            ...keyValues(request),
            request.requester,
            request.expiresAt,
            Buffer.from(request.frame),
            digest(request.frame)
          );
          return this.record(request, this.matching(db, request));
        })
        .immediate()
    );
  }

  read(input: RealtimeRequestKey): RealtimeJournalRecord | null {
    const key = keySchema.parse(input);
    return this.withDatabase((db) => {
      const row = this.readRow(db, key);
      return row ? this.record(key, row) : null;
    });
  }

  /** Caller must recheck verified permissions immediately before this local claim. */
  claim(
    input: RealtimeJournalRequest
  ):
    | { state: 'claimed'; permit: RealtimeStartPermit }
    | { state: 'expired'; record: RealtimeJournalRecord }
    | { state: 'existing'; record: RealtimeJournalRecord } {
    const request = copyRequest(input);
    const claimed = this.withDatabase((db) =>
      db
        .transaction(() => {
          const row = this.matching(db, request);
          if (row.state !== 'received')
            return { state: 'existing' as const, record: this.record(request, row) };
          const current = z.number().int().nonnegative().safe().parse(this.now());
          const observed = db.prepare('SELECT observed_at FROM realtime_clock WHERE id = 1').get();
          const previous = observed
            ? z.object({ observed_at: z.number().int().nonnegative().safe() }).parse(observed)
                .observed_at
            : 0;
          const now = Math.max(current, previous);
          db.prepare(`INSERT INTO realtime_clock (id, observed_at) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET observed_at = excluded.observed_at`).run(now);
          if (request.expiresAt <= now)
            return { state: 'expired' as const, record: this.record(request, row) };
          const claim = randomUUID();
          const changed = db
            .prepare(`UPDATE realtime_requests SET state = 'started', claim = ?
            WHERE ${whereKey} AND state = 'received'`)
            .run(claim, ...keyValues(request));
          if (changed.changes !== 1 || this.matching(db, request).claim !== claim)
            throw new Error('Realtime journal start claim was not retained');
          return { state: 'claimed' as const, claim };
        })
        .immediate()
    );
    if (claimed.state !== 'claimed') return claimed;
    const permit: RealtimeStartPermit = Object.freeze({ [permitBrand]: true });
    this.permits.set(permit, {
      request: { ...request, frame: Uint8Array.from(request.frame) },
      claim: claimed.claim,
    });
    return { state: 'claimed', permit };
  }

  /** Repeating an identical finish is safe; no other result may replace the first. */
  finish(permit: RealtimeStartPermit, outcome: Uint8Array): RealtimeJournalRecord {
    const owned = this.permits.get(permit);
    if (!owned) throw new RealtimeJournalError('permit');
    const bytes = Uint8Array.from(z.instanceof(Uint8Array).parse(outcome));
    if (owned.outcome && !sameBytes(owned.outcome, bytes))
      throw new RealtimeJournalError('outcome_conflict');
    owned.outcome ??= Uint8Array.from(bytes);
    return this.withDatabase((db) =>
      db
        .transaction(() => {
          const row = this.matching(db, owned.request);
          if (row.claim !== owned.claim) throw new RealtimeJournalError('permit');
          if (row.state === 'completed') {
            if (row.outcome === null || !sameBytes(row.outcome, bytes))
              throw new RealtimeJournalError('outcome_conflict');
            return this.record(owned.request, row);
          }
          if (row.state !== 'started') throw new RealtimeJournalError('permit');
          const changed = db
            .prepare(`UPDATE realtime_requests SET state = 'completed', outcome = ?, outcome_digest = ?
            WHERE ${whereKey} AND state = 'started' AND claim = ?`)
            .run(Buffer.from(bytes), digest(bytes), ...keyValues(owned.request), owned.claim);
          const completed = this.matching(db, owned.request);
          if (
            changed.changes !== 1 ||
            completed.state !== 'completed' ||
            completed.outcome === null ||
            !sameBytes(completed.outcome, bytes)
          )
            throw new Error('Realtime journal result was not retained');
          return this.record(owned.request, completed);
        })
        .immediate()
    );
  }

  /** I/O recovery retries the retained first result, never the business action. */
  retryFinish(permit: RealtimeStartPermit): RealtimeJournalRecord {
    const owned = this.permits.get(permit);
    if (!owned?.outcome) throw new RealtimeJournalError('permit');
    return this.finish(permit, owned.outcome);
  }

  /** Persist the already signed/encrypted original before either channel publishes it.
   * Slots are contiguous local positions starting at zero, not approved wire indices.
   * Started/completed owners may retain responses; this never changes the outcome. */
  retainResponse(
    permit: RealtimeStartPermit,
    input: { readonly index: number; readonly frame: Uint8Array }
  ): Uint8Array {
    const owned = this.permits.get(permit);
    if (!owned) throw new RealtimeJournalError('permit');
    const parsed = responseSchema.parse(input);
    const index = parsed.index;
    const frame = Uint8Array.from(parsed.frame);
    if (
      owned.pendingResponse &&
      (owned.pendingResponse.index !== index || !sameBytes(owned.pendingResponse.frame, frame))
    )
      throw new RealtimeJournalError('response_conflict');
    const saved = this.withDatabase((db) =>
      db
        .transaction(() => {
          const request = this.matching(db, owned.request);
          if (request.claim !== owned.claim || request.state === 'received')
            throw new RealtimeJournalError('permit');
          const existing = this.response(db, owned.request, index);
          if (existing) {
            if (!sameBytes(existing, frame)) throw new RealtimeJournalError('response_conflict');
            return existing;
          }
          const positions = z
            .object({
              count: z.number().int().nonnegative().safe(),
              last: z.number().int().min(-1).safe(),
            })
            .parse(
              db
                .prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(position), -1) AS last
          FROM realtime_responses WHERE ${whereKey}`)
                .get(...keyValues(owned.request))
            );
          if (positions.last !== positions.count - 1)
            throw new Error('Invalid realtime response positions');
          if (index !== positions.count) throw new RealtimeJournalError('response_gap');
          // Rejections above never poison the owner. Once writing begins, retain one
          // exact original through uncertainty, even if the transaction rolls back.
          owned.pendingResponse ??= { index, frame };
          db.prepare(`INSERT INTO realtime_responses
          (genesis, workspace_id, target_machine_id, request_id, position, frame, digest)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            ...keyValues(owned.request),
            index,
            Buffer.from(frame),
            digest(frame)
          );
          const retained = this.response(db, owned.request, index);
          if (retained === null || !sameBytes(retained, frame))
            throw new Error('Realtime response was not retained');
          return retained;
        })
        .immediate()
    );
    owned.pendingResponse = undefined;
    return saved;
  }

  /** Retry only the pending original response; never execute, sign or encrypt again. */
  retryResponse(permit: RealtimeStartPermit): Uint8Array {
    const owned = this.permits.get(permit);
    if (!owned?.pendingResponse) throw new RealtimeJournalError('permit');
    return this.retainResponse(permit, owned.pendingResponse);
  }

  /** Match the full original request before reading an owned response copy.
   * Reopening grants no start permit or authority to regenerate a missing frame. */
  readResponse(input: RealtimeJournalRequest, index: number): Uint8Array | null {
    const request = copyRequest(input);
    const position = responseSchema.shape.index.parse(index);
    return this.withDatabase((db) => {
      this.matching(db, request);
      return this.response(db, request, position);
    });
  }
}

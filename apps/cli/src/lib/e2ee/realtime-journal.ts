import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';

const timestamp = z.number().int().nonnegative().safe();
const isExists = (cause: unknown) =>
  cause instanceof Error && 'code' in cause && cause.code === 'EEXIST';
const isEmptyDatabase = (db: Database.Database) =>
  db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get() === undefined;

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
    | { readonly state: 'received' }
    | { readonly state: 'uncertain'; readonly outcomeStatus: 'unknown' }
    | { readonly state: 'completed'; readonly outcome: Uint8Array }
  );

const permitBrand: unique symbol = Symbol('RealtimeStartPermit');
export type RealtimeStartPermit = { readonly [permitBrand]: true };

export class RealtimeJournalError extends Error {
  constructor(
    readonly code:
      | 'storage'
      | 'clock_skew'
      | 'unsupported_schema'
      | 'reset_required'
      | 'journal_reset'
      | 'archived_request'
      | 'identity_conflict'
      | 'missing'
      | 'permit'
      | 'outcome_conflict'
      | 'response_conflict'
      | 'response_gap',
    cause?: unknown,
    readonly archivePath?: string
  ) {
    super(
      code === 'clock_skew'
        ? 'E2EE realtime journal: local clock or retained clock floor is more than 10 minutes ahead of trusted time. Correct your system clock; if already correct, reset the local execution log.'
        : `E2EE realtime journal: ${code}${archivePath !== undefined ? `; evidence: ${archivePath}; run lody e2ee journal reset --file <journal>` : ''}`,
      { cause }
    );
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

  private journalId?: string;

  constructor(
    private readonly filename: string,
    private readonly now: () => number,
    private readonly options: { readonly trustedNow?: () => number | undefined } = {}
  ) {}

  /** Explicit first provisioning only. Restart/open must use the constructor. */
  static create(
    filename: string,
    now: () => number,
    options: { readonly trustedNow?: () => number | undefined } = {}
  ): RealtimeJournal {
    try {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      const fd = openSync(filename, 'wx', 0o600);
      closeSync(fd);
    } catch (cause) {
      throw new RealtimeJournalError('storage', cause);
    }
    const journal = new RealtimeJournal(filename, now, options);
    journal.withDatabase(() => undefined);
    return journal;
  }

  /** Diagnostic causes stay in the host; consuming them does not release failed handles. */
  takeCleanupErrors(): unknown[] {
    return this.cleanupErrors.splice(0);
  }

  retryCleanup(): void {
    for (const db of this.pendingClose.keys()) {
      if (this.closeDatabase(db).closed) this.pendingClose.delete(db);
      else break; // Keep the control lock until the earlier main handle closes.
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

  /** Adapter opens hold a shared control lock; reset/rename requires exclusive access.
   * Locks are released on process death.
   * Never remove this control file: its retired IDs prevent replay across resets. */
  private withControl<A>(body: (control: Database.Database) => A, exclusive = true): A {
    this.retryCleanup();
    if (this.pendingClose.size > 0)
      throw new RealtimeJournalError('storage', this.pendingClose.values().next().value);
    let control: Database.Database | undefined;
    try {
      const lockPath = `${this.filename}.control.sqlite`;
      try {
        closeSync(openSync(lockPath, 'wx', 0o600));
      } catch (cause) {
        if (!isExists(cause)) throw cause;
      }
      control = new Database(lockPath, { timeout: 0, fileMustExist: true });
      const database = control;
      database.pragma('synchronous = FULL');
      database.exec(exclusive ? 'BEGIN EXCLUSIVE' : 'BEGIN DEFERRED');
      const version = database.pragma('user_version', { simple: true });
      if (version === 0 && isEmptyDatabase(database)) {
        database.exec(`CREATE TABLE retired_requests (identity TEXT PRIMARY KEY) WITHOUT ROWID;
          CREATE TABLE pending_reset (id INTEGER PRIMARY KEY CHECK(id = 1),
            archive_path TEXT NOT NULL, replacement_id TEXT NOT NULL, reason TEXT NOT NULL);
          PRAGMA user_version = 1;`);
      } else if (version !== 1) throw new Error('Unsupported realtime journal control store');
      const result = body(database);
      // A confirmed main commit stays successful even if its handle cannot close.
      // Retain the mutex with it so another owner cannot rename an open database.
      if (this.pendingClose.size === 0) database.exec('COMMIT');
      return result;
    } catch (cause) {
      if (cause instanceof RealtimeJournalError) throw cause;
      throw new RealtimeJournalError('storage', cause);
    } finally {
      if (control) {
        if (this.pendingClose.size > 0) {
          this.pendingClose.set(control, this.pendingClose.values().next().value);
        } else this.closeDatabase(control); // close also rolls back failed transactions.
      }
    }
  }

  /** Rename/provision steps require confirmed close; retain original operation failures. */
  private withClosedDatabase<A>(body: (db: Database.Database) => A): A {
    const db = new Database(this.filename, { fileMustExist: true, timeout: 0 });
    let result: A;
    try {
      result = body(db);
    } catch (cause) {
      this.closeDatabase(db);
      throw cause;
    }
    const closed = this.closeDatabase(db);
    if (!closed.closed) throw new RealtimeJournalError('storage', closed.cause);
    return result;
  }

  private pendingReset(control: Database.Database) {
    const row = control
      .prepare('SELECT archive_path, replacement_id, reason FROM pending_reset WHERE id = 1')
      .get();
    return row === undefined
      ? null
      : z
          .object({
            archive_path: z.string(),
            replacement_id: z.string(),
            reason: z.enum(['reset', 'unsupported']),
          })
          .parse(row);
  }

  /** Explicit local operation. Stop execution/dispatch owners before calling.
   * Durable intent precedes rename; retry completes an interrupted reset. */
  reset(): { archivePath: string } {
    try {
      this.stageReset('reset');
    } catch (cause) {
      if (!(cause instanceof RealtimeJournalError) || cause.code !== 'unsupported_schema')
        throw cause;
      this.stageReset('unsupported');
    }
    return this.completeReset(true);
  }

  private stageReset(reason: 'reset' | 'unsupported'): void {
    this.withControl((control) => {
      if (this.pendingReset(control)) return;
      this.withClosedDatabase((db) => {
        if (reason === 'unsupported') {
          let unsupported = false;
          try {
            this.ensureSchema(db);
          } catch (cause) {
            if (!(cause instanceof RealtimeJournalError) || cause.code !== 'unsupported_schema')
              throw cause;
            unsupported = true;
          }
          if (!unsupported) throw new RealtimeJournalError('journal_reset');
        }
        if (reason === 'reset') {
          this.ensureSchema(db);
          // No old-schema decoder. Retain only current request identities, not
          // runnable rows, when the operator explicitly resets this format.
          const retire = control.prepare('INSERT OR IGNORE INTO retired_requests VALUES (?)');
          for (const row of db
            .prepare(
              'SELECT genesis, workspace_id, target_machine_id, request_id FROM realtime_requests'
            )
            .iterate()) {
            const key = z
              .object({
                genesis: z.string(),
                workspace_id: z.string(),
                target_machine_id: z.string(),
                request_id: z.string(),
              })
              .parse(row);
            retire.run(
              digest(
                Buffer.from(
                  JSON.stringify([
                    key.genesis,
                    key.workspace_id,
                    key.target_machine_id,
                    key.request_id,
                  ])
                )
              )
            );
          }
        }
        const replacementId = randomUUID();
        control
          .prepare('INSERT INTO pending_reset VALUES (1, ?, ?, ?)')
          .run(`${this.filename}.archive-${randomUUID()}`, replacementId, reason);
      });
    });
  }

  private completeReset(createReplacement: boolean): { archivePath: string } {
    return this.withControl((control) => {
      const pending = this.pendingReset(control);
      if (!pending) throw new RealtimeJournalError('storage');
      if (!existsSync(pending.archive_path)) {
        this.withClosedDatabase((db) => {
          // Native recovery/checkpoint must finish before renaming. Refuse a
          // busy external reader/writer; never split a WAL/hot journal pair.
          if (db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete')
            throw new RealtimeJournalError('storage');
          db.transaction(() => undefined).exclusive();
        });
        renameSync(this.filename, pending.archive_path);
      }
      if (createReplacement) {
        if (!existsSync(this.filename)) closeSync(openSync(this.filename, 'wx', 0o600));
        this.withClosedDatabase((db) => {
          this.initializeEmpty(db, pending.replacement_id);
          this.ensureSchema(db);
          const id = z
            .object({ id: z.string() })
            .parse(db.prepare('SELECT id FROM realtime_identity').get()).id;
          if (id !== pending.replacement_id) throw new RealtimeJournalError('journal_reset');
        });
        control.prepare('DELETE FROM pending_reset WHERE id = 1').run();
      }
      return { archivePath: pending.archive_path };
    });
  }

  private withDatabase<A>(body: (db: Database.Database, control: Database.Database) => A): A {
    try {
      return this.withControl((control) => {
        const pending = this.pendingReset(control);
        if (pending)
          throw new RealtimeJournalError('reset_required', undefined, pending.archive_path);
        let db: Database.Database | undefined;
        try {
          db = new Database(this.filename, { timeout: 0, fileMustExist: true });
          this.initializeEmpty(db);
          this.ensureSchema(db);
          const id = z
            .object({ id: z.string() })
            .parse(db.prepare('SELECT id FROM realtime_identity').get()).id;
          if (this.journalId !== undefined && id !== this.journalId)
            throw new RealtimeJournalError('journal_reset');
          this.journalId = id;
          chmodSync(this.filename, 0o600);
          db.pragma('synchronous = FULL');
          db.pragma('foreign_keys = ON');
          return body(db, control);
        } finally {
          if (db) this.closeDatabase(db);
        }
      }, false);
    } catch (cause) {
      if (cause instanceof RealtimeJournalError && cause.code === 'unsupported_schema') {
        if (this.pendingClose.size > 0) throw cause;
        this.stageReset('unsupported');
        const { archivePath } = this.completeReset(false);
        throw new RealtimeJournalError('unsupported_schema', cause, archivePath);
      }
      throw cause;
    }
  }

  private initializeEmpty(db: Database.Database, id: string = randomUUID()): void {
    // BEGIN IMMEDIATE serializes interrupted-first-create recovery. SQLite reads
    // the schema after native rollback; only version zero with no objects is empty.
    if (db.pragma('user_version', { simple: true }) !== 0 || !isEmptyDatabase(db)) return;
    db.pragma('synchronous = FULL');
    db.transaction(() => {
      if (db.pragma('user_version', { simple: true }) !== 0 || !isEmptyDatabase(db)) return;
      db.exec(`CREATE TABLE realtime_requests (
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
        genesis TEXT NOT NULL, workspace_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
        PRIMARY KEY (genesis, workspace_id)
      ) WITHOUT ROWID;
      CREATE TABLE realtime_identity (id TEXT PRIMARY KEY) WITHOUT ROWID;
      ${responseTable}; PRAGMA user_version = 3;`);
      db.prepare('INSERT INTO realtime_identity VALUES (?)').run(id);
    }).immediate();
  }

  private ensureSchema(db: Database.Database): void {
    const version = db.pragma('user_version', { simple: true });
    if (version !== 3) throw new RealtimeJournalError('unsupported_schema');
    try {
      db.prepare(`SELECT genesis, workspace_id, target_machine_id, request_id,
      requester, expires_at, frame, digest, state, claim, outcome, outcome_digest
      FROM realtime_requests LIMIT 0`).all();
      db.prepare('SELECT genesis, workspace_id, observed_at FROM realtime_clock LIMIT 0').all();
      db.prepare('SELECT id FROM realtime_identity LIMIT 0').all();
      // No schema migration or evidence repair. SQLite owns native recovery.
      db.prepare(`SELECT genesis, workspace_id, target_machine_id, request_id,
      position, frame, digest FROM realtime_responses LIMIT 0`).all();
    } catch (cause) {
      throw new RealtimeJournalError('unsupported_schema', cause);
    }
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
      : row.state === 'received'
        ? { ...request, state: 'received' }
        : { ...request, state: 'uncertain', outcomeStatus: 'unknown' };
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
    return this.withDatabase((db, control) =>
      db
        .transaction(() => {
          if (
            control
              .prepare('SELECT 1 FROM retired_requests WHERE identity = ?')
              .get(digest(Buffer.from(JSON.stringify(keyValues(request)))))
          )
            throw new RealtimeJournalError('archived_request');
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
          const current = timestamp.parse(this.now());
          // Caller supplies a current independently authenticated reference,
          // never a timestamp taken from this opaque request. No network here.
          const reference = this.options.trustedNow?.();
          if (reference !== undefined && current - timestamp.parse(reference) > 600_000)
            throw new RealtimeJournalError('clock_skew');
          const observed = db
            .prepare(
              'SELECT observed_at FROM realtime_clock WHERE genesis = ? AND workspace_id = ?'
            )
            .get(request.genesis, request.workspaceId);
          const previous = observed
            ? z.object({ observed_at: timestamp }).parse(observed).observed_at
            : 0;
          if (reference !== undefined && previous - reference > 600_000)
            throw new RealtimeJournalError('clock_skew');
          const now = Math.max(reference ?? current, previous);
          db.prepare(`INSERT INTO realtime_clock (genesis, workspace_id, observed_at) VALUES (?, ?, ?)
            ON CONFLICT(genesis, workspace_id) DO UPDATE SET observed_at = excluded.observed_at`).run(
            request.genesis,
            request.workspaceId,
            now
          );
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

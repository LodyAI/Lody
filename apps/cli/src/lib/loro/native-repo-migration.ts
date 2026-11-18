import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Flock } from '@loro-dev/flock-wasm';
import { z } from 'zod';

/** Compatibility is deliberately restricted to the published engine, not SDK main. */
export { NATIVE_REPO_MIGRATION_FORMAT } from '@lody/shared/node/native-repo-migration-format';
import { NATIVE_REPO_MIGRATION_FORMAT } from '@lody/shared/node/native-repo-migration-format';

const roomSchema = z
  .object({
    kind: z.enum(['flock', 'meta']),
    id: z.string().min(1),
  })
  .strict();
export type NativeFlockRoom = z.infer<typeof roomSchema>;
const txSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({ sourceId: z.string().min(1), sha256: digestSchema }).strict();
export type FrozenFlockSource = { readonly sourceId: string; readonly snapshot: Uint8Array };

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export { readNativeFlockSnapshot, type NativeFlockSnapshot } from './native-repo-snapshot';
import type { NativeFlockSnapshot } from './native-repo-snapshot';

const coverageBrand: unique symbol = Symbol('verified-frozen-flock-coverage');
export type VerifiedFlockMigration = {
  readonly [coverageBrand]: true;
  readonly namespace: string;
  readonly room: NativeFlockRoom;
  readonly roomTxId: number;
  readonly snapshotSha256: string;
  readonly sources: ReadonlyArray<z.infer<typeof receiptSchema>>;
};

/** Canonicalize only private shadows. Keeping the same reader peer excludes
 * local identity from the comparison; strict binary import/export preserves
 * values that the legacy JS JSON decoder cannot represent (notably i64).
 * Exact equality is a sufficient proof, never a claim that unequal files are
 * semantically different. Unsupported/noncanonical state remains fail-closed. */
const canonicalFlockBytes = (snapshots: readonly Uint8Array[]): Uint8Array => {
  const shadow = new Flock('lody-read-only-migration-proof-v1');
  for (const snapshot of snapshots) shadow.strictImportFile(snapshot);
  return shadow.exportFile();
};

/** Compare complete CRDT state, including deletion clocks and opaque metadata. */
export function verifyFrozenFlockMigration(
  target: NativeFlockSnapshot,
  sources: readonly FrozenFlockSource[]
): VerifiedFlockMigration {
  if (sources.length === 0)
    throw new Error('Migration requires a complete frozen source inventory');
  const ids = new Set<string>();
  const receipts = sources
    .map((source) => {
      const sourceId = z.string().min(1).parse(source.sourceId);
      if (ids.has(sourceId)) throw new Error('Duplicate frozen Flock source identity');
      ids.add(sourceId);
      return { sourceId, sha256: digest(source.snapshot) };
    })
    .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  if (
    target.sha256 !== digest(target.bytes) ||
    !isDeepStrictEqual(
      canonicalFlockBytes([target.bytes]),
      canonicalFlockBytes(sources.map((source) => source.snapshot))
    )
  ) {
    throw new Error('Native Flock does not cover the exact frozen CRDT source state');
  }
  return {
    [coverageBrand]: true,
    namespace: target.namespace,
    room: roomSchema.parse(target.room),
    roomTxId: txSchema.parse(target.roomTxId),
    snapshotSha256: target.sha256,
    sources: receipts,
  };
}

const intentSchema = z
  .object({
    migrationId: z.string().min(1),
    binding: z.string().min(1),
    namespace: z.string().min(1),
    room: roomSchema,
    targetGeneration: z.string().min(1),
    sources: z.array(receiptSchema).min(1),
    groupRooms: z.array(roomSchema).min(1).optional(),
  })
  .strict();
export type NativeFlockMigrationIntent = z.infer<typeof intentSchema>;
const rollbackBrand: unique symbol = Symbol('verified-legacy-flock-rollback');
export type LegacyFlockRollbackProof = {
  readonly [rollbackBrand]: true;
  readonly intent: NativeFlockMigrationIntent;
  readonly nativeRoomTxId: number;
  readonly nativeSnapshotSha256: string;
  readonly legacyBeforeSha256: string;
  readonly legacyAfterSha256: string;
};

/**
 * Verify the binary legacy result after its real persistence barrier. Both
 * native and legacy producers must stay frozen until the whole group commits.
 * Receipts bind this result to its original migration, not a caller boolean.
 */
export function verifyLegacyFlockRollback(args: {
  readonly intent: NativeFlockMigrationIntent;
  readonly nativeSnapshot: NativeFlockSnapshot;
  readonly legacyBefore: Uint8Array;
  readonly legacyAfter: Uint8Array;
}): LegacyFlockRollbackProof {
  const intent = intentSchema.parse(args.intent);
  const native = args.nativeSnapshot;
  if (
    intent.namespace !== native.namespace ||
    !isDeepStrictEqual(intent.room, native.room) ||
    native.sha256 !== digest(native.bytes)
  ) {
    throw new Error('Rollback snapshot does not match its migration room');
  }
  if (
    !isDeepStrictEqual(
      canonicalFlockBytes([args.legacyBefore, native.bytes]),
      canonicalFlockBytes([args.legacyAfter])
    )
  ) {
    throw new Error('Legacy rollback does not cover the exact old and native CRDT state');
  }
  return {
    [rollbackBrand]: true,
    intent,
    nativeRoomTxId: txSchema.parse(native.roomTxId),
    nativeSnapshotSha256: native.sha256,
    legacyBeforeSha256: digest(args.legacyBefore),
    legacyAfterSha256: digest(args.legacyAfter),
  };
}

export type NativeRoomOwner = 'legacy' | 'frozen' | 'native';
export type NativeRoomMigrationRoute =
  | { readonly owner: 'legacy' }
  | {
      readonly owner: 'frozen' | 'native';
      readonly migrationId: string;
      readonly targetGeneration: string;
    };
const journalRowSchema = z.object({
  intent: z.string(),
  stage: z.enum(['frozen', 'verified', 'native', 'legacy']),
  proof: z.string().nullable(),
});

/**
 * A room routing journal, separate from source/engine databases. The application
 * must drain legacy producers before freeze and consult owner() before admission.
 * A frozen row is not a legacy fallback. This journal cannot fence old binaries.
 * No payloads, tokens, checkpoints or source database paths are stored here.
 */
export class NativeRepoMigrationJournal {
  private readonly database: Database.Database;

  constructor(journalPath: string) {
    this.database = new Database(journalPath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.exec(`CREATE TABLE IF NOT EXISTS native_room_migrations (
      binding TEXT NOT NULL, room_key TEXT NOT NULL, intent TEXT NOT NULL,
      stage TEXT NOT NULL, proof TEXT,
      PRIMARY KEY (binding, room_key)
    ) WITHOUT ROWID`);
    this.database.exec(`CREATE TABLE IF NOT EXISTS native_room_maintenance (
      binding TEXT NOT NULL, room_key TEXT NOT NULL, migration_id TEXT NOT NULL,
      PRIMARY KEY (binding, room_key)
    ) WITHOUT ROWID`);
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  owner(binding: string, room: NativeFlockRoom): NativeRoomOwner {
    return this.route(binding, room).owner;
  }

  route(binding: string, room: NativeFlockRoom): NativeRoomMigrationRoute {
    const row = this.read(binding, room);
    if (!row || row.stage === 'legacy') return { owner: 'legacy' };
    const intent = intentSchema.parse(JSON.parse(row.intent));
    return {
      owner: row.stage === 'native' ? 'native' : 'frozen',
      migrationId: intent.migrationId,
      targetGeneration: intent.targetGeneration,
    };
  }

  getIntent(binding: string, room: NativeFlockRoom): NativeFlockMigrationIntent | undefined {
    const row = this.read(binding, room);
    return row ? intentSchema.parse(JSON.parse(row.intent)) : undefined;
  }

  /** Persistent admission fence, including after a controller/daemon restart. */
  isMaintained(binding: string, room: NativeFlockRoom): boolean {
    return (
      this.database
        .prepare('SELECT 1 FROM native_room_maintenance WHERE binding = ? AND room_key = ?')
        .get(binding, this.key(room)) !== undefined
    );
  }

  beginRollbackGroup(
    binding: string,
    rooms: readonly NativeFlockRoom[],
    migrationId: string
  ): void {
    const groupRooms = [...rooms].sort((a, b) => (this.key(a) < this.key(b) ? -1 : 1));
    if (!rooms.length || new Set(rooms.map((room) => this.key(room))).size !== rooms.length)
      throw new Error('Rollback maintenance requires a distinct complete room group');
    this.database
      .transaction(() => {
        for (const room of groupRooms) {
          const row = this.read(binding, room);
          const intent = row && intentSchema.parse(JSON.parse(row.intent));
          if (
            !row ||
            row.stage !== 'native' ||
            !intent ||
            intent.migrationId !== migrationId ||
            !isDeepStrictEqual(intent.groupRooms ?? [room], groupRooms)
          )
            throw new Error('Rollback maintenance requires the published complete native group');
          const maintenance = this.database
            .prepare(
              'SELECT migration_id FROM native_room_maintenance WHERE binding = ? AND room_key = ?'
            )
            .get(binding, this.key(room)) as { migration_id: string } | undefined;
          if (maintenance && maintenance.migration_id !== migrationId)
            throw new Error('A different rollback maintenance generation is active');
          this.database
            .prepare(
              'INSERT OR IGNORE INTO native_room_maintenance (binding, room_key, migration_id) VALUES (?, ?, ?)'
            )
            .run(binding, this.key(room), migrationId);
        }
      })
      .immediate();
  }

  freeze(input: NativeFlockMigrationIntent): void {
    this.freezeGroup([input]);
  }

  /** FI and FIS use one group: no request can observe a partially frozen pair. */
  freezeGroup(inputs: readonly NativeFlockMigrationIntent[]): void {
    const intents = inputs.map((input) => intentSchema.parse(input));
    const first = intents[0];
    if (!first) throw new Error('Migration group must not be empty');
    const groupRooms = intents
      .map((intent) => intent.room)
      .sort((a, b) => (this.key(a) < this.key(b) ? -1 : 1));
    if (
      new Set(groupRooms.map((room) => this.key(room))).size !== groupRooms.length ||
      intents.some(
        (intent) =>
          intent.binding !== first.binding ||
          intent.migrationId !== first.migrationId ||
          intent.namespace !== first.namespace ||
          intent.targetGeneration !== first.targetGeneration ||
          (intent.groupRooms !== undefined && !isDeepStrictEqual(intent.groupRooms, groupRooms))
      )
    ) {
      throw new Error('Migration group identity or membership mismatch');
    }
    this.database
      .transaction(() => {
        for (const intent of intents) this.freezeOne({ ...intent, groupRooms });
      })
      .immediate();
  }

  /** One routing snapshot; mixed owners must never become a legacy fallback. */
  routeGroup(binding: string, rooms: readonly NativeFlockRoom[]): NativeRoomMigrationRoute {
    return this.database.transaction(() => {
      const routes = rooms.map((room) => this.route(binding, room));
      const first = routes[0];
      if (!first || routes.some((route) => !isDeepStrictEqual(route, first))) {
        throw new Error('Migration group has mixed owners');
      }
      return first;
    })();
  }

  private freezeOne(input: NativeFlockMigrationIntent): void {
    const intent = intentSchema.parse(input);
    const sources = [...intent.sources].sort((a, b) =>
      a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0
    );
    if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) {
      throw new Error('Duplicate frozen Flock source identity');
    }
    const encoded = JSON.stringify({ ...intent, sources });
    this.database
      .transaction(() => {
        const row = this.read(intent.binding, intent.room);
        if (row && row.stage !== 'legacy') {
          if (row.intent === encoded) return;
          throw new Error('Room already has a different migration owner');
        }
        this.database
          .prepare(`INSERT INTO native_room_migrations
        (binding, room_key, intent, stage, proof) VALUES (?, ?, ?, 'frozen', NULL)
        ON CONFLICT(binding, room_key) DO UPDATE SET intent = excluded.intent,
          stage = 'frozen', proof = NULL`)
          .run(intent.binding, this.key(intent.room), encoded);
      })
      .immediate();
  }

  verify(binding: string, migrationId: string, proof: VerifiedFlockMigration): void {
    if (proof[coverageBrand] !== true) throw new Error('Verified CRDT coverage required');
    this.database
      .transaction(() => {
        const row = this.read(binding, proof.room);
        if (!row || row.stage === 'legacy') throw new Error('Room migration is not frozen');
        const intent = intentSchema.parse(JSON.parse(row.intent));
        if (
          intent.migrationId !== migrationId ||
          intent.namespace !== proof.namespace ||
          !isDeepStrictEqual(intent.sources, proof.sources)
        ) {
          throw new Error('Coverage does not match the frozen source inventory');
        }
        const encoded = JSON.stringify({ roomTxId: proof.roomTxId, sha256: proof.snapshotSha256 });
        if (row.stage === 'native') {
          if (row.proof !== encoded)
            throw new Error('Published migration proof cannot be replaced');
          return;
        }
        this.database
          .prepare(`UPDATE native_room_migrations SET stage = 'verified', proof = ?
        WHERE binding = ? AND room_key = ?`)
          .run(encoded, binding, this.key(proof.room));
      })
      .immediate();
  }

  publish(binding: string, room: NativeFlockRoom, migrationId: string): void {
    this.transition(binding, room, migrationId, 'native');
  }

  publishGroup(binding: string, rooms: readonly NativeFlockRoom[], migrationId: string): void {
    this.transitionGroup(binding, rooms, migrationId, 'native');
  }

  /** Pre-publication only. Native writes require a separately verified reverse migration. */
  abort(binding: string, room: NativeFlockRoom, migrationId: string): void {
    this.transition(binding, room, migrationId, 'legacy');
  }

  abortGroup(binding: string, rooms: readonly NativeFlockRoom[], migrationId: string): void {
    this.transitionGroup(binding, rooms, migrationId, 'legacy');
  }

  /** Publish only a verified whole-group reverse migration; never a flag flip. */
  completeRollbackGroup(
    binding: string,
    rooms: readonly NativeFlockRoom[],
    migrationId: string,
    proofs: readonly LegacyFlockRollbackProof[]
  ): void {
    const groupRooms = [...rooms].sort((a, b) => (this.key(a) < this.key(b) ? -1 : 1));
    const proofByRoom = new Map(proofs.map((proof) => [this.key(proof.intent.room), proof]));
    if (
      groupRooms.length === 0 ||
      proofs.length !== groupRooms.length ||
      proofByRoom.size !== groupRooms.length ||
      new Set(groupRooms.map((room) => this.key(room))).size !== groupRooms.length
    ) {
      throw new Error('Rollback requires one proof per distinct group room');
    }
    this.database
      .transaction(() => {
        let groupStage: 'native' | 'legacy' | undefined;
        for (const room of groupRooms) {
          const row = this.read(binding, room);
          const proof = proofByRoom.get(this.key(room));
          if (
            !row ||
            !proof ||
            proof[rollbackBrand] !== true ||
            (row.stage !== 'native' && row.stage !== 'legacy')
          ) {
            throw new Error('Rollback requires a published native group and verified CRDT proofs');
          }
          if (groupStage && groupStage !== row.stage)
            throw new Error('Rollback group has mixed owners');
          groupStage = row.stage;
          const intent = intentSchema.parse(JSON.parse(row.intent));
          if (
            intent.migrationId !== migrationId ||
            intent.binding !== binding ||
            !isDeepStrictEqual(intent.groupRooms ?? [room], groupRooms) ||
            !isDeepStrictEqual(intent, proof.intent)
          ) {
            throw new Error('Rollback proof does not match the original migration inventory');
          }
          const maintenance = this.database
            .prepare(
              'SELECT migration_id FROM native_room_maintenance WHERE binding = ? AND room_key = ?'
            )
            .get(binding, this.key(room)) as { migration_id: string } | undefined;
          if (maintenance && maintenance.migration_id !== migrationId)
            throw new Error('Rollback maintenance generation mismatch');
          // The stable result permits exact retries after completion. A changed
          // legacy source can be the already-merged result after a crash, but a
          // different resulting snapshot must never replace a published receipt.
          const receipt = JSON.stringify({
            kind: 'rollback',
            nativeRoomTxId: proof.nativeRoomTxId,
            nativeSha256: proof.nativeSnapshotSha256,
            legacySha256: proof.legacyAfterSha256,
            legacyBeforeSha256: proof.legacyBeforeSha256,
          });
          if (row.stage === 'legacy') {
            const previous = z
              .object({
                kind: z.literal('rollback'),
                nativeRoomTxId: txSchema,
                nativeSha256: digestSchema,
                legacySha256: digestSchema,
                legacyBeforeSha256: digestSchema,
              })
              .strict()
              .safeParse(JSON.parse(row.proof ?? 'null'));
            if (
              !previous.success ||
              previous.data.nativeRoomTxId !== proof.nativeRoomTxId ||
              previous.data.nativeSha256 !== proof.nativeSnapshotSha256 ||
              previous.data.legacySha256 !== proof.legacyAfterSha256
            ) {
              throw new Error('Completed rollback receipt mismatch');
            }
            continue;
          }
          const forward = z
            .object({ roomTxId: txSchema, sha256: digestSchema })
            .strict()
            .parse(JSON.parse(row.proof ?? 'null'));
          if (proof.nativeRoomTxId < forward.roomTxId) {
            throw new Error('Rollback snapshot predates native publication');
          }
          this.database
            .prepare(`UPDATE native_room_migrations SET stage = 'legacy', proof = ?
          WHERE binding = ? AND room_key = ?`)
            .run(receipt, binding, this.key(room));
        }
        // Same FULL SQLite transaction as every room's native -> legacy route.
        for (const room of groupRooms)
          this.database
            .prepare(
              'DELETE FROM native_room_maintenance WHERE binding = ? AND room_key = ? AND migration_id = ?'
            )
            .run(binding, this.key(room), migrationId);
      })
      .immediate();
  }

  private transitionGroup(
    binding: string,
    rooms: readonly NativeFlockRoom[],
    migrationId: string,
    next: 'native' | 'legacy'
  ): void {
    const groupRooms = [...rooms].sort((a, b) => (this.key(a) < this.key(b) ? -1 : 1));
    if (
      groupRooms.length === 0 ||
      new Set(groupRooms.map((room) => this.key(room))).size !== groupRooms.length
    ) {
      throw new Error('Migration group must have distinct rooms');
    }
    this.database
      .transaction(() => {
        for (const room of groupRooms)
          this.transition(binding, room, migrationId, next, groupRooms);
      })
      .immediate();
  }

  private transition(
    binding: string,
    room: NativeFlockRoom,
    migrationId: string,
    next: 'native' | 'legacy',
    groupRooms: readonly NativeFlockRoom[] = [room]
  ): void {
    this.database
      .transaction(() => {
        const row = this.read(binding, room);
        if (!row || intentSchema.parse(JSON.parse(row.intent)).migrationId !== migrationId) {
          throw new Error('Migration identity mismatch');
        }
        const intent = intentSchema.parse(JSON.parse(row.intent));
        if (!isDeepStrictEqual(intent.groupRooms ?? [room], groupRooms)) {
          throw new Error('Migration group must switch all rooms atomically');
        }
        if (row.stage === next) return;
        if ((next === 'native' && row.stage !== 'verified') || row.stage === 'native') {
          throw new Error(
            'Migration transition requires verified coverage; published rooms cannot fall back'
          );
        }
        this.database
          .prepare(`UPDATE native_room_migrations SET stage = ?
        WHERE binding = ? AND room_key = ?`)
          .run(next, binding, this.key(room));
      })
      .immediate();
  }

  private key(room: NativeFlockRoom): string {
    return JSON.stringify(roomSchema.parse(room));
  }
  private read(
    binding: string,
    room: NativeFlockRoom
  ): z.infer<typeof journalRowSchema> | undefined {
    const row = this.database
      .prepare(`SELECT intent, stage, proof FROM native_room_migrations
      WHERE binding = ? AND room_key = ?`)
      .get(z.string().min(1).parse(binding), this.key(room));
    return row === undefined ? undefined : journalRowSchema.parse(row);
  }
}

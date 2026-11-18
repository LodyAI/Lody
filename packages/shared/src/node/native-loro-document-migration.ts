import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LoroDoc } from 'loro-crdt';
import {
  LODY_PREVIEW_COMMENT_DOC_SCHEMA,
  LODY_SCHEDULE_DOC_SCHEMA,
  LODY_SESSION_DOC_SCHEMA,
  RepoRpcError,
  type RepoClient,
  type DocSchema,
} from '@loro-dev/loro-repo-client';
import { NATIVE_REPO_MIGRATION_FORMAT } from './native-repo-migration-format';

import {
  nativeLoroDocumentManifestSchema as manifestSchema,
  type NativeLoroDocumentManifest,
} from './native-loro-document-manifest';
export type { NativeLoroDocumentManifest } from './native-loro-document-manifest';
export type FrozenLoroDocumentSource = {
  readonly sourceId: string;
  readonly bytes: Uint8Array;
  /** Omitted means the original nonempty binary source contract. Missing
   * records require an explicit false witness; empty bytes alone prove nothing. */
  readonly present?: boolean;
};
const hasBody = (source: FrozenLoroDocumentSource) => source.present !== false;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const inventory = (
  manifest: NativeLoroDocumentManifest,
  sources: readonly FrozenLoroDocumentSource[]
) => {
  if (
    sources.length !== manifest.sourceIds.length ||
    new Set(sources.map((source) => source.sourceId)).size !== sources.length ||
    sources.some(
      (source) =>
        !manifest.sourceIds.includes(source.sourceId) ||
        (source.present === false ? source.bytes.length !== 0 : source.bytes.length === 0)
    )
  )
    throw new Error('Frozen Loro source inventory is incomplete');
  return sources
    .map((source) => ({
      sourceId: source.sourceId,
      sha256: digest(source.bytes),
      ...(source.present === false ? { present: false as const } : {}),
    }))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
};
const merge = (sources: readonly Uint8Array[]) => {
  const doc = new LoroDoc();
  try {
    for (const bytes of sources) {
      const imported = doc.import(bytes);
      if (imported.pending?.size) throw new Error('Frozen Loro source is causally incomplete');
    }
    return doc;
  } catch (error) {
    doc.free();
    throw error;
  }
};
const sameState = (left: LoroDoc, right: LoroDoc) => {
  const a = left.version(),
    b = right.version();
  try {
    return a.compare(b) === 0 && isDeepStrictEqual(left.toJSON(), right.toJSON());
  } finally {
    a.free();
    b.free();
  }
};
const covered = (source: LoroDoc, target: LoroDoc) => {
  const a = source.version(),
    b = target.version();
  try {
    const relation = b.compare(a);
    return relation !== undefined && relation >= 0;
  } finally {
    a.free();
    b.free();
  }
};

type Stage = 'frozen' | 'native' | 'rollback' | 'legacy';
/** Durable admission manifest for ONE selected plaintext document. It grants no
 * rights: composition must fence every producer and every transport using route().
 * This controller never discovers rooms, activates real user data, or borrows a
 * workspace token for separately authorized Prompt Shortcuts. */
export class NativeLoroDocumentMigration {
  private readonly database: DatabaseSync;
  constructor(
    journalPath: string,
    private readonly owner: {
      readonly client: RepoClient;
      /** Revalidate account/workspace binding, plaintext policy and live engine generation. */
      readonly assertAccess: (manifest: NativeLoroDocumentManifest) => void;
    }
  ) {
    this.database = new DatabaseSync(journalPath);
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = FULL');
    this.database.exec(`CREATE TABLE IF NOT EXISTS native_loro_document_migrations (
      binding TEXT NOT NULL, room_id TEXT NOT NULL, manifest TEXT NOT NULL,
      stage TEXT NOT NULL, sources TEXT, receipt TEXT,
      PRIMARY KEY(binding, room_id)
    ) WITHOUT ROWID`);
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS native_loro_document_migration_sources(binding TEXT NOT NULL,room_id TEXT NOT NULL,source_id TEXT NOT NULL,present INTEGER NOT NULL,sha256 TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(binding,room_id,source_id)) WITHOUT ROWID`
    );
  }
  close() {
    if (this.database.isOpen) this.database.close();
  }
  private read(binding: string, roomId: string) {
    return this.database
      .prepare(
        'SELECT manifest, stage, sources, receipt FROM native_loro_document_migrations WHERE binding = ? AND room_id = ?'
      )
      .get(binding, roomId) as
      | { manifest: string; stage: Stage; sources: string | null; receipt: string | null }
      | undefined;
  }
  archivedSources(
    input: NativeLoroDocumentManifest
  ): readonly FrozenLoroDocumentSource[] | undefined {
    const manifest = manifestSchema.parse(input);
    this.owner.assertAccess(manifest);
    const state = this.read(manifest.binding, manifest.roomId);
    if (!state || !isDeepStrictEqual(JSON.parse(state.manifest), manifest))
      throw new Error('Archived document manifest changed');
    if (manifest.origin === 'created') {
      if (!state.sources) return undefined;
      const absence = JSON.parse(state.sources) as { sourceId: string; absent: boolean }[];
      if (
        !Array.isArray(absence) ||
        !absence.length ||
        new Set(absence.map((value) => value.sourceId)).size !== absence.length ||
        absence.some(
          (value) =>
            !value ||
            typeof value.sourceId !== 'string' ||
            !value.sourceId ||
            value.absent !== true ||
            Object.keys(value).some((key) => key !== 'sourceId' && key !== 'absent')
        )
      )
        throw new Error('Archived creation absence is corrupt');
      return absence.map((value) => ({
        sourceId: value.sourceId,
        present: false,
        bytes: new Uint8Array(),
      }));
    }
    const rows = this.database
      .prepare(
        'SELECT source_id,present,sha256,bytes FROM native_loro_document_migration_sources WHERE binding=? AND room_id=? ORDER BY source_id'
      )
      .all(manifest.binding, manifest.roomId) as {
      source_id: string;
      present: number;
      sha256: string;
      bytes: Uint8Array;
    }[];
    if (!rows.length) return undefined;
    const sources = rows.map((row) => {
      if ((row.present !== 0 && row.present !== 1) || digest(row.bytes) !== row.sha256)
        throw new Error('Archived document source is corrupt');
      return {
        sourceId: row.source_id,
        present: row.present === 1,
        bytes: Uint8Array.from(row.bytes),
      };
    });
    const receipts = inventory(manifest, sources);
    if (!state.sources || !isDeepStrictEqual(JSON.parse(state.sources), receipts))
      throw new Error('Archived document inventory changed');
    return sources;
  }
  route(binding: string, roomId: string): 'legacy' | 'frozen' | 'native' {
    const stage = this.read(binding, roomId)?.stage;
    return stage === 'native'
      ? 'native'
      : stage === undefined || stage === 'legacy'
        ? 'legacy'
        : 'frozen';
  }
  private assert(manifest: NativeLoroDocumentManifest, stage: Stage) {
    this.owner.assertAccess(manifest);
    const row = this.read(manifest.binding, manifest.roomId);
    if (!row || row.stage !== stage || !isDeepStrictEqual(JSON.parse(row.manifest), manifest))
      throw new Error('Single-document migration fence changed');
    return row;
  }
  private freeze(input: NativeLoroDocumentManifest) {
    const manifest = manifestSchema.parse(input);
    this.owner.assertAccess(manifest);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      (() => {
        const row = this.read(manifest.binding, manifest.roomId);
        if (row && row.stage !== 'legacy') {
          if (!isDeepStrictEqual(JSON.parse(row.manifest), manifest))
            throw new Error('Conflicting single-document migration manifest');
          return;
        }
        this.database
          .prepare(`INSERT INTO native_loro_document_migrations(binding, room_id, manifest, stage)
        VALUES (?, ?, ?, 'frozen') ON CONFLICT(binding, room_id) DO UPDATE SET manifest=excluded.manifest, stage='frozen', sources=NULL, receipt=NULL`)
          .run(manifest.binding, manifest.roomId, JSON.stringify(manifest));
        this.database
          .prepare(
            'DELETE FROM native_loro_document_migration_sources WHERE binding=? AND room_id=?'
          )
          .run(manifest.binding, manifest.roomId);
      })();
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch (rollback) {
        throw new AggregateError([error, rollback], 'Native document freeze failed');
      }
      throw error;
    }
    return manifest;
  }
  async migrate(
    input: NativeLoroDocumentManifest,
    ports: {
      /** Called AFTER durable fencing. Drain prior leases/remote writers, flush old
       * persistence, and return the complete frozen binary source inventory. */
      drainLegacy: () => Promise<readonly FrozenLoroDocumentSource[]>;
      /** Trusted Node verifier for values the WASM facade cannot represent.
       * Full causal equality remains mandatory before this hook is called. */
      verifyState?: (input: {
        sources: readonly Uint8Array[];
        target: Uint8Array;
        schema: DocSchema;
      }) => Promise<void>;
      beforePublish?: () => Promise<void>;
    }
  ): Promise<void> {
    if (input.origin === 'created')
      throw new Error('New Sessions require typed creation, never binary import');
    const manifest = this.freeze(input);
    if (this.route(manifest.binding, manifest.roomId) === 'native') {
      this.assert(manifest, 'native');
      return;
    }
    this.assert(manifest, 'frozen');
    const sources = (await ports.drainLegacy()).map((source) => ({
      sourceId: source.sourceId,
      bytes: Uint8Array.from(source.bytes),
      ...(source.present === undefined ? {} : { present: source.present }),
    }));
    const receipts = inventory(manifest, sources);
    const presentSources = sources.filter(hasBody);
    if (!presentSources.length)
      throw new Error('Existing document migration requires a real body source');
    const row = this.assert(manifest, 'frozen');
    if (row.sources && !isDeepStrictEqual(JSON.parse(row.sources), receipts))
      throw new Error('Frozen Loro source bytes changed');
    // Archive the complete immutable binary inventory before the first engine
    // import. Missing records are explicit rows too; a restart never invents an
    // empty source or relies on the continued existence of a renderer database.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.assert(manifest, 'frozen');
      const archived = this.archivedSources(manifest);
      if (archived && !isDeepStrictEqual(inventory(manifest, archived), receipts))
        throw new Error('Archived document source bytes changed');
      if (!archived)
        for (const source of sources)
          this.database
            .prepare(
              'INSERT INTO native_loro_document_migration_sources(binding,room_id,source_id,present,sha256,bytes) VALUES(?,?,?,?,?,?)'
            )
            .run(
              manifest.binding,
              manifest.roomId,
              source.sourceId,
              hasBody(source) ? 1 : 0,
              digest(source.bytes),
              source.bytes
            );
      this.database
        .prepare(
          'UPDATE native_loro_document_migrations SET sources=? WHERE binding=? AND room_id=?'
        )
        .run(JSON.stringify(receipts), manifest.binding, manifest.roomId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    const expected = merge(presentSources.map((source) => source.bytes));
    const schema =
      manifest.family === 'preview_comments'
        ? LODY_PREVIEW_COMMENT_DOC_SCHEMA
        : manifest.family === 'session'
          ? LODY_SESSION_DOC_SCHEMA
          : LODY_SCHEDULE_DOC_SCHEMA;
    // Root declarations are schema metadata, not authored Loro operations.
    for (const [root, kind] of Object.entries(schema.roots ?? {})) {
      if (kind === 'map') expected.getMap(root);
      else if (kind === 'list') expected.getList(root);
      else if (kind === 'movable_list') expected.getMovableList(root);
      else expected.getText(root);
    }
    try {
      const room = { kind: 'loro_doc' as const, id: manifest.roomId };
      await this.owner.client.createRoom(manifest.namespace, room, 'plaintext', {
        docSchema: schema,
      });
      this.assert(manifest, 'frozen');
      const old = await this.owner.client.exportLoroRaw(manifest.namespace, room);
      const previous = merge([old.bytes]);
      try {
        if (!covered(previous, expected))
          throw new Error('Native target contains operations outside the frozen source inventory');
      } finally {
        previous.free();
      }
      for (const source of presentSources) {
        this.assert(manifest, 'frozen');
        await this.owner.client.importRoomState(manifest.namespace, room, {
          snapshot: source.bytes,
          enqueueOutbox: false,
        });
      }
      this.assert(manifest, 'frozen');
      const exported = await this.owner.client.exportLoroRaw(manifest.namespace, room);
      const target = merge([exported.bytes]);
      try {
        // Root declarations without operations are omitted from raw snapshots.
        // Apply the same read-only schema view on both sides; compare all
        // authored operations and unknown roots without inventing body writes.
        for (const [root, kind] of Object.entries(schema.roots ?? {})) {
          if (kind === 'map') target.getMap(root);
          else if (kind === 'list') target.getList(root);
          else if (kind === 'movable_list') target.getMovableList(root);
          else target.getText(root);
        }
        if (ports.verifyState) {
          const a = expected.version(),
            b = target.version();
          try {
            if (a.compare(b) !== 0)
              throw new Error('Native target does not cover exact frozen Loro causal state');
          } finally {
            a.free();
            b.free();
          }
          await ports.verifyState({
            sources: presentSources.map((source) => source.bytes),
            target: exported.bytes,
            schema,
          });
        } else if (!sameState(expected, target))
          throw new Error('Native target does not cover exact frozen Loro state');
      } finally {
        target.free();
      }
      this.assert(manifest, 'frozen');
      await ports.beforePublish?.();
      this.assert(manifest, 'frozen');
      const receipt = {
        ...NATIVE_REPO_MIGRATION_FORMAT,
        roomTxId: exported.roomTxId,
        sha256: digest(exported.bytes),
        sources: receipts,
      };
      this.database
        .prepare(
          "UPDATE native_loro_document_migrations SET stage='native', receipt=? WHERE binding=? AND room_id=?"
        )
        .run(JSON.stringify(receipt), manifest.binding, manifest.roomId);
    } finally {
      expected.free();
    }
  }
  /** A newly reserved UUID has no old body to import. The trusted composition
   * must supply one complete per-Session window/CLI absence witness and a Meta
   * reservation committed by its actual CAS owner. Unknown writes stay frozen;
   * a later explicit reconciliation reads the same reservation, never replays it. */
  async createSession(
    input: Omit<NativeLoroDocumentManifest, 'family' | 'sourceIds' | 'origin'> & {
      creationIntentSha256: string;
    },
    ports: {
      drainLegacy(): Promise<{
        sources: readonly { sourceId: string; present: boolean }[];
        assertCurrent(): void;
      }>;
      reserveMetadata(): Promise<{ reservationId: string }>;
      assertReservation(reservationId: string): Promise<void>;
    }
  ): Promise<void> {
    const manifest = this.freeze({ ...input, family: 'session', sourceIds: [], origin: 'created' });
    if (this.route(manifest.binding, manifest.roomId) === 'native') {
      this.assert(manifest, 'native');
      await ports.assertReservation(manifest.migrationId);
      return;
    }
    const witness = await ports.drainLegacy();
    witness.assertCurrent();
    this.assert(manifest, 'frozen');
    if (
      !witness.sources.length ||
      new Set(witness.sources.map((source) => source.sourceId)).size !== witness.sources.length ||
      witness.sources.some((source) => !source.sourceId || source.present)
    )
      throw new Error('New Session requires complete legacy absence, not an existing body');
    const absence = witness.sources
      .map(({ sourceId }) => ({ sourceId, absent: true }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const frozen = this.assert(manifest, 'frozen');
    if (frozen.sources && !isDeepStrictEqual(JSON.parse(frozen.sources), absence))
      throw new Error('New Session absence inventory changed');
    this.database
      .prepare('UPDATE native_loro_document_migrations SET sources=? WHERE binding=? AND room_id=?')
      .run(JSON.stringify(absence), manifest.binding, manifest.roomId);
    const reservation = await ports.reserveMetadata();
    if (reservation.reservationId !== manifest.migrationId)
      throw new Error('New Session Meta reservation identity mismatch');
    await ports.assertReservation(manifest.migrationId);
    witness.assertCurrent();
    this.assert(manifest, 'frozen');
    const room = { kind: 'loro_doc' as const, id: manifest.roomId };
    await this.owner.client.createRoom(manifest.namespace, room, 'plaintext', {
      docSchema: LODY_SESSION_DOC_SCHEMA,
    });
    const sessionId = manifest.roomId.slice('session-'.length);
    await this.owner.client.transactCas(async () => {
      witness.assertCurrent();
      this.assert(manifest, 'frozen');
      await ports.assertReservation(manifest.migrationId);
      const read = await this.owner.client.readDoc(manifest.namespace, room, []);
      const causal = await this.owner.client.inspectDocCausal(manifest.namespace, room);
      if (causal.roomTxId !== read.roomTxId) throw new RepoRpcError('precondition_failed');
      const value = read.value as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid new Session body');
      const session = value.session as Record<string, unknown> | undefined;
      const recovered =
        session?.id === sessionId && session.nativeCreationReservation === manifest.migrationId;
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'session' && recovered) {
          if (
            Object.keys(session!).some(
              (field) => field !== 'id' && field !== 'nativeCreationReservation'
            )
          )
            throw new Error('New Session contains unrelated session fields');
          continue;
        }
        if (
          !(
            entry === '' ||
            (Array.isArray(entry) && entry.length === 0) ||
            (entry !== null &&
              typeof entry === 'object' &&
              !Array.isArray(entry) &&
              Object.keys(entry).length === 0)
          )
        )
          throw new Error('New Session target already contains a body');
      }
      if (!recovered) {
        if (Object.values(causal.version).some((counter) => counter !== 0))
          throw new Error('New Session target has prior authored history');
        await this.owner.client.applyDocPatch(
          manifest.namespace,
          room,
          [
            { op: 'set', path: ['session', 'id'], value: sessionId },
            {
              op: 'set',
              path: ['session', 'nativeCreationReservation'],
              value: manifest.migrationId,
            },
          ],
          {
            docSchema: LODY_SESSION_DOC_SCHEMA,
            precondition: { mode: 'cas', expected_room_tx_id: read.roomTxId },
          }
        );
      }
    });
    await ports.assertReservation(manifest.migrationId);
    witness.assertCurrent();
    this.assert(manifest, 'frozen');
    const causal = await this.owner.client.inspectDocCausal(manifest.namespace, room);
    this.database
      .prepare(
        "UPDATE native_loro_document_migrations SET stage='native',receipt=? WHERE binding=? AND room_id=?"
      )
      .run(
        JSON.stringify({
          ...NATIVE_REPO_MIGRATION_FORMAT,
          kind: 'created',
          reservationId: manifest.migrationId,
          creationIntentSha256: manifest.creationIntentSha256,
          roomTxId: causal.roomTxId,
          version: causal.version,
          absence,
        }),
        manifest.binding,
        manifest.roomId
      );
  }
  /** Trusted Node creation for independently owned leaf documents. Initial
   * fields are prepared by the family planner; no arbitrary renderer patch is
   * accepted here. A matching committed marker is reconciled by reading only. */
  async createLeaf(
    input: Omit<NativeLoroDocumentManifest, 'sourceIds' | 'origin'> & {
      family: 'preview_comments' | 'schedule_definition';
      creationIntentSha256: string;
    },
    ports: {
      initial: Readonly<Record<string, import('@loro-dev/loro-repo-client').JsonValue>>;
      onPhase?(phase: 'meta_reserve' | 'meta_assert' | 'body_init' | 'before_publish'): void;
      drainLegacy(): Promise<{
        sources: readonly { sourceId: string; present: boolean }[];
        assertCurrent(): void;
      }>;
      reserveMetadata(): Promise<{ reservationId: string }>;
      assertReservation(reservationId: string): Promise<void>;
      beforePublish?(): Promise<void>;
    }
  ): Promise<void> {
    const manifest = this.freeze({ ...input, sourceIds: [], origin: 'created' });
    const room = { kind: 'loro_doc' as const, id: manifest.roomId };
    const marker = 'nativeCreationReservation';
    const initial = structuredClone(ports.initial);
    if (Object.prototype.hasOwnProperty.call(initial, marker))
      throw new Error('Reserved leaf marker cannot be supplied by a caller');
    const identity = manifest.roomId.slice(manifest.family === 'preview_comments' ? 16 : 9);
    const bindingField = initial[manifest.family === 'preview_comments' ? 'meta' : 'definition'];
    if (
      !bindingField ||
      typeof bindingField !== 'object' ||
      Array.isArray(bindingField) ||
      Reflect.get(
        bindingField,
        manifest.family === 'preview_comments' ? 'sessionId' : 'scheduleId'
      ) !== identity
    )
      throw new Error('New leaf body identity mismatch');
    if (this.route(manifest.binding, manifest.roomId) === 'native') {
      this.assert(manifest, 'native');
      await ports.assertReservation(manifest.migrationId);
      return;
    }
    const witness = await ports.drainLegacy();
    witness.assertCurrent();
    this.assert(manifest, 'frozen');
    if (
      !witness.sources.length ||
      new Set(witness.sources.map((source) => source.sourceId)).size !== witness.sources.length ||
      witness.sources.some((source) => !source.sourceId || source.present)
    )
      throw new Error('New leaf requires complete legacy absence');
    const absence = witness.sources
      .map(({ sourceId }) => ({ sourceId, absent: true }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const frozen = this.assert(manifest, 'frozen');
    if (frozen.sources && !isDeepStrictEqual(JSON.parse(frozen.sources), absence))
      throw new Error('New leaf absence inventory changed');
    this.database
      .prepare('UPDATE native_loro_document_migrations SET sources=? WHERE binding=? AND room_id=?')
      .run(JSON.stringify(absence), manifest.binding, manifest.roomId);
    ports.onPhase?.('meta_reserve');
    const reserved = await ports.reserveMetadata();
    if (reserved.reservationId !== manifest.migrationId)
      throw new Error('New leaf reservation mismatch');
    ports.onPhase?.('meta_assert');
    await ports.assertReservation(manifest.migrationId);
    witness.assertCurrent();
    this.assert(manifest, 'frozen');
    ports.onPhase?.('body_init');
    const schema =
      manifest.family === 'preview_comments'
        ? LODY_PREVIEW_COMMENT_DOC_SCHEMA
        : LODY_SCHEDULE_DOC_SCHEMA;
    await this.owner.client.createRoom(manifest.namespace, room, 'plaintext', {
      docSchema: schema,
    });
    await this.owner.client.transactCas(async () => {
      witness.assertCurrent();
      this.assert(manifest, 'frozen');
      await ports.assertReservation(manifest.migrationId);
      const read = await this.owner.client.readDoc(manifest.namespace, room, []);
      const causal = await this.owner.client.inspectDocCausal(manifest.namespace, room);
      if (causal.roomTxId !== read.roomTxId) throw new RepoRpcError('precondition_failed');
      if (!read.value || typeof read.value !== 'object' || Array.isArray(read.value))
        throw new Error('Invalid new leaf root');
      const value = read.value as Record<string, unknown>;
      const recovered = value[marker] === manifest.migrationId;
      if (recovered) {
        if (
          Object.entries(initial).some(
            ([key, expected]) => !isDeepStrictEqual(value[key], expected)
          )
        )
          throw new Error('Reserved leaf body changed before publication');
      } else if (Object.values(causal.version).some((counter) => counter !== 0)) {
        throw new Error('New leaf target has authored history');
      }
      for (const [key, entry] of Object.entries(value)) {
        if (recovered && (key === marker || Object.prototype.hasOwnProperty.call(initial, key)))
          continue;
        if (
          !(
            entry === '' ||
            (Array.isArray(entry) && entry.length === 0) ||
            (entry !== null &&
              typeof entry === 'object' &&
              !Array.isArray(entry) &&
              Object.keys(entry).length === 0)
          )
        )
          throw new Error('New leaf target contains unrelated data');
      }
      if (!recovered)
        await this.owner.client.applyDocPatch(
          manifest.namespace,
          room,
          [
            ...Object.entries(initial).map(([key, value]) => ({
              op: 'set' as const,
              path: [key],
              value,
            })),
            { op: 'set', path: [marker], value: manifest.migrationId },
          ],
          { docSchema: schema, precondition: { mode: 'cas', expected_room_tx_id: read.roomTxId } }
        );
    });
    await ports.assertReservation(manifest.migrationId);
    ports.onPhase?.('before_publish');
    await ports.beforePublish?.();
    witness.assertCurrent();
    this.assert(manifest, 'frozen');
    const causal = await this.owner.client.inspectDocCausal(manifest.namespace, room);
    this.database
      .prepare(
        "UPDATE native_loro_document_migrations SET stage='native',receipt=? WHERE binding=? AND room_id=?"
      )
      .run(
        JSON.stringify({
          ...NATIVE_REPO_MIGRATION_FORMAT,
          kind: 'created',
          family: manifest.family,
          reservationId: manifest.migrationId,
          creationIntentSha256: manifest.creationIntentSha256,
          roomTxId: causal.roomTxId,
          version: causal.version,
          absence,
        }),
        manifest.binding,
        manifest.roomId
      );
  }
  async rollback(
    input: NativeLoroDocumentManifest,
    ports: {
      drainNative: () => Promise<void>;
      /** Import the native binary into each old persisted owner, flush it, then
       * export those persisted bytes again. A live in-memory merge is insufficient. */
      mergeAndFlushLegacy: (native: Uint8Array) => Promise<readonly FrozenLoroDocumentSource[]>;
    }
  ): Promise<void> {
    const manifest = manifestSchema.parse(input);
    if (manifest.origin === 'created')
      throw new Error(
        'Created Sessions require an explicit complete legacy destination inventory for rollback'
      );
    this.owner.assertAccess(manifest);
    const row = this.read(manifest.binding, manifest.roomId);
    if (
      !row ||
      !isDeepStrictEqual(JSON.parse(row.manifest), manifest) ||
      (row.stage !== 'native' && row.stage !== 'rollback')
    )
      throw new Error('Rollback requires this published native manifest');
    this.database
      .prepare(
        "UPDATE native_loro_document_migrations SET stage='rollback' WHERE binding=? AND room_id=?"
      )
      .run(manifest.binding, manifest.roomId);
    await ports.drainNative();
    this.assert(manifest, 'rollback');
    const room = { kind: 'loro_doc' as const, id: manifest.roomId };
    const exported = await this.owner.client.exportLoroRaw(manifest.namespace, room);
    const persisted = await ports.mergeAndFlushLegacy(exported.bytes);
    inventory(manifest, persisted);
    if (persisted.some((source) => !hasBody(source)))
      throw new Error('Each persisted legacy owner must cover exact native Loro state');
    this.assert(manifest, 'rollback');
    const latest = await this.owner.client.exportLoroRaw(manifest.namespace, room);
    if (latest.roomTxId !== exported.roomTxId)
      throw new Error('Native document changed during frozen rollback');
    const expected = merge([exported.bytes]);
    try {
      for (const source of persisted) {
        const legacy = merge([source.bytes]);
        try {
          if (!sameState(expected, legacy))
            throw new Error('Each persisted legacy owner must cover exact native Loro state');
        } finally {
          legacy.free();
        }
      }
    } finally {
      expected.free();
    }
    this.assert(manifest, 'rollback');
    this.database
      .prepare(
        "UPDATE native_loro_document_migrations SET stage='legacy', receipt=? WHERE binding=? AND room_id=?"
      )
      .run(
        JSON.stringify({
          ...NATIVE_REPO_MIGRATION_FORMAT,
          rollbackSha256: digest(exported.bytes),
          sources: inventory(manifest, persisted),
        }),
        manifest.binding,
        manifest.roomId
      );
  }
}

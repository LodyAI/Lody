import {
  getSessionRoomId,
  getScheduleRoomId,
  ScheduleAuthorizationRequestSchema,
  readScheduleAuthorization,
  captureScheduleAuthorization,
  scheduleChangedSince,
  scheduleDocumentFromMirrorState,
  scheduleDefinitionFingerprint,
  type ScheduleAuthorizationRequest,
  type SessionId,
} from '@lody/shared';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { Clock, Effect, type Scope } from 'effect';
import {
  decodeImportBlobMeta,
  isContainer,
  type LoroDoc,
  type LoroMap,
  type OpId,
} from 'loro-crdt';
import type { PayloadProtectionOpenInput } from '@loro-dev/streams-crdt';
import { z } from 'zod';
import type {
  EncryptedExecutionIntent,
  VerifiedExecutionOriginal,
  PendingExecutionOriginal,
} from './agent-execution';

const attempt = <A>(body: () => A) => Effect.try({ try: body, catch: (cause) => cause });
const frameSchema = z.object({ sealed: z.instanceof(Uint8Array), aad: z.instanceof(Uint8Array) });
const context = {
  protocol: 'loro-streams-crdt-payload-protection',
  version: 2,
  kind: 'update_batch',
} as const;
const windowMs = 15 * 60_000;

/** Decode the released SDK's u32be plaintext update batch, never a private SDK API. */
function updates(plaintext: Uint8Array) {
  const values: { meta: ReturnType<typeof decodeImportBlobMeta>; bytes: Uint8Array }[] = [];
  const sizes = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  for (let offset = 0; offset < plaintext.length;) {
    if (plaintext.length - offset < 4 || values.length >= 100)
      throw new Error('e2ee_invalid_update_batch');
    const size = sizes.getUint32(offset, false);
    offset += 4;
    if (size === 0 || size > plaintext.length - offset)
      throw new Error('e2ee_invalid_update_batch');
    const bytes = plaintext.subarray(offset, offset + size);
    const meta = decodeImportBlobMeta(bytes, true);
    // A snapshot signer is not the origin of all turns inside its state.
    if (meta.mode !== 'update' && meta.mode !== 'outdated-update')
      throw new Error('e2ee_execution_origin_missing');
    values.push({ meta, bytes });
    offset += size;
  }
  return values;
}
const contains = (meta: ReturnType<typeof decodeImportBlobMeta>, id: OpId) =>
  (meta.partialStartVersionVector.get(id.peer) ?? 0) <= id.counter &&
  (meta.partialEndVersionVector.get(id.peer) ?? 0) > id.counter;

function findTurn(doc: LoroDoc, userTurnId: string) {
  const list = doc.getList('history');
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const value: unknown = list.get(index);
    if (!isContainer(value) || value.kind() !== 'Map') continue;
    const map = value as LoroMap;
    if (map.get('id') === userTurnId && map.get('role') === 'user') {
      const id = list.getIdAt(index);
      return id ? { map, id } : undefined;
    }
  }
  return undefined;
}
const projection = (map: LoroMap) => {
  const read = (key: string): unknown => {
    const value: unknown = map.get(key);
    return isContainer(value) ? (value.toJSON() as unknown) : value;
  };
  return {
    id: read('id'),
    role: read('role'),
    timestamp: read('timestamp'),
    inputConfig: read('inputConfig'),
    items: read('items'),
    scheduleRun: read('scheduleRun'),
  };
};

type Opened = {
  plaintext: Uint8Array;
  author: { device: { toBytes(): Uint8Array }; actor: { toBytes(): Uint8Array } };
};

/** Workspace-local original ciphertext receipts. No plaintext or user identity is
 * trusted from SQLite: resolution opens/verifies the exact frame again, then
 * reconstructs only its signed Loro version and matches the selected turn. */
export class ExecutionOrigins {
  constructor(private readonly filename: string) {}

  private database<A>(body: (db: Database.Database) => A): A {
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const db = new Database(this.filename, { timeout: 0 });
    try {
      chmodSync(this.filename, 0o600);
      db.pragma('synchronous = FULL');
      db.exec(`CREATE TABLE IF NOT EXISTS frames(digest TEXT PRIMARY KEY, resource TEXT NOT NULL, sealed BLOB NOT NULL, aad BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS spans(resource TEXT NOT NULL, peer TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(resource, peer, start, end, digest));`);
      return body(db);
    } finally {
      db.close();
    }
  }

  /** Called only after signature AND AEAD verification; snapshot opens never call it. */
  retain(
    resource: string,
    request: PayloadProtectionOpenInput,
    plaintext: Uint8Array,
    target?: OpId
  ): boolean {
    if (
      request.context.kind !== 'update_batch' ||
      request.header.length !== 1 ||
      request.header[0] !== 3
    )
      throw new Error('e2ee_execution_origin_missing');
    const decoded = updates(plaintext);
    const digest = createHash('sha256')
      .update(request.sealed)
      .update(request.additionalData)
      .digest('hex');
    this.database((db) =>
      db
        .transaction(() => {
          db.prepare('INSERT OR IGNORE INTO frames VALUES (?, ?, ?, ?)').run(
            digest,
            resource,
            Buffer.from(request.sealed),
            Buffer.from(request.additionalData)
          );
          const insert = db.prepare('INSERT OR IGNORE INTO spans VALUES (?, ?, ?, ?, ?)');
          for (const { meta } of decoded) {
            for (const [peer, end] of meta.partialEndVersionVector.toJSON()) {
              const start = meta.partialStartVersionVector.get(peer) ?? 0;
              if (start < end) insert.run(resource, peer, start, end, digest);
            }
          }
        })
        .immediate()
    );
    return target !== undefined && decoded.some(({ meta }) => contains(meta, target));
  }

  /** A declaration is useful only through its exact signed update. Snapshot
   * authors and later machine-generated turns never supply Schedule authority. */
  resolveSchedule = Effect.fnUntraced(function* (
    this: ExecutionOrigins,
    request: ScheduleAuthorizationRequest,
    doc: LoroDoc,
    open: (input: PayloadProtectionOpenInput) => Effect.Effect<Opened, unknown, Scope.Scope>,
    recover?: (
      docId: string,
      id: OpId,
      open: (input: PayloadProtectionOpenInput) => Effect.Effect<Opened, unknown, Scope.Scope>
    ) => Effect.Effect<void, unknown, Scope.Scope>
  ): Effect.fn.Return<string[] | { state: 'pending-evidence' } | undefined, unknown, Scope.Scope> {
    const fingerprint = (source: LoroDoc) => {
      const raw = source.toJSON() as {
        definition?: unknown;
        prompt?: unknown;
        message?: { payload?: unknown };
      };
      if (typeof raw.prompt !== 'string') return undefined;
      const document = scheduleDocumentFromMirrorState(
        { ...raw, prompt: raw.prompt, timeline: [] },
        request.scheduleId
      );
      return document ? scheduleDefinitionFingerprint(document) : undefined;
    };
    const unchanged = captureScheduleAuthorization(doc, request.manualRunKey);
    if (fingerprint(doc) !== request.definitionFingerprint) return undefined;
    const docId = getScheduleRoomId(request.scheduleId);
    const resource = `doc:${docId}`;
    const signers: string[] = [];
    for (const manualRunKey of request.manualRunKey
      ? [undefined, request.manualRunKey]
      : [undefined]) {
      const selected = readScheduleAuthorization(doc, manualRunKey);
      if (
        !selected ||
        !isDeepStrictEqual(selected.value, {
          definitionFingerprint: request.definitionFingerprint,
          kind: manualRunKey ? 'manual' : 'definition',
          ...(manualRunKey ? { manualRunKey } : {}),
        })
      )
        return undefined;
      const read = () =>
        this.database((db) =>
          db
            .prepare(`SELECT DISTINCT f.sealed, f.aad FROM spans s JOIN frames f ON s.digest=f.digest
        WHERE s.resource=? AND f.resource=? AND s.peer=? AND s.start<=? AND s.end>?`)
            .all(resource, resource, selected.id.peer, selected.id.counter, selected.id.counter)
            .map((row) => frameSchema.parse(row))
        );
      let rows = yield* attempt(read);
      if (!rows.length && recover) {
        yield* recover(docId, selected.id, open);
        rows = yield* attempt(read);
      }
      if (!rows.length) return { state: 'pending-evidence' };
      let signer: string | undefined;
      for (const row of rows) {
        const opened = yield* open({
          context,
          header: Uint8Array.of(3),
          sealed: row.sealed,
          additionalData: row.aad,
        });
        try {
          const decoded = updates(opened.plaintext);
          for (const { meta } of decoded) {
            if (!contains(meta, selected.id)) continue;
            const historical = yield* attempt(() => doc.forkAt(meta.startFrontiers));
            try {
              yield* attempt(() => historical.importBatch(decoded.map((update) => update.bytes)));
              const declaration = readScheduleAuthorization(historical, manualRunKey);
              if (
                !isDeepStrictEqual(declaration, selected) ||
                fingerprint(historical) !== request.definitionFingerprint ||
                scheduleChangedSince(doc, historical)
              )
                return undefined;
              const verified = Buffer.from(opened.author.device.toBytes()).toString('hex');
              if (signer && signer !== verified) return undefined;
              signer = verified;
            } finally {
              historical.free();
            }
          }
        } finally {
          opened.plaintext.fill(0);
        }
      }
      if (!signer) return undefined;
      signers.push(signer);
    }
    return unchanged() && fingerprint(doc) === request.definitionFingerprint ? signers : undefined;
  });

  resolve = Effect.fnUntraced(function* (
    this: ExecutionOrigins,
    intent: EncryptedExecutionIntent,
    doc: LoroDoc,
    open: (request: PayloadProtectionOpenInput) => Effect.Effect<Opened, unknown, Scope.Scope>,
    recover?: (
      docId: string,
      id: OpId,
      open: (request: PayloadProtectionOpenInput) => Effect.Effect<Opened, unknown, Scope.Scope>
    ) => Effect.Effect<void, unknown, Scope.Scope>
  ): Effect.fn.Return<
    VerifiedExecutionOriginal | PendingExecutionOriginal | undefined,
    unknown,
    Scope.Scope
  > {
    const selected = findTurn(doc, intent.userTurnId);
    if (!selected) return undefined;
    const current = projection(selected.map);
    if (!isDeepStrictEqual(current.inputConfig ?? {}, intent.inputConfig ?? {})) return undefined;
    const schedule =
      current.scheduleRun === undefined
        ? undefined
        : ScheduleAuthorizationRequestSchema.extend({
            turnId: z.literal(intent.userTurnId),
          }).safeParse(current.scheduleRun);
    if (schedule && !schedule.success) return undefined;
    const resource = `doc:${getSessionRoomId(intent.sessionId as SessionId)}`;
    const readRows = () =>
      this.database((db) =>
        db
          .prepare(`SELECT DISTINCT f.sealed, f.aad FROM spans s JOIN frames f ON s.digest=f.digest
      WHERE s.resource=? AND f.resource=? AND s.peer=? AND s.start<=? AND s.end>?`)
          .all(resource, resource, selected.id.peer, selected.id.counter, selected.id.counter)
          .map((row) => frameSchema.parse(row))
      );
    let rows = yield* attempt(readRows);
    if (!rows.length) {
      const timestamp = typeof current.timestamp === 'string' ? Date.parse(current.timestamp) : NaN;
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        !Number.isSafeInteger(timestamp + windowMs)
      )
        return undefined;
      if (recover && (yield* Clock.currentTimeMillis) < timestamp + windowMs) {
        yield* recover(getSessionRoomId(intent.sessionId as SessionId), selected.id, open);
        rows = yield* attempt(readRows);
      }
      if (!rows.length) return { state: 'pending-evidence', expiresAt: timestamp + windowMs };
    }
    let original: VerifiedExecutionOriginal | undefined;
    for (const row of rows) {
      const opened = yield* open({
        context,
        header: Uint8Array.of(3),
        sealed: row.sealed,
        additionalData: row.aad,
      });
      try {
        const decoded = updates(opened.plaintext);
        for (const { meta } of decoded) {
          if (!contains(meta, selected.id)) continue;
          // Reconstruct from the signed update's dependencies, then import its
          // exact bytes. Reading the live doc at the same operation ids would
          // incorrectly authenticate a different payload reusing peer/counters.
          const historical = yield* attempt(() => doc.forkAt(meta.startFrontiers));
          try {
            if (findTurn(historical, intent.userTurnId)) return undefined;
            yield* attempt(() => historical.importBatch(decoded.map((update) => update.bytes)));
            const signedTurn = findTurn(historical, intent.userTurnId);
            if (
              !signedTurn ||
              signedTurn.id.peer !== selected.id.peer ||
              signedTurn.id.counter !== selected.id.counter ||
              !isDeepStrictEqual(projection(signedTurn.map), current)
            )
              return undefined;
            const timestamp =
              typeof current.timestamp === 'string' ? Date.parse(current.timestamp) : NaN;
            if (
              !Number.isSafeInteger(timestamp) ||
              timestamp < 0 ||
              !Number.isSafeInteger(timestamp + windowMs)
            )
              return undefined;
            const verified = {
              requesterDevice: Buffer.from(opened.author.device.toBytes()).toString('hex'),
              requesterCryptoUserId: Buffer.from(opened.author.actor.toBytes()).toString('hex'),
              expiresAt: timestamp + windowMs,
              ...(schedule?.success ? { schedule: schedule.data } : {}),
            };
            // Imported/forwarded operations cannot replace an earlier signer with
            // another device's authorization. Conflicting provenance is unknown.
            if (original && !isDeepStrictEqual(original, verified)) return undefined;
            original = verified;
          } finally {
            historical.free();
          }
        }
      } finally {
        opened.plaintext.fill(0);
      }
    }
    const latest = findTurn(doc, intent.userTurnId);
    return latest &&
      latest.id.peer === selected.id.peer &&
      latest.id.counter === selected.id.counter &&
      isDeepStrictEqual(projection(latest.map), current)
      ? original
      : undefined;
  });
}

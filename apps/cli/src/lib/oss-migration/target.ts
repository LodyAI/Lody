import { StreamsCrdt, type CrdtAdapter, type JsonObject as Version } from '@loro-dev/streams-crdt';
import { StreamsClient, type Result, type StreamError } from '@loro-dev/streams-client';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import { createFlockAdapter } from '@loro-dev/streams-crdt/flock';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import {
  createLoroStreamUrl,
  getLoroMetaStreamId,
  getLoroStreamIdForDocId,
  getLoroStreamsShardUrls,
  getMachineRoomId,
  isSessionDocRoomId,
  LORO_STREAMS_BUCKET_ID,
  streamsSnapshotCodec,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroStreamsTokenProvider } from '@lody/platform';
import { prepareCliStreamsGatewayBaseUrl } from '../loro/streams-access';
import {
  assertOwnedDocument,
  canonical,
  hashBytes,
  mergeRowDecision,
  migratedMetadata,
  receiptRoot,
  type Manifest,
  type MigrationDocument,
  type MigrationRow,
} from './model';

function unwrap<T>(result: Result<T, StreamError>): T {
  if (!result.ok)
    throw new Error(`Migration request failed: ${result.result.code}`, { cause: result.result });
  return result.result;
}
// Durable Streams binary framing, also used by the CRDT transport's append path.
function part(updates: readonly Uint8Array[]) {
  const body = new Uint8Array(updates.reduce((size, update) => size + 4 + update.length, 0));
  const view = new DataView(body.buffer);
  let offset = 0;
  for (const update of updates) {
    view.setUint32(offset, update.length, false);
    body.set(update, offset + 4);
    offset += update.length + 4;
  }
  return { contentType: 'application/octet-stream', body };
}
function receiptKey(manifest: Manifest, row: MigrationRow) {
  return ['ossMigration', manifest.migrationId, hashBytes(canonical(row.key))];
}
function hasReceipt(flock: Flock, manifest: Manifest, row: MigrationRow): boolean {
  const receipt = flock.get(receiptKey(manifest, row));
  if (receipt === undefined) return false;
  if (receipt !== hashBytes(canonical(row.value)))
    throw new Error('Migration index receipt mismatch');
  return true;
}
function checkMeta(meta: Flock, entry: MigrationDocument, manifest: Manifest) {
  const existence = meta.getEntry(['e', entry.id]);
  const owner = meta.get(['m', entry.id, 'ossMigrationId']);
  if (existence !== undefined && owner !== manifest.migrationId)
    throw new Error(`Document ID collision: ${entry.id}. Existing cloud data is unchanged.`);
}
export type MigrationTarget = {
  preflight(manifest: Manifest, reserved: readonly string[], signal?: AbortSignal): Promise<void>;
  reserve(
    entry: MigrationDocument,
    manifest: Manifest,
    knownReservation: boolean,
    signal?: AbortSignal
  ): Promise<void>;
  upload(
    entry: MigrationDocument,
    manifest: Manifest,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<void>;
  verify(
    entry: MigrationDocument,
    manifest: Manifest,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<void>;
  mergeIndexes(manifest: Manifest, signal?: AbortSignal): Promise<void>;
  publish(entry: MigrationDocument, manifest: Manifest, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
};

/** Reads use isolated replicas. All shared-index writes use server-enforced CAS. */
export async function openMigrationTarget(
  provider: LoroStreamsTokenProvider,
  workspaceId: WorkspaceId
): Promise<MigrationTarget> {
  const baseUrl = await prepareCliStreamsGatewayBaseUrl(provider);
  const lifetime = new AbortController();
  const streams = new Set<StreamsCrdt<Version>>();
  const urlFor = (id: string) =>
    createLoroStreamUrl({ baseUrl, bucketId: LORO_STREAMS_BUCKET_ID, streamId: id });
  const fetchFor =
    (signal?: AbortSignal): typeof fetch =>
    (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          lifetime.signal,
          ...(signal ? [signal] : []),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
  const client = (id: string, signal?: AbortSignal) =>
    new StreamsClient({
      url: urlFor(id),
      auth: provider.createAuthCallback(),
      fetch: fetchFor(signal),
      timeout: { connectTimeoutMs: 30_000, pollTimeoutMs: 30_000 },
      retry: { maxAttempts: 0 },
    });
  const make = (id: string, adapter: CrdtAdapter<Version>, signal?: AbortSignal) => {
    const stream = new StreamsCrdt({
      streamUrl: urlFor(id),
      adapter,
      auth: provider.createAuthCallback(),
      fetch: fetchFor(signal),
      snapshotCodec: streamsSnapshotCodec,
      shardUrls: getLoroStreamsShardUrls(baseUrl, provider.getShardHostSuffix()),
    });
    streams.add(stream);
    return stream;
  };
  const closeStream = async (stream: StreamsCrdt<Version>) => {
    await stream.close();
    streams.delete(stream);
  };
  const read = async (id: string, adapter: CrdtAdapter<Version>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const stream = make(id, adapter, signal);
    try {
      const result = await stream.catchup({ force: true });
      if (!result.ok) {
        if (result.error.code === 'stream_not_found') return null;
        throw new Error(`Migration read failed: ${result.error.code}`, { cause: result.error });
      }
      return result.value.cursor;
    } finally {
      await closeStream(stream);
    }
  };
  const readMeta = async (signal?: AbortSignal) => {
    const meta = new Flock();
    await read(getLoroMetaStreamId(workspaceId), createFlockAdapter(meta), signal);
    return meta;
  };
  const readDoc = async (entry: MigrationDocument, signal?: AbortSignal) => {
    const doc = new LoroDoc();
    const cursor = await read(
      getLoroStreamIdForDocId(workspaceId, entry.id),
      createLoroDocAdapter(doc),
      signal
    );
    return { doc, exists: cursor !== null };
  };
  // Never reuse a replica after a rejected CAS: its tentative mutations must not leak.
  const transact = async (id: string, mutate: (flock: Flock) => void, signal?: AbortSignal) => {
    for (let attempt = 0; attempt < 32; attempt++) {
      signal?.throwIfAborted();
      const flock = new Flock();
      const adapter: CrdtAdapter<Version> = createFlockAdapter(flock);
      const cursor = await read(id, adapter, signal);
      mutate(flock);
      flock.commit();
      const batch = adapter.exportUpdates(
        cursor?.serverLowerBoundVersion ?? adapter.emptyVersion()
      );
      if (!batch?.updates.length) return;
      if (!cursor) {
        // The initial index and its receipts are one atomic stream creation.
        if (unwrap(await client(id, signal).create({ part: part(batch.updates) })).created) return;
      } else {
        const result = unwrap(
          await client(id, signal).appendCas({
            expectedOffset: cursor.nextOffset,
            part: part(batch.updates),
          })
        );
        if (result.kind === 'ok') return;
      }
    }
    throw new Error('Cloud index is changing continuously. Retry migration to resume safely.');
  };
  return {
    async preflight(manifest, _reserved, signal) {
      if (
        !unwrap(
          await client(getLoroMetaStreamId(workspaceId), signal).bucketSupportsAppendCas({ signal })
        )
      )
        throw new Error('This Streams deployment lacks append-cas; safe migration is unavailable.');
      const meta = await readMeta(signal);
      for (const entry of manifest.documents) {
        checkMeta(meta, entry, manifest);
        const remote = await readDoc(entry, signal);
        if (remote.exists) {
          if (!remote.doc.opCount()) throw new Error(`Unowned empty stream collision: ${entry.id}`);
          assertOwnedDocument(remote.doc, entry, manifest.migrationId);
        }
      }
      for (const index of manifest.flocks) {
        if (meta.getEntry(['ef', index.id]) && meta.get(['ef', index.id]) !== true)
          throw new Error(`Deleted target index: ${index.id}`);
        const flock = new Flock();
        await read(index.id, createFlockAdapter(flock), signal);
        for (const row of index.rows)
          if (!hasReceipt(flock, manifest, row))
            mergeRowDecision(flock.get(row.key), row, flock.getEntry(row.key) !== undefined);
      }
    },
    async reserve(entry, manifest, _knownReservation, signal) {
      checkMeta(await readMeta(signal), entry, manifest);
      const doc = new LoroDoc();
      doc.getMap(receiptRoot).set('id', manifest.migrationId);
      doc.getMap(receiptRoot).set('sourceSha256', entry.sha256);
      doc.commit();
      // Ownership and creation are atomic, including when the successful response is lost.
      const created = unwrap(
        await client(getLoroStreamIdForDocId(workspaceId, entry.id), signal).create({
          part: part([doc.export({ mode: 'update' })]),
        })
      );
      if (!created.created)
        assertOwnedDocument((await readDoc(entry, signal)).doc, entry, manifest.migrationId);
    },
    async upload(entry, manifest, bytes, signal) {
      const remote = await readDoc(entry, signal);
      if (!remote.exists) throw new Error(`Migration reservation disappeared: ${entry.id}`);
      assertOwnedDocument(remote.doc, entry, manifest.migrationId);
      remote.doc.import(bytes);
      const stream = make(
        getLoroStreamIdForDocId(workspaceId, entry.id),
        createLoroDocAdapter(remote.doc),
        signal
      );
      try {
        const result = await stream.sync();
        if (!result.ok)
          throw new Error(`Migration upload failed: ${result.error.code}`, { cause: result.error });
      } finally {
        await closeStream(stream);
      }
    },
    async verify(entry, manifest, bytes, signal) {
      const { exists, doc } = await readDoc(entry, signal);
      if (!exists) throw new Error(`Uploaded document missing: ${entry.id}`);
      assertOwnedDocument(doc, entry, manifest.migrationId);
      const expected = new LoroDoc();
      expected.import(bytes);
      const comparison = expected.oplogVersion().compare(doc.oplogVersion());
      if (comparison === undefined || comparison > 0)
        throw new Error(`Incomplete uploaded history: ${entry.id}`);
    },
    async mergeIndexes(manifest, signal) {
      for (const index of manifest.flocks) {
        await transact(
          index.id,
          (flock) => {
            for (const row of index.rows) {
              if (hasReceipt(flock, manifest, row)) continue;
              if (
                mergeRowDecision(flock.get(row.key), row, flock.getEntry(row.key) !== undefined) ===
                'insert'
              )
                flock.set(row.key, row.value);
              // Same CAS as the row. Survives lost responses and later user edits/deletes.
              flock.set(receiptKey(manifest, row), hashBytes(canonical(row.value)));
            }
          },
          signal
        );
      }
      await transact(
        getLoroMetaStreamId(workspaceId),
        (meta) => {
          for (const index of manifest.flocks) {
            if (meta.getEntry(['ef', index.id]) && meta.get(['ef', index.id]) !== true)
              throw new Error(`Deleted target index: ${index.id}`);
            if (meta.get(['ef', index.id]) !== true) meta.set(['ef', index.id], true);
          }
          const room = getMachineRoomId(manifest.targetMachineId as MachineId);
          if (!meta.getEntry(['e', room])) {
            meta.set(['e', room], true);
            for (const [key, value] of Object.entries({
              name: manifest.machineMeta.name ?? 'Imported machine',
              os: manifest.machineMeta.os ?? 'unknown',
              cliVersion: manifest.machineMeta.cliVersion ?? '',
              id: manifest.targetMachineId,
              ownerUserId: manifest.targetUserId,
              sessions: [],
            }))
              meta.set(['m', room, key], value);
          }
        },
        signal
      );
    },
    async publish(entry, manifest, signal) {
      await transact(
        getLoroMetaStreamId(workspaceId),
        (meta) => {
          checkMeta(meta, entry, manifest);
          // A published (even since deleted) record is never rewritten on retry.
          if (meta.get(['m', entry.id, 'ossMigrationId']) === manifest.migrationId) return;
          const values = isSessionDocRoomId(entry.id)
            ? migratedMetadata(entry.meta, manifest)
            : { ...entry.meta, ossMigrationId: manifest.migrationId };
          meta.set(['e', entry.id], true);
          for (const [key, value] of Object.entries(values)) meta.set(['m', entry.id, key], value);
        },
        signal
      );
    },
    async close() {
      lifetime.abort();
      const results = await Promise.allSettled([...streams].map((s) => s.close()));
      streams.clear();
      const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
      if (errors.length) throw new AggregateError(errors, 'Could not close migration transports');
    },
  };
}

import { RepoRpcError, type RepoClient, type RoomKey } from '@loro-dev/loro-repo-client';
import type { ExternalDocFeed, ExternalDocsAdapter } from 'loro-repo';
import {
  RemoteWriteConflictError,
  RemoteWriteIndeterminateError,
  type RemoteSessionDocPort,
} from '../session-data/remote-document';
import { engineDocSchemaFromMirror } from '../session-data/engine-doc-schema';
import { sessionDocSchema } from '../schema';
import { scheduleDocSchema } from '../schedule-schema';
import { isNativeScheduleDocId } from '../native-workspace-meta-ipc';
import { MIGRATIONS_ROOM, observeLoroDoc, observeLoroPaths } from './native-repo';

/** Type-only loro-repo use keeps its WASM out of the Electron main bundle. */
const CAPABILITY = 'loro-external-docs-v1' as const;

const docRoom = (docId: string): RoomKey => ({ kind: 'loro_doc', id: docId });

/**
 * Creates (or re-declares) an owned document room. Declaring every root lets
 * the engine read below it by type: an undeclared root is found through the
 * document's shallow value, which a freshly loaded 100k-turn room answers in
 * about 240 ms. The schema makes remote patches create Mirror-shaped containers.
 */
export function createDocRoom(client: RepoClient, namespace: string, docId: string) {
  // Declared once per connection: re-declaring a schema reloads and revalidates
  // the document in the engine.
  let declared = declaredRooms.get(client);
  if (!declared) declaredRooms.set(client, (declared = new Map()));
  const key = `${namespace}\0${docId}`;
  let pending = declared.get(key);
  if (!pending) {
    pending = client
      .createRoom(namespace, docRoom(docId), 'plaintext', {
        rootContainers: engineDocSchemaFor(docId).roots,
        docSchema: engineDocSchemaFor(docId),
      })
      .then(() => {});
    pending.catch(() => declared.delete(key));
    declared.set(key, pending);
  }
  return pending;
}
const declaredRooms = new WeakMap<RepoClient, Map<string, Promise<void>>>();

/** Remote writes create the containers the Mirror and HistoryWriter would. */
export const SESSION_ENGINE_DOC_SCHEMA = engineDocSchemaFromMirror(sessionDocSchema);
const SCHEDULE_ENGINE_DOC_SCHEMA = engineDocSchemaFromMirror(scheduleDocSchema);
/** Each owned document type declares the roots and containers of its Mirror. */
const engineDocSchemaFor = (docId: string) =>
  isNativeScheduleDocId(docId) ? SCHEDULE_ENGINE_DOC_SCHEMA : SESSION_ENGINE_DOC_SCHEMA;
/** Migration and native-write markers share one prefix per document. */
const marker = (docId: string, source: string) => ['loro_doc', docId, source];
export const NATIVE_WRITE_SOURCE = 'native';

/** A legacy replica's complete document: snapshot bytes and its oplog version. */
export interface LegacyDoc {
  readonly snapshot: Uint8Array;
  readonly version: Readonly<Record<string, number>>;
}

/** Whether a source's replica of a document was already migrated. */
export async function isLegacyDocPublished(
  client: RepoClient,
  namespace: string,
  docId: string,
  source: string
) {
  await client.createRoom(namespace, MIGRATIONS_ROOM, 'plaintext');
  return (await client.flockGet(namespace, MIGRATIONS_ROOM, marker(docId, source))).found;
}

/**
 * Lazily migrates one legacy replica of one document: import the complete
 * snapshot (a lossless Loro merge), verify that the room's version covers the
 * legacy version, then publish. A published source is skipped on later opens.
 */
export async function importLegacyDoc(
  client: RepoClient,
  namespace: string,
  docId: string,
  source: string,
  load: () => Promise<LegacyDoc | undefined>
): Promise<'imported' | 'already-published'> {
  if (await isLegacyDocPublished(client, namespace, docId, source)) return 'already-published';
  const key = marker(docId, source);
  const legacy = await load();
  if (legacy) {
    await createDocRoom(client, namespace, docId);
    await client.importRoomState(namespace, docRoom(docId), { snapshot: legacy.snapshot });
    const { version } = await client.inspectDocCausal(namespace, docRoom(docId));
    const missing = Object.entries(legacy.version).filter(
      ([peer, counter]) => (version[peer] ?? 0) < counter
    );
    if (missing.length > 0)
      throw new Error(`native_doc_migration_incomplete: ${missing.length} peers`);
  }
  await client.flockBatch(namespace, MIGRATIONS_ROOM, [
    { op: 'put', key, value: { publishedAt: Date.now() } },
  ]);
  return 'imported';
}

/** Documents with native state: migrated from any source or written natively. */
export async function listNativeDocIds(client: RepoClient, namespace: string) {
  await client.createRoom(namespace, MIGRATIONS_ROOM, 'plaintext');
  const ids = new Set<string>();
  let start: (string | number)[] | undefined;
  for (;;) {
    const page = await client.flockScanPage(
      namespace,
      MIGRATIONS_ROOM,
      { prefix: ['loro_doc'], ...(start ? { start: { bound: 'exclusive', key: start } } : {}) },
      { maxRows: 4096, maxBytes: 1024 * 1024 }
    );
    for (const entry of page.entries)
      if (!entry.deleted && typeof entry.key[1] === 'string') ids.add(entry.key[1]);
    if (page.eof) return [...ids];
    const last = page.entries.at(-1);
    if (!last) throw new Error('native_repo_page_without_progress');
    start = last.key as (string | number)[];
  }
}

/** Returns a source of one document to legacy ownership (re-imported if enabled again). */
export async function unpublishLegacyDoc(
  client: RepoClient,
  namespace: string,
  docId: string,
  source: string
) {
  await client.flockBatch(namespace, MIGRATIONS_ROOM, [
    { op: 'delete', key: marker(docId, source) },
  ]);
}

/** Commits replica update bytes to the document room. */
export async function commitDocUpdates(
  client: RepoClient,
  namespace: string,
  docId: string,
  updates: readonly Uint8Array[]
) {
  for (const update of updates)
    await client.importRoomState(namespace, docRoom(docId), { updates: [update] });
}

/** Register view of one Loro document room (creates the room if needed). */
export async function observeNativeDoc(
  client: RepoClient,
  namespace: string,
  docId: string,
  listener: Parameters<typeof observeLoroDoc>[3],
  since?: Readonly<Record<string, number>>
) {
  await createDocRoom(client, namespace, docId);
  return observeLoroDoc(client, namespace, docRoom(docId), listener, since);
}

/**
 * Owner of selected Loro documents for a LoroRepo in this process. Each open
 * replica has one update observation on the shared connection; a reload after
 * reconnect delivers the snapshot again, which imports as an update. A repo
 * reopening a document it retained passes its version and receives only the
 * newer ops.
 * `legacy` migrates this process's own replica of a document on first open.
 */
export function createNativeDocs(
  client: RepoClient,
  namespace: string,
  owns: (docId: string) => boolean,
  legacy?: { source: string; load(docId: string): Promise<LegacyDoc | undefined> }
): ExternalDocsAdapter {
  const marked = new Set<string>();
  return {
    capability: CAPABILITY,
    owns,
    async open(docId, onUpdate, known): Promise<ExternalDocFeed> {
      if (legacy)
        await importLegacyDoc(client, namespace, docId, legacy.source, () => legacy.load(docId));
      let first: Uint8Array | undefined;
      const observation = await observeNativeDoc(
        client,
        namespace,
        docId,
        (event) => {
          if (event.kind === 'snapshot') {
            if (first === undefined) first = event.file;
            else onUpdate(event.file);
          } else if (event.kind === 'changes') {
            for (const update of event.updates) onUpdate(update);
          }
        },
        known?.version
      );
      try {
        await observation.ready;
      } catch (error) {
        await observation.release().catch(() => {});
        throw error;
      }
      const close = () => observation.release();
      if (!first?.byteLength) return { close };
      return known ? { update: first, close } : { snapshot: first, close };
    },
    async commit(docId, updates) {
      if (!marked.has(docId)) {
        await client.createRoom(namespace, MIGRATIONS_ROOM, 'plaintext');
        await client.flockBatch(namespace, MIGRATIONS_ROOM, [
          { op: 'put', key: marker(docId, NATIVE_WRITE_SOURCE), value: true },
        ]);
        marked.add(docId);
      }
      await commitDocUpdates(client, namespace, docId, updates);
    },
  };
}

/** Bounded reads and changed-path observation of one native Session document. */
/**
 * Bounded reads, changed-path observation and schema-checked patch writes of
 * one native Session document, on the process's shared connection.
 */
export function createNativeRemoteHistoryPort(
  client: RepoClient,
  namespace: string,
  docId: string
): RemoteSessionDocPort {
  const room = docRoom(docId);
  const created = createDocRoom(client, namespace, docId);
  const readPathAt = async (path: readonly (string | number)[]) => {
    await created;
    try {
      const read = await client.readDoc(namespace, room, [...path]);
      return { value: read.value as unknown, roomTxId: read.roomTxId };
    } catch (error) {
      if (!/path not found/.test(String(error))) throw error;
      const { roomTxId } = await client.readDocListFields(namespace, room, ['history'], {
        start: 0,
        end: 0,
        fields: [],
      });
      return { value: undefined, roomTxId };
    }
  };
  return {
    async readListFields(start, end, fields) {
      await created;
      const page = await client.readDocListFields(namespace, room, ['history'], {
        start,
        ...(end !== undefined ? { end } : {}),
        fields: fields.map((field) => ({
          path: [...field.path],
          ...(field.shape ? { shape: true } : {}),
        })),
      });
      return { len: page.len, start: page.start, rows: page.rows, roomTxId: page.roomTxId };
    },
    readPathAt,
    readPath: async (path) => (await readPathAt(path)).value,
    async applyPatch(ops, precondition) {
      await created;
      try {
        await client.applyDocPatch(namespace, room, ops as never, { precondition });
      } catch (error) {
        if (error instanceof RepoRpcError) {
          if (error.code === 'precondition_failed') throw new RemoteWriteConflictError();
          throw error;
        }
        // Sent, but the reply never came: the write may have landed.
        throw new RemoteWriteIndeterminateError(error);
      }
      return { frontiers: (await client.inspectDocCausal(namespace, room)).frontiers };
    },
    observePaths(listener) {
      const observation = (async () => {
        await created;
        return observeLoroPaths(client, namespace, room, (event) => {
          // A disconnect is followed by a reset once the SDK resubscribes.
          if (event.kind === 'reset') listener({ kind: 'reset' });
          else if (event.kind === 'changes') listener({ kind: 'changes', changes: event.changes });
        });
      })();
      return {
        ready: observation.then((handle) => handle.ready),
        close: () => void observation.then((handle) => handle.release()).catch(() => {}),
      };
    },
  };
}

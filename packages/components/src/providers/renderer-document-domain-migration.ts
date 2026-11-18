import { LoroDoc } from 'loro-crdt';
import {
  DOCUMENT_DOMAIN_CAPTURE_MAX_DATABASES,
  DOCUMENT_DOMAIN_CAPTURE_MAX_BYTES,
  rendererDocumentDomainRegistrationSchema,
  rendererDocumentDomainRequestSchema,
  rendererDocumentDomainAckSchema,
  type RendererDocumentDomainScope,
  type RendererDocumentDomainRegistration,
  type RendererDocumentDomainRequest,
  type RendererDocumentDomainAck,
  type RendererDocumentDomainSource,
} from '@lody/shared/renderer-document-domain-migration';
const request = <A>(operation: IDBRequest<A>): Promise<A> =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error('Document IDB read failed'));
  });
const binary = (value: unknown): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  throw new Error('Unsupported persisted Loro document binary');
};
/** Released loro-repo layout4 only. No loadDoc/compaction, creation or JSON rewrite. */
export async function captureFrozenRendererDocumentDomain(options: {
  workspaceId: string;
  scope: RendererDocumentDomainScope;
  indexedDB?: IDBFactory;
}): Promise<RendererDocumentDomainSource[]> {
  const idb = options.indexedDB ?? globalThis.indexedDB;
  if (!idb || typeof idb.databases !== 'function')
    throw new Error('Complete document database enumeration required');
  const prefix = `lody-loro-repo-db-${options.workspaceId}`;
  const enumerate = async () =>
    (await idb.databases())
      .filter((db) => db.name === prefix || db.name?.startsWith(`${prefix}:`))
      .map((db) => ({ name: db.name!, version: db.version }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const before = await enumerate();
  if (before.length > DOCUMENT_DOMAIN_CAPTURE_MAX_DATABASES)
    throw new Error('Complete document database inventory exceeds budget');
  const sources: RendererDocumentDomainSource[] = [];
  let totalBytes = 0;
  for (const descriptor of before) {
    const opening = idb.open(descriptor.name);
    opening.onupgradeneeded = () => opening.transaction?.abort();
    const db = await request(opening);
    try {
      if (
        db.version !== 4 ||
        !db.objectStoreNames.contains('docs') ||
        !db.objectStoreNames.contains('doc-updates')
      )
        throw new Error('Unsupported document IndexedDB layout');
      const tx = db.transaction(['docs', 'doc-updates'], 'readonly');
      const completed = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () =>
          reject(tx.error ?? new Error('Document capture transaction failed'));
      });
      const [base, queue] = await Promise.all([
        request(tx.objectStore('docs').get(options.scope.roomId)),
        request(tx.objectStore('doc-updates').get(options.scope.roomId)),
        completed,
      ]);
      let updates: unknown[] = [];
      if (queue != null) {
        if (Array.isArray(queue)) updates = queue;
        else if (typeof queue === 'object' && Array.isArray(queue.updates)) updates = queue.updates;
        else throw new Error('Unsupported persisted Loro update queue');
      }
      const parts = [...(base == null ? [] : [binary(base)]), ...updates.map(binary)];
      totalBytes += parts.reduce((sum, part) => sum + part.byteLength, 0);
      if (totalBytes > DOCUMENT_DOMAIN_CAPTURE_MAX_BYTES || parts.length > 65_536)
        throw new Error('Complete document source exceeds budget');
      let snapshot = new Uint8Array();
      if (parts.length) {
        const doc = new LoroDoc();
        try {
          const imported = doc.importBatch(parts);
          if (imported.pending?.size)
            throw new Error('Persisted document causal inventory is incomplete');
          snapshot = Uint8Array.from(doc.export({ mode: 'snapshot' }));
          if (snapshot.byteLength > DOCUMENT_DOMAIN_CAPTURE_MAX_BYTES)
            throw new Error('Document snapshot exceeds budget');
        } finally {
          doc.free();
        }
      }
      sources.push({
        sourceId: `renderer-idb:loro-doc-layout4:${descriptor.name}`,
        dbName: descriptor.name,
        present: parts.length > 0,
        snapshot,
      });
    } finally {
      db.close();
    }
  }
  if (JSON.stringify(before) !== JSON.stringify(await enumerate()))
    throw new Error('Document database inventory changed during capture');
  return sources;
}
export async function enumerateRendererDocumentDomainDatabases(
  workspaceId: string,
  indexedDB?: IDBFactory
) {
  const idb = indexedDB ?? globalThis.indexedDB;
  if (!idb || typeof idb.databases !== 'function')
    throw new Error('Complete document database enumeration required');
  const prefix = `lody-loro-repo-db-${workspaceId}`;
  const descriptors = (await idb.databases())
    .filter((db) => db.name === prefix || db.name?.startsWith(`${prefix}:`))
    .sort((a, b) => (a.name! < b.name! ? -1 : a.name! > b.name! ? 1 : 0));
  if (descriptors.length > DOCUMENT_DOMAIN_CAPTURE_MAX_DATABASES)
    throw new Error('Complete document inventory exceeds budget');
  // Layout capability is checked before durable freeze. Opening a database that
  // disappeared may never recreate or upgrade a legacy replica.
  for (const descriptor of descriptors) {
    if (descriptor.version !== 4) throw new Error('Unsupported document IndexedDB layout');
    const opening = idb.open(descriptor.name!);
    opening.onupgradeneeded = () => opening.transaction?.abort();
    const db = await request(opening);
    try {
      if (
        db.version !== 4 ||
        !db.objectStoreNames.contains('docs') ||
        !db.objectStoreNames.contains('doc-updates')
      )
        throw new Error('Unsupported document IndexedDB layout');
    } finally {
      db.close();
    }
  }
  const names = descriptors.map((db) => ({
    dbName: db.name!,
    sourceId: `renderer-idb:loro-doc-layout4:${db.name!}`,
  }));
  return names;
}
/** Both document families have their own exact room gate. No Session body,
 * Machine Flock or workspace-wide receipt grants this freeze. */
export class RendererDocumentDomainFreeze {
  private registration: RendererDocumentDomainRegistration | undefined;
  private retired = false;
  private readonly rooms = new Map<
    string,
    {
      scope: RendererDocumentDomainScope;
      revision: string;
      owner: 'frozen' | 'native';
      pending?: Promise<void>;
    }
  >();
  private readonly active = new Map<string, Set<Promise<unknown>>>();
  constructor(
    private readonly ports: {
      beginFreeze(scope: RendererDocumentDomainScope): void;
      drainLegacy(scope: RendererDocumentDomainScope): Promise<void>;
      published?(scope: RendererDocumentDomainScope): void;
      indexedDB?: IDBFactory;
    }
  ) {}
  bind(input: RendererDocumentDomainRegistration) {
    const registration = rendererDocumentDomainRegistrationSchema.parse(input);
    if (
      this.retired ||
      (this.registration && this.registration.registrationId !== registration.registrationId)
    )
      throw new Error('Document migration registration retired');
    this.registration = registration;
    for (const room of registration.rooms) this.rooms.set(room.scope.roomId, room);
  }
  owner(roomId: string): 'legacy' | 'frozen' | 'native' {
    if (this.retired) throw new Error('Document migration owner retired');
    return this.rooms.get(roomId)?.owner ?? 'legacy';
  }
  shouldRoute(roomId: string) {
    return (
      (!roomId.startsWith('preview-comment-') && !roomId.startsWith('schedule-')) ||
      (!this.retired && !this.rooms.has(roomId))
    );
  }
  assertLegacy(roomId: string) {
    if (!this.shouldRoute(roomId)) throw new Error('Legacy document author is frozen');
  }
  runSync<A>(scope: RendererDocumentDomainScope, work: () => A): A {
    this.assertLegacy(scope.roomId);
    return work();
  }
  run<A>(scope: RendererDocumentDomainScope, work: () => Promise<A> | A): Promise<A> {
    this.assertLegacy(scope.roomId);
    const raw = Promise.resolve().then(work);
    const jobs = this.active.get(scope.roomId) ?? new Set<Promise<unknown>>();
    jobs.add(raw);
    this.active.set(scope.roomId, jobs);
    void raw
      .finally(() => {
        jobs.delete(raw);
        if (!jobs.size) this.active.delete(scope.roomId);
      })
      .catch(() => {});
    return raw;
  }
  async handle(input: RendererDocumentDomainRequest): Promise<RendererDocumentDomainAck> {
    const message = rendererDocumentDomainRequestSchema.parse(input),
      registration = this.registration;
    if (
      this.retired ||
      !registration ||
      registration.registrationId !== message.registrationId ||
      registration.metadataGeneration !== message.metadataGeneration ||
      JSON.stringify(registration.binding) !== JSON.stringify(message.binding)
    )
      throw new Error('Document migration scope mismatch');
    if (message.phase === 'enumerate')
      return {
        ...message,
        databases: await enumerateRendererDocumentDomainDatabases(
          registration.binding.workspaceId,
          this.ports.indexedDB
        ),
      };
    let room = this.rooms.get(message.scope.roomId);
    if (message.phase === 'freeze') {
      if (
        room &&
        (room.revision !== message.revision ||
          JSON.stringify(room.scope) !== JSON.stringify(message.scope) ||
          room.owner === 'native')
      )
        throw new Error('Document freeze generation changed');
      room ??= { scope: message.scope, revision: message.revision, owner: 'frozen' };
      this.rooms.set(message.scope.roomId, room);
      this.ports.beginFreeze(message.scope);
      room.pending ??= (async () => {
        await Promise.allSettled([...(this.active.get(message.scope.roomId) ?? [])]);
        await this.ports.drainLegacy(message.scope);
      })().catch((error) => {
        room!.pending = undefined;
        throw error;
      });
      await room.pending;
    } else {
      if (
        !room ||
        room.revision !== message.revision ||
        JSON.stringify(room.scope) !== JSON.stringify(message.scope)
      )
        throw new Error('Document capture requires its exact completed freeze');
      if (message.phase === 'publish') {
        await room.pending;
        room.owner = 'native';
        this.ports.published?.(message.scope);
      } else {
        if (!room.pending) throw new Error('Document drain has not completed');
        await room.pending;
        const sources = await captureFrozenRendererDocumentDomain({
          workspaceId: registration.binding.workspaceId,
          scope: message.scope,
          indexedDB: this.ports.indexedDB,
        });
        if (this.retired || this.rooms.get(message.scope.roomId) !== room)
          throw new Error('Document capture retired');
        return rendererDocumentDomainAckSchema.parse({ ...message, sources });
      }
    }
    if (this.retired) throw new Error('Document migration retired');
    return { ...message };
  }
  retire() {
    this.retired = true;
  }
}

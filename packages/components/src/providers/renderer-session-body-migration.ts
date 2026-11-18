import { LoroDoc } from 'loro-crdt';
import type { SessionDocStore } from '../atoms/runtime';
import {
  SESSION_BODY_CAPTURE_MAX_DATABASES,
  rendererSessionBodyRegistrationSchema,
  rendererSessionBodyRequestSchema,
  rendererSessionBodyAckSchema,
  type RendererSessionBodyRegistration,
  type RendererSessionBodyRequest,
  type RendererSessionBodyAck,
  type RendererSessionBodySource,
} from '@lody/shared/renderer-session-body-migration';
const request = <A>(operation: IDBRequest<A>): Promise<A> =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error('Session IDB read failed'));
  });
const binary = (value: unknown): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  throw new Error('Unsupported Session binary persistence');
};
/** Database identities only: does not open, read, author or freeze a body. */
export async function enumerateRendererSessionDatabases(
  workspaceId: string,
  indexedDB?: IDBFactory
) {
  const idb = indexedDB ?? globalThis.indexedDB;
  if (!idb || typeof idb.databases !== 'function')
    throw new Error('Complete Session IndexedDB enumeration required');
  const prefix = `lody-loro-repo-db-${workspaceId}`;
  const databases = (await idb.databases())
    .filter((db) => db.name === prefix || db.name?.startsWith(`${prefix}:`))
    .map((db) => ({ sourceId: `renderer-idb:loro-doc-layout4:${db.name!}`, dbName: db.name! }))
    .sort((a, b) => (a.dbName < b.dbName ? -1 : a.dbName > b.dbName ? 1 : 0));
  if (databases.length > SESSION_BODY_CAPTURE_MAX_DATABASES)
    throw new Error('Complete Session database inventory exceeds budget');
  return databases;
}
/** Exact released loro-repo layout4, read-only; never call loadDoc, which may compact. */
export async function captureFrozenRendererSessionBody(options: {
  workspaceId: string;
  sessionId: string;
  indexedDB?: IDBFactory;
}): Promise<RendererSessionBodySource[]> {
  const idb = options.indexedDB ?? globalThis.indexedDB;
  if (!idb || typeof idb.databases !== 'function')
    throw new Error('Complete Session IndexedDB enumeration required');
  const prefix = `lody-loro-repo-db-${options.workspaceId}`,
    roomId = `session-${options.sessionId}`;
  const enumerate = async () =>
    (await idb.databases())
      .filter((db) => db.name === prefix || db.name?.startsWith(`${prefix}:`))
      .map((db) => ({ name: db.name!, version: db.version }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const before = await enumerate();
  if (before.length > SESSION_BODY_CAPTURE_MAX_DATABASES)
    throw new Error('Complete Session database inventory exceeds budget');
  const sources: RendererSessionBodySource[] = [];
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
        throw new Error('Unsupported Session IDB layout');
      const tx = db.transaction(['docs', 'doc-updates'], 'readonly');
      const completed = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () =>
          reject(tx.error ?? new Error('Session capture transaction failed'));
      });
      const [base, queue] = await Promise.all([
        request(tx.objectStore('docs').get(roomId)),
        request(tx.objectStore('doc-updates').get(roomId)),
        completed,
      ]);
      let updates: unknown[] = [];
      if (queue !== undefined && queue !== null) {
        if (Array.isArray(queue)) updates = queue;
        else if (typeof queue === 'object' && Array.isArray(queue.updates)) updates = queue.updates;
        else throw new Error('Unsupported Session persisted update queue');
      }
      const parts = [...(base == null ? [] : [binary(base)]), ...updates.map(binary)];
      let snapshot = new Uint8Array();
      if (parts.length) {
        const doc = new LoroDoc();
        try {
          const imported = doc.importBatch(parts);
          if (imported.pending?.size)
            throw new Error('Session persisted causal inventory is incomplete');
          snapshot = Uint8Array.from(doc.export({ mode: 'snapshot' }));
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
    throw new Error('Session database inventory changed during frozen capture');
  return sources;
}
/** One workspace's per-Session author/read-transport gate. A freeze is retained
 * after failure. Physical drain ports must dispose real Mirrors, stores, peers,
 * prefetch and SDK room leases; a cache boolean alone is not a freeze receipt. */
export class RendererSessionBodyFreeze {
  private registration: RendererSessionBodyRegistration | undefined;
  private retired = false;
  private readonly rooms = new Map<
    string,
    { revision: string; owner: 'frozen' | 'native'; pending?: Promise<void> }
  >();
  private readonly active = new Map<string, number>();
  private readonly idle = new Map<string, Set<() => void>>();
  constructor(
    private readonly ports: {
      beginFreeze(sessionId: string): void;
      drainLegacySession(sessionId: string): Promise<void>;
      indexedDB?: IDBFactory;
      published?(sessionId: string): void;
    }
  ) {}
  bind(input: RendererSessionBodyRegistration) {
    const registration = rendererSessionBodyRegistrationSchema.parse(input);
    if (
      this.retired ||
      (this.registration && this.registration.registrationId !== registration.registrationId)
    )
      throw new Error('Session migration registration retired');
    this.registration = registration;
    for (const room of registration.rooms) this.rooms.set(room.sessionId, { ...room });
  }
  shouldRoute(roomId: string) {
    return !roomId.startsWith('session-') || (!this.retired && !this.rooms.has(roomId.slice(8)));
  }
  private check(sessionId: string) {
    if (this.retired || this.rooms.has(sessionId)) throw new Error('Legacy Session body is frozen');
  }
  runSync<A>(sessionId: string, work: () => A): A {
    this.check(sessionId);
    return work();
  }
  async run<A>(sessionId: string, work: () => A | Promise<A>): Promise<A> {
    this.check(sessionId);
    this.active.set(sessionId, (this.active.get(sessionId) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const count = (this.active.get(sessionId) ?? 1) - 1;
      this.active.set(sessionId, count);
      if (!count) for (const wake of this.idle.get(sessionId) ?? []) wake();
    }
  }
  guardStore(store: SessionDocStore): SessionDocStore {
    if (store.nativeBody) return store;
    const id = store.sessionId;
    const commands = Object.fromEntries(
      Object.entries(store.sessionData.commands).map(([key, value]) => [
        key,
        typeof value === 'function'
          ? (...args: unknown[]) =>
              this.run(id, () => Reflect.apply(value, store.sessionData.commands, args))
          : value,
      ])
    ) as unknown as typeof store.sessionData.commands;
    const thisGate = this;
    return {
      ...store,
      get doc() {
        return thisGate.runSync(id, () => store.doc);
      },
      setState: (next) => this.runSync(id, () => store.setState(next)),
      sessionData: { ...store.sessionData, commands },
    };
  }
  async handle(input: RendererSessionBodyRequest): Promise<RendererSessionBodyAck> {
    const message = rendererSessionBodyRequestSchema.parse(input),
      registration = this.registration;
    if (
      this.retired ||
      !registration ||
      registration.registrationId !== message.registrationId ||
      JSON.stringify(registration.binding) !== JSON.stringify(message.binding)
    )
      throw new Error('Session freeze scope mismatch');
    if (message.phase === 'enumerate')
      return {
        ...message,
        databases: await enumerateRendererSessionDatabases(
          registration.binding.workspaceId,
          this.ports.indexedDB
        ),
      };
    let room = this.rooms.get(message.sessionId);
    if (message.phase === 'freeze') {
      if (room && room.revision !== message.revision)
        throw new Error('Session freeze generation changed');
      if (room?.owner === 'native')
        throw new Error('Published Session cannot reopen legacy capture');
      room ??= { revision: message.revision, owner: 'frozen' };
      this.rooms.set(message.sessionId, room);
      this.ports.beginFreeze(message.sessionId);
      room.pending ??= (async () => {
        if (this.active.get(message.sessionId)) {
          await new Promise<void>((resolve) => {
            const waiters = this.idle.get(message.sessionId) ?? new Set();
            waiters.add(resolve);
            this.idle.set(message.sessionId, waiters);
          });
        }
        await this.ports.drainLegacySession(message.sessionId);
      })().catch((error) => {
        room!.pending = undefined;
        throw error;
      });
      await room.pending;
    } else {
      if (!room || room.revision !== message.revision)
        throw new Error('Session capture requires its exact completed freeze');
      if (message.phase === 'publish') {
        await room.pending;
        room.owner = 'native';
        this.ports.published?.(message.sessionId);
      } else {
        if (!room.pending) throw new Error('Session freeze drain has not completed');
        await room.pending;
        const sources = await captureFrozenRendererSessionBody({
          workspaceId: registration.binding.workspaceId,
          sessionId: message.sessionId,
          indexedDB: this.ports.indexedDB,
        });
        if (this.retired || this.rooms.get(message.sessionId) !== room)
          throw new Error('Session capture retired');
        return rendererSessionBodyAckSchema.parse({ ...message, sources });
      }
    }
    if (this.retired) throw new Error('Session freeze retired');
    return { ...message };
  }
  retire() {
    this.retired = true;
  }
}

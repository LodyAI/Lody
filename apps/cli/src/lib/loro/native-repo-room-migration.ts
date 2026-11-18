import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import {
  NativeRepoMigrationJournal,
  readNativeFlockSnapshot,
  verifyFrozenFlockMigration,
  verifyLegacyFlockRollback,
  type FrozenFlockSource,
  type NativeFlockRoom,
} from './native-repo-migration';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const key = (room: NativeFlockRoom) => JSON.stringify([room.kind, room.id]);
const distinctRooms = (rooms: readonly NativeFlockRoom[]) => {
  if (!rooms.length || new Set(rooms.map(key)).size !== rooms.length)
    throw new Error('Migration requires a nonempty distinct whole-room group');
  return [...rooms].sort((a, b) => key(a).localeCompare(key(b), 'en'));
};

/**
 * One trusted process's producer AND observer admission. Every room user must
 * retain its lease until mutations, subscriptions and persistence have drained.
 * Other processes/old binaries need their own explicit freeze-and-drain port;
 * this object makes no claim to fence callers which bypass it.
 */
export class NativeRoomMigrationAdmission {
  private readonly blocked = new Set<string>();
  private readonly users = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  constructor(
    private readonly journal: NativeRepoMigrationJournal,
    private readonly binding: string
  ) {}
  admit(owner: 'legacy' | 'native', rooms: readonly NativeFlockRoom[]): { release(): void } {
    const group = distinctRooms(rooms);
    if (group.some((room) => this.blocked.has(key(room))))
      throw new Error('Room admission is frozen');
    if (group.some((room) => this.journal.isMaintained(this.binding, room)))
      throw new Error('Room admission has persistent rollback maintenance');
    if (this.journal.routeGroup(this.binding, group).owner !== owner)
      throw new Error('Room admission owner does not match the migration journal');
    for (const room of group) this.users.set(key(room), (this.users.get(key(room)) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        for (const room of group) {
          const count = this.users.get(key(room))! - 1;
          if (count) this.users.set(key(room), count);
          else this.users.delete(key(room));
        }
        for (const wake of this.waiters) wake();
      },
    };
  }
  /** Synchronous rejection first, then wait for explicit lease releases. */
  async freezeAndDrain(rooms: readonly NativeFlockRoom[]): Promise<void> {
    const group = distinctRooms(rooms);
    for (const room of group) this.blocked.add(key(room));
    if (group.every((room) => !this.users.has(key(room)))) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        if (group.some((room) => this.users.has(key(room)))) return;
        this.waiters.delete(wake);
        resolve();
      };
      this.waiters.add(wake);
      wake();
    });
  }
  /** Only after the durable whole-group route is committed. */
  resume(rooms: readonly NativeFlockRoom[], owner: 'legacy' | 'native'): void {
    if (rooms.some((room) => this.journal.isMaintained(this.binding, room)))
      throw new Error('Cannot resume persistent rollback maintenance');
    if (this.journal.routeGroup(this.binding, rooms).owner !== owner)
      throw new Error('Cannot resume a different or frozen migration owner');
    for (const room of rooms) this.blocked.delete(key(room));
  }
}

export type NativeRoomMigrationSource = {
  readonly sourceId: string;
  /** Complete exportFile bytes after that replica's persistence/drain barrier. */
  snapshot(): Promise<Uint8Array>;
};
export type NativeRoomMigrationInput = {
  readonly room: NativeFlockRoom;
  /** Explicit complete inventory, including every renderer IDB/daemon replica. */
  readonly sources: readonly NativeRoomMigrationSource[];
};
export type NativeRoomMigrationCoordinatorOptions = {
  readonly binding: string;
  readonly namespace: string;
  readonly targetGeneration: string;
  readonly directory: string;
  readonly dataDir: string;
  readonly journal: NativeRepoMigrationJournal;
  readonly client: RepoClient;
  readonly admission: NativeRoomMigrationAdmission;
  /**
   * Reject new legacy AND native producers/observers, stop transport, then drain
   * every external owner. Must include renderer, other Node clients and services.
   * Persist maintenance mode first; startup must honor it before any admission.
   * Rollback keeps the route native until its final atomic commit, so a process
   * restart cannot use that route alone as permission to restart producers.
   * A failed call stays fenced. No remote pause/remove is a valid substitute.
   */
  freezeExternalOwners(rooms: readonly NativeFlockRoom[]): Promise<void>;
  beforePublish?(): Promise<void>;
};

/**
 * Offline/local binary migration only: imports deliberately enqueue no outbox.
 * Cloud activation must separately publish a complete merged baseline, including
 * previously unsynced replica edits, before claiming cloud catch-up. Neither this
 * tool nor its local journal is a remote-authoritative receipt.
 * No product flag/routing is enabled by constructing this trusted Node tool.
 */
export function createNativeRoomMigrationCoordinatorLegacy(
  options: NativeRoomMigrationCoordinatorOptions
) {
  if (
    !path.isAbsolute(options.directory) ||
    !path.isAbsolute(options.dataDir) ||
    !options.binding ||
    !options.namespace ||
    !options.targetGeneration
  )
    throw new Error('Complete absolute migration owner configuration required');
  let inflight: Promise<unknown> | undefined;
  const exclusive = <A>(run: () => Promise<A>): Promise<A> => {
    if (inflight) return Promise.reject(new Error('Another whole-room migration is active'));
    const operation = run().finally(() => {
      if (inflight === operation) inflight = undefined;
    });
    inflight = operation;
    return operation;
  };
  const freeze = async (rooms: readonly NativeFlockRoom[]) => {
    // Block local admission before external asynchronous shutdown starts.
    const drained = options.admission.freezeAndDrain(rooms);
    await options.freezeExternalOwners(rooms);
    await drained;
    // Published 0.1.0 paused remotes still upload. Require a genuinely quiet
    // namespace, not aggregate health or a successful sync round.
    if ((await options.client.getRemoteStatus(options.namespace)).length)
      throw new Error('Migration requires an offline namespace without configured remotes');
  };
  const archivedPath = (migrationId: string, room: NativeFlockRoom, sourceId: string) => {
    if (!/^[a-f0-9-]+$/.test(migrationId)) throw new Error('Invalid migration archive identity');
    return path.join(
      options.directory,
      'sources',
      migrationId,
      hash(key(room)),
      `${hash(sourceId)}.flock`
    );
  };
  const persist = async (file: string, bytes: Uint8Array) => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      const directory = await open(parent, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      if (parent === path.resolve(options.directory)) break;
      if (path.dirname(parent) === parent) throw new Error('Archive escaped migration directory');
    }
  };
  const read = (room: NativeFlockRoom) =>
    readNativeFlockSnapshot({
      dataDir: options.dataDir,
      namespace: options.namespace,
      room,
    });
  return {
    /** Any failure after freeze remains denied; retry resumes the frozen journal. */
    migrate(inputs: readonly NativeRoomMigrationInput[]): Promise<void> {
      return exclusive(async () => {
        const rooms = distinctRooms(inputs.map((input) => input.room));
        const byRoom = new Map(inputs.map((input) => [key(input.room), input]));
        let route = options.journal.routeGroup(options.binding, rooms);
        if (rooms.some((room) => options.journal.isMaintained(options.binding, room)))
          throw new Error('Room group has persistent rollback maintenance');
        if (route.owner !== 'legacy') {
          for (const room of rooms) {
            const intent = options.journal.getIntent(options.binding, room)!;
            if (
              intent.namespace !== options.namespace ||
              !isDeepStrictEqual(distinctRooms(intent.groupRooms ?? [room]), rooms)
            )
              throw new Error('Migration requires the original complete room group');
          }
        }
        if (route.owner === 'native') {
          if (route.targetGeneration !== options.targetGeneration)
            throw new Error('Migration generation changed');
          return;
        }
        await freeze(rooms);
        route = options.journal.routeGroup(options.binding, rooms);
        if (route.owner === 'native') throw new Error('Migration owner changed during freeze');
        if (route.owner === 'frozen' && route.targetGeneration !== options.targetGeneration)
          throw new Error('Migration generation changed');
        const migrationId = route.owner === 'frozen' ? route.migrationId : randomUUID();
        const sourcesByRoom = new Map<string, FrozenFlockSource[]>();
        for (const room of rooms) {
          const sources: FrozenFlockSource[] = [];
          if (route.owner === 'frozen') {
            const intent = options.journal.getIntent(options.binding, room)!;
            if (intent.namespace !== options.namespace) throw new Error('Frozen namespace changed');
            for (const receipt of intent.sources) {
              const snapshot = await readFile(archivedPath(migrationId, room, receipt.sourceId));
              if (hash(snapshot) !== receipt.sha256)
                throw new Error('Frozen archive integrity failure');
              sources.push({ sourceId: receipt.sourceId, snapshot });
            }
          } else {
            const inventory = byRoom.get(key(room))!.sources;
            if (
              !inventory.length ||
              new Set(inventory.map((source) => source.sourceId)).size !== inventory.length ||
              inventory.some((source) => !source.sourceId)
            )
              throw new Error('Complete distinct source inventory required for every room');
            for (const source of inventory) {
              const snapshot = Uint8Array.from(await source.snapshot());
              // Validate complete CRDT format before changing any journal route.
              verifyFrozenFlockMigration(
                {
                  namespace: options.namespace,
                  room,
                  roomTxId: 0,
                  bytes: snapshot,
                  sha256: hash(snapshot),
                },
                [{ sourceId: source.sourceId, snapshot }]
              );
              await persist(archivedPath(migrationId, room, source.sourceId), snapshot);
              sources.push({ sourceId: source.sourceId, snapshot });
            }
          }
          sourcesByRoom.set(key(room), sources);
        }
        if (route.owner === 'legacy')
          options.journal.freezeGroup(
            rooms.map((room) => ({
              binding: options.binding,
              namespace: options.namespace,
              migrationId,
              room,
              targetGeneration: options.targetGeneration,
              sources: sourcesByRoom
                .get(key(room))!
                .map((source) => ({ sourceId: source.sourceId, sha256: hash(source.snapshot) })),
            }))
          );
        for (const room of rooms) {
          await options.client.createRoom(options.namespace, room, 'plaintext');
          const sources = sourcesByRoom.get(key(room))!;
          for (const source of sources)
            await options.client.importRoomState(options.namespace, room, {
              snapshot: source.snapshot,
              enqueueOutbox: false,
            });
          await options.client.compactRoom(options.namespace, room);
          options.journal.verify(
            options.binding,
            migrationId,
            verifyFrozenFlockMigration(read(room), sources)
          );
        }
        await options.beforePublish?.();
        options.journal.publishGroup(options.binding, rooms, migrationId);
        options.admission.resume(rooms, 'native');
      });
    },
    rollback(
      roomsInput: readonly NativeFlockRoom[],
      legacy: {
        /** Must merge binary CRDT, flush/reopen durable legacy state, then return both snapshots. */
        mergeAndPersist(
          room: NativeFlockRoom,
          native: Uint8Array
        ): Promise<{ before: Uint8Array; after: Uint8Array }>;
      }
    ): Promise<void> {
      return exclusive(async () => {
        const rooms = distinctRooms(roomsInput);
        const route = options.journal.routeGroup(options.binding, rooms);
        if (route.owner === 'legacy') return;
        if (route.owner !== 'native' || route.targetGeneration !== options.targetGeneration)
          throw new Error('Rollback requires a published whole native room group');
        for (const room of rooms) {
          const intent = options.journal.getIntent(options.binding, room)!;
          if (
            intent.namespace !== options.namespace ||
            !isDeepStrictEqual(distinctRooms(intent.groupRooms ?? [room]), rooms)
          )
            throw new Error('Rollback requires the original namespace and complete room group');
        }
        options.journal.beginRollbackGroup(options.binding, rooms, route.migrationId);
        await freeze(rooms);
        const proofs = [];
        for (const room of rooms) {
          await options.client.compactRoom(options.namespace, room);
          const nativeSnapshot = read(room);
          const legacyState = await legacy.mergeAndPersist(room, nativeSnapshot.bytes);
          proofs.push(
            verifyLegacyFlockRollback({
              intent: options.journal.getIntent(options.binding, room)!,
              nativeSnapshot,
              legacyBefore: legacyState.before,
              legacyAfter: legacyState.after,
            })
          );
        }
        await options.beforePublish?.();
        options.journal.completeRollbackGroup(options.binding, rooms, route.migrationId, proofs);
        options.admission.resume(rooms, 'legacy');
      });
    },
  };
}

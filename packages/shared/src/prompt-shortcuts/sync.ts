import { Effect, Exit, Scope } from 'effect';
import {
  makeDurableStream,
  durableAdapterLegacy,
  StreamsAuth,
} from '@loro-dev/streams-crdt/effect';
import { RepoIOError, RepoReleaseFailed } from 'loro-repo/effect';
import type { RemoteCursor } from '@loro-dev/streams-crdt';
import {
  workspaceAcquisitionFailureLegacy,
  type WorkspaceRepoLegacy,
} from '../workspace-data/repo-legacy';
import { type CrdtAdapter, type JsonObject } from '@loro-dev/streams-crdt';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import { createFlockAdapter } from '@loro-dev/streams-crdt/flock';

import { createLoroStreamUrl, LORO_STREAMS_BUCKET_ID } from '../index';
import { getShortcutBodyStreamId, getShortcutIndexStreamId } from './access';
import { PromptShortcutError } from './model';
import type { ShortcutResource } from './access';
import { ShortcutLifetime } from './lifetime';

export type ShortcutStreamGrant = {
  token: string;
  expiresIn: number;
  gatewayBaseUrl: string;
  streamId: string;
};

/** Prevent background echo writes as well as relying on the gateway's read-only grant. */
export function readonlyShortcutAdapter<T extends JsonObject>(
  adapter: CrdtAdapter<T>
): CrdtAdapter<T> {
  return {
    emptyVersion: () => adapter.emptyVersion(),
    mergeVersions: (left, right) => adapter.mergeVersions(left, right),
    exportSnapshot: () => adapter.exportSnapshot(),
    applySnapshot: (snapshot) => adapter.applySnapshot(snapshot),
    exportUpdates: () => null,
    applyRemoteUpdates: (updates, version) => adapter.applyRemoteUpdates(updates, version),
    ...(adapter.createIsolatedAdapter
      ? { createIsolatedAdapter: () => adapter.createIsolatedAdapter!() }
      : {}),
    subscribeLocalUpdates: () => () => {},
  };
}

type ShortcutSyncRoom = {
  sync(): Promise<void>;
  join(): Promise<void>;
  close(): Promise<void>;
};

type ShortcutRoomEntry = {
  refs: number;
  write: boolean;
  opening: Promise<ShortcutSyncRoom>;
  retiring?: boolean;
  closing?: Promise<void>;
};

export type ShortcutSyncLease = Pick<ShortcutSyncRoom, 'sync' | 'join'> & {
  release(): Promise<void>;
};

/**
 * Scoped resources do not use the workspace token or sync its Meta room.
 * Each live room has one CRDT/transport/lease, independent of React consumers.
 */
export class PromptShortcutSync {
  private readonly lifetime = new ShortcutLifetime();
  private rooms = new Map<string, ShortcutRoomEntry>();
  private disposed = false;

  constructor(
    private readonly options: {
      repo: WorkspaceRepoLegacy;
      grant: (resource: ShortcutResource, write: boolean) => Promise<ShortcutStreamGrant>;
      now: () => number;
    }
  ) {}

  async acquire(resource: ShortcutResource, write: boolean): Promise<ShortcutSyncLease> {
    if (this.disposed) throw new Error('Shortcut sync is disposed');
    const key =
      resource.kind === 'index'
        ? getShortcutIndexStreamId(resource.domain)
        : getShortcutBodyStreamId(resource.bodyDocId);
    let entry = this.rooms.get(key);
    if (entry?.retiring) {
      await this.closeRoom(key, entry);
      return this.acquire(resource, write);
    }
    if (entry && entry.write !== write)
      throw new PromptShortcutError(
        'forbidden',
        'Release the existing room before changing its access mode'
      );
    if (!entry) {
      entry = { refs: 0, write, opening: this.open(resource, write) };
      this.rooms.set(key, entry);
    }
    const captured = entry;
    captured.refs++;
    let room: ShortcutSyncRoom;
    try {
      room = await captured.opening;
    } catch (error) {
      captured.refs--;
      if (this.rooms.get(key) === captured) this.rooms.delete(key);
      throw error;
    }
    let released = false;
    const release = async () => {
      if (!released) {
        released = true;
        captured.refs--;
      }
      if (captured.refs !== 0 || this.rooms.get(key) !== captured) return;
      return this.closeRoom(key, captured);
    };
    if (this.disposed) {
      await release();
      throw new Error('Shortcut sync is disposed');
    }
    return {
      sync: () => {
        if (released) throw new Error('Shortcut sync lease released');
        return room.sync();
      },
      join: () => {
        if (released) throw new Error('Shortcut sync lease released');
        return room.join();
      },
      release,
    };
  }

  private closeRoom(key: string, entry: ShortcutRoomEntry): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.retiring = true;
    entry.closing = entry.opening
      .then((room) => room.close())
      .then(() => {
        if (this.rooms.get(key) === entry) this.rooms.delete(key);
      })
      .finally(() => {
        entry.closing = undefined;
      });
    return entry.closing;
  }

  private async open(resource: ShortcutResource, write: boolean): Promise<ShortcutSyncRoom> {
    const streamId =
      resource.kind === 'index'
        ? getShortcutIndexStreamId(resource.domain)
        : getShortcutBodyStreamId(resource.bodyDocId);
    let grant = await this.lifetime.wait(this.options.grant(resource, write));
    if (grant.streamId !== streamId)
      throw new PromptShortcutError('forbidden', 'Grant does not match the requested stream');
    const gatewayBaseUrl = grant.gatewayBaseUrl;
    let expiresAt = this.options.now() + grant.expiresIn * 1000;
    const auth = async (force: boolean) => {
      if (force || this.options.now() >= expiresAt - 5000) {
        grant = await this.lifetime.wait(this.options.grant(resource, write));
        if (grant.streamId !== streamId || grant.gatewayBaseUrl !== gatewayBaseUrl) {
          throw new PromptShortcutError('forbidden', 'Stream grant changed its resource');
        }
        expiresAt = this.options.now() + grant.expiresIn * 1000;
      }
      return grant.token;
    };
    const owner = await this.options.repo.acquireScopeLegacy(`shortcut:${streamId}`);
    const repo = this.options.repo;
    try {
      const resourceOwner = await repo.runLegacy(
        Effect.gen(function* () {
          const lease =
            resource.kind === 'body'
              ? yield* repo.native.acquireDoc(streamId)
              : yield* repo.native.acquireFlockDoc(streamId);
          const adapter: CrdtAdapter<JsonObject> =
            'doc' in lease ? createLoroDocAdapter(lease.doc) : createFlockAdapter(lease.flock);
          let cursor: RemoteCursor | null = null;
          const transport = yield* makeDurableStream({
            streamUrl: createLoroStreamUrl({
              baseUrl: gatewayBaseUrl,
              bucketId: LORO_STREAMS_BUCKET_ID,
              streamId,
            }),
            adapter: durableAdapterLegacy(write ? adapter : readonlyShortcutAdapter(adapter)),
            createStreamIfMissing: write,
            // Data is saved first. This private cursor deliberately disappears with the room.
            persistence: {
              load: () => Effect.succeed(cursor),
              checkpoint: ({ cursor: next }) =>
                lease.persist.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      cursor = structuredClone(next);
                    })
                  )
                ),
            },
          }).pipe(
            Effect.provideService(StreamsAuth, {
              getToken: (context, io) =>
                io.fromPromise(() => auth(context.reason === 'unauthorized')),
            })
          );
          return { transport, persist: lease.persist };
        }).pipe(Effect.provideService(Scope.Scope, owner.scope))
      );
      const transport = resourceOwner.transport;
      let joining: Promise<void> | undefined;
      let closed = false;
      let releaseFailed = false;
      const release: Effect.Effect<void, RepoReleaseFailed> = Effect.suspend(() =>
        Effect.gen(function* () {
          const result = yield* (releaseFailed ? transport.retryRelease : transport.close).pipe(
            Effect.exit
          );
          if (Exit.isFailure(result)) {
            releaseFailed = true;
            yield* Effect.fail(
              new RepoReleaseFailed(`shortcut:${streamId}`, result.cause, release)
            );
          }
          yield* owner.close;
        })
      );
      return {
        sync: async () => {
          if (closed) throw new Error('Shortcut room closed');
          await repo.runLegacy(
            transport.connect.pipe(
              Effect.andThen(transport.sync),
              Effect.flatMap((result) =>
                result.kind === 'confirmed'
                  ? resourceOwner.persist
                  : Effect.fail(new RepoIOError('shortcut synchronization not confirmed', result))
              ),
              Effect.mapError((failure) =>
                failure instanceof RepoIOError ? failure : new RepoIOError('shortcut sync', failure)
              ),
              Effect.provideService(Scope.Scope, owner.scope)
            )
          );
        },
        join: () => {
          if (closed) return Promise.reject(new Error('Shortcut room closed'));
          if (joining) return joining;
          joining = repo
            .runLegacy(
              transport.join.pipe(Effect.asVoid, Effect.provideService(Scope.Scope, owner.scope))
            )
            .catch((error: unknown) => {
              joining = undefined;
              throw error;
            });
          return joining;
        },
        close: async () => {
          closed = true;
          await repo.runLegacy(release);
        },
      };
    } catch (error) {
      try {
        await repo.runLegacy(owner.close);
      } catch (cleanup) {
        throw workspaceAcquisitionFailureLegacy(error, cleanup, 'Shortcut acquisition');
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifetime.dispose();
    const entries = [...this.rooms];
    const results = await Promise.allSettled(
      entries.map(([key, entry]) => this.closeRoom(key, entry))
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Shortcut sync release failed'
      );
  }
}

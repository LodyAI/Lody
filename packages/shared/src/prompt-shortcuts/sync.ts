import {
  StreamsCrdt,
  type CrdtAdapter,
  type JsonObject,
  type TransportSubscription,
} from '@loro-dev/streams-crdt';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import { createFlockAdapter } from '@loro-dev/streams-crdt/flock';
import type { LoroRepo } from 'loro-repo';
import { createLoroStreamUrl, LORO_STREAMS_BUCKET_ID } from '../index';
import { getShortcutBodyStreamId, getShortcutIndexStreamId } from './access';
import { PromptShortcutError } from './model';
import type { ShortcutResource } from './access';

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

export type ShortcutSyncLease = Pick<ShortcutSyncRoom, 'sync' | 'join'> & {
  release(): Promise<void>;
};

/**
 * Scoped resources do not use the workspace token or sync its Meta room.
 * Each live room has one CRDT/transport/lease, independent of React consumers.
 */
export class PromptShortcutSync {
  private rooms = new Map<
    string,
    { refs: number; write: boolean; opening: Promise<ShortcutSyncRoom> }
  >();
  private disposed = false;

  constructor(
    private readonly options: {
      repo: LoroRepo;
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
      if (released) return;
      released = true;
      captured.refs--;
      if (captured.refs === 0 && this.rooms.get(key) === captured) {
        this.rooms.delete(key);
        await room.close();
      }
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

  private async open(resource: ShortcutResource, write: boolean): Promise<ShortcutSyncRoom> {
    const streamId =
      resource.kind === 'index'
        ? getShortcutIndexStreamId(resource.domain)
        : getShortcutBodyStreamId(resource.bodyDocId);
    let grant = await this.options.grant(resource, write);
    if (grant.streamId !== streamId)
      throw new PromptShortcutError('forbidden', 'Grant does not match the requested stream');
    const gatewayBaseUrl = grant.gatewayBaseUrl;
    let expiresAt = this.options.now() + grant.expiresIn * 1000;
    const auth = async (force: boolean) => {
      if (force || this.options.now() >= expiresAt - 5000) {
        grant = await this.options.grant(resource, write);
        if (grant.streamId !== streamId || grant.gatewayBaseUrl !== gatewayBaseUrl) {
          throw new PromptShortcutError('forbidden', 'Stream grant changed its resource');
        }
        expiresAt = this.options.now() + grant.expiresIn * 1000;
      }
      return grant.token;
    };
    const lease =
      resource.kind === 'body'
        ? await this.options.repo.acquireDoc(streamId)
        : await this.options.repo.acquireFlockDoc(streamId);
    try {
      const adapter: CrdtAdapter<JsonObject> =
        'doc' in lease ? createLoroDocAdapter(lease.doc) : createFlockAdapter(lease.flock);
      const persist = () =>
        'doc' in lease
          ? this.options.repo.persistDocNow(streamId, lease.doc)
          : this.options.repo.persistFlockDocNow(streamId, lease.flock);
      const transport = new StreamsCrdt({
        streamUrl: createLoroStreamUrl({
          baseUrl: gatewayBaseUrl,
          bucketId: LORO_STREAMS_BUCKET_ID,
          streamId,
        }),
        adapter: write ? adapter : readonlyShortcutAdapter(adapter),
        auth: (context) => auth(context?.reason === 'unauthorized'),
        createStreamIfMissing: write,
        // In-memory cursors deliberately replay on restart. The document is durable,
        // but a cursor must never outlive the matching local state.
        beforeRemoteCursorSave: persist,
      });
      let subscription: TransportSubscription | undefined;
      let joining: Promise<void> | undefined;
      let closed = false;
      return {
        sync: async () => {
          if (closed) throw new Error('Shortcut room closed');
          const result = await transport.sync();
          if (!result.ok) throw new Error(result.error.message);
          await persist();
        },
        join: () => {
          if (closed) return Promise.reject(new Error('Shortcut room closed'));
          if (joining) return joining;
          joining = (async () => {
            const result = await transport.join();
            if (!result.ok) throw new Error(result.error.message);
            subscription = result.value;
            if (closed) subscription.unsubscribe();
          })().catch((error: unknown) => {
            joining = undefined;
            throw error;
          });
          return joining;
        },
        close: async () => {
          if (closed) return;
          closed = true;
          subscription?.unsubscribe();
          try {
            await transport.close();
          } finally {
            await lease.release();
          }
        },
      };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(
      entries.map(async (entry) => {
        const room = await entry.opening.catch(() => null);
        await room?.close();
      })
    );
  }
}

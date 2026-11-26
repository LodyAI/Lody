import { HANDLED_SHORTCUT_TOKEN_ERROR, isConvexUnauthenticatedError } from '../auth';
import type { WorkspaceStreamsContent } from '../workspace-streams-content';
import {
  encodeStreamsRoomAdditionalData,
  type StreamsRoomIdentity,
} from 'loro-repo/transport/streams';
import {
  type CrdtAdapter,
  type JsonObject,
  type PayloadProtectionProvider,
  type TransportSubscription,
} from '@loro-dev/streams-crdt';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import { createFlockAdapter } from '@loro-dev/streams-crdt/flock';
import type { LoroRepo } from 'loro-repo';
import {
  createLoroStreamUrl,
  getLoroStreamsShardUrls,
  LORO_STREAMS_BUCKET_ID,
} from '../loro-streams-routing';
import {
  loroStreamsWebSocketOptions,
  type LoroStreamsWebSocketOptions,
} from '../loro-streams-websocket';
import { createStreamsCrdt } from '../streams-crdt-factory';
import { getShortcutResourceStreamId, type ShortcutResource } from './access';
import { PromptShortcutError } from './model';
import { ShortcutLifetime } from './lifetime';

export type ShortcutStreamGrant = {
  token: string;
  expiresIn: number;
  gatewayBaseUrl: string;
  streamId: string;
  bucketId?: string;
  shardHostSuffix?: string;
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

export class ShortcutSyncTransportError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ShortcutSyncTransportError';
  }
}

let nextInstancePoolId = 0;

/**
 * Each live room has one CRDT/transport/lease per access mode, independent of React consumers.
 */
export class PromptShortcutSync {
  private readonly lifetime = new ShortcutLifetime();
  private readonly instancePoolId = ++nextInstancePoolId;
  private rooms = new Map<
    string,
    { refs: number; write: boolean; opening: Promise<ShortcutSyncRoom> }
  >();
  private retiringRooms = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly options: {
      content: WorkspaceStreamsContent;
      canWrite?: () => boolean;
      repo: LoroRepo;
      grant: (
        resource: ShortcutResource,
        write: boolean,
        force?: boolean
      ) => Promise<ShortcutStreamGrant>;
      now: () => number;
      workspaceId?: string;
      webSocketEnabled?: boolean;
      webSocketAuth?: LoroStreamsWebSocketOptions['auth'];
      shardHostSuffix?: string;
    }
  ) {}

  async acquire(resource: ShortcutResource, write: boolean): Promise<ShortcutSyncLease> {
    if (this.options.content.mode === 'protected') {
      if (resource.kind === 'index' || resource.kind === 'body')
        throw new PromptShortcutError(
          'forbidden',
          'Encrypted shortcuts require workspace resources'
        );
      if (write && this.options.canWrite?.() !== true)
        throw new PromptShortcutError('forbidden', 'Workspace prompts are read-only');
    }
    if (this.disposed) throw new Error('Shortcut sync is disposed');
    const streamId = getShortcutResourceStreamId(resource);
    if (resource.kind === 'workspace-index') {
      const oppositeKey = `${write ? 'r' : 'w'}:${streamId}`;
      const opposite = this.rooms.get(oppositeKey);
      if (opposite) {
        this.rooms.delete(oppositeKey);
        const previous = this.retiringRooms.get(streamId);
        const retire = (async () => {
          await previous;
          const oldRoom = await opposite.opening.catch(() => null);
          await oldRoom?.close();
        })().finally(() => {
          if (this.retiringRooms.get(streamId) === retire) {
            this.retiringRooms.delete(streamId);
          }
        });
        this.retiringRooms.set(streamId, retire);
      }
      const retiring = this.retiringRooms.get(streamId);
      if (retiring) {
        await retiring;
        if (this.disposed) throw new Error('Shortcut sync is disposed');
      }
    }
    const key = `${write ? 'w' : 'r'}:${streamId}`;
    let entry = this.rooms.get(key);
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
    const streamId = getShortcutResourceStreamId(resource);
    let grant = await this.lifetime.wait(this.options.grant(resource, write, false));
    if (grant.streamId !== streamId)
      throw new PromptShortcutError('forbidden', 'Grant does not match the requested stream');
    const content = this.options.content;
    const bucketId = content.mode === 'protected' ? grant.bucketId : LORO_STREAMS_BUCKET_ID;
    if (!bucketId || (content.mode === 'protected' && bucketId === LORO_STREAMS_BUCKET_ID))
      throw new PromptShortcutError('forbidden', 'Encrypted shortcut bucket unavailable');
    const gatewayBaseUrl = grant.gatewayBaseUrl;
    const shardHostSuffix = grant.shardHostSuffix ?? this.options.shardHostSuffix;
    let provider: PayloadProtectionProvider | undefined;
    if (content.mode === 'protected') {
      const room: StreamsRoomIdentity =
        resource.kind === 'workspace-index'
          ? { kind: 'flock', flockDocId: streamId }
          : { kind: 'doc', docId: streamId };
      const protection = content.resolve(room);
      if (protection.mode !== 'protected')
        throw new PromptShortcutError('forbidden', 'Shortcut room protection unavailable');
      const selected = protection.config.provider;
      provider = {
        maxSealOverheadBytes: selected.maxSealOverheadBytes,
        seal: (request) =>
          selected.seal({
            ...request,
            additionalData: (header) =>
              encodeStreamsRoomAdditionalData(
                content.namespace,
                room,
                request.additionalData(header)
              ),
          }),
        open: (request) =>
          selected.open({
            ...request,
            additionalData: encodeStreamsRoomAdditionalData(
              content.namespace,
              room,
              request.additionalData
            ),
          }),
      };
    }
    let expiresAt = this.options.now() + grant.expiresIn * 1000;
    const auth = async (force: boolean) => {
      if (content.mode === 'protected' && write && this.options.canWrite?.() !== true)
        throw new PromptShortcutError('forbidden', 'Workspace prompts are read-only');
      if (force || this.options.now() >= expiresAt - 5000) {
        grant = await this.lifetime.wait(this.options.grant(resource, write, force));
        if (
          grant.streamId !== streamId ||
          grant.gatewayBaseUrl !== gatewayBaseUrl ||
          (content.mode === 'protected' &&
            (grant.bucketId !== bucketId ||
              (grant.shardHostSuffix ?? this.options.shardHostSuffix) !== shardHostSuffix))
        ) {
          throw new PromptShortcutError('forbidden', 'Stream grant changed its resource');
        }
        expiresAt = this.options.now() + grant.expiresIn * 1000;
      }
      return grant.token;
    };
    const isBody = resource.kind === 'body' || resource.kind === 'workspace-body';
    const lease = isBody
      ? await this.options.repo.acquireDoc(streamId)
      : await this.options.repo.acquireFlockDoc(streamId);
    try {
      const adapter: CrdtAdapter<JsonObject> =
        'doc' in lease ? createLoroDocAdapter(lease.doc) : createFlockAdapter(lease.flock);
      const persist = () =>
        'doc' in lease
          ? this.options.repo.persistDocNow(streamId, lease.doc)
          : this.options.repo.persistFlockDocNow(streamId, lease.flock);
      const isWorkspaceRoom =
        resource.kind === 'workspace-index' || resource.kind === 'workspace-body';
      const authPoolBase =
        this.options.workspaceId ??
        (resource.kind === 'workspace-index' ? resource.workspaceId : '');
      const authPoolKey = this.options.webSocketAuth
        ? authPoolBase
        : authPoolBase
          ? `${authPoolBase}:shortcut:${this.instancePoolId}`
          : `shortcut:${this.instancePoolId}`;
      const { webSocket } = loroStreamsWebSocketOptions(
        this.options.webSocketEnabled === true && resource.kind === 'workspace-index',
        gatewayBaseUrl,
        authPoolKey,
        this.options.webSocketAuth
      );
      const shardUrls = isWorkspaceRoom
        ? (getLoroStreamsShardUrls(gatewayBaseUrl, shardHostSuffix) ?? 'disabled')
        : 'disabled';
      const remoteCursorStore =
        resource.kind === 'workspace-index' &&
        'flock' in lease &&
        typeof this.options.repo.supportsReplicaCheckpoints === 'function' &&
        this.options.repo.supportsReplicaCheckpoints()
          ? this.options.repo.getReplicaCheckpointStore({
              kind: 'flock',
              flockDocId: streamId,
              flock: lease.flock,
            })
          : undefined;
      const transport = createStreamsCrdt({
        streamUrl: createLoroStreamUrl({
          baseUrl: gatewayBaseUrl,
          bucketId,
          streamId,
        }),
        webSocket: webSocket ?? 'disabled',
        shardUrls,
        ...(content.mode === 'protected'
          ? {
              e2ee: {
                readPolicy: 'encrypted-only' as const,
                writePolicy: 'encrypt' as const,
                provider: provider!,
              },
              payloadProtectionRequired: true,
              snapshotCodec: content.snapshotCodec,
              snapshotUpload: write ? content.snapshotUpload : { canUpload: async () => false },
            }
          : {}),
        adapter: write ? adapter : readonlyShortcutAdapter(adapter),
        auth: (context) => auth(context?.reason === 'unauthorized'),
        createStreamIfMissing: write,
        ...(remoteCursorStore ? { remoteCursorStore } : {}),
        beforeRemoteCursorSave: persist,
      });
      let subscription: TransportSubscription | undefined;
      let joining: Promise<void> | undefined;
      let closed = false;
      const toTransportError = (error: {
        code: string;
        message: string;
        cause?: unknown;
      }): Error => {
        if (
          error.code === 'auth_provider_error' &&
          error.cause instanceof Error &&
          (error.cause.name === HANDLED_SHORTCUT_TOKEN_ERROR ||
            isConvexUnauthenticatedError(error.cause))
        )
          return error.cause;
        return new ShortcutSyncTransportError(error.code, error.message);
      };
      return {
        sync: async () => {
          if (closed) throw new Error('Shortcut room closed');
          const result = await transport.sync();
          if (!result.ok) throw toTransportError(result.error);
          await persist();
        },
        join: () => {
          if (closed) return Promise.reject(new Error('Shortcut room closed'));
          if (joining) return joining;
          joining = (async () => {
            const result = await transport.join();
            if (!result.ok) throw toTransportError(result.error);
            subscription = result.value;
            if (closed) {
              subscription.unsubscribe();
              return;
            }
            await persist();
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
    this.lifetime.dispose();
    const entries = [...this.rooms.values()];
    this.rooms.clear();
    const retiring = [...this.retiringRooms.values()];
    await Promise.all([
      ...retiring.map((task) => task.catch(() => undefined)),
      ...entries.map(async (entry) => {
        const room = await entry.opening.catch(() => null);
        await room?.close();
      }),
    ]);
  }
}

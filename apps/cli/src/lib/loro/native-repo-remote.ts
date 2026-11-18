import { readNativeFlockSnapshot, type NativeFlockSnapshot } from './native-repo-snapshot';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  createLodyWorkspaceRoutes,
  type RemoteConfig,
  type RepoClient,
  type RoomKey,
  type StreamRouteRule,
  type SyncReport,
} from '@loro-dev/loro-repo-client';
import {
  connectEngine,
  connectSocketTransport,
  readEngineEndpoint,
} from '@loro-dev/loro-repo-client/node';
import { StreamsClient } from '@loro-dev/streams-client';
import {
  getLoroMetaStreamId,
  getLoroStreamIdForDocId,
  getLoroStreamsBaseUrl,
  getLoroStreamsShardUrls,
  LORO_STREAMS_BUCKET_ID,
  type WorkspaceId,
} from '@lody/shared';
import type { CloudStreamsTokenPort } from '@lody/platform';
import { nodeProcessLive } from '@lody/shared/node/process';
import {
  requirePlaintextWorkspaceStreamsContent,
  type WorkspaceStreamsMode,
} from '@lody/shared/workspace-streams-content';

type RemoteRoom = RoomKey & { readonly kind: 'loro_doc' | 'flock' | 'meta' };
const roomSchema = z
  .object({ kind: z.enum(['loro_doc', 'flock', 'meta']), id: z.string().min(1) })
  .strict();
const roomKey = (room: RemoteRoom) => `${room.kind}:${room.id}`;
const persistedRouteSchema = z
  .object({
    kind: z.enum(['meta', 'loro_doc', 'flock', 'roost_stream']),
    match_exact: z.string().nullable(),
    strip_prefix: z.string().nullable(),
    stream_id: z.string(),
    ttl_seconds: z.number().nullable(),
    bucket: z.string().nullable(),
    skip: z.boolean(),
  })
  .strict();
const persistedRoutes = (routes: readonly StreamRouteRule[]) =>
  routes.map((rule) => ({
    kind: rule.kind,
    match_exact: rule.matchExact ?? null,
    strip_prefix: rule.stripPrefix ?? null,
    stream_id: rule.streamId ?? '',
    ttl_seconds: rule.ttlSeconds ?? null,
    bucket: rule.bucket ?? null,
    skip: rule.skip ?? false,
  }));

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Exact migrated rooms only. Nothing falls through to SDK's default Userspace mapping. */
export function nativeWorkspaceRemoteRoutes(
  workspaceId: WorkspaceId,
  input: readonly RemoteRoom[]
): StreamRouteRule[] {
  const canonical = createLodyWorkspaceRoutes(workspaceId);
  const seen = new Set<string>();
  const routes = input.map((value) => {
    const room = roomSchema.parse(value);
    if (
      seen.has(roomKey(room)) ||
      (room.kind === 'meta' && room.id !== 'meta') ||
      (room.kind === 'flock' && !room.id.startsWith(`${workspaceId}:`)) ||
      (room.kind === 'loro_doc' && room.id.startsWith('shortcut-'))
    ) {
      throw new Error('Native workspace remote room is outside its admitted scope');
    }
    seen.add(roomKey(room));
    const rule = canonical.find(
      (candidate) =>
        candidate.kind === room.kind &&
        (candidate.matchExact !== undefined
          ? candidate.matchExact === room.id
          : candidate.stripPrefix !== undefined
            ? room.id.startsWith(candidate.stripPrefix)
            : true)
    );
    if (!rule || rule.skip) throw new Error('Native workspace remote has no supported route');
    // The published preset misses the legacy session-comment exception and
    // task prefix. The application's existing mapper remains authoritative.
    const streamId =
      room.kind === 'meta'
        ? getLoroMetaStreamId(workspaceId)
        : room.kind === 'loro_doc'
          ? getLoroStreamIdForDocId(workspaceId, room.id)
          : room.id;
    return {
      kind: room.kind,
      matchExact: room.id,
      streamId,
      bucket: LORO_STREAMS_BUCKET_ID,
      ...(rule.ttlSeconds === undefined ? {} : { ttlSeconds: rule.ttlSeconds }),
    };
  });
  if (routes.length === 0) throw new Error('Native workspace remote requires admitted rooms');
  return [
    ...routes,
    ...(['meta', 'loro_doc', 'flock', 'roost_stream'] as const).map((kind) => ({
      kind,
      skip: true,
    })),
  ];
}

/** Stable journal identity: never regenerate it merely because an IPC acknowledgement was lost. */
export function nativeCatalogMigrationWriter(args: {
  binding: string;
  namespace: string;
  remoteId: string;
  migrationId: string;
}): string {
  const values = [args.binding, args.namespace, args.remoteId, args.migrationId].map((value) =>
    z.string().min(1).parse(value)
  );
  return `migration:${sha256(JSON.stringify(values))}`;
}

/**
 * Prepare one NEW remote ID's complete catalog group using published 0.1.0.
 * The caller holds frozen whole-room writers and exclusive remote-configuration
 * ownership until the following first configureRemote. Persist this returned
 * receipt in its journal BEFORE configuration; resume configuration after an
 * unknown ACK without rerunning this preparation or minting another remote ID.
 * Existing remotes must have canonical exact, physically disjoint routes. Never
 * reconfigure their routes or delete them: that destroys their outbox/checkpoints.
 * Each later group gets its own stable remote ID and full frozen inventory.
 */
export async function prepareNativeCatalogRemoteSeedLegacy(args: {
  content: WorkspaceStreamsMode;
  workspaceId: WorkspaceId;
  binding: string;
  namespace: string;
  remoteId: string;
  migrationId: string;
  engineRunId: string;
  dataDir: string;
  client: RepoClient;
  frozen: readonly NativeFlockSnapshot[];
}) {
  requirePlaintextWorkspaceStreamsContent(args.content);
  if (!args.frozen.length) throw new Error('Native catalog seed requires frozen rooms');
  const writer = nativeCatalogMigrationWriter(args);
  const rooms = args.frozen.map((snapshot) => {
    if (snapshot.namespace !== args.namespace)
      throw new Error('Native catalog seed namespace mismatch');
    const room = roomSchema.parse(snapshot.room);
    if (
      room.kind !== 'meta' &&
      (room.kind !== 'flock' ||
        (![`${args.workspaceId}:wf:workspace`, `${args.workspaceId}:sr`].includes(room.id) &&
          !room.id.startsWith(`${args.workspaceId}:mf:`)))
    )
      throw new Error('Native catalog seed does not admit Shortcut, Roost, or document rooms');
    return room;
  });
  nativeWorkspaceRemoteRoutes(args.workspaceId, rooms);
  const assertOwner = async () => {
    if ((await readEngineEndpoint(args.dataDir)).runId !== args.engineRunId)
      throw new Error('Native catalog seed engine changed');
    const db = new Database(
      path.join(
        args.dataDir,
        'namespaces',
        `ns_${Buffer.from(args.namespace).toString('hex')}.sqlite3`
      ),
      { readonly: true, fileMustExist: true, timeout: 0 }
    );
    try {
      const configured = z
        .array(
          z.object({
            remote_id: z.string(),
            encrypted: z.literal(0),
            bucket: z.literal(LORO_STREAMS_BUCKET_ID),
            space: z.literal(args.workspaceId),
            routes_json: z.string(),
          })
        )
        .parse(
          db
            .prepare(
              'SELECT remote_id, encrypted, bucket, space, routes_json FROM v2_remotes ORDER BY remote_id'
            )
            .all()
        );
      if (configured.some((remote) => remote.remote_id === args.remoteId))
        throw new Error(
          'Native catalog seed requires a first remote ID; resume its durable outbox/checkpoints'
        );
      const physical = new Set(
        nativeWorkspaceRemoteRoutes(args.workspaceId, rooms)
          .filter((rule) => !rule.skip)
          .map((rule) => JSON.stringify([rule.bucket, rule.streamId]))
      );
      for (const remote of configured) {
        const routes = persistedRouteSchema.array().parse(JSON.parse(remote.routes_json));
        const activeRooms = routes
          .filter((rule) => !rule.skip)
          .map((rule) => roomSchema.parse({ kind: rule.kind, id: rule.match_exact }));
        const canonical = nativeWorkspaceRemoteRoutes(args.workspaceId, activeRooms);
        if (!isDeepStrictEqual(routes, persistedRoutes(canonical)))
          throw new Error('Native catalog seed requires canonical exact routes without fallback');
        for (const rule of canonical.filter((rule) => !rule.skip)) {
          const target = JSON.stringify([rule.bucket, rule.streamId]);
          if (physical.has(target))
            throw new Error('Native catalog seed routes overlap a physical room');
          physical.add(target);
        }
      }
    } finally {
      db.close();
    }
  };
  const assertFrozen = () => {
    for (const expected of args.frozen) {
      const current = readNativeFlockSnapshot({
        dataDir: args.dataDir,
        namespace: args.namespace,
        room: expected.room,
      });
      if (current.roomTxId !== expected.roomTxId || current.sha256 !== expected.sha256)
        throw new Error('Native catalog seed frozen state changed');
    }
  };
  await assertOwner();
  assertFrozen();
  for (const room of rooms) {
    await args.client.compactRoom(args.namespace, room, writer);
    await assertOwner();
    assertFrozen();
  }
  return {
    writer,
    namespace: args.namespace,
    remoteId: args.remoteId,
    migrationId: args.migrationId,
    rooms: args.frozen.map(({ room, roomTxId, sha256 }) => ({ room, roomTxId, sha256 })),
  };
}

const baselineBrand: unique symbol = Symbol('native-room-observed-tail');
export type NativeRoomRemoteBaseline = {
  readonly [baselineBrand]: true;
  readonly binding: string;
  readonly namespace: string;
  readonly remoteId: string;
  readonly engineRunId: string;
  readonly generation: string;
  readonly configurationSha256: string;
  readonly room: RemoteRoom;
  readonly offset: string;
  readonly roomTxId: number;
};

/**
 * Third-party Promise boundary for the existing CloudStreamsTokenPort Legacy
 * consumer. It creates no cloud port, credentials, Effect runtime, or engine.
 * One trusted workspace owner exclusively controls this namespace/remote route.
 *
 * `releaseAuth` releases this adapter's credentials/client, NOT network I/O.
 * 0.1.0 paused remotes still upload plaintext; removeRemote/route changes delete
 * outbox/checkpoints. Binding retirement must stop the workspace-owned host.
 */
export async function createNativeRepoPlaintextRemoteLegacy(args: {
  readonly content: WorkspaceStreamsMode;
  readonly workspaceId: WorkspaceId;
  readonly binding: string;
  readonly namespace: string;
  readonly remoteId: string;
  readonly engineRunId: string;
  readonly dataDir: string;
  readonly rooms: readonly RemoteRoom[];
  readonly streamsTokens: CloudStreamsTokenPort;
  /** The application's getCliHttpFetch port; tests use their loopback HTTP fixture. */
  readonly fetch: typeof globalThis.fetch;
}) {
  requirePlaintextWorkspaceStreamsContent(args.content);
  for (const value of [
    args.workspaceId,
    args.binding,
    args.namespace,
    args.remoteId,
    args.engineRunId,
  ]) {
    z.string().min(1).parse(value);
  }
  const routes = nativeWorkspaceRemoteRoutes(args.workspaceId, args.rooms);
  const allowed = new Map(args.rooms.map((room) => [roomKey(room), roomSchema.parse(room)]));
  let generation = randomUUID();
  const assertRun = async () => {
    const endpoint = await readEngineEndpoint(args.dataDir);
    if (endpoint.runId !== args.engineRunId || endpoint.protocolVersion !== 2) {
      throw new Error('Native remote engine generation changed');
    }
    return endpoint;
  };
  const originalEndpoint = await assertRun();
  const client = await connectEngine(args.dataDir, { autoReconnect: false });
  let tokens: ReturnType<CloudStreamsTokenPort['createTokenProviderLegacy']>;
  try {
    tokens = args.streamsTokens.createTokenProviderLegacy({ workspaceId: args.workspaceId });
  } catch (error) {
    try {
      await client.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Native remote token acquisition and client release failed'
      );
    }
    throw error;
  }
  let releasing = false;
  let released = false;
  let releaseInFlight: Promise<{ readonly requiresHostStop: true }> | undefined;
  let config: RemoteConfig | undefined;
  let configured = false;
  let originalHostStopped = false;
  let configurationSha256 = '';
  const releaseAuth = () => {
    releasing = true;
    if (released) return Promise.resolve({ requiresHostStop: true } as const);
    return (releaseInFlight ??= (async () => {
      const failures: unknown[] = [];
      // Same route, no deletion/reseed. Clear only the engine's RAM bearer.
      if (configured && config && !originalHostStopped) {
        try {
          await assertRun();
          if (
            configurationSha256 &&
            readRemoteState(args.dataDir, args.namespace, args.remoteId).configurationSha256 !==
              configurationSha256
          ) {
            throw new Error('Native remote configuration changed before auth release');
          }
          assertCompatiblePersistedRoute(args.dataDir, args.namespace, config);
          await client.configureRemote(args.namespace, { ...config, auth_token: null });
        } catch (error) {
          failures.push(error);
        }
      }
      const results = await Promise.allSettled([client.close(), tokens.close()]);
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length)
        throw new AggregateError(failures, 'Native remote auth release incomplete');
      released = true;
      return { requiresHostStop: true } as const;
    })().finally(() => {
      releaseInFlight = undefined;
    }));
  };
  try {
    await tokens.getToken();
    const gateway = getLoroStreamsBaseUrl(tokens.getGatewayBaseUrl());
    const parsedGateway = new URL(gateway);
    if (
      !['http:', 'https:'].includes(parsedGateway.protocol) ||
      parsedGateway.username ||
      parsedGateway.password ||
      parsedGateway.search ||
      parsedGateway.hash
    ) {
      throw new Error('Native remote gateway must be a credential-free HTTP origin/path');
    }
    const suffix = tokens.getShardHostSuffix();
    const shardUrls =
      getLoroStreamsShardUrls(gateway, suffix) ??
      (parsedGateway.pathname !== '/'
        ? {
            // 0.1.0 rewrite_origin treats its fallback base_url as an origin; a
            // pathful gateway otherwise becomes /gateway/gateway/ds/.... Explicit
            // origin-only pools preserve the canonical gateway path exactly once.
            bootstrap: [parsedGateway.origin],
            catchup: [parsedGateway.origin],
            largePost: [parsedGateway.origin],
            other: [parsedGateway.origin],
          }
        : undefined);
    const auth = tokens.createAuthCallback();
    const readAuth = async (
      context?: { reason: string; previousToken?: string },
      signal?: AbortSignal
    ) => {
      if (releasing) throw new Error('Native remote auth is retiring');
      const token = await auth(context, signal);
      if (
        releasing ||
        getLoroStreamsBaseUrl(tokens.getGatewayBaseUrl()) !== gateway ||
        tokens.getShardHostSuffix() !== suffix
      )
        throw new Error('Native remote auth topology changed');
      return token;
    };
    const registerAuth = () =>
      client.registerAuthProvider({
        domains: [args.namespace],
        remoteIds: [args.remoteId],
        getToken: async (request) => {
          if (request.namespace !== args.namespace || request.remoteId !== args.remoteId) {
            throw new Error('Native remote auth scope mismatch');
          }
          try {
            return (
              (await readAuth(
                request.rejectedToken
                  ? { reason: 'unauthorized', previousToken: request.rejectedToken }
                  : { reason: 'request' }
              )) ?? null
            );
          } catch {
            // Reverse-RPC errors are serialized by the SDK. Keep credential and
            // external HTTP error payloads inside the official token owner.
            throw new Error('Native remote auth unavailable');
          }
        },
      });
    for (const room of allowed.values()) {
      if (room.kind === 'loro_doc') await client.inspectDocCausal(args.namespace, room);
      else await client.flockScan(args.namespace, room, { limit: 1 });
    }
    config = {
      remote_id: args.remoteId,
      base_url: gateway,
      encrypted: false,
      bucket: LORO_STREAMS_BUCKET_ID,
      space: args.workspaceId,
      snapshot_zstd: true,
      auth_token: null,
      routes,
      shardUrls,
    };
    assertCompatiblePersistedRoute(args.dataDir, args.namespace, config);
    await registerAuth();
    await client.configureRemote(args.namespace, config);
    configured = true;
    configurationSha256 = readRemoteState(
      args.dataDir,
      args.namespace,
      args.remoteId
    ).configurationSha256;

    const assertOpen = async () => {
      if (releasing) throw new Error('Native remote auth is retiring');
      await assertRun();
      if (
        readRemoteState(args.dataDir, args.namespace, args.remoteId).configurationSha256 !==
        configurationSha256
      ) {
        throw new Error('Native remote configuration changed');
      }
    };
    const head = async (room: RemoteRoom, signal?: AbortSignal) => {
      const route = routes.find(
        (candidate) => candidate.kind === room.kind && candidate.matchExact === room.id
      );
      if (!route?.streamId) throw new Error('Native remote room is outside its admitted scope');
      const url = new URL(
        `${gateway}/ds/${encodeURIComponent(LORO_STREAMS_BUCKET_ID)}/${encodeURIComponent(route.streamId)}`
      );
      const shard = config?.shardUrls?.other?.[0];
      if (shard) {
        const origin = new URL(shard);
        url.protocol = origin.protocol;
        url.host = origin.host;
      }
      const stream = new StreamsClient({
        url,
        auth: readAuth,
        fetch: args.fetch,
      });
      const result = await stream.head({ signal });
      // 404 and 403 are unconfirmed, never an authoritative empty room.
      if (!result.ok) throw new Error('Native remote stream tail is unconfirmed');
      return z.string().min(1).parse(result.result.nextOffset);
    };
    return {
      /** One bounded SDK round; success does not imply the room reached its tail. */
      async syncRound(): Promise<SyncReport> {
        await assertOpen();
        const result = await client.syncNamespace(args.namespace, args.remoteId);
        await assertOpen();
        return result;
      },
      /**
       * A successful SyncNamespace can stop after 4 MiB. Prove one room's
       * persisted checkpoint equals an authenticated observed tail instead.
       * Offsets are opaque: unequal values never imply ordering or coverage.
       */
      async syncRoomToObservedTail(
        roomInput: RemoteRoom,
        options: { readonly signal?: AbortSignal; readonly maxRounds?: number } = {}
      ): Promise<NativeRoomRemoteBaseline> {
        const room = allowed.get(roomKey(roomSchema.parse(roomInput)));
        if (!room) throw new Error('Native remote room is outside its admitted scope');
        const maxRounds = z
          .number()
          .int()
          .min(1)
          .max(64)
          .parse(options.maxRounds ?? 8);
        await assertOpen();
        const before = await head(room, options.signal);
        for (let round = 0; round < maxRounds; round++) {
          options.signal?.throwIfAborted();
          const report = await client.syncNamespace(args.namespace, args.remoteId);
          await assertOpen();
          if (report.blockedRooms !== 0) throw new Error('Native remote room sync is blocked');
          const tail = await head(room, options.signal);
          await assertOpen();
          const checkpoint = readRemoteState(args.dataDir, args.namespace, args.remoteId, room);
          if (checkpoint.configurationSha256 !== configurationSha256)
            throw new Error('Native remote configuration changed');
          if (
            checkpoint.offset !== undefined &&
            (checkpoint.offset === before || checkpoint.offset === tail)
          ) {
            options.signal?.throwIfAborted();
            return {
              [baselineBrand]: true,
              binding: args.binding,
              namespace: args.namespace,
              remoteId: args.remoteId,
              engineRunId: args.engineRunId,
              generation,
              configurationSha256,
              room,
              offset: checkpoint.offset,
              roomTxId: checkpoint.roomTxId,
            };
          }
        }
        throw new Error('Native remote room tail coverage is unconfirmed');
      },
      async isCurrent(receipt: NativeRoomRemoteBaseline): Promise<boolean> {
        if (
          receipt[baselineBrand] !== true ||
          receipt.binding !== args.binding ||
          receipt.namespace !== args.namespace ||
          receipt.remoteId !== args.remoteId ||
          receipt.engineRunId !== args.engineRunId ||
          receipt.generation !== generation ||
          receipt.configurationSha256 !== configurationSha256 ||
          !allowed.has(roomKey(receipt.room))
        )
          return false;
        try {
          await assertOpen();
          return true;
        } catch {
          return false;
        }
      },
      /** Rebind only this same admitted engine run. The SDK re-registers auth
       * providers; it never replays sent writes. Receipts from the prior socket
       * generation become invalid, even though its durable checkpoint survives. */
      async reconnectAuth() {
        await assertOpen();
        const endpoint = await assertRun();
        generation = randomUUID();
        const transport = await connectSocketTransport(endpoint.socket);
        try {
          await client.reconnectWith(transport);
          await assertOpen();
        } catch (error) {
          try {
            await transport.close();
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], 'Native remote reconnect cleanup failed');
          }
          throw error;
        }
      },
      releaseAuth,
      /** Independent host process only. Stop proof is a real OS observation of
       * the original engine PID, not a caller-supplied flag or a dead socket.
       * A reused/live PID or EPERM remains unconfirmed; never touch a successor.
       * In-process engines cannot use this cleanup path while their host lives. */
      async releaseAuthAfterHostStop() {
        if (!Number.isSafeInteger(originalEndpoint.pid) || originalEndpoint.pid <= 0)
          throw new Error('Native remote host stop proof is unavailable');
        try {
          nodeProcessLive.kill(originalEndpoint.pid, 0);
          throw new Error('Native remote original host is still alive');
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH')
            throw error;
        }
        originalHostStopped = true;
        return await releaseAuth();
      },
      async retryAuthCleanup() {
        await tokens.retryCleanup();
        return await releaseAuth();
      },
    };
  } catch (error) {
    try {
      await releaseAuth();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Native remote initialization and auth release failed'
      );
    }
    throw error;
  }
}

/** A route change in 0.1.0 deletes outbox/checkpoints. Never silently replace it. */
function assertCompatiblePersistedRoute(
  dataDir: string,
  namespace: string,
  config: RemoteConfig
): void {
  const database = new Database(
    path.join(dataDir, 'namespaces', `ns_${Buffer.from(namespace).toString('hex')}.sqlite3`),
    { readonly: true, fileMustExist: true, timeout: 0 }
  );
  try {
    const row = database
      .prepare(`SELECT base_url, encrypted, bucket, space, routes_json,
      shard_urls_json, aad_domain FROM v2_remotes WHERE remote_id = ?`)
      .get(config.remote_id) as
      | {
          base_url: string;
          encrypted: number;
          bucket: string | null;
          space: string | null;
          routes_json: string | null;
          shard_urls_json: string | null;
          aad_domain: string | null;
        }
      | undefined;
    if (!row) return;
    const routes = persistedRoutes(config.routes ?? []);
    const shard = config.shardUrls;
    const shards = shard
      ? {
          bootstrap: shard.bootstrap ?? [],
          catchup: shard.catchup ?? [],
          large_post: shard.largePost ?? [],
          other: shard.other ?? [],
          presence: shard.presence ?? [],
          large_post_min_bytes: shard.largePostMinBytes ?? 0,
        }
      : null;
    if (
      row.base_url.replace(/\/+$/g, '') !== config.base_url ||
      row.encrypted !== 0 ||
      row.bucket !== config.bucket ||
      row.space !== config.space ||
      row.aad_domain !== (config.aadDomain ?? null) ||
      !isDeepStrictEqual(JSON.parse(row.routes_json ?? '[]'), routes) ||
      !isDeepStrictEqual(JSON.parse(row.shard_urls_json ?? 'null'), shards)
    ) {
      throw new Error('Native remote route replacement requires explicit outbox-safe migration');
    }
  } finally {
    database.close();
  }
}

/** Pinned 0.1.0/schema1 compatibility, matching sync.rs lrs1 checkpoint encoding. */
function readRemoteState(dataDir: string, namespace: string, remoteId: string, room?: RemoteRoom) {
  const database = new Database(
    path.join(dataDir, 'namespaces', `ns_${Buffer.from(namespace).toString('hex')}.sqlite3`),
    { readonly: true, fileMustExist: true, timeout: 0 }
  );
  try {
    return database.transaction(() => {
      z.object({ v: z.literal(1) }).parse(
        database.prepare("SELECT v FROM v2_meta WHERE k = 'schema_version'").get()
      );
      const remote = database
        .prepare(`SELECT remote_id, base_url, encrypted, bucket, space,
        snapshot_zstd, paused, routes_json, shard_urls_json, aad_domain FROM v2_remotes WHERE remote_id = ?`)
        .get(remoteId);
      if (!remote) throw new Error('Native remote is not configured');
      const configurationSha256 = sha256(JSON.stringify(remote));
      if (!room) return { configurationSha256, offset: undefined, roomTxId: 0 };
      const kind = room.kind === 'loro_doc' ? 1 : room.kind === 'flock' ? 2 : 3;
      const state = z
        .object({
          encryption: z.literal(0),
          head_tx_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .parse(
          database
            .prepare(
              'SELECT encryption, head_tx_id FROM v2_rooms WHERE room_kind = ? AND room_id = ?'
            )
            .get(kind, room.id)
        );
      const checkpoint = database
        .prepare(
          'SELECT cursor FROM v2_sync_checkpoints WHERE remote_id = ? AND room_kind = ? AND room_id = ?'
        )
        .get(remoteId, kind, room.id) as { cursor?: unknown } | undefined;
      const bytes = checkpoint?.cursor;
      const encoded =
        bytes instanceof Uint8Array
          ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          : undefined;
      const offset = encoded?.startsWith('lrs1:') ? encoded.slice(5) : undefined;
      return { configurationSha256, offset: offset || undefined, roomTxId: state.head_tx_id };
    })();
  } finally {
    database.close();
  }
}

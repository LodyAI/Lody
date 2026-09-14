import type { StreamsTransportAdapter } from 'loro-repo/transport/streams';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';

export type LocalSyncMessage = Parameters<LocalLoroDataPlaneConnection['send']>[0];
export type LocalSyncEvent = Parameters<
  Parameters<LocalLoroDataPlaneConnection['onMessage']>[0]
>[0];

export type EagerSyncTransport =
  | { plane: 'local' }
  | {
      plane: 'cloud';
      options: Pick<
        ConstructorParameters<typeof StreamsTransportAdapter>[0],
        'bucketId' | 'metaStreamId' | 'baseUrl' | 'shardUrls'
      >;
      streamId: string;
    };

/**
 * Auth context carried from the worker's Streams transport to the host. The
 * fields the token provider reads are picked explicitly rather than spread, so
 * a future non-cloneable field on the SDK's context cannot break `postMessage`;
 * the SDK's `status` is intentionally not carried because nothing reads it.
 *
 * `previousToken` is the token the gateway just rejected. The host's provider
 * needs it to tell a real rejection from a stale one, so it must cross this
 * boundary rather than the message being reduced to `reason`. `reason` stays a
 * literal union: the provider compares against `'unauthorized'`, and a widened
 * `string` would let a renamed reason compile while silently degrading to the
 * non-refreshing path.
 */
export type EagerSyncAuthContext = {
  reason: 'request' | 'unauthorized';
  previousToken?: string;
};

export type EagerSyncWorkerInput =
  | {
      type: 'start';
      scope: string;
      workspaceId: string;
      roomId: string;
      peerId: string;
      lastMessageAt: number;
      connected: boolean;
      transport: EagerSyncTransport;
    }
  | { type: 'local-event'; event: LocalSyncEvent }
  | { type: 'local-status'; connected: boolean }
  | { type: 'auth-result'; id: number; token?: string };

export type EagerSyncWorkerOutput =
  | { type: 'complete'; outcome: 'synced' | 'failed' | 'skipped' }
  | { type: 'local-send'; message: LocalSyncMessage }
  | { type: 'auth'; id: number; context?: EagerSyncAuthContext };

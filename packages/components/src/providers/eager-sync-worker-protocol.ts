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
  | { type: 'auth'; id: number; reason?: string };

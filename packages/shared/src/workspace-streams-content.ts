import { parseMachineFlockDocId } from './machine-flock';
import { getWorkspaceFlockDocId } from './workspace-flock';
import type { WorkspaceId } from './ids';
import type { SnapshotCodec, SnapshotUploadOptions } from '@loro-dev/streams-crdt';
import type {
  StreamsRoomIdentity,
  StreamsRoomPayloadProtectionResolver,
} from 'loro-repo/transport/streams';

/** Transport configuration, not a persisted workspace mode or an E2EE capability verdict. */
export type WorkspaceStreamsContent =
  | { mode: 'plaintext' }
  | {
      mode: 'protected';
      /** Trusted application identity; never derive it from a packet or routing URL. */
      namespace: string;
      /** Every Meta, document and named Flock room must select protected content. */
      resolve: StreamsRoomPayloadProtectionResolver;
      /** Explicit admission is required; protection never inherits the plaintext allow gate. */
      snapshotUpload: SnapshotUploadOptions;
      /** Compression only. The SDK protects both updates and snapshots with the provider. */
      snapshotCodec?: SnapshotCodec;
    };

export class WorkspaceStreamsConfigurationError extends Error {
  override readonly name = 'WorkspaceStreamsConfigurationError';
}

/** A cloneable mode marker for paths that cannot yet protect content. */
export type WorkspaceStreamsMode = Pick<WorkspaceStreamsContent, 'mode'>;

/** Reject before any cache, authentication, or transport side effect. */
export function requirePlaintextWorkspaceStreamsContent(content: WorkspaceStreamsMode): void {
  if (content?.mode !== 'plaintext') {
    throw new WorkspaceStreamsConfigurationError(
      'Encrypted workspace does not support this operation'
    );
  }
}

/** Stable across devices and epochs: loro-repo includes this value in frame AAD. */
export function encryptedWorkspaceNamespace(genesisHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(genesisHash))
    throw new WorkspaceStreamsConfigurationError('Encrypted workspace genesis is invalid');
  return `lody-e2ee:${genesisHash}`;
}

/** The M2 content domain. This also validates foreign IPC room identities. */
export function encryptedWorkspaceRoom(
  workspaceId: string,
  room: StreamsRoomIdentity
): { resource: string; model: 'loro' | 'flock' } {
  if (room?.kind === 'meta') return { resource: 'meta', model: 'flock' };
  if (
    room?.kind === 'doc' &&
    typeof room.docId === 'string' &&
    room.docId.length > 0 &&
    room.docId.length <= 1000
  )
    return { resource: `doc:${room.docId}`, model: 'loro' };
  if (
    room?.kind === 'flock' &&
    typeof room.flockDocId === 'string' &&
    room.flockDocId.length <= 1000
  ) {
    const machine = parseMachineFlockDocId(room.flockDocId);
    if (
      (machine && machine.workspaceId === workspaceId) ||
      room.flockDocId === getWorkspaceFlockDocId(workspaceId as WorkspaceId)
    )
      return { resource: `flock:${room.flockDocId}`, model: 'flock' };
  }
  throw new WorkspaceStreamsConfigurationError('Encrypted workspace room is unavailable');
}

/** Build a fail-closed encrypted-only selector without a plaintext default. */
export function encryptedWorkspaceResolver(
  workspaceId: string,
  provider: (
    room: StreamsRoomIdentity
  ) => import('@loro-dev/streams-crdt').PayloadProtectionProvider
): StreamsRoomPayloadProtectionResolver {
  return (room) => {
    encryptedWorkspaceRoom(workspaceId, room);
    return {
      mode: 'protected',
      config: { provider: provider(room), readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
    };
  };
}

/** Content-bearing side channels remain unavailable; minimal plaintext presence is allowed. */
export type WorkspaceRestrictedFeature =
  | 'schedules'
  | 'preview-comments'
  | 'code-collab-index'
  | 'shortcuts'
  | 'sharing'
  | 'remote-preview'
  | 'export'
  | 'oss-import'
  | 'notification-body'
  | 'attachments'
  | 'rpc'
  | 'presence';
export function workspaceSupports(
  content: WorkspaceStreamsMode,
  feature: WorkspaceRestrictedFeature
): boolean {
  return content.mode === 'plaintext' || feature === 'presence';
}

/** Verified host facts only. This state never supplies ledger authority. */
export type WorkspaceEpochStatus = {
  epoch: number;
  rotationRequired: boolean;
  hasCurrentKey: boolean;
};
/** Reception progress only: every non-closed phase permits retained-epoch sends. */
export type WorkspaceEpochPhase = 'ready' | 'installing' | 'waiting-key' | 'failed' | 'closed';

/** Stable room providers select a confirmed installed epoch per operation.
 * Reception never removes transports or blocks old-epoch sends. Timed-out raw
 * work stays owned until settlement; its late receipt cannot commit a selection.
 * @deprecated Compose this Promise SDK boundary when its callers migrate.
 */
export function createWorkspaceEpochTransitionLegacy(input: {
  epoch: number;
  rotationRequired?: boolean;
  timeoutMs?: number;
  onPhase?: (phase: WorkspaceEpochPhase) => void;
}) {
  let epoch = input.epoch;
  let latest: WorkspaceEpochStatus = {
    epoch,
    rotationRequired: !!input.rotationRequired,
    hasCurrentKey: true,
  };
  let phase: WorkspaceEpochPhase = 'ready';
  let generation = 0;
  let flight: Promise<boolean> | undefined;
  let installation: Promise<WorkspaceEpochStatus> | undefined;
  const admitted = new Set<Promise<unknown>>();
  const isClosed = () => phase === 'closed';
  const publish = (next: WorkspaceEpochPhase) => {
    phase = next;
    input.onPhase?.(next);
  };
  const observe = (status: WorkspaceEpochStatus) => {
    if (!isClosed() && status.epoch >= latest.epoch) latest = { ...status };
  };
  const needsUpdate = () => !isClosed() && latest.epoch > epoch;
  return {
    observe,
    needsUpdate,
    phase: () => phase,
    epoch: () => epoch,
    provider(
      make: (writeEpoch: number) => import('@loro-dev/streams-crdt').PayloadProtectionProvider
    ) {
      const track = async <A>(work: () => A | Promise<A>): Promise<A> => {
        if (isClosed()) throw new Error('e2ee_closed');
        const pending = Promise.resolve(work());
        admitted.add(pending);
        try {
          const result = await pending;
          if (isClosed()) throw new Error('e2ee_closed');
          return result;
        } finally {
          admitted.delete(pending);
        }
      };
      return {
        maxSealOverheadBytes: make(epoch).maxSealOverheadBytes,
        seal: (request) => {
          const selected = make(epoch);
          return track(() => selected.seal(request));
        },
        open: (request) => {
          const selected = make(epoch);
          return track(() => selected.open(request));
        },
      } satisfies import('@loro-dev/streams-crdt').PayloadProtectionProvider;
    },
    transition(ports: { install(): Promise<WorkspaceEpochStatus> }): Promise<boolean> {
      if (isClosed()) return Promise.reject(new Error('e2ee_closed'));
      if (flight) return flight;
      if (!needsUpdate()) return Promise.resolve(true);
      // A timed-out native call may still be running. Retain one raw owner and
      // let the next trigger retry only after that owner settles.
      if (installation) return Promise.resolve(false);
      const attempt = ++generation;
      publish('installing');
      const raw = Promise.resolve().then(ports.install);
      installation = raw;
      void raw.then(
        () => {
          if (installation === raw) installation = undefined;
        },
        () => {
          if (installation === raw) installation = undefined;
        }
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('e2ee_key_update_timeout')),
          input.timeoutMs ?? 10_000
        );
      });
      flight = (async () => {
        try {
          const installed = await Promise.race([raw, deadline]);
          if (isClosed() || generation !== attempt) return false;
          observe(installed);
          if (!installed.hasCurrentKey || installed.epoch !== latest.epoch) {
            publish('waiting-key');
            return false;
          }
          // No await between key readback and selection. Existing room callbacks
          // keep the same provider and obtain this epoch on their next seal.
          epoch = installed.epoch;
          publish('ready');
          return true;
        } catch (error) {
          if (!isClosed()) {
            generation += 1;
            publish('failed');
          }
          throw error;
        } finally {
          clearTimeout(timer);
          flight = undefined;
        }
      })();
      return flight;
    },
    async close() {
      generation += 1;
      publish('closed');
      await flight?.catch(() => {});
      await installation?.catch(() => {});
      await Promise.allSettled([...admitted]);
    },
  };
}

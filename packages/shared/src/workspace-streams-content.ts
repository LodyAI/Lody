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

/** Unencrypted side channels remain unavailable until their E2EE milestones. */
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
  _feature: WorkspaceRestrictedFeature
): boolean {
  return content.mode === 'plaintext';
}

/** Verified host facts only. This state never supplies ledger authority. */
export type WorkspaceEpochStatus = {
  epoch: number;
  rotationRequired: boolean;
  hasCurrentKey: boolean;
};
/** Safe progress for the owning workspace's recovery UI. */
export type WorkspaceEpochPhase =
  | 'ready'
  | 'draining'
  | 'waiting-key'
  | 'installing'
  | 'restarting'
  | 'failed'
  | 'closed';

/** Promise SDK boundary shared by renderer and CLI. One workspace owns one gate.
 * Stop admission synchronously, retain actual operations through settlement and
 * retry failed handoffs on the same owners. No journal or CRDT data is deleted.
 * @deprecated Compose the SDK lifecycle natively when its callers migrate.
 */
export function createWorkspaceEpochTransitionLegacy(input: {
  epoch: number;
  rotationRequired?: boolean;
  onPhase?: (phase: WorkspaceEpochPhase) => void;
}) {
  let epoch = input.epoch;
  let latest: WorkspaceEpochStatus = {
    epoch,
    rotationRequired: input.rotationRequired === true,
    hasCurrentKey: true,
  };
  let phase: WorkspaceEpochPhase = latest.rotationRequired ? 'waiting-key' : 'ready';
  let generation = 0;
  let flight: Promise<boolean> | undefined;
  const admitted = new Set<Promise<unknown>>();
  const publish = (next: WorkspaceEpochPhase) => {
    phase = next;
    input.onPhase?.(next);
  };
  const isClosed = () => phase === 'closed';
  const stale = () => new Error('e2ee_epoch_superseded');
  const observe = (status: WorkspaceEpochStatus) => {
    if (isClosed() || status.epoch < latest.epoch) return;
    const changed = status.epoch > latest.epoch;
    latest = { ...status };
    if (phase === 'ready' && (status.epoch !== epoch || status.rotationRequired)) {
      generation += 1;
      publish('draining');
    } else if (changed) {
      generation += 1;
    }
  };
  return {
    observe,
    phase: () => phase,
    epoch: () => epoch,
    provider(
      make: (writeEpoch: number) => import('@loro-dev/streams-crdt').PayloadProtectionProvider
    ) {
      const ownedGeneration = generation;
      const provider = make(epoch);
      const track = async <A>(work: () => A | Promise<A>, writing: boolean): Promise<A> => {
        if (writing && phase !== 'ready' && !isClosed())
          throw new Error('e2ee_key_update_required');
        if (ownedGeneration !== generation || isClosed()) throw stale();
        const pending = Promise.resolve(work());
        admitted.add(pending);
        try {
          const result = await pending;
          if (ownedGeneration !== generation || isClosed()) throw stale();
          return result;
        } finally {
          admitted.delete(pending);
        }
      };
      return {
        ...provider,
        seal: (request) => track(() => provider.seal(request), true),
        open: (request) => track(() => provider.open(request), false),
      } satisfies import('@loro-dev/streams-crdt').PayloadProtectionProvider;
    },
    transition(ports: {
      drain(): Promise<void>;
      install(): Promise<WorkspaceEpochStatus>;
      restart(): Promise<void>;
    }): Promise<boolean> {
      if (isClosed()) return Promise.reject(stale());
      if (flight) return flight;
      if (phase === 'ready') return Promise.resolve(true);
      const startGeneration = generation;
      const current = () => {
        if (isClosed() || generation !== startGeneration) throw stale();
      };
      flight = (async () => {
        try {
          publish('draining');
          await Promise.allSettled([...admitted]);
          current();
          await ports.drain();
          current();
          if (latest.rotationRequired) {
            publish('waiting-key');
            return false;
          }
          publish('installing');
          const installed = await ports.install();
          current();
          observe(installed);
          if (installed.rotationRequired || !installed.hasCurrentKey) {
            publish('waiting-key');
            return false;
          }
          if (installed.epoch !== latest.epoch) throw stale();
          epoch = installed.epoch;
          // Providers acquired before the successful key readback stay retired.
          generation += 1;
          const restartGeneration = generation;
          publish('restarting');
          await ports.restart();
          if (isClosed() || generation !== restartGeneration) throw stale();
          publish('ready');
          return true;
        } catch (error) {
          if (!isClosed()) publish('failed');
          throw error;
        } finally {
          flight = undefined;
        }
      })();
      return flight;
    },
    async close() {
      generation += 1;
      publish('closed');
      await flight?.catch(() => {});
      await Promise.allSettled([...admitted]);
    },
  };
}

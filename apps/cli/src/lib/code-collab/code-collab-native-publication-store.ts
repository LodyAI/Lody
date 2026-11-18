import { RepoRpcError, type RepoClient, type FlockOp } from '@loro-dev/loro-repo-client';
import {
  CodeCollabPublicationConflict,
  type CodeCollabPublicationMutation,
  type CodeCollabPublicationStore,
} from './code-collab-publication-store';
import { waitForCodeCollabTask } from './code-collab-task';

/**
 * Local-only pilot. The composition owner must select this entire fi/fis room
 * pair and exclude legacy acquisition/sync before handing it to publication.
 * This adapter borrows a private client; it never owns the engine or transport.
 */
export function createNativeLocalCodeCollabPublicationStore(options: {
  readonly client: RepoClient;
  readonly namespace: string;
  readonly workspaceId: string;
}): CodeCollabPublicationStore {
  const { client, namespace, workspaceId } = options;
  const indexPrefix = `${workspaceId}:fi:`;
  const signalPrefix = `${workspaceId}:fis:`;
  return {
    async open(flockDocId, signal) {
      signal?.throwIfAborted();
      const isIndex = flockDocId.startsWith(indexPrefix) && flockDocId.length > indexPrefix.length;
      const isSignal =
        flockDocId.startsWith(signalPrefix) && flockDocId.length > signalPrefix.length;
      if (!isIndex && !isSignal)
        throw new Error('Code Collab publication room is outside this workspace.');
      const room = { kind: 'flock' as const, id: flockDocId };
      await waitForCodeCollabTask(client.createRoom(namespace, room, 'plaintext'), signal);
      signal?.throwIfAborted();
      return {
        async reconcile(signal) {
          signal?.throwIfAborted();
          // No cloud operation belongs in P2. The engine owner's namespace is
          // local-only; current local rows are not remote command authority.
        },
        async read(signal) {
          signal?.throwIfAborted();
          const state = await waitForCodeCollabTask(client.flockScan(namespace, room), signal);
          signal?.throwIfAborted();
          return { view: { scan: () => state.entries }, roomTxId: state.roomTxId };
        },
        async commit(snapshot, mutation, _updatedAtMs, signal) {
          signal?.throwIfAborted();
          if ((isIndex && mutation.kind !== 'index') || (isSignal && mutation.kind !== 'signal')) {
            throw new Error('Code Collab publication mutation does not match the room.');
          }
          if (snapshot.roomTxId === undefined)
            throw new Error('Native publication requires a room revision.');
          const ops = toOperations(mutation);
          if (ops.length === 0) return false;
          try {
            await waitForCodeCollabTask(
              client.flockBatch(namespace, room, ops, {
                precondition: { mode: 'cas', expected_room_tx_id: snapshot.roomTxId },
              }),
              signal
            );
          } catch (error) {
            if (error instanceof RepoRpcError && error.code === 'precondition_failed') {
              throw new CodeCollabPublicationConflict(error);
            }
            throw error;
          }
          signal?.throwIfAborted();
          return true;
        },
      };
    },
  };
}

function toOperations(mutation: CodeCollabPublicationMutation): FlockOp[] {
  if (mutation.kind === 'signal') {
    return [{ op: 'put', key: ['s'], value: { v: 1, r: mutation.revision } }];
  }
  const { batch } = mutation;
  return [
    ...batch.sets.map(([path, value]): FlockOp => ({ op: 'put', key: [path], value })),
    ...batch.generationSets.map(([path, g]): FlockOp => ({
      op: 'put',
      key: [path, 'v'],
      value: { g },
    })),
    ...batch.deletes.map((path): FlockOp => ({ op: 'delete', key: [path] })),
    ...batch.generationDeletes.map((path): FlockOp => ({ op: 'delete', key: [path, 'v'] })),
  ];
}

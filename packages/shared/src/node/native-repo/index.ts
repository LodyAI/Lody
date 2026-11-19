import { Effect } from 'effect';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { connectEngine, ensureEngineHost } from '@loro-dev/loro-repo-client/node';
import type { RepoClient, FlockStateEntry, FlockOp } from '@loro-dev/loro-repo-client';
import {
  applyPreviewVisualCommentMutation,
  PreviewVisualCommentMutationSchema,
} from '../../preview-comment-mutation';
import type { PreviewVisualCommentMutation } from '../../preview-comment-mutation';
import type { PreviewVisualComment, PreviewVisualCommentDoc } from '../../preview-comment-types';
import type { SessionId } from '../../index';
import { observeRoom, type ObservationSource } from '../../room-observation';
import { getLodyDataDir } from '../installation-profile';

export const nativePreviewDataDir = () =>
  join(getLodyDataDir('local'), 'native-preview-comments', 'v1');
export const nativePreviewRoom = { kind: 'flock' as const, id: 'preview-comments-v1' };
const budget = { maxRows: 128, maxBytes: 256 * 1024 };
const key = (sessionId: string, id: string) => ['comment', sessionId, id];

/** Daemon application boundary. SDK owns locking, endpoint publication and threads. */
export async function startNativePreviewHost(dataDir = nativePreviewDataDir()) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const addon = await import('@loro-dev/loro-repo-engine');
  return ensureEngineHost({ addon, dataDir, clientOptions: { queueWhileReconnecting: false } });
}

/** Main attaches only; it never stops an engine owned by the daemon. */
export const connectNativePreviewHost = (dataDir = nativePreviewDataDir()) =>
  connectEngine(dataDir, { queueWhileReconnecting: false, waitForEndpointMs: 2000 });

export function nativeFlockSource(
  client: RepoClient,
  namespace: string,
  prefix: string[]
): ObservationSource<FlockStateEntry> {
  return {
    begin(listener) {
      const stop = client.onConnectionStateChange((state) => {
        if (state !== 'connected')
          listener({ kind: 'invalidated', generation: opening.handle.generation });
      });
      const opening = client.beginFlockChangesSubscription(
        namespace,
        nativePreviewRoom,
        prefix,
        (update) => {
          if (update.kind === 'gap')
            listener({ kind: 'invalidated', generation: update.generation });
          else listener({ ...update, kind: update.kind });
        }
      );
      return {
        ready: opening.ready,
        handle: {
          release: async () => {
            stop();
            return opening.handle.release();
          },
        },
      };
    },
  };
}

/** Trusted Node adapter; namespaces and authors are selected by the caller's admission. */
export function createNativePreviewComments(client: RepoClient, namespace: string) {
  const ensure = () => client.createRoom(namespace, nativePreviewRoom);
  return {
    ensure,
    observe(sessionId: string, listener: Parameters<typeof observeRoom<FlockStateEntry>>[1]) {
      return observeRoom(nativeFlockSource(client, namespace, ['comment', sessionId]), listener);
    },
    async read(sessionId: string, ids: string[]) {
      return client.flockReadMany(
        namespace,
        nativePreviewRoom,
        ids.map((id) => ({ kind: 'key' as const, key: key(sessionId, id) })),
        budget
      );
    },
    async page(sessionId: string, cursor?: Parameters<RepoClient['flockScanPage']>[4]) {
      return client.flockScanPage(
        namespace,
        nativePreviewRoom,
        { prefix: ['comment', sessionId] },
        budget,
        cursor
      );
    },
    async mutate(sessionId: SessionId, input: PreviewVisualCommentMutation) {
      const mutation = PreviewVisualCommentMutationSchema.parse(input);
      if (Buffer.byteLength(JSON.stringify(mutation)) > 128 * 1024)
        throw new Error('preview_comment_command_too_large');
      const ids =
        mutation.kind === 'create'
          ? [mutation.comment.id]
          : mutation.kind === 'mark-submitted'
            ? mutation.commentIds
            : [mutation.commentId];
      if (ids.length > 64) throw new Error('preview_comment_batch_too_large');
      // No replay on conflict/disconnect: re-read or reconcile the original business id.
      const read = await client.flockReadMany(
        namespace,
        nativePreviewRoom,
        ids.map((id) => ({ kind: 'key' as const, key: key(sessionId, id) })),
        budget
      );
      const doc: PreviewVisualCommentDoc = { meta: { sessionId }, turns: Object.create(null) };
      for (const result of read.results)
        for (const row of result) {
          if (row.deleted) continue;
          const comment = row.value as unknown as PreviewVisualComment;
          const turn = (doc.turns[comment.turnId] ??= { turnId: comment.turnId, comments: [] });
          turn.comments.push(comment);
        }
      if (
        !applyPreviewVisualCommentMutation(
          doc as unknown as Parameters<typeof applyPreviewVisualCommentMutation>[0],
          mutation
        )
      )
        return;
      const ops: FlockOp[] = Object.values(doc.turns).flatMap((turn) =>
        turn.comments.map((comment) => ({
          op: 'put' as const,
          key: key(sessionId, comment.id),
          value: JSON.parse(JSON.stringify(comment)),
        }))
      );
      return client.flockBatchConditional(namespace, nativePreviewRoom, ops, read.readSet);
    },
  };
}

/** Native resource unit; execution belongs to daemon entry, not this adapter. */
export const acquireNativePreviewHost = (dataDir = nativePreviewDataDir()) =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => startNativePreviewHost(dataDir), catch: (cause) => cause }),
    (host) => Effect.promise(() => host.close())
  );

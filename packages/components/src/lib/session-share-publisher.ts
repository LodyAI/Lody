import i18next from 'i18next';
import {
  getSessionFileDownloadApiPath,
  getSessionImageDownloadApiPath,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  prepareSharePackage,
  readShareResponseBytes,
  SHARE_LIMITS,
  ShareResourceId,
} from '@lody/shared/session-sharing';
import type { WorkspaceRuntime, SessionDocStore } from '@/atoms/runtime';
import { API_BASE_URL } from '@/lib';

/** App-only source adapter. Never import this module from the anonymous entry. */
export async function captureSessionShare(options: {
  runtime: WorkspaceRuntime;
  sessions: readonly SessionMeta[];
  rootSessionId: string;
  token: string;
  previousSourceIds?: readonly { sourceId: string; conversationId: string }[];
  signal: AbortSignal;
}) {
  const stores: Array<{ store: SessionDocStore; releaseSync: () => void }> = [];
  try {
    for (const session of options.sessions) {
      options.signal.throwIfAborted();
      await options.runtime.prepareSessionTarget(session.id, session.machineId);
      const store = await options.runtime.acquireSessionStore(session.id);
      stores.push({ store, releaseSync: store.acquireSync() });
    }
    // Hydrate every selected document before capturing any history. Capture below
    // then detaches all histories synchronously in a single client event-loop turn.
    await Promise.all(
      stores.map(({ store }) =>
        Promise.race([
          store.firstSynced,
          new Promise<never>((_, reject) => {
            if (options.signal.aborted) reject(new Error('Share capture cancelled'));
            else
              options.signal.addEventListener(
                'abort',
                () => reject(new Error('Share capture cancelled')),
                { once: true }
              );
          }),
        ])
      )
    );
    options.signal.throwIfAborted();
    const prepared = prepareSharePackage({
      fileAttachmentOmissionText: i18next.t(
        'sharing.fileAttachmentOmitted',
        'File attachment not included in this share'
      ),
      rootSourceId: options.rootSessionId,
      previousSourceIds: options.previousSourceIds,
      capturedAt: new Date().toISOString(),
      conversations: stores.map(({ store }, index) => {
        const meta = options.sessions[index]!;
        return {
          sourceId: meta.id,
          title: meta.title ?? '',
          history: store.historyWriter.readStored(),
          parentSourceId: meta.parentSessionId ?? undefined,
          openedBySourceId: meta.openedBySessionId ?? undefined,
          childSessionPlacement:
            meta.childSessionPlacement === 'side-panel' ? 'side-panel' : undefined,
        };
      }),
      signal: options.signal,
      readAttachment: async ({ conversationSourceId, kind, reference }, signal) => {
        if (kind === 'file' && reference.transport !== 'r2')
          throw new Error('Upload local attachments before sharing');
        const storageId = ShareResourceId.parse(
          reference.storageSessionId ?? conversationSourceId
        ) as SessionId;
        const objectId = ShareResourceId.parse(reference[kind === 'image' ? 'imageId' : 'fileId']);
        const path =
          kind === 'image'
            ? getSessionImageDownloadApiPath(options.runtime.workspaceId, storageId, objectId)
            : getSessionFileDownloadApiPath(options.runtime.workspaceId, storageId, objectId);
        const response = await fetch(new URL(path, API_BASE_URL), {
          headers: { Authorization: `Bearer ${options.token}` },
          signal,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        return {
          bytes: await readShareResponseBytes(response, SHARE_LIMITS.objectBytes),
          mediaType:
            response.headers.get('Content-Type')?.split(';')[0]?.trim() ||
            'application/octet-stream',
        };
      },
    });
    return await prepared;
  } finally {
    for (const { store, releaseSync } of stores) {
      releaseSync();
      options.runtime.releaseSessionStoreRef(store.sessionId);
    }
  }
}

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import {
  createPreviewVisualComment,
  getServerNow,
  type MinimalVisualAnnotationAnchor,
  type PreviewVisualComment,
  type PreviewVisualCommentDocInput,
  type PreviewVisualCommentDocState,
  type SessionId,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom, type PreviewVisualCommentDocStore } from '@/atoms/runtime';
import { browserOnlineAtom } from '@/atoms/control-connection';
import type { RoomSyncState } from '@/lib/room-sync-state';

type PreviewVisualCommentUser = {
  id: string;
  name?: string;
};

type PreviewVisualCommentTurnLike = {
  comments: PreviewVisualComment[];
};

export type UsePreviewVisualCommentDocResult = {
  doc: PreviewVisualCommentDocState;
  comments: PreviewVisualComment[];
  createComment: (input: {
    turnId: string;
    body: string;
    anchor: MinimalVisualAnnotationAnchor;
  }) => Promise<PreviewVisualComment>;
  toggleResolved: (input: { commentId: string; resolved: boolean }) => Promise<void>;
  markSubmitted: (input: { commentId: string; submittedMessageId?: string }) => Promise<void>;
  waitUntilSynced: () => Promise<void>;
  ready: boolean;
  synced: boolean;
};

function normalizeBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error('Comment body is required');
  }
  return trimmed;
}

function requireCurrentUser(
  currentUser: PreviewVisualCommentUser | null
): PreviewVisualCommentUser {
  if (!currentUser?.id) {
    throw new Error('You must be signed in to comment');
  }
  return currentUser;
}

function isPreviewVisualCommentTurnLike(value: unknown): value is PreviewVisualCommentTurnLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { comments?: unknown }).comments)
  );
}

function flattenComments(doc: PreviewVisualCommentDocState): PreviewVisualComment[] {
  const comments: PreviewVisualComment[] = [];
  for (const turn of Object.values(doc.turns)) {
    if (!isPreviewVisualCommentTurnLike(turn)) {
      continue;
    }
    comments.push(...turn.comments);
  }
  return comments
    .filter((comment) => comment.status !== 'cancelled')
    .toSorted((a, b) => b.createdAt - a.createdAt);
}

export function usePreviewVisualCommentDoc(
  sessionId: SessionId,
  options?: { enabled?: boolean; currentUser?: PreviewVisualCommentUser | null }
): UsePreviewVisualCommentDocResult {
  const enabled = options?.enabled ?? true;
  const currentUser = options?.currentUser ?? null;
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const browserOnline = useAtomValue(browserOnlineAtom);
  const ownerTarget = useMemo(() => ({ domain: 'preview_comments' as const, id: sessionId }), [sessionId]);
  const ownerEpoch = useSyncExternalStore(
    useCallback((listener) => runtime?.subscribeDocumentDomainEpoch?.(ownerTarget, listener) ?? (() => {}), [runtime, ownerTarget]),
    useCallback(() => runtime?.getDocumentDomainEpoch?.(ownerTarget) ?? 0, [runtime, ownerTarget]),
    () => 0
  );
  const [nativeSource, setNativeSource] = useState(false);
  const fallbackDoc = useMemo<PreviewVisualCommentDocInput>(
    () => ({ meta: { sessionId }, turns: {} }),
    [sessionId]
  );
  const [state, setState] = useState<PreviewVisualCommentDocState>(
    fallbackDoc as PreviewVisualCommentDocState
  );
  const [ready, setReady] = useState(false);
  const [syncState, setSyncState] = useState<RoomSyncState>('idle');

  useEffect(() => {
    let cancelled = false;
    let acquired = false;
    let acquiredStore: PreviewVisualCommentDocStore | undefined;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeSyncState: (() => void) | null = null;
    setReady(false);
    setSyncState('idle');
    setState(fallbackDoc as PreviewVisualCommentDocState);

    if (!runtime || !enabled) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const store = await runtime.acquirePreviewVisualCommentStore(sessionId);
        acquired = true;
        acquiredStore = store;
        if (cancelled) {
          runtime.releasePreviewVisualCommentStoreRef(sessionId, acquiredStore);
          return;
        }
        setNativeSource(Boolean(store.nativePreview));
        setState(store.getState());
        setSyncState(store.getSyncState());
        setReady(true);
        unsubscribeSyncState = store.subscribeSyncState((nextState) => {
          if (!cancelled) {
            setSyncState(nextState);
            if (store.nativePreview) setReady(nextState === 'synced');
          }
        });
        unsubscribe = store.subscribe((nextState) => {
          if (!cancelled) {
            setState(nextState);
          }
        });
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load preview visual comment doc', { sessionId, error });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) {
        unsubscribe();
      }
      if (unsubscribeSyncState) {
        unsubscribeSyncState();
      }
      if (acquired) {
        runtime.releasePreviewVisualCommentStoreRef(sessionId, acquiredStore);
      }
    };
  }, [enabled, fallbackDoc, runtime, sessionId, ownerEpoch]);

  const withStore = useCallback(
    async <T>(fn: (store: PreviewVisualCommentDocStore) => Promise<T> | T): Promise<T> => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      // Always go through the ref-counted runtime helper. Do not shortcut via a
      // locally cached store: in-flight async callbacks can outlive unmount, at
      // which point the effect's ref is already released and the store may be
      // disposed + unloaded under us.
      return runtime.withPreviewVisualCommentStore(sessionId, fn);
    },
    [runtime, sessionId]
  );

  const createComment = useCallback(
    async (input: { turnId: string; body: string; anchor: MinimalVisualAnnotationAnchor }) => {
      const author = requireCurrentUser(currentUser);
      const now = getServerNow();
      const comment = createPreviewVisualComment({
        id: uuidv4(),
        turnId: input.turnId,
        body: normalizeBody(input.body),
        anchor: input.anchor,
        authorId: author.id,
        authorName: author.name,
        createdAt: now,
        updatedAt: now,
      });
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      await runtime.writer.mutatePreviewVisualComments(sessionId, {
        kind: 'create',
        comment,
      });
      return comment;
    },
    [currentUser, runtime, sessionId]
  );

  const toggleResolved = useCallback(
    async (input: { commentId: string; resolved: boolean }) => {
      const author = requireCurrentUser(currentUser);
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      const now = getServerNow();
      await runtime.writer.mutatePreviewVisualComments(sessionId, {
        ...(input.resolved
          ? {
              kind: 'resolve' as const,
              commentId: input.commentId,
              resolvedAt: now,
              resolvedBy: author.id,
            }
          : {
              kind: 'unresolve' as const,
              commentId: input.commentId,
              updatedAt: now,
            }),
      });
    },
    [currentUser, runtime, sessionId]
  );

  const markSubmitted = useCallback(
    async (input: { commentId: string; submittedMessageId?: string }) => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      await runtime.writer.mutatePreviewVisualComments(sessionId, {
        kind: 'mark-submitted',
        commentIds: [input.commentId],
        submittedAt: getServerNow(),
        ...(input.submittedMessageId ? { submittedMessageId: input.submittedMessageId } : {}),
      });
    },
    [runtime, sessionId]
  );

  const waitUntilSynced = useCallback(async () => {
    await withStore((store) => store.waitUntilSynced());
  }, [withStore]);

  const comments = useMemo(() => flattenComments(state), [state]);

  return {
    doc: state,
    comments,
    createComment,
    toggleResolved,
    markSubmitted,
    waitUntilSynced,
    ready,
    synced: (nativeSource || browserOnline) && syncState === 'synced',
  };
}

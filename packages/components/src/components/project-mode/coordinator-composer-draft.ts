import {
  CoordinatorReplyRefSchema,
  type CoordinatorReplyRef,
  type SessionId,
} from '@lody/shared';
import { z } from 'zod';

const coordinatorThreadDraftSchema = z.object({
  prompt: z.string(),
  subReplyTarget: CoordinatorReplyRefSchema.nullable().default(null),
});

export type CoordinatorThreadDraft = {
  prompt: string;
  subReplyTarget: CoordinatorReplyRef | null;
};

const EMPTY_COORDINATOR_THREAD_DRAFT: CoordinatorThreadDraft = {
  prompt: '',
  subReplyTarget: null,
};

const replyDraftMemoryCache = new Map<SessionId, CoordinatorReplyRef | null>();
const replyDraftStorageKeys = new Map<SessionId, string>();
const threadDraftMemoryCache = new Map<string, CoordinatorThreadDraft>();
const threadDraftStorageKeys = new Map<string, string>();

export const coordinatorReplyDraftKey = (workspaceId: string, sessionId: string): string =>
  `lody:coordinatorReplyDraft:v1:${workspaceId}:${sessionId}`;

export const coordinatorThreadDraftKey = (
  workspaceId: string,
  coordinatorSessionId: string,
  threadRootId: string
): string =>
  `lody:coordinatorThreadDraft:v1:${workspaceId}:${coordinatorSessionId}:${threadRootId}`;

const toThreadMemoryKey = (coordinatorSessionId: string, threadRootId: string): string =>
  `${coordinatorSessionId}:${threadRootId}`;

/**
 * Read the pending reply-banner target for a coordinator conversation, falling
 * back to `localStorage` when the in-memory cache has not hydrated yet.
 */
export function readCoordinatorReplyDraft(
  workspaceId: string | null | undefined,
  sessionId: SessionId
): CoordinatorReplyRef | null {
  if (replyDraftMemoryCache.has(sessionId)) {
    return replyDraftMemoryCache.get(sessionId) ?? null;
  }
  if (!workspaceId || typeof localStorage === 'undefined') {
    return null;
  }
  const key = coordinatorReplyDraftKey(workspaceId, sessionId);
  replyDraftStorageKeys.set(sessionId, key);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = CoordinatorReplyRefSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    replyDraftMemoryCache.set(sessionId, parsed.data);
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Persist or clear the pending reply-banner target for a coordinator conversation.
 */
export function writeCoordinatorReplyDraft(
  workspaceId: string | null | undefined,
  sessionId: SessionId,
  reply: CoordinatorReplyRef | null
): void {
  if (reply) {
    replyDraftMemoryCache.set(sessionId, reply);
  } else {
    replyDraftMemoryCache.delete(sessionId);
  }
  if (typeof localStorage === 'undefined') {
    return;
  }
  const key = workspaceId
    ? coordinatorReplyDraftKey(workspaceId, sessionId)
    : replyDraftStorageKeys.get(sessionId);
  if (!key) {
    return;
  }
  if (workspaceId) {
    replyDraftStorageKeys.set(sessionId, key);
  }
  try {
    if (reply) {
      localStorage.setItem(key, JSON.stringify(reply));
    } else {
      localStorage.removeItem(key);
      replyDraftStorageKeys.delete(sessionId);
    }
  } catch {
    /** Ignore unavailable or quota-full storage while keeping in-memory state. */
  }
}

/**
 * Read the unsent composer draft for a coordinator thread side-panel tab.
 */
export function readCoordinatorThreadDraft(
  workspaceId: string | null | undefined,
  coordinatorSessionId: SessionId,
  threadRootId: string
): CoordinatorThreadDraft {
  const memoryKey = toThreadMemoryKey(coordinatorSessionId, threadRootId);
  const cached = threadDraftMemoryCache.get(memoryKey);
  if (cached) {
    return cached;
  }
  if (!workspaceId || typeof localStorage === 'undefined') {
    return EMPTY_COORDINATOR_THREAD_DRAFT;
  }
  const storageKey = coordinatorThreadDraftKey(workspaceId, coordinatorSessionId, threadRootId);
  threadDraftStorageKeys.set(memoryKey, storageKey);
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return EMPTY_COORDINATOR_THREAD_DRAFT;
    }
    const parsed = coordinatorThreadDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return EMPTY_COORDINATOR_THREAD_DRAFT;
    }
    const draft: CoordinatorThreadDraft = {
      prompt: parsed.data.prompt,
      subReplyTarget: parsed.data.subReplyTarget,
    };
    if (draft.prompt || draft.subReplyTarget) {
      threadDraftMemoryCache.set(memoryKey, draft);
    }
    return draft;
  } catch {
    return EMPTY_COORDINATOR_THREAD_DRAFT;
  }
}

/**
 * Persist or clear the unsent composer draft for a coordinator thread side-panel tab.
 */
export function writeCoordinatorThreadDraft(
  workspaceId: string | null | undefined,
  coordinatorSessionId: SessionId,
  threadRootId: string,
  draft: CoordinatorThreadDraft
): void {
  const memoryKey = toThreadMemoryKey(coordinatorSessionId, threadRootId);
  const hasContent = Boolean(draft.prompt || draft.subReplyTarget);
  if (hasContent) {
    threadDraftMemoryCache.set(memoryKey, draft);
  } else {
    threadDraftMemoryCache.delete(memoryKey);
  }
  if (typeof localStorage === 'undefined') {
    return;
  }
  const storageKey = workspaceId
    ? coordinatorThreadDraftKey(workspaceId, coordinatorSessionId, threadRootId)
    : threadDraftStorageKeys.get(memoryKey);
  if (!storageKey) {
    return;
  }
  if (workspaceId) {
    threadDraftStorageKeys.set(memoryKey, storageKey);
  }
  try {
    if (hasContent) {
      localStorage.setItem(storageKey, JSON.stringify(draft));
    } else {
      localStorage.removeItem(storageKey);
      threadDraftStorageKeys.delete(memoryKey);
    }
  } catch {
    /** Ignore unavailable or quota-full storage while keeping in-memory state. */
  }
}

/** Reset in-memory coordinator draft caches in tests to simulate a cold reload. */
export function evictCoordinatorComposerMemoryDraftsForTest(): void {
  replyDraftMemoryCache.clear();
  replyDraftStorageKeys.clear();
  threadDraftMemoryCache.clear();
  threadDraftStorageKeys.clear();
}

import { SESSION_FILE_MAX_COUNT, type SessionId, type SessionFilePayload } from '@lody/shared';
import type { DraftItem } from '@lody/plugin-sdk/client';
import type { PersistedMentionRange } from '../components/mentions/mention-persistence';
import type { PastedTextDraft } from './pasted-text-draft';
import { validateSessionFile, type SessionFileTransferPhase } from './session-file-upload';
import {
  conversationQuoteDraftKey,
  loadConversationQuoteDraft,
  saveConversationQuoteDraft,
} from './conversation-quote-draft';
import { pluginAttachmentFile } from '../plugins/workspace-drafts';
export const sessionDraftsCache = new Map<SessionId, string>();
export type PendingFile = {
  localId: string;
  file: File;
  status: 'draft' | SessionFileTransferPhase | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  uploaded?: SessionFilePayload;
  /** Abort controller for the in-flight upload (cleared on terminal state). */
  abort?: AbortController;
};
export const sessionFileDraftsCache = new Map<SessionId, PendingFile[]>();
export const sessionPastedTextDraftsCache = new Map<SessionId, PastedTextDraft[]>();
export const sessionQuoteDraftKeys = new Map<SessionId, string>();
export const getSessionFileDrafts = (sessionId: SessionId): PendingFile[] => [
  ...(sessionFileDraftsCache.get(sessionId) ?? []),
];
export const setSessionFileDrafts = (
  sessionId: SessionId,
  files: readonly PendingFile[]
): PendingFile[] => {
  const next = [...files];
  if (next.length === 0) {
    sessionFileDraftsCache.delete(sessionId);
  } else {
    sessionFileDraftsCache.set(sessionId, next);
  }
  return next;
};
/**
 * Mention ranges for the session's draft, kept beside its text.
 *
 * Same lifetime as the other draft caches — in memory, so it covers leaving the
 * session and coming back, which is where the ranges were being lost. It does
 * not survive a restart, but neither does the draft text here, so there is
 * nothing to restore them onto.
 */
export const sessionMentionRangesCache = new Map<SessionId, PersistedMentionRange[]>();
export const getSessionMentionRanges = (sessionId: SessionId): PersistedMentionRange[] => [
  ...(sessionMentionRangesCache.get(sessionId) ?? []),
];
export const setSessionMentionRanges = (
  sessionId: SessionId,
  ranges: readonly PersistedMentionRange[]
): void => {
  if (ranges.length === 0) {
    sessionMentionRangesCache.delete(sessionId);
  } else {
    sessionMentionRangesCache.set(sessionId, [...ranges]);
  }
};
export function hydrateSessionDraft(workspaceId: string, sessionId: SessionId) {
  const key = conversationQuoteDraftKey(workspaceId, sessionId);
  sessionQuoteDraftKeys.set(sessionId, key);
  if (sessionDraftsCache.has(sessionId)) return;
  if (typeof localStorage === 'undefined') return;
  const saved = loadConversationQuoteDraft(localStorage, key);
  if (saved) {
    sessionDraftsCache.set(sessionId, saved.text);
    sessionPastedTextDraftsCache.set(sessionId, saved.drafts);
    setSessionMentionRanges(sessionId, saved.mentions ?? []);
  }
}
export function appendUnmountedSessionDraft(
  workspaceId: string,
  sessionId: SessionId,
  item: DraftItem
) {
  if (item.kind === 'attachment') {
    const files = getSessionFileDrafts(sessionId);
    const file = pluginAttachmentFile(item.snapshot);
    if (files.length >= SESSION_FILE_MAX_COUNT || validateSessionFile(file))
      throw Error('Draft file exceeds attachment limits');
    setSessionFileDrafts(sessionId, [
      ...files,
      { file, localId: crypto.randomUUID(), status: 'draft', progress: 0 },
    ]);
    return;
  }
  hydrateSessionDraft(workspaceId, sessionId);
  const text = (sessionDraftsCache.get(sessionId) ?? '') + item.text;
  sessionDraftsCache.set(sessionId, text);
  const drafts = sessionPastedTextDraftsCache.get(sessionId);
  if (drafts?.length && typeof localStorage !== 'undefined')
    saveConversationQuoteDraft(
      localStorage,
      conversationQuoteDraftKey(workspaceId, sessionId),
      text,
      drafts,
      getSessionMentionRanges(sessionId)
    );
}

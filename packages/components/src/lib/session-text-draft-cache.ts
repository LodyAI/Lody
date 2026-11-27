import type { SessionHistory, SessionId } from '@lody/shared';

/** In-memory composer text draft cache shared across session mounts and workspace switches. */
export const sessionTextDraftsCache = new Map<SessionId, string>();

/**
 * Seed the composer text draft for a session that has not mounted yet. The
 * composer hydrates from this cache on mount, so callers can hand text across
 * a tab promotion or a workspace switch without holding a ref to the component.
 */
export const setSessionChatInputTextDraft = (sessionId: SessionId, text: string): void => {
  if (text) {
    sessionTextDraftsCache.set(sessionId, text);
  } else {
    sessionTextDraftsCache.delete(sessionId);
  }
};

/** Preserve unsent text from disposed held sends without overwriting newer user edits. */
export const preserveHeldSendTextDrafts = (
  sends: ReadonlyArray<{ sessionId: SessionId; entry: Pick<SessionHistory, 'items'> }>
): void => {
  const bySession = new Map<SessionId, string[]>();
  for (const send of sends) {
    const text = send.entry.items
      ?.flatMap((item) => (item.type === 'text' ? [item.text] : []))
      .join('\n')
      .trim();
    if (!text) continue;
    const list = bySession.get(send.sessionId);
    if (list) list.push(text);
    else bySession.set(send.sessionId, [text]);
  }
  for (const [sessionId, parts] of bySession) {
    const existing = sessionTextDraftsCache.get(sessionId)?.trim();
    const combined = parts.join('\n\n');
    setSessionChatInputTextDraft(sessionId, existing ? `${combined}\n\n${existing}` : combined);
  }
};

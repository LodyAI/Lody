/**
 * Rollback switch for windowed conversation rendering, kept for one release.
 *
 * Off means the old path: the session Mirror materializes the whole `history`
 * list, writes go through `Mirror.setState`, and the renderer is fed a fully
 * hydrated `ConversationView` adapter over that array.
 *
 * Resolution order: the build-time env `LODY_CONVERSATION_VIEW=0` wins, then
 * the per-device setting (`conversationViewEnabledAtom`), then on.
 */
export const CONVERSATION_VIEW_STORAGE_KEY = 'lody-conversation-view-enabled';

const readEnvOverride = (): boolean | null => {
  const raw = (import.meta.env as Record<string, string | undefined>).LODY_CONVERSATION_VIEW;
  if (raw === undefined || raw === '') return null;
  return raw !== '0' && raw !== 'false' && raw !== 'off';
};

const readStoredSetting = (): boolean | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CONVERSATION_VIEW_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
};

/** Read at session-store creation; a change applies to stores opened afterwards. */
export function isConversationViewEnabled(): boolean {
  return readEnvOverride() ?? readStoredSetting() ?? true;
}

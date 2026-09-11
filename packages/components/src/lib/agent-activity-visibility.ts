import type { SessionHistoryInput } from '@lody/shared';

type HistoryEntry = Pick<SessionHistoryInput, 'role' | 'finished'> | undefined | null;

/**
 * The session activity row is rendered under the last history bubble.
 * A finished assistant already shows completion chrome (timestamp / duration).
 * Keeping "Thinking" under that bubble is a false status for the same turn.
 *
 * Do not use this to clear session presence. Presence stays session-scoped so a
 * following user turn, permission wait, or autoPrompt can still light the row.
 */
export const shouldHideThinkingUnderFinishedAssistant = (
  history: readonly HistoryEntry[] | null | undefined
): boolean => {
  if (!history?.length) {
    return false;
  }
  const last = history[history.length - 1];
  return last?.role === 'assistant' && last.finished === true;
};

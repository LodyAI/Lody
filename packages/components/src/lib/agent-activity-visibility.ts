import type { SessionHistoryInput, SessionStatus } from '@lody/shared';

type HistoryEntry = Pick<SessionHistoryInput, 'role' | 'finished'> | undefined | null;

/**
 * The session activity row is rendered under the last history bubble.
 * A finished assistant already shows completion chrome (timestamp / duration).
 * Keeping "Thinking" under that bubble is a false status for leftover presence
 * on the same turn. Initializing / permission presence is a new turn (goal
 * resume has no user row) and must keep the presence-driven label.
 *
 * Do not use this to clear session presence.
 */
export const shouldHideThinkingUnderFinishedAssistant = (
  history: readonly HistoryEntry[] | null | undefined,
  liveStatusType?: SessionStatus['type'] | null
): boolean => {
  if (liveStatusType === 'initializing' || liveStatusType === 'requestPermission') {
    return false;
  }
  if (!history?.length) {
    return false;
  }
  const last = history[history.length - 1];
  return last?.role === 'assistant' && last.finished === true;
};

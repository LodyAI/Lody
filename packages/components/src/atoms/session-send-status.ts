import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { SessionSendState, SessionSendStatus } from '@/lib/session-send-status';

/** Written by `SessionPendingSendsHost` from the in-memory pending sends; never synced. */
export const sessionSendStatusesAtom = atom<Record<string, SessionSendStatus>>({});

function sameStatus(a: SessionSendStatus | null, b: SessionSendStatus | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.state === b.state &&
    a.progress === b.progress &&
    a.sentBytes === b.sentBytes &&
    a.totalBytes === b.totalBytes &&
    a.unsentNewConversation === b.unsentNewConversation
  );
}

/** Includes upload progress: subscribe only from a row's end-slot leaf. */
export const sessionSendStatusAtomFamily = atomFamily((sessionId: string) => {
  let previous: SessionSendStatus | null = null;
  return atom((get) => {
    const next = get(sessionSendStatusesAtom)[sessionId] ?? null;
    if (sameStatus(previous, next)) return previous;
    previous = next;
    return next;
  });
});

/** Changes only when a first message is written; safe for memoized rows. */
export const sessionUnsentNewConversationAtomFamily = atomFamily((sessionId: string) =>
  atom((get) => get(sessionSendStatusesAtom)[sessionId]?.unsentNewConversation === true)
);

/**
 * Send state per session without progress, so layout-level group summaries
 * re-render on start, failure and completion only.
 */
export const sessionSendStatesAtom = (() => {
  let previous: Readonly<Record<string, SessionSendState>> = {};
  return atom((get) => {
    const next: Record<string, SessionSendState> = {};
    for (const [sessionId, status] of Object.entries(get(sessionSendStatusesAtom))) {
      next[sessionId] = status.state;
    }
    const keys = Object.keys(next);
    if (
      keys.length === Object.keys(previous).length &&
      keys.every((key) => previous[key] === next[key])
    ) {
      return previous;
    }
    previous = next;
    return next;
  });
})();

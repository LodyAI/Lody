import { useCallback } from 'react';
import { useAtomValue, useStore } from 'jotai';
import type { SessionId } from '@lody/shared';
import { chatLandingDraftSessionIdAtomFamily } from '@/atoms/chat-landing-draft';

function createDraftSessionId(): SessionId {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID() as SessionId;
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}` as SessionId;
}

/**
 * The landing's reserved session id. Held in a module-level atom so the
 * attachments uploaded against it stay addressable after the landing route
 * unmounts and remounts; the store read also removes the state/ref pair the
 * synchronous `ensureSessionId` used to need.
 */
export function useChatLandingDraftSession(draftKey: string) {
  const sessionIdAtom = chatLandingDraftSessionIdAtomFamily(draftKey);
  const store = useStore();
  const sessionId = useAtomValue(sessionIdAtom);

  const ensureSessionId = useCallback((): SessionId => {
    const current = store.get(sessionIdAtom);
    if (current) return current;
    const next = createDraftSessionId();
    store.set(sessionIdAtom, next);
    return next;
  }, [sessionIdAtom, store]);

  const resetSessionId = useCallback(() => {
    store.set(sessionIdAtom, null);
  }, [sessionIdAtom, store]);

  return { sessionId, ensureSessionId, resetSessionId };
}

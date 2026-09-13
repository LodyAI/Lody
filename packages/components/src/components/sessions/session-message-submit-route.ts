export type SessionMessageSubmitRoute =
  | { type: 'direct_dispatch' }
  | { type: 'guide' }
  | { type: 'queue'; reason: 'forced' | 'prompt_busy' | 'unfinished_assistant_turn' };

export type SessionMessageSubmitRouteInput = {
  forceDirect: boolean;
  forceQueue: boolean;
  invertQueuedBehavior: boolean;
  isPromptBusy: boolean;
  hasUnfinishedAssistantTurn: boolean;
  queuedMessageBehavior: 'queue' | 'guide';
};

/**
 * Resolve one authoritative send route from live and durable conversation state.
 *
 * Presence is authoritative for whether a prompt is working right now. The
 * unfinished assistant turn is a conservative ordering barrier for the short
 * cross-room window where history has arrived but presence has not: queuing is
 * safe for both a genuinely active turn and a stale transcript, while direct
 * dispatch can violate the session's single-turn contract.
 */
export function resolveSessionMessageSubmitRoute({
  forceDirect,
  forceQueue,
  invertQueuedBehavior,
  isPromptBusy,
  hasUnfinishedAssistantTurn,
  queuedMessageBehavior,
}: SessionMessageSubmitRouteInput): SessionMessageSubmitRoute {
  if (forceDirect) {
    return { type: 'direct_dispatch' };
  }
  const effectiveQueuedMessageBehavior = invertQueuedBehavior
    ? queuedMessageBehavior === 'queue'
      ? 'guide'
      : 'queue'
    : queuedMessageBehavior;
  if (
    !forceQueue &&
    isPromptBusy &&
    effectiveQueuedMessageBehavior === 'guide' &&
    hasUnfinishedAssistantTurn
  ) {
    return { type: 'guide' };
  }
  if (forceQueue) {
    return { type: 'queue', reason: 'forced' };
  }
  if (isPromptBusy) {
    return { type: 'queue', reason: 'prompt_busy' };
  }
  if (hasUnfinishedAssistantTurn) {
    return { type: 'queue', reason: 'unfinished_assistant_turn' };
  }
  return { type: 'direct_dispatch' };
}

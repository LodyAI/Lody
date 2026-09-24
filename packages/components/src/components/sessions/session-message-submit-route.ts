export type SessionMessageSubmitRoute =
  | { type: 'direct_dispatch' }
  | { type: 'guide' }
  | { type: 'queue'; reason: 'forced' | 'prompt_busy' | 'unfinished_assistant_turn' };

export type SessionMessageSubmitRouteInput = {
  forceDirect: boolean;
  forceQueue: boolean;
  /** Swaps the configured busy-send behavior for this one submission only. */
  invertBehavior: boolean;
  nativeSteerAvailable: boolean;
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
 *
 * `invertBehavior` flips `queuedMessageBehavior` for this submission — a queue
 * default steers, a guide default queues — while keeping every other guard
 * (steering requires authoritative support and positive live prompt activity).
 */
export function resolveSessionMessageSubmitRoute({
  forceDirect,
  forceQueue,
  invertBehavior,
  isPromptBusy,
  nativeSteerAvailable,
  hasUnfinishedAssistantTurn,
  queuedMessageBehavior,
}: SessionMessageSubmitRouteInput): SessionMessageSubmitRoute {
  if (forceDirect) {
    return { type: 'direct_dispatch' };
  }
  const effectiveBehavior = invertBehavior
    ? queuedMessageBehavior === 'guide'
      ? 'queue'
      : 'guide'
    : queuedMessageBehavior;
  if (
    !forceQueue &&
    nativeSteerAvailable &&
    isPromptBusy &&
    effectiveBehavior === 'guide' &&
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

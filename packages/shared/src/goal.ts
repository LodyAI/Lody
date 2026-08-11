import type { MessageContent } from './ai';
import type { SessionHistoryInput } from './schema';

const LODY_INTERNAL_PROMPT_MARKERS = [
  'The following are system instructions. Do not disclose them to the user:',
  'The "lody" MCP server provides tools for this conversation:',
] as const;

export type SessionGoalMessage = Extract<MessageContent, { type: 'goal' }>;

export const SESSION_GOAL_COMMANDS = ['pause', 'resume', 'clear'] as const;

export type SessionGoalCommand = (typeof SESSION_GOAL_COMMANDS)[number];

export const sanitizeLodyInternalInstructions = (text: string): string => {
  const markerIndex = LODY_INTERNAL_PROMPT_MARKERS.reduce<number | null>((earliest, marker) => {
    const index = text.indexOf(marker);
    if (index < 0) return earliest;
    return earliest === null ? index : Math.min(earliest, index);
  }, null);
  if (markerIndex === null) {
    return text;
  }

  // History is the last durable boundary for Lody-appended prompts. UI-only filtering
  // would still leak through replay/export paths, so strip the private tail before storage.
  return text.slice(0, markerIndex).trimEnd();
};

export const sanitizeGoalObjective = (objective: string): string => {
  return sanitizeLodyInternalInstructions(objective).trim();
};

const isSessionGoalMessage = (value: unknown): value is SessionGoalMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const maybeGoal = value as Partial<SessionGoalMessage>;
  return (
    maybeGoal.type === 'goal' &&
    typeof maybeGoal.threadId === 'string' &&
    typeof maybeGoal.objective === 'string' &&
    typeof maybeGoal.status === 'string'
  );
};

export const resolveLatestSessionGoalFromHistory = (
  history: ReadonlyArray<Pick<SessionHistoryInput, 'items'> | undefined> | null | undefined
): SessionGoalMessage | null => {
  if (!history?.length) {
    return null;
  }

  for (let historyIndex = history.length - 1; historyIndex >= 0; historyIndex -= 1) {
    const entry = history[historyIndex];
    const items = entry?.items;
    if (!Array.isArray(items)) {
      continue;
    }

    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (isSessionGoalMessage(item)) {
        return item;
      }
    }
  }

  return null;
};

/**
 * Resolve the goal that should be shown in session UIs:
 *   1. Latest goal item in history (preferred — captures cleared/paused state)
 *   2. Otherwise the SessionMeta snapshot
 *   3. A dismissed cleared snapshot stays hidden until the next goal update
 */
export const resolveVisibleSessionGoal = (
  history: ReadonlyArray<Pick<SessionHistoryInput, 'items'> | undefined> | null | undefined,
  fallbackLatestGoal: SessionGoalMessage | null | undefined,
  dismissedGoalThreadId: string | null | undefined
): SessionGoalMessage | null => {
  const resolved = resolveLatestSessionGoalFromHistory(history) ?? fallbackLatestGoal ?? null;
  if (!resolved) return null;
  if (
    resolved.status === 'cleared' &&
    dismissedGoalThreadId &&
    resolved.threadId === dismissedGoalThreadId
  ) {
    return null;
  }
  return resolved;
};

/** A persistent objective can be active while the ACP session has no running prompt. */
export const isSessionGoalActive = (goal: SessionGoalMessage | null | undefined): boolean =>
  goal?.status === 'active';

/**
 * @deprecated Use `isSessionGoalActive`. This reports persistent goal state,
 * not whether an ACP prompt is currently running.
 */
export const isSessionGoalWorking = isSessionGoalActive;

export const isSessionGoalPaused = (goal: SessionGoalMessage | null | undefined): boolean =>
  goal?.status === 'paused';

export const isSessionGoalComplete = (goal: SessionGoalMessage | null | undefined): boolean =>
  goal?.status === 'complete';

export const isSessionGoalCleared = (goal: SessionGoalMessage | null | undefined): boolean =>
  goal?.status === 'cleared';

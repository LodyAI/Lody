import { useEffect, useMemo, useRef } from 'react';
import { resolveSessionHistoryStatus, type SessionHistory, type SessionId } from '@lody/shared';
import { isNativeIOSAppShell } from '@/lib/native-platform';
import {
  APP_STORE_REVIEW_MIN_WINDOWED_TURNS,
  countWindowedTurns,
  createAppStoreReviewPromptState,
  hasRecentHardFailureOutcome,
  markAppStoreReviewRequestAttempt,
  recordAppStoreReviewTurnOutcomes,
  resolveAppStoreReviewBlockReason,
  type AppStoreReviewBlockReason,
  type AppStoreReviewPromptState,
  type AppStoreReviewTurnOutcome,
} from '@/lib/app-store-review-policy';
import { deferredPostHog } from '@/lib/deferred-posthog';
import { capturePostHogEvent } from '@/lib/posthog-analytics';

export type { AppStoreReviewTurnOutcome } from '@/lib/app-store-review-policy';

export type LodyAppStoreReviewBridge = {
  requestReview: () => void | Promise<void>;
};

const REVIEW_PROMPT_IDLE_MS = 2_500;
const STORAGE_KEY_PREFIX = 'lody:app-store-review:v2:';
/**
 * v1 stored a lifetime turn counter plus up to 512 `sessionId:turnId` strings.
 * Per-turn times cannot be reconstructed from that total, so v2 starts fresh
 * and drops the old blob rather than leaving ~25KB per user behind forever.
 */
const LEGACY_STORAGE_KEY_PREFIX = 'lody:app-store-review:v1:';
const memoryStates = new Map<string, AppStoreReviewPromptState>();

/**
 * Gates outside the eligibility policy that can also stop a candidate turn.
 * Reported through the same `block_reason` so one funnel covers the whole path
 * from finalized turn to StoreKit call.
 */
type AppStoreReviewRuntimeBlockReason =
  | 'bridge_unavailable'
  | 'text_entry_in_progress'
  | 'user_interaction'
  | 'app_not_visible';

type ReviewPromptBlockReason = AppStoreReviewBlockReason | AppStoreReviewRuntimeBlockReason;

// StoreKit reports nothing back and every gate is device-local, so analytics is
// the only way to tell "nobody is eligible" apart from "the bridge is broken".
// Deduplicated per user AND per reason for the life of the app process: a
// candidate turn arrives on every completed turn, so an undeduplicated event
// would be one of the noisiest in the product, while deduplicating on the user
// alone would let whichever gate happens to trip first mask the rest.
const reportedBlockReasons = new Set<string>();

function buildPromptStateProperties(
  state: AppStoreReviewPromptState,
  nowMs: number
): Record<string, unknown> {
  return {
    platform: 'mobile',
    native_platform: 'ios',
    windowed_turn_count: countWindowedTurns(state, nowMs),
    // Distinguishes "never accumulated turns" from "accumulated, then aged out".
    stored_turn_count: state.recentTurnTimesMs.length,
    days_since_last_attempt:
      state.lastRequestAttemptAtMs == null
        ? null
        : Math.round(((nowMs - state.lastRequestAttemptAtMs) / 86_400_000) * 10) / 10,
    has_requested_before: state.lastRequestAttemptAtMs != null,
  };
}

function captureReviewPromptBlocked(userId: string, blockReason: ReviewPromptBlockReason): void {
  const dedupeKey = `${userId}:${blockReason}`;
  if (reportedBlockReasons.has(dedupeKey)) return;
  reportedBlockReasons.add(dedupeKey);
  const nowMs = Date.now();
  capturePostHogEvent(deferredPostHog, 'mobile/app_store_review_prompt_blocked', {
    ...buildPromptStateProperties(readPromptState(userId), nowMs),
    block_reason: blockReason,
    app_version: getCurrentAppVersion(),
  });
}

function getAppStoreReviewBridge(): LodyAppStoreReviewBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as Window & { __LODY_APP_STORE_REVIEW__?: LodyAppStoreReviewBridge })
    .__LODY_APP_STORE_REVIEW__;
  if (!bridge || typeof bridge !== 'object') return null;
  if (typeof bridge.requestReview !== 'function') return null;
  return bridge;
}

function getStorageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

function isStoredTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizePromptState(rawState: unknown): AppStoreReviewPromptState {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    return createAppStoreReviewPromptState();
  }
  const record = rawState as Record<string, unknown>;
  const recentTurnTimesMs = Array.isArray(record.recentTurnTimesMs)
    ? record.recentTurnTimesMs
        .filter(isStoredTimestamp)
        .sort((left, right) => left - right)
        .slice(-APP_STORE_REVIEW_MIN_WINDOWED_TURNS)
    : [];

  return {
    schemaVersion: 2,
    recentTurnTimesMs,
    lastRequestAttemptAtMs: isStoredTimestamp(record.lastRequestAttemptAtMs)
      ? record.lastRequestAttemptAtMs
      : null,
  };
}

function readPromptState(userId: string): AppStoreReviewPromptState {
  const key = getStorageKey(userId);
  const inMemory = memoryStates.get(key);
  if (inMemory) return inMemory;
  try {
    const raw = window.localStorage.getItem(key);
    const state = raw ? normalizePromptState(JSON.parse(raw)) : createAppStoreReviewPromptState();
    memoryStates.set(key, state);
    window.localStorage.removeItem(`${LEGACY_STORAGE_KEY_PREFIX}${encodeURIComponent(userId)}`);
    return state;
  } catch {
    const state = createAppStoreReviewPromptState();
    memoryStates.set(key, state);
    return state;
  }
}

function writePromptState(userId: string, state: AppStoreReviewPromptState): void {
  const key = getStorageKey(userId);
  memoryStates.set(key, state);
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Device policy or private browsing can deny local storage. The in-memory state still
    // prevents repeat requests during the current app process.
  }
}

function getCurrentAppVersion(): string | null {
  const version = window.__LODY_APP_INFO__?.version ?? window.__LODY_APP_INFO__?.app_version;
  const normalized = version?.trim();
  return normalized || null;
}

function getOutcomeTime(entry: SessionHistory): number {
  if (typeof entry.endedAt === 'number' && Number.isFinite(entry.endedAt)) {
    return entry.endedAt;
  }
  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isCompletedAssistantTurn(entry: SessionHistory): boolean {
  return (
    entry.role === 'assistant' &&
    (entry.finished === true ||
      (typeof entry.endedAt === 'number' && Number.isFinite(entry.endedAt)))
  );
}

function containsChatFailure(entry: SessionHistory): boolean {
  return (entry.items ?? []).some(
    (item) => item.type === 'system_notice' && item.name === 'chat_failed'
  );
}

function hasVisibleAssistantResponse(entry: SessionHistory): boolean {
  return (entry.items?.length ?? 0) > 0 || (entry.plan?.length ?? 0) > 0;
}

export function extractAppStoreReviewTurnOutcomes({
  sessionId,
  history,
}: {
  sessionId: SessionId;
  history: readonly SessionHistory[];
}): AppStoreReviewTurnOutcome[] {
  const outcomes: AppStoreReviewTurnOutcome[] = [];
  const userTurnsById = new Map(
    history.filter((entry) => entry.role === 'user').map((entry) => [entry.id, entry] as const)
  );

  for (const entry of history) {
    if (!entry?.id) continue;
    const occurredAtMs = getOutcomeTime(entry);
    const outcomeId = `${sessionId}:${entry.id}`;

    if (
      entry.role === 'user' &&
      (resolveSessionHistoryStatus(entry) === 'failed' || entry.sendStatus === 'timeout')
    ) {
      outcomes.push({ id: outcomeId, kind: 'hard_failure', occurredAtMs });
      continue;
    }

    if (!isCompletedAssistantTurn(entry)) continue;
    const linkedUserTurn = entry.userTurnId ? userTurnsById.get(entry.userTurnId) : undefined;
    const linkedUserStatus = resolveSessionHistoryStatus(linkedUserTurn);
    if (
      linkedUserStatus === 'failed' ||
      linkedUserStatus === 'canceled' ||
      linkedUserTurn?.sendStatus === 'timeout'
    ) {
      continue;
    }
    if (containsChatFailure(entry)) {
      outcomes.push({ id: outcomeId, kind: 'hard_failure', occurredAtMs });
      continue;
    }
    // An item-level failed tool call is not a terminal turn failure: the agent may
    // recover and finish normally. `chat_failed` is the structured turn-level signal.
    if (hasVisibleAssistantResponse(entry)) {
      outcomes.push({ id: outcomeId, kind: 'completed', occurredAtMs });
    }
  }

  return outcomes;
}

function isTextEntryInProgress(): boolean {
  if (typeof document === 'undefined') return true;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    activeElement.isContentEditable
  );
}

/**
 * Stores finalized agent-turn outcomes locally and waits for a short idle period
 * before asking the iOS shell to request the system review prompt. Historical
 * turns seed eligibility only; they never trigger a prompt on mount.
 */
export function useAppStoreReviewPrompt({
  sessionId,
  sessionOwnerId,
  currentUserId,
  history,
  historyHydrated,
  sessionCompleted,
  lastCompletedAssistantMessageId,
}: {
  sessionId: SessionId;
  sessionOwnerId: string | null | undefined;
  currentUserId: string | null | undefined;
  history: readonly SessionHistory[];
  historyHydrated: boolean;
  sessionCompleted: boolean;
  lastCompletedAssistantMessageId: string | null;
}): void {
  const outcomes = useMemo(
    () => (historyHydrated ? extractAppStoreReviewTurnOutcomes({ sessionId, history }) : []),
    [history, historyHydrated, sessionId]
  );
  const sessionKey = currentUserId ? `${currentUserId}:${sessionId}` : null;
  const bootstrappedSessionKeyRef = useRef<string | null>(null);
  const consumedTurnIdsRef = useRef<Set<string>>(new Set());
  const hasRecentHardFailure = useMemo(() => hasRecentHardFailureOutcome(outcomes), [outcomes]);
  const hasRecentHardFailureRef = useRef(hasRecentHardFailure);
  hasRecentHardFailureRef.current = hasRecentHardFailure;
  const completedCandidateTurnId = useMemo(() => {
    if (!historyHydrated || !sessionCompleted || !lastCompletedAssistantMessageId) return null;
    const turnId = `${sessionId}:${lastCompletedAssistantMessageId}`;
    const outcome = outcomes.find((candidate) => candidate.id === turnId);
    return outcome?.kind === 'completed' ? turnId : null;
  }, [historyHydrated, lastCompletedAssistantMessageId, outcomes, sessionCompleted, sessionId]);

  useEffect(() => {
    if (!isNativeIOSAppShell()) return;
    if (!historyHydrated || !currentUserId || currentUserId !== sessionOwnerId || !sessionKey) {
      return;
    }

    if (bootstrappedSessionKeyRef.current !== sessionKey) {
      bootstrappedSessionKeyRef.current = sessionKey;
      consumedTurnIdsRef.current = new Set(
        outcomes.filter((outcome) => outcome.kind === 'completed').map((outcome) => outcome.id)
      );
    }

    // The newest stored turn time acts as a watermark, so re-scanning a session's
    // history records nothing and returns the same state object — which is what
    // keeps a streaming update from rewriting localStorage every frame. v1 needed
    // a per-mount set of observed outcome ids to get the same property.
    const currentState = readPromptState(currentUserId);
    const nextState = recordAppStoreReviewTurnOutcomes(currentState, outcomes, Date.now());
    if (nextState !== currentState) writePromptState(currentUserId, nextState);
  }, [currentUserId, historyHydrated, outcomes, sessionKey, sessionOwnerId]);

  useEffect(() => {
    if (!isNativeIOSAppShell()) return undefined;
    if (
      !completedCandidateTurnId ||
      !currentUserId ||
      currentUserId !== sessionOwnerId ||
      !sessionKey
    ) {
      return undefined;
    }
    if (isTextEntryInProgress()) {
      captureReviewPromptBlocked(currentUserId, 'text_entry_in_progress');
      return undefined;
    }
    const bridge = getAppStoreReviewBridge();
    if (!bridge) {
      captureReviewPromptBlocked(currentUserId, 'bridge_unavailable');
      return undefined;
    }
    if (consumedTurnIdsRef.current.has(completedCandidateTurnId)) {
      return undefined;
    }

    // A turn gets one idle opportunity. If the user resumes work, wait for a later
    // completed turn instead of interrupting their flow or retrying this same one.
    consumedTurnIdsRef.current.add(completedCandidateTurnId);
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'touchstart', 'keydown', 'input'];
    for (const event of events) {
      window.addEventListener(event, cancel, { capture: true, passive: true });
    }
    const timer = window.setTimeout(() => {
      if (cancelled || isTextEntryInProgress()) {
        captureReviewPromptBlocked(currentUserId, 'user_interaction');
        return;
      }
      if (document.visibilityState !== 'visible') {
        captureReviewPromptBlocked(currentUserId, 'app_not_visible');
        return;
      }
      const appVersion = getCurrentAppVersion();
      const nowMs = Date.now();
      const promptState = readPromptState(currentUserId);
      const blockReason = resolveAppStoreReviewBlockReason({
        state: promptState,
        appVersion,
        nowMs,
        hasRecentHardFailure: hasRecentHardFailureRef.current,
      });
      if (blockReason) {
        captureReviewPromptBlocked(currentUserId, blockReason);
        return;
      }

      // StoreKit can suppress the sheet and does not report a rating. Record the attempt
      // before invoking it so an interrupted native call cannot immediately retry.
      writePromptState(
        currentUserId,
        markAppStoreReviewRequestAttempt(promptState, { attemptedAtMs: nowMs })
      );
      // The furthest point we can observe: the request left the WebView. StoreKit
      // never reports whether the sheet rendered or what rating was given.
      capturePostHogEvent(deferredPostHog, 'mobile/app_store_review_prompt_requested', {
        ...buildPromptStateProperties(promptState, nowMs),
        app_version: appVersion,
      });
      void Promise.resolve(bridge.requestReview()).catch(() => undefined);
    }, REVIEW_PROMPT_IDLE_MS);

    return () => {
      window.clearTimeout(timer);
      for (const event of events) {
        window.removeEventListener(event, cancel, { capture: true });
      }
    };
  }, [completedCandidateTurnId, currentUserId, sessionKey, sessionOwnerId]);
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionId } from '@lody/shared';

export const CAPACITY_RETRY_CONTINUATION_PROMPT =
  'Continue working from where you left off. The previous turn stopped because the selected model was at capacity.';

const FIRST_RETRY_DELAY_MS = 5_000;
const MAX_AUTOMATIC_RETRIES = 3;

export type CapacityRetryControl = {
  noticeId: string;
  retryInSeconds: number | null;
  retryRemainingRatio: number | null;
  pending: boolean;
  canRetry: boolean;
  autoRetryEnabled: boolean;
  autoRetryExhausted: boolean;
  retry: () => void;
  stopAutoRetry: () => void;
};

type CapacityRetryHistoryEntry = {
  id: string;
  role: string;
  items?: readonly ({ type: string; name?: string; meta?: unknown } | null | undefined)[];
};

export function findLatestCapacityFailureNoticeId(
  history: readonly CapacityRetryHistoryEntry[] | null | undefined
): string | null {
  if (!history) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    // Any newer user input supersedes an older failure. Retrying after it would
    // inject an out-of-order continuation into a different round.
    if (entry.role === 'user') return null;
    for (const item of entry.items ?? []) {
      if (item?.type !== 'system_notice' || item.name !== 'chat_failed') continue;
      const reason = (item.meta as { reason?: unknown } | undefined)?.reason;
      return reason === 'acp_provider_overloaded' ? entry.id : null;
    }
  }
  return null;
}

export function useCapacityAutoRetry(options: {
  sessionId: SessionId;
  history: readonly CapacityRetryHistoryEntry[] | null | undefined;
  canRetry: boolean;
  onRetry: () => Promise<boolean>;
}): CapacityRetryControl | null {
  const { sessionId, history, canRetry, onRetry } = options;
  const noticeId = useMemo(() => findLatestCapacityFailureNoticeId(history), [history]);
  const handledNoticeIdsRef = useRef(new Set<string>());
  const automaticAttemptsRef = useRef(0);
  const retryInFlightRef = useRef(false);
  const onRetryRef = useRef(onRetry);
  const [autoRetryEnabled, setAutoRetryEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [retryInSeconds, setRetryInSeconds] = useState<number | null>(null);
  const [retryRemainingRatio, setRetryRemainingRatio] = useState<number | null>(null);

  useEffect(() => {
    onRetryRef.current = onRetry;
  }, [onRetry]);

  useEffect(() => {
    handledNoticeIdsRef.current.clear();
    automaticAttemptsRef.current = 0;
    retryInFlightRef.current = false;
    setAutoRetryEnabled(false);
    setPending(false);
    setRetryInSeconds(null);
    setRetryRemainingRatio(null);
  }, [sessionId]);

  const performRetry = useCallback(async (targetNoticeId: string, automatic: boolean) => {
    if (retryInFlightRef.current || handledNoticeIdsRef.current.has(targetNoticeId)) {
      return;
    }
    retryInFlightRef.current = true;
    setPending(true);
    setRetryInSeconds(null);
    setRetryRemainingRatio(null);
    try {
      const accepted = await onRetryRef.current();
      if (accepted) {
        handledNoticeIdsRef.current.add(targetNoticeId);
        if (automatic) automaticAttemptsRef.current += 1;
      } else {
        // A transport or lifecycle race did not accept the continuation. Do not
        // loop on the UI failure; return control to the user.
        setAutoRetryEnabled(false);
      }
    } catch {
      // Dispatch already owns user-visible transport diagnostics. The retry
      // control only needs to stop automatic attempts and become clickable.
      setAutoRetryEnabled(false);
    } finally {
      retryInFlightRef.current = false;
      setPending(false);
    }
  }, []);

  const retry = useCallback(() => {
    if (!noticeId || !canRetry) return;
    // The first click is explicit consent for bounded automatic retries in this
    // mounted Session. A later manual click also renews an exhausted budget.
    automaticAttemptsRef.current = 0;
    setAutoRetryEnabled(true);
    void performRetry(noticeId, false);
  }, [canRetry, noticeId, performRetry]);

  const stopAutoRetry = useCallback(() => {
    setAutoRetryEnabled(false);
    setRetryInSeconds(null);
    setRetryRemainingRatio(null);
  }, []);

  const autoRetryExhausted = automaticAttemptsRef.current >= MAX_AUTOMATIC_RETRIES;

  useEffect(() => {
    if (
      !noticeId ||
      !canRetry ||
      !autoRetryEnabled ||
      autoRetryExhausted ||
      pending ||
      retryInFlightRef.current ||
      handledNoticeIdsRef.current.has(noticeId)
    ) {
      setRetryInSeconds(null);
      setRetryRemainingRatio(null);
      return undefined;
    }

    const delayMs = FIRST_RETRY_DELAY_MS * 2 ** automaticAttemptsRef.current;
    const retryAt = Date.now() + delayMs;
    const updateCountdown = () => {
      const remainingMs = Math.max(0, retryAt - Date.now());
      setRetryInSeconds(Math.ceil(remainingMs / 1_000));
      setRetryRemainingRatio(remainingMs / delayMs);
    };
    updateCountdown();
    const interval = window.setInterval(updateCountdown, 250);
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
      setRetryInSeconds(null);
      setRetryRemainingRatio(null);
      void performRetry(noticeId, true);
    }, delayMs);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [autoRetryEnabled, autoRetryExhausted, canRetry, noticeId, pending, performRetry]);

  if (!noticeId) return null;
  return {
    noticeId,
    retryInSeconds,
    retryRemainingRatio,
    pending,
    canRetry,
    autoRetryEnabled,
    autoRetryExhausted,
    retry,
    stopAutoRetry,
  };
}

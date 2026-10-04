import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionFileProvider } from '@/lib/session-file-provider';
import { useLatestRef } from './use-latest-ref';
import { SaveTextConflictError, SaveTextTransientError } from '@/lib/code-collab-save-errors';

export { SaveTextConflictError, SaveTextTransientError } from '@/lib/code-collab-save-errors';

export const DEFAULT_CODE_COLLAB_SAVE_DEBOUNCE_MS = 10_000;
export const DEFAULT_CODE_COLLAB_LIVE_SYNC_DEBOUNCE_MS = 8;

type SaveAttemptResult = 'idle' | 'done' | 'retry-later' | 'blocked';

export type SessionFileSaveStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly at: number }
  | { readonly kind: 'error'; readonly message: string; readonly at: number }
  | { readonly kind: 'conflict_pending'; readonly message?: string; readonly at: number }
  | {
      readonly kind: 'conflict';
      readonly conflict: string;
      readonly conflictId?: string;
      readonly at: number;
    };

export type SessionFileLiveSyncStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'syncing' }
  | { readonly kind: 'synced'; readonly at: number }
  | { readonly kind: 'delayed'; readonly message: string; readonly at: number };

export type UseCodeCollabSaveTextInput = {
  readonly provider: SessionFileProvider | null | undefined;
  readonly fileId: string | null | undefined;
  readonly enabled: boolean;
  readonly debounceMs?: number;
  readonly liveSyncDebounceMs?: number;
  readonly onLiveTextSynced?: (text: string, fileId: string) => void;
};

export type UseCodeCollabSaveTextResult = {
  readonly status: SessionFileSaveStatus;
  readonly liveStatus: SessionFileLiveSyncStatus;
  readonly onContentChange: (text: string) => void;
  readonly onExternalTextApplied: () => void;
  readonly markConflictPending: (message?: string) => void;
  readonly flush: () => Promise<void>;
  readonly resolveConflict: (
    resolution: 'override' | 'discard' | 'load_with_conflicts'
  ) => Promise<void>;
};

// Buffers local Monaco edits in memory and persists only when `flush()`
// is called by the explicit Save UI. Reports a small state machine so
// the editor can render "Unsaved" / "Saving" / "Saved" / "Save failed".
//
// Conflicts arrive as `SaveTextConflictError` instances from the browser
// runtime (carrying `conflict` kind + `conflictId`); the hook
// surfaces them as the `conflict` status branch and exposes
// `resolveConflict(resolution)` to round-trip through
// `provider.resolveSaveConflict`.
export function useCodeCollabSaveText(
  input: UseCodeCollabSaveTextInput
): UseCodeCollabSaveTextResult {
  const { provider, fileId, enabled } = input;
  const debounceMs = input.debounceMs ?? DEFAULT_CODE_COLLAB_SAVE_DEBOUNCE_MS;
  const liveSyncDebounceMs = input.liveSyncDebounceMs ?? DEFAULT_CODE_COLLAB_LIVE_SYNC_DEBOUNCE_MS;

  const [status, setStatus] = useState<SessionFileSaveStatus>({ kind: 'idle' });
  const [liveStatus, setLiveStatus] = useState<SessionFileLiveSyncStatus>({ kind: 'idle' });
  // Mirror committed status into a ref so `resolveConflict` (and any
  // other handler that consults the latest status during its own
  // execution) can read the up-to-date value without depending on
  // React's render cycle. setState commits update both atomically.
  const statusRef = useRef<SessionFileSaveStatus>(status);
  const liveStatusRef = useRef<SessionFileLiveSyncStatus>(liveStatus);

  const pendingTextRef = useRef<string | null>(null);
  const pendingLiveTextRef = useRef<string | null>(null);
  // Tracks the fileId associated with the pending text so a save that
  // started before a file switch doesn't write the old file's bytes
  // against the new fileId after `fileIdRef.current` updates.
  const pendingFileIdRef = useRef<string | null>(null);
  const pendingLiveFileIdRef = useRef<string | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const liveSyncInflightRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const providerRef = useLatestRef(provider);
  const fileIdRef = useLatestRef(fileId);
  const onLiveTextSyncedRef = useLatestRef(input.onLiveTextSynced);
  const firstPendingSaveAtRef = useRef<number | null>(null);
  // Late-bound pointer to `schedule` so `performSave`'s transient-
  // retry branch can re-arm the debounce without creating a
  // declaration-order cycle between the two useCallbacks (schedule
  // depends on performSave; performSave's retry path depends on
  // schedule). The ref is wired after both are declared.
  const scheduleRef = useRef<(delayMs?: number) => void>(() => {});
  const scheduleLiveSyncRef = useRef<() => void>(() => {});
  const liveSyncGenerationRef = useRef(0);
  const retryableSaveFailureCountRef = useRef(0);

  const commitStatus = useCallback((next: SessionFileSaveStatus) => {
    // The no-payload transitions (idle / pending / saving) repeat on
    // every keystroke — pending in particular fires once per char. Skip
    // identical updates so consumers don't re-render on every motion.
    // States with payload (saved/error/conflict) have timestamps so
    // their object reference is always new; React's setState reference
    // check would diff them anyway.
    if (
      statusRef.current.kind === next.kind &&
      (next.kind === 'idle' || next.kind === 'pending' || next.kind === 'saving')
    ) {
      return;
    }
    statusRef.current = next;
    setStatus(next);
  }, []);

  const commitLiveStatus = useCallback((next: SessionFileLiveSyncStatus) => {
    if (
      liveStatusRef.current.kind === next.kind &&
      (next.kind === 'idle' || next.kind === 'pending' || next.kind === 'syncing')
    ) {
      return;
    }
    liveStatusRef.current = next;
    setLiveStatus(next);
  }, []);

  const performSave = useCallback(async (): Promise<SaveAttemptResult> => {
    const text = pendingTextRef.current;
    const targetFileId = pendingFileIdRef.current;
    const currentProvider = providerRef.current;
    if (text === null || !currentProvider || !targetFileId) {
      return 'idle';
    }
    // If the active fileId changed between scheduling and firing, drop
    // the save instead of writing the old file's text against the new
    // fileId. The reset effect clears `pendingTextRef` on file switch
    // anyway, but a debounce-fire that beats the effect into the
    // microtask queue could still race here.
    if (targetFileId !== fileIdRef.current) {
      pendingTextRef.current = null;
      pendingFileIdRef.current = null;
      firstPendingSaveAtRef.current = null;
      return 'idle';
    }
    const isCurrentTarget = (): boolean =>
      targetFileId === fileIdRef.current && currentProvider === providerRef.current;
    const pendingWindowStartedAt = firstPendingSaveAtRef.current;
    pendingTextRef.current = null;
    pendingFileIdRef.current = null;
    firstPendingSaveAtRef.current = null;
    commitStatus({ kind: 'saving' });
    // Restore the failed (text, fileId) into the pending refs so a
    // follow-up keystroke or `flush()` retries instead of silently
    // dropping the user's edits. Used for the generic-error branch
    // and for `unavailable` results below — both are potentially
    // transient (most importantly: a host-side rename rescan that
    // hasn't yet landed when our debounce fires will reject the
    // save with `write_failed: not an active text file`). We only
    // restore when nothing newer has been written into the refs;
    // a keystroke during the in-flight save already provides newer
    // text that the next tick will save instead.
    const restorePending = (): void => {
      if (pendingTextRef.current === null && isCurrentTarget()) {
        pendingTextRef.current = text;
        pendingFileIdRef.current = targetFileId;
        firstPendingSaveAtRef.current = pendingWindowStartedAt ?? Date.now();
      }
    };
    const scheduleNewerPending = (): boolean => {
      if (pendingTextRef.current === null || pendingFileIdRef.current !== targetFileId) {
        return false;
      }
      retryableSaveFailureCountRef.current = 0;
      commitStatus({ kind: 'pending' });
      return true;
    };
    try {
      const result = await currentProvider.saveText(targetFileId, text);
      if (!isCurrentTarget()) return 'idle';
      retryableSaveFailureCountRef.current = 0;
      if (result.status === 'unavailable') {
        if (scheduleNewerPending()) return 'retry-later';
        restorePending();
        commitStatus({
          kind: 'error',
          message: result.message ?? `Save failed (${result.reason})`,
          at: Date.now(),
        });
        return 'blocked';
      }
      if (liveStatusRef.current.kind !== 'idle') {
        commitLiveStatus({ kind: 'synced', at: Date.now() });
      }
      commitStatus(
        pendingTextRef.current === null ? { kind: 'saved', at: Date.now() } : { kind: 'pending' }
      );
      return 'done';
    } catch (error) {
      if (!isCurrentTarget()) return 'idle';
      if (error instanceof SaveTextConflictError) {
        retryableSaveFailureCountRef.current = 0;
        // Conflicts are not retryable from the pending buffer — the
        // user has to pick a resolution; leave pending cleared so
        // a stray keystroke doesn't beat the resolution RPC.
        commitStatus({
          kind: 'conflict',
          conflict: error.conflict,
          ...(error.conflictId === undefined ? {} : { conflictId: error.conflictId }),
          at: Date.now(),
        });
        return 'blocked';
      }
      if (error instanceof SaveTextTransientError) {
        retryableSaveFailureCountRef.current = 0;
        if (scheduleNewerPending()) return 'retry-later';
        restorePending();
        commitStatus({ kind: 'error', message: error.message, at: Date.now() });
        return 'blocked';
      }
      if (scheduleNewerPending()) return 'retry-later';
      restorePending();
      const message = error instanceof Error ? error.message : String(error);
      if (isRetryableSaveError(error)) {
        retryableSaveFailureCountRef.current += 1;
        commitStatus({ kind: 'error', message, at: Date.now() });
        return 'blocked';
      }
      retryableSaveFailureCountRef.current = 0;
      commitStatus({ kind: 'error', message, at: Date.now() });
      return 'blocked';
    }
    // `providerRef` / `fileIdRef` are stable `useLatestRef`
    // MutableRefObjects — listing them is a no-op at runtime but
    // satisfies the exhaustive-deps lint rule, which can't detect
    // ref stability through a custom hook return value.
  }, [commitLiveStatus, commitStatus, providerRef, fileIdRef]);

  const drainSaves = useCallback(async (): Promise<void> => {
    while (pendingTextRef.current !== null) {
      const result = await performSave();
      if (result !== 'done') break;
    }
  }, [performSave]);

  const startDrain = useCallback((): Promise<void> => {
    if (inflightRef.current !== null) return inflightRef.current;
    const next = drainSaves();
    inflightRef.current = next;
    void next.finally(() => {
      if (inflightRef.current === next) inflightRef.current = null;
    });
    return next;
  }, [drainSaves]);

  const schedule = useCallback(
    (delayMs: number = debounceMs) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      const pendingStartedAt = firstPendingSaveAtRef.current;
      const cappedDelayMs =
        pendingStartedAt === null || delayMs !== debounceMs
          ? delayMs
          : Math.min(delayMs, Math.max(0, pendingStartedAt + debounceMs - Date.now()));
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        // Keep one active save drain. New edits overwrite the pending
        // buffer, and the drain sends only the latest text after the
        // current RPC finishes instead of queuing obsolete attempts.
        void startDrain();
      }, cappedDelayMs);
    },
    [debounceMs, startDrain]
  );
  scheduleRef.current = schedule;

  const performLiveSync = useCallback(async (): Promise<void> => {
    const text = pendingLiveTextRef.current;
    const targetFileId = pendingLiveFileIdRef.current;
    const currentProvider = providerRef.current;
    const updateLiveText = currentProvider?.updateLiveText;
    if (text === null || !currentProvider || !updateLiveText || !targetFileId) {
      return;
    }
    if (targetFileId !== fileIdRef.current) {
      pendingLiveTextRef.current = null;
      pendingLiveFileIdRef.current = null;
      return;
    }
    const syncGeneration = liveSyncGenerationRef.current;
    pendingLiveTextRef.current = null;
    pendingLiveFileIdRef.current = null;
    commitLiveStatus({ kind: 'syncing' });
    try {
      await updateLiveText.call(currentProvider, targetFileId, text);
      if (syncGeneration !== liveSyncGenerationRef.current || targetFileId !== fileIdRef.current) {
        return;
      }
      onLiveTextSyncedRef.current?.(text, targetFileId);
      commitLiveStatus(
        pendingLiveTextRef.current === null
          ? { kind: 'synced', at: Date.now() }
          : { kind: 'pending' }
      );
    } catch {
      // Provider-level live text publishing is a latency optimization;
      // the debounced save below remains the authoritative persistence path.
      if (syncGeneration !== liveSyncGenerationRef.current || targetFileId !== fileIdRef.current) {
        return;
      }
      if (pendingLiveTextRef.current === null) {
        commitLiveStatus({
          kind: 'delayed',
          message: 'Realtime sync is delayed; disk save will still retry.',
          at: Date.now(),
        });
      } else {
        commitLiveStatus({ kind: 'pending' });
      }
    }
  }, [commitLiveStatus, providerRef, fileIdRef, onLiveTextSyncedRef]);

  const startLiveSync = useCallback((): Promise<void> => {
    if (liveSyncInflightRef.current !== null) return liveSyncInflightRef.current;
    const next = performLiveSync();
    liveSyncInflightRef.current = next;
    void next.finally(() => {
      if (liveSyncInflightRef.current === next) liveSyncInflightRef.current = null;
      if (pendingLiveTextRef.current !== null) {
        scheduleLiveSyncRef.current();
      }
    });
    return next;
  }, [performLiveSync]);

  const scheduleLiveSync = useCallback(() => {
    if (liveSyncTimerRef.current !== null) {
      clearTimeout(liveSyncTimerRef.current);
    }
    liveSyncTimerRef.current = setTimeout(() => {
      liveSyncTimerRef.current = null;
      void startLiveSync();
    }, liveSyncDebounceMs);
  }, [liveSyncDebounceMs, startLiveSync]);
  scheduleLiveSyncRef.current = scheduleLiveSync;

  const onContentChange = useCallback(
    (text: string) => {
      if (!enabled) return;
      const currentFileId = fileIdRef.current;
      if (!currentFileId) return;
      retryableSaveFailureCountRef.current = 0;
      if (pendingTextRef.current === null) {
        firstPendingSaveAtRef.current = Date.now();
      }
      pendingTextRef.current = text;
      pendingFileIdRef.current = currentFileId;
      if (statusRef.current.kind !== 'conflict_pending') {
        commitStatus({ kind: 'pending' });
      }
    },
    // `fileIdRef` is a stable `useLatestRef` MutableRefObject — listing
    // it is a no-op at runtime but satisfies the exhaustive-deps lint
    // rule, which can't detect ref stability through a custom hook
    // return value.
    [commitStatus, enabled, fileIdRef]
  );

  const markConflictPending = useCallback(
    (message?: string) => {
      if (!enabled) return;
      if (pendingTextRef.current === null || pendingFileIdRef.current !== fileIdRef.current) {
        return;
      }
      commitStatus({
        kind: 'conflict_pending',
        ...(message === undefined ? {} : { message }),
        at: Date.now(),
      });
    },
    [commitStatus, enabled, fileIdRef]
  );

  const flush = useCallback(async (): Promise<void> => {
    if (liveSyncTimerRef.current !== null) {
      clearTimeout(liveSyncTimerRef.current);
      liveSyncTimerRef.current = null;
    }
    if (pendingLiveTextRef.current !== null) {
      await startLiveSync();
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    while (inflightRef.current !== null) {
      const current = inflightRef.current;
      await current;
      if (inflightRef.current === current) {
        inflightRef.current = null;
      }
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingTextRef.current !== null) {
      await startDrain();
    }
  }, [startDrain, startLiveSync]);

  const onExternalTextApplied = useCallback(() => {
    pendingTextRef.current = null;
    pendingFileIdRef.current = null;
    firstPendingSaveAtRef.current = null;
    pendingLiveTextRef.current = null;
    pendingLiveFileIdRef.current = null;
    liveSyncGenerationRef.current += 1;
    retryableSaveFailureCountRef.current = 0;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (liveSyncTimerRef.current !== null) {
      clearTimeout(liveSyncTimerRef.current);
      liveSyncTimerRef.current = null;
    }
    if (statusRef.current.kind === 'pending' || statusRef.current.kind === 'conflict_pending') {
      commitStatus({ kind: 'idle' });
    }
    if (liveStatusRef.current.kind === 'pending' || liveStatusRef.current.kind === 'syncing') {
      commitLiveStatus({ kind: 'idle' });
    }
  }, [commitLiveStatus, commitStatus]);

  useEffect(() => {
    const isDirty = () =>
      pendingTextRef.current !== null ||
      statusRef.current.kind === 'saving' ||
      statusRef.current.kind === 'conflict_pending' ||
      statusRef.current.kind === 'conflict' ||
      statusRef.current.kind === 'error';
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!isDirty()) {
        return;
      }
      console.warn('[unload-blocked] editor save', {
        buffered: pendingTextRef.current !== null,
        status: statusRef.current.kind,
      });
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  const resolveConflict = useCallback(
    async (resolution: 'override' | 'discard' | 'load_with_conflicts'): Promise<void> => {
      const currentProvider = providerRef.current;
      const currentFileId = fileIdRef.current;
      if (!currentProvider || !currentFileId) return;
      const reconciler = currentProvider.resolveSaveConflict;
      if (!reconciler) {
        commitStatus({
          kind: 'error',
          message: 'Conflict resolution is not supported by this provider',
          at: Date.now(),
        });
        return;
      }
      // We only attempt the round-trip when we have the id from the most
      // recent conflict response; the host requires it to verify the resolver
      // is acting on the same disk state it reported.
      // `statusRef` is updated synchronously with every `setStatus`,
      // so it reflects the committed state even between renders.
      const currentStatus = statusRef.current;
      const conflictId = currentStatus.kind === 'conflict' ? currentStatus.conflictId : undefined;
      if (!conflictId) {
        commitStatus({
          kind: 'error',
          message: 'Conflict resolution requires the most recent conflict id',
          at: Date.now(),
        });
        return;
      }
      commitStatus({ kind: 'saving' });
      try {
        retryableSaveFailureCountRef.current = 0;
        await reconciler.call(currentProvider, currentFileId, {
          conflictId,
          resolution,
        });
        commitStatus(
          resolution === 'load_with_conflicts'
            ? { kind: 'pending' }
            : { kind: 'saved', at: Date.now() }
        );
      } catch (error) {
        if (error instanceof SaveTextConflictError) {
          commitStatus({
            kind: 'conflict',
            conflict: error.conflict,
            ...(error.conflictId === undefined ? {} : { conflictId: error.conflictId }),
            at: Date.now(),
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        commitStatus({ kind: 'error', message, at: Date.now() });
      }
    },
    // `providerRef` / `fileIdRef` are stable `useLatestRef`
    // MutableRefObjects — listing them is a no-op at runtime but
    // satisfies the exhaustive-deps lint rule, which can't detect
    // ref stability through a custom hook return value.
    [commitStatus, providerRef, fileIdRef]
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (liveSyncTimerRef.current !== null) {
        clearTimeout(liveSyncTimerRef.current);
        liveSyncTimerRef.current = null;
      }
    };
  }, []);

  // Reset status when the target changes — stale
  // "Saved" or "error" from a previous file would otherwise look like
  // it applies to the newly opened one. Also cancel any debounce timer /
  // pending text from the previous file so it can't race a save against
  // the new fileId. Provider identity changes intentionally do not reset
  // the buffer: Code Collab shared-state updates rebuild providers while
  // the open file and base digest must remain intact. Editability (`enabled`)
  // can briefly flicker during provider rebuilds, so it is deliberately not a
  // reset trigger.
  useEffect(() => {
    pendingTextRef.current = null;
    pendingFileIdRef.current = null;
    firstPendingSaveAtRef.current = null;
    pendingLiveTextRef.current = null;
    pendingLiveFileIdRef.current = null;
    liveSyncGenerationRef.current += 1;
    retryableSaveFailureCountRef.current = 0;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (liveSyncTimerRef.current !== null) {
      clearTimeout(liveSyncTimerRef.current);
      liveSyncTimerRef.current = null;
    }
    commitStatus({ kind: 'idle' });
    commitLiveStatus({ kind: 'idle' });
  }, [commitLiveStatus, commitStatus, fileId]);

  return {
    status,
    liveStatus,
    onContentChange,
    onExternalTextApplied,
    markConflictPending,
    flush,
    resolveConflict,
  };
}

function isRetryableSaveError(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'unknown');
  return /\b(timeout|timed out|network|fetch failed|failed to fetch|terminated|aborted|econnreset|econnrefused|enotfound|eai_again)\b/iu.test(
    message
  );
}

import { useCallback, useSyncExternalStore } from 'react';
import type { SessionId } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
/** Reacquire the selected Session after its persisted body owner changes. */
export function useSessionStoreEpoch(
  runtime: WorkspaceRuntime | null | undefined,
  sessionId: SessionId
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      runtime?.subscribeSessionStoreEpoch?.(sessionId, listener) ?? (() => {}),
    [runtime, sessionId]
  );
  const snapshot = useCallback(
    () => runtime?.getSessionStoreEpoch?.(sessionId) ?? 0,
    [runtime, sessionId]
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

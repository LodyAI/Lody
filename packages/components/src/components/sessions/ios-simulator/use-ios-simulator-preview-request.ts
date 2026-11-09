import { useEffect, useRef } from 'react';

/** Discovery only. Actual status/access are resolved by the existing panel. */
export function useIosSimulatorPreviewRequest(
  sessionId: string | undefined,
  requestId: string | undefined,
  enabled: boolean,
  onOpen: (() => void) | undefined,
  persistence: 'tab' | 'device' = 'tab'
) {
  const consumed = useRef(new Map<string, string>());
  useEffect(() => {
    if (!enabled || !sessionId || !requestId || !onOpen) return;
    const key = `lody:simulator-preview-request:${sessionId}`;
    if (consumed.current.get(sessionId) === requestId) return;
    consumed.current.set(sessionId, requestId);
    if (persistence === 'device') {
      try {
        // Android dismissal survives app restarts. This is a local UI preference,
        // not live preview status, and must not be cleared with disposable caches.
        if (localStorage.getItem(key) === requestId) return;
        localStorage.setItem(key, requestId);
      } catch {
        // Fall back to tab-scoped consumption when persistent storage is unavailable.
      }
    }
    try {
      // Keep a dismissed request consumed across tab switches and component remounts,
      // and honor requests consumed before device persistence was introduced.
      if (sessionStorage.getItem(key) === requestId) return;
      sessionStorage.setItem(key, requestId);
    } catch {
      // Storage-restricted clients still dedupe for this mounted view.
    }
    onOpen();
  }, [sessionId, requestId, enabled, onOpen, persistence]);
}

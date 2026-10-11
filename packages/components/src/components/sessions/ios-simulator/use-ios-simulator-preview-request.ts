import { useEffect, useRef } from 'react';

/** Discovery only. Actual status/access are resolved by the existing panel. */
export function useIosSimulatorPreviewRequest(
  sessionId: string | undefined,
  requestId: string | undefined,
  enabled: boolean,
  onOpen: (() => void) | undefined
) {
  const consumed = useRef(new Map<string, string>());
  useEffect(() => {
    if (!enabled || !sessionId || !requestId || !onOpen) return;
    const key = `lody:simulator-preview-request:${sessionId}`;
    if (consumed.current.get(sessionId) === requestId) return;
    consumed.current.set(sessionId, requestId);
    try {
      // Keep a dismissed request consumed across tab switches and component remounts,
      // but leave another browser/device free to discover it independently.
      if (sessionStorage.getItem(key) === requestId) return;
      sessionStorage.setItem(key, requestId);
    } catch {
      // Storage-restricted clients still dedupe for this mounted view.
    }
    onOpen();
  }, [sessionId, requestId, enabled, onOpen]);
}

import { useCallback, useRef, useSyncExternalStore } from 'react';

import {
  getInFlightSessionMentionDragId,
  hasAcceptableSessionMentionTransfer,
  readSessionMentionDragSessionId,
  registerSessionMentionPointerTarget,
  subscribeSessionMentionDrag,
} from '@/lib/session-mention-drag';
import { useDropZone } from '@/hooks/use-drop-zone';

/**
 * True while a sidebar session drag is in flight and this surface would accept
 * it. Used to paint the drop mask as soon as the row is picked up, not only
 * after `dragenter` on the page.
 */
export function useAcceptableSessionMentionDrag(
  excludeSessionId?: string | null,
  enabled = true
): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      enabled ? subscribeSessionMentionDrag(onStoreChange) : () => undefined,
    [enabled]
  );
  const getSnapshot = useCallback(
    () => (enabled ? getInFlightSessionMentionDragId() : null),
    [enabled]
  );
  const draggedId = useSyncExternalStore(subscribe, getSnapshot, () => null);
  if (!draggedId) return false;
  const exclude = excludeSessionId?.toLowerCase();
  return !exclude || draggedId.toLowerCase() !== exclude;
}

export function useSessionMentionDropZone({
  enabled,
  excludeSessionId,
  observeInFlight = true,
  onDropSessionId,
}: {
  enabled: boolean;
  excludeSessionId?: string | null;
  /** Disable when an ancestor owns the shared drag overlay. */
  observeInFlight?: boolean;
  onDropSessionId: (sessionId: string) => void;
}) {
  const accepts = useCallback(
    (dataTransfer: DataTransfer) =>
      hasAcceptableSessionMentionTransfer(dataTransfer, { excludeSessionId }),
    [excludeSessionId]
  );
  const onDrop = useCallback(
    (dataTransfer: DataTransfer) => {
      const sessionId = readSessionMentionDragSessionId(dataTransfer);
      if (sessionId) onDropSessionId(sessionId);
    },
    [onDropSessionId]
  );
  const dropZone = useDropZone({ enabled, accepts, onDrop });
  // The same surface accepts pointer drags (pinned sidebar rows) released over it.
  const pointerTarget = useRef({ enabled, excludeSessionId, onDropSessionId });
  pointerTarget.current = { enabled, excludeSessionId, onDropSessionId };
  const releasePointerTarget = useRef<(() => void) | null>(null);
  const pointerDropRef = useCallback((element: Element | null) => {
    releasePointerTarget.current?.();
    releasePointerTarget.current = element
      ? registerSessionMentionPointerTarget(element, {
          accepts: (sessionId) => {
            const current = pointerTarget.current;
            const exclude = current.excludeSessionId?.toLowerCase();
            return current.enabled && (!exclude || sessionId.toLowerCase() !== exclude);
          },
          drop: (sessionId) => pointerTarget.current.onDropSessionId(sessionId),
        })
      : null;
  }, []);
  const observesDrag = enabled && observeInFlight;
  const dragArmed = useAcceptableSessionMentionDrag(excludeSessionId, observesDrag);

  return {
    dropZone,
    /** Attach to the element that spreads `dropZone.handlers`. */
    pointerDropRef,
    overlayActive: observesDrag && (dropZone.isActive || dragArmed),
  };
}

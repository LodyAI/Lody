import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  getWorkspaceShortcutSlots,
  reconcileWorkspaceShortcutSlots,
  setWorkspaceShortcutSlot,
  subscribeWorkspaceShortcutSlots,
  type WorkspaceShortcutSlotNumber,
  type WorkspaceShortcutSlots,
} from '@/lib/workspace-shortcut-slots';

const EMPTY_SLOTS: WorkspaceShortcutSlots = Object.freeze([
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
]);

export function useWorkspaceShortcutSlots(
  userId: string | null,
  availableWorkspaceIds: readonly string[] | undefined
): {
  slots: WorkspaceShortcutSlots;
  setSlot: (slot: WorkspaceShortcutSlotNumber, workspaceId: string | null) => void;
} {
  const subscribe = useCallback(
    (listener: () => void) =>
      userId ? subscribeWorkspaceShortcutSlots(userId, listener) : () => {},
    [userId]
  );
  const getSnapshot = useCallback(
    () => (userId ? getWorkspaceShortcutSlots(userId) : EMPTY_SLOTS),
    [userId]
  );
  const slots = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SLOTS);
  const availableKey = availableWorkspaceIds?.join('\0') ?? null;

  useEffect(() => {
    if (!userId || !availableWorkspaceIds) return;
    reconcileWorkspaceShortcutSlots(userId, availableWorkspaceIds);
    // The scalar key avoids re-running for a catalog array with unchanged ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableKey, userId]);

  const setSlot = useCallback(
    (slot: WorkspaceShortcutSlotNumber, workspaceId: string | null) => {
      if (!userId) return;
      setWorkspaceShortcutSlot(userId, slot, workspaceId);
    },
    [userId]
  );

  return { slots, setSlot };
}

import { z } from 'zod';

export const WORKSPACE_SHORTCUT_SLOT_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type WorkspaceShortcutSlotNumber = (typeof WORKSPACE_SHORTCUT_SLOT_NUMBERS)[number];

export type WorkspaceShortcutSlots = readonly (string | null)[];

type WorkspaceShortcutSlotState = {
  initialized: boolean;
  slots: WorkspaceShortcutSlots;
};

const STORAGE_KEY_PREFIX = 'lody.workspaceShortcutSlots.v1:';
const EMPTY_SLOTS: WorkspaceShortcutSlots = Object.freeze(
  WORKSPACE_SHORTCUT_SLOT_NUMBERS.map(() => null)
);
const EMPTY_STATE: WorkspaceShortcutSlotState = Object.freeze({
  initialized: false,
  slots: EMPTY_SLOTS,
});
const storedStateSchema = z.object({
  version: z.literal(1),
  slots: z.array(z.string().min(1).nullable()).length(WORKSPACE_SHORTCUT_SLOT_NUMBERS.length),
});

const snapshots = new Map<string, WorkspaceShortcutSlotState>();
const listeners = new Map<string, Set<() => void>>();
let storageSubscriberCount = 0;

export function getWorkspaceShortcutSlotsStorageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

function readState(userId: string): WorkspaceShortcutSlotState {
  if (typeof localStorage === 'undefined') return EMPTY_STATE;
  const storageKey = getWorkspaceShortcutSlotsStorageKey(userId);
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return EMPTY_STATE;
    const parsed = storedStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      return { initialized: true, slots: Object.freeze([...parsed.data.slots]) };
    }
    localStorage.removeItem(storageKey);
  } catch {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Ignore unavailable storage. The in-memory snapshot still works for this renderer.
    }
  }
  return EMPTY_STATE;
}

function getState(userId: string): WorkspaceShortcutSlotState {
  const current = snapshots.get(userId);
  if (current) return current;
  const loaded = readState(userId);
  snapshots.set(userId, loaded);
  return loaded;
}

function notify(userId: string): void {
  for (const listener of listeners.get(userId) ?? []) listener();
}

function writeState(userId: string, slots: WorkspaceShortcutSlots): WorkspaceShortcutSlots {
  const nextSlots = Object.freeze([...slots]);
  const current = getState(userId);
  if (
    current.initialized &&
    current.slots.every((workspaceId, index) => workspaceId === nextSlots[index])
  ) {
    return current.slots;
  }

  snapshots.set(userId, { initialized: true, slots: nextSlots });
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(
        getWorkspaceShortcutSlotsStorageKey(userId),
        JSON.stringify({ version: 1, slots: nextSlots })
      );
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }
  notify(userId);
  return nextSlots;
}

function handleStorage(event: StorageEvent): void {
  if (
    event.storageArea &&
    typeof localStorage !== 'undefined' &&
    event.storageArea !== localStorage
  ) {
    return;
  }
  if (event.key === null) {
    for (const [userId] of listeners) {
      snapshots.set(userId, readState(userId));
      notify(userId);
    }
    return;
  }
  if (!event.key.startsWith(STORAGE_KEY_PREFIX)) return;
  for (const [userId] of listeners) {
    if (event.key !== getWorkspaceShortcutSlotsStorageKey(userId)) continue;
    snapshots.set(userId, readState(userId));
    notify(userId);
    return;
  }
}

export function getWorkspaceShortcutSlots(userId: string): WorkspaceShortcutSlots {
  return getState(userId).slots;
}

export function subscribeWorkspaceShortcutSlots(userId: string, listener: () => void): () => void {
  let userListeners = listeners.get(userId);
  if (!userListeners) {
    userListeners = new Set();
    listeners.set(userId, userListeners);
  }
  userListeners.add(listener);
  storageSubscriberCount += 1;
  if (storageSubscriberCount === 1 && typeof window !== 'undefined') {
    window.addEventListener('storage', handleStorage);
  }

  return () => {
    const currentListeners = listeners.get(userId);
    currentListeners?.delete(listener);
    if (currentListeners?.size === 0) listeners.delete(userId);
    storageSubscriberCount -= 1;
    if (storageSubscriberCount === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', handleStorage);
    }
  };
}

/** Initialize once from catalog order, then preserve slot identity across later reordering. */
export function reconcileWorkspaceShortcutSlots(
  userId: string,
  availableWorkspaceIds: readonly string[]
): WorkspaceShortcutSlots {
  const state = getState(userId);
  const uniqueAvailableIds = [...new Set(availableWorkspaceIds.filter(Boolean))];
  if (!state.initialized) {
    return writeState(
      userId,
      WORKSPACE_SHORTCUT_SLOT_NUMBERS.map((_, index) => uniqueAvailableIds[index] ?? null)
    );
  }

  const available = new Set(uniqueAvailableIds);
  const seen = new Set<string>();
  const next = state.slots.map((workspaceId) => {
    if (workspaceId === null || !available.has(workspaceId) || seen.has(workspaceId)) {
      return null;
    }
    seen.add(workspaceId);
    return workspaceId;
  });
  return writeState(userId, next);
}

/** Assign a stable workspace id to a slot, moving it out of any previous slot. */
export function setWorkspaceShortcutSlot(
  userId: string,
  slot: WorkspaceShortcutSlotNumber,
  workspaceId: string | null
): WorkspaceShortcutSlots {
  const next = [...getState(userId).slots];
  if (workspaceId !== null) {
    for (let index = 0; index < next.length; index += 1) {
      if (next[index] === workspaceId) next[index] = null;
    }
  }
  next[slot - 1] = workspaceId;
  return writeState(userId, next);
}

export function __resetWorkspaceShortcutSlotsForTests(): void {
  snapshots.clear();
}

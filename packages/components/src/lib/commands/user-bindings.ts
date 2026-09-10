import { z } from 'zod';

/**
 * Persisted user overrides for command keybindings.
 *
 * Shape: `Record<commandId, string[]>`
 *   - missing entry → use the command's declared defaults
 *   - empty array  → user explicitly unbound the command (no keys fire it)
 *   - one or more strings → fully replaces the command's declared bindings
 *
 * Stored in localStorage (per-device): a keymap is tied to the physical keyboard, not
 * the workspace, so we deliberately don't sync it via Loro.
 */

export const USER_BINDINGS_STORAGE_KEY = 'lody.commandOverrides.v1';

const userBindingsSchema = z.record(z.string(), z.array(z.string()));
export type UserBindingsMap = z.infer<typeof userBindingsSchema>;

export function loadUserBindings(): UserBindingsMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(USER_BINDINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = userBindingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    console.warn('[commands] discarding malformed user bindings', parsed.error);
    localStorage.removeItem(USER_BINDINGS_STORAGE_KEY);
    return {};
  } catch (error) {
    console.warn('[commands] failed to load user bindings; clearing', error);
    try {
      localStorage.removeItem(USER_BINDINGS_STORAGE_KEY);
    } catch {
      // ignore
    }
    return {};
  }
}

export function saveUserBindings(map: UserBindingsMap): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(USER_BINDINGS_STORAGE_KEY);
    } else {
      localStorage.setItem(USER_BINDINGS_STORAGE_KEY, JSON.stringify(map));
    }
  } catch (error) {
    console.warn('[commands] failed to save user bindings', error);
  }
}

/** Subscribe to persisted binding changes made by another renderer window. */
export function subscribeUserBindings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== USER_BINDINGS_STORAGE_KEY) return;
    if (
      event.storageArea &&
      typeof localStorage !== 'undefined' &&
      event.storageArea !== localStorage
    ) {
      return;
    }
    listener();
  };

  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
}

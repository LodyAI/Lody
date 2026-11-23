import {
  matchesKeyboardEvent as matchesHotkeyEvent,
  normalizeHotkey,
  validateHotkey,
  type Hotkey,
} from '@tanstack/hotkeys';
import { getHotkeyPlatform } from './platform';

/** Normalize a binding with the same parser used by the DOM matching engine. */
export function canonicalizeBinding(binding: string): string | null {
  if (!validateHotkey(binding).valid) return null;
  return normalizeHotkey(binding, getHotkeyPlatform());
}

/** Match a component-local chord with the same semantics as application commands. */
export function matchesKeyboardEvent(event: KeyboardEvent, binding: string): boolean {
  const normalized = canonicalizeBinding(binding);
  if (!normalized) return false;
  return matchesHotkeyEvent(event, normalized as Hotkey, getHotkeyPlatform());
}

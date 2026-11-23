import { formatForDisplay } from '@tanstack/hotkeys';
import { getHotkeyPlatform } from './platform';

/**
 * Convert a binding string like `Mod+shift+b` into a platform-appropriate display string.
 * macOS: `⌘⇧B`. Other: `Ctrl+Shift+B`.
 */
export function formatKeyBinding(binding: string): string {
  const platform = getHotkeyPlatform();
  return formatForDisplay(binding, {
    platform,
    separatorToken: platform === 'mac' ? '' : '+',
  });
}

/**
 * Convert a binding string into platform-appropriate per-key labels — e.g.
 * `Mod+shift+b` → `['⌘', '⇧', 'B']` on macOS, `['Ctrl', 'Shift', 'B']` elsewhere.
 *
 * Use this when rendering each key as its own visual chip (Kbd primitive).
 */
export function formatKeyParts(binding: string): string[] {
  const separator = '\u001f';
  return formatForDisplay(binding, {
    platform: getHotkeyPlatform(),
    separatorToken: separator,
  }).split(separator);
}

import { commands } from './registry';
import { canonicalizeBinding } from './key-matcher';
import { getPlatform } from './platform';
import type { ShortcutCommandId } from './shortcuts';

export const NUMBERED_CHAT_COMMANDS = Array.from({ length: 9 }, (_, index) => ({
  id: `session.selectVisible${index + 1}` as ShortcutCommandId,
  titleKey: `commands.session.selectVisible${index + 1}`,
  title: `Select Chat ${index + 1}`,
  category: 'Navigation' as const,
  index,
}));

const TAB_COMMANDS = Array.from({ length: 9 }, (_, index) =>
  index === 8 ? 'session.switchToLastTab' : `session.switchToTab${index + 1}`
);
export type NumberShortcutTarget = 'tabs' | 'chats';

function numberBindings(target: NumberShortcutTarget): Record<string, string[]> {
  const secondary = getPlatform() === 'mac' ? 'Ctrl' : 'Alt';
  return Object.fromEntries(
    NUMBERED_CHAT_COMMANDS.flatMap((chat, index) => [
      [chat.id, [`${target === 'chats' ? 'Mod' : secondary}+${index + 1}`]],
      [TAB_COMMANDS[index], [`${target === 'tabs' ? 'Mod' : secondary}+${index + 1}`]],
    ])
  );
}

/** Derive the preset from effective bindings so individual edits never leave stale UI. */
export function getNumberShortcutTarget(): NumberShortcutTarget | 'custom' {
  for (const target of ['tabs', 'chats'] as const) {
    if (
      Object.entries(numberBindings(target)).every(([id, expected]) => {
        const actual = commands.getKeybindingsFor(id);
        return (
          actual.length === 1 && canonicalizeBinding(actual[0]) === canonicalizeBinding(expected[0])
        );
      })
    )
      return target;
  }
  return 'custom';
}

export function setNumberShortcutTarget(target: NumberShortcutTarget): void {
  commands.setUserKeybindingsBatch(numberBindings(target));
}

import { useTranslation } from 'react-i18next';
import {
  composerScopedKeybindings,
  getCommandKeybindings,
  useCommand,
} from '@/lib/commands';
import type { ShortcutCommandId } from '@/lib/commands/shortcuts';

/** One cyclable composer option: an ordered value list, the current value, and a setter. */
export type ComposerCycleTarget = {
  values: string[];
  current: string | null;
  onSelect: (value: string) => void;
};

function cycleNext(target: ComposerCycleTarget | null | undefined): void {
  if (!target || target.values.length === 0) return;
  const index = target.current ? target.values.indexOf(target.current) : -1;
  const next = target.values[(index + 1) % target.values.length];
  if (next != null && next !== target.current) target.onSelect(next);
}

function canCycle(target: ComposerCycleTarget | null | undefined): boolean {
  return Boolean(target && target.values.length > 1);
}

/**
 * Registers the composer "cycle X" commands, shared by the chat landing and the
 * in-session composer. Mode cycling is bound to ⇧Tab with a binding-level
 * composer-focus guard, so custom bindings and command palette execution remain
 * available outside the input without hijacking reverse-Tab in the palette /
 * dialogs / settings. Provider / model / think-effort cyclers ship without a
 * default binding and are rebindable from the keyboard settings page.
 *
 * Pass `null` for any target that isn't applicable in the current surface (e.g. the agent
 * provider can't change mid-conversation).
 *
 * `getComposerAnchor` scopes each binding to the composer box owning the surface: two
 * visible composers (a session and an embedded landing draft) stack the same ids, and
 * without it a chord in one input cycles the other surface's state.
 */
export function useComposerCycleCommands(params: {
  enabled?: boolean;
  getComposerAnchor?: () => HTMLElement | null;
  mode?: ComposerCycleTarget | null;
  provider?: ComposerCycleTarget | null;
  model?: ComposerCycleTarget | null;
  thinkEffort?: ComposerCycleTarget | null;
}): void {
  const { t } = useTranslation();
  const { enabled = true, getComposerAnchor, mode, provider, model, thinkEffort } = params;

  const cycleKeybindings = (id: ShortcutCommandId) =>
    getComposerAnchor
      ? composerScopedKeybindings(getCommandKeybindings(id), getComposerAnchor)
      : getCommandKeybindings(id);

  useCommand(
    {
      id: 'session.cycleMode',
      title: t('commands.session.cycleMode', 'Cycle Agent Mode'),
      category: 'Session',
      keybindings: cycleKeybindings('session.cycleMode'),
      when: () => canCycle(mode),
      run: () => cycleNext(mode),
    },
    enabled
  );

  useCommand(
    {
      id: 'session.cycleProvider',
      title: t('commands.session.cycleProvider', 'Cycle ACP Provider'),
      category: 'Session',
      keybindings: cycleKeybindings('session.cycleProvider'),
      when: () => canCycle(provider),
      run: () => cycleNext(provider),
    },
    enabled
  );

  useCommand(
    {
      id: 'session.cycleModel',
      title: t('commands.session.cycleModel', 'Cycle Model'),
      category: 'Session',
      keybindings: cycleKeybindings('session.cycleModel'),
      when: () => canCycle(model),
      run: () => cycleNext(model),
    },
    enabled
  );

  useCommand(
    {
      id: 'session.cycleThinkEffort',
      title: t('commands.session.cycleThinkEffort', 'Cycle Thinking Effort'),
      category: 'Session',
      keybindings: cycleKeybindings('session.cycleThinkEffort'),
      when: () => canCycle(thinkEffort),
      run: () => cycleNext(thinkEffort),
    },
    enabled
  );
}

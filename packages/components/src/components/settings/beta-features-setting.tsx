import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/ui/switch';
import {
  developerModeEnabledAtom,
  inboxBetaEnabledAtom,
  promptShortcutsBetaEnabledAtom,
  semanticShortcutsBetaEnabledAtom,
} from '@/atoms/settings';
import { CompactRow, CompactSection } from './compact-layout';

/**
 * Unfinished features the user can opt into. The whole section is hidden unless
 * Developer mode is on, so a beta is something you have to go looking for twice:
 * once to reveal Developer mode, once to switch the feature on.
 *
 * Turning Developer mode off hides this section but deliberately does NOT clear
 * the switches — each derived feature gate already requires both, so the features
 * disappear immediately either way, and a user toggling Developer mode for an
 * unrelated diagnostic does not silently lose their opt-ins.
 */
export function BetaFeaturesSection() {
  const { t } = useTranslation();
  const developerModeEnabled = useAtomValue(developerModeEnabledAtom);
  const [inboxBetaEnabled, setInboxBetaEnabled] = useAtom(inboxBetaEnabledAtom);

  const [promptShortcutsBetaEnabled, setPromptShortcutsBetaEnabled] = useAtom(
    promptShortcutsBetaEnabledAtom
  );

  const [semanticShortcutsEnabled, setSemanticShortcutsEnabled] = useAtom(
    semanticShortcutsBetaEnabledAtom
  );

  if (!developerModeEnabled) return null;

  return (
    <CompactSection title={t('settings.beta.title', 'Beta features')}>
      <CompactRow
        label={t('settings.beta.inbox', 'Inbox')}
        helper={t(
          'settings.beta.inboxHelper',
          'Show the unfinished mobile Inbox tab. In development — expect rough edges.'
        )}
      >
        <Switch
          checked={inboxBetaEnabled}
          onCheckedChange={setInboxBetaEnabled}
          aria-label={t('settings.beta.inbox', 'Inbox')}
        />
      </CompactRow>
      <CompactRow
        label={t('settings.tabs.promptShortcuts', 'Prompt Shortcuts')}
        helper={t(
          'settings.beta.promptShortcutsHelper',
          'Create reusable prompts and insert them with /. In development — expect rough edges.'
        )}
      >
        <Switch
          checked={promptShortcutsBetaEnabled}
          onCheckedChange={setPromptShortcutsBetaEnabled}
          aria-label={t('settings.tabs.promptShortcuts', 'Prompt Shortcuts')}
        />
      </CompactRow>
      <CompactRow
        label={t('settings.beta.semanticShortcuts', 'Pointer-aware close shortcut')}
        helper={t(
          'settings.beta.semanticShortcutsHelper',
          'On desktop, close the active tab in the conversation or right panel you last pointed at or used with the keyboard.'
        )}
      >
        <Switch
          checked={semanticShortcutsEnabled}
          onCheckedChange={setSemanticShortcutsEnabled}
          aria-label={t('settings.beta.semanticShortcuts', 'Pointer-aware close shortcut')}
        />
      </CompactRow>
    </CompactSection>
  );
}

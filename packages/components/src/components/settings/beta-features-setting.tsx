import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Switch } from '@lody/ui/switch';
import {
  developerModeEnabledAtom,
  e2eeWorkspaceCreationEnabledAtom,
  inboxBetaEnabledAtom,
  roostHistoryExperimentEnabledAtom,
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
 *
 * The Roost history switch lives here with the same pattern: Developer mode and
 * the switch are required together, while the Experimental features master switch
 * is an independent user-facing surface.
 */
export function BetaFeaturesSection() {
  const { t } = useTranslation();
  const developerModeEnabled = useAtomValue(developerModeEnabledAtom);
  const [inboxBetaEnabled, setInboxBetaEnabled] = useAtom(inboxBetaEnabledAtom);
  const [e2eeCreationEnabled, setE2eeCreationEnabled] = useAtom(e2eeWorkspaceCreationEnabledAtom);

  const [semanticShortcutsEnabled, setSemanticShortcutsEnabled] = useAtom(
    semanticShortcutsBetaEnabledAtom
  );
  const [roostHistoryEnabled, setRoostHistoryEnabled] = useAtom(roostHistoryExperimentEnabledAtom);

  if (!developerModeEnabled) return null;

  return (
    <CompactSection title={t('settings.beta.title', 'Beta features')}>
      <CompactRow
        label={t('settings.beta.e2eeWorkspace', 'Encrypted workspace creation')}
        helper={t(
          'settings.beta.e2eeWorkspaceHelper',
          'Create a workspace with a device identity and signed permission history. Conversation sync and execution are not available yet. Existing workspaces are unchanged.'
        )}
      >
        <Switch
          checked={e2eeCreationEnabled}
          onCheckedChange={setE2eeCreationEnabled}
          aria-label={t('settings.beta.e2eeWorkspace', 'Encrypted workspace creation')}
        />
      </CompactRow>
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
        label={t('settings.beta.semanticShortcuts', 'Pointer-aware close shortcut')}
        helper={t(
          'settings.beta.semanticShortcutsHelper',
          'On desktop, close the tab where you last opened content, clicked, typed, or scrolled. Moving the pointer keeps that target; hover selects a region only before an explicit interaction.'
        )}
      >
        <Switch
          checked={semanticShortcutsEnabled}
          onCheckedChange={setSemanticShortcutsEnabled}
          aria-label={t('settings.beta.semanticShortcuts', 'Pointer-aware close shortcut')}
        />
      </CompactRow>

      <CompactRow
        label={t('settings.experimental.roostHistory', 'Roost history')}
        helper={t(
          'settings.experimental.roostHistoryHelper',
          'Use Roost for new conversations. Existing conversations keep their current history backend.'
        )}
      >
        <Switch
          checked={roostHistoryEnabled}
          onCheckedChange={setRoostHistoryEnabled}
          aria-label={t('settings.experimental.roostHistory', 'Roost history')}
        />
      </CompactRow>
    </CompactSection>
  );
}

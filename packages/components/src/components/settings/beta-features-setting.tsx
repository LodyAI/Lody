import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/ui/switch';
import {
  developerModeEnabledAtom,
  inboxBetaEnabledAtom,
  tasksBetaEnabledAtom,
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
  const [tasksBetaEnabled, setTasksBetaEnabled] = useAtom(tasksBetaEnabledAtom);
  const [inboxBetaEnabled, setInboxBetaEnabled] = useAtom(inboxBetaEnabledAtom);

  if (!developerModeEnabled) return null;

  return (
    <CompactSection title={t('settings.beta.title', 'Beta features')}>
      <CompactRow
        label={t('settings.beta.tasks', 'Tasks')}
        helper={t(
          'settings.beta.tasksHelper',
          'Track work you are not starting yet, separately from chats. In development — expect rough edges.'
        )}
      >
        <Switch
          checked={tasksBetaEnabled}
          onCheckedChange={setTasksBetaEnabled}
          aria-label={t('settings.beta.tasks', 'Tasks')}
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
    </CompactSection>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Select } from '@lody/ui/select';
import { AlertDialog } from '@/ui/dialog';
import { toast } from '@/lib/toast';
import type { MachineId, MachineViewMeta } from '@lody/shared';
import { CollapsibleSection } from './form-primitives';
import { CompactRow } from './compact-layout';

export function MachineIdentityRestore({
  machine,
  candidates,
  onRestore,
  encryptedWorkspace = false,
}: {
  machine: MachineViewMeta;
  candidates: readonly MachineViewMeta[];
  encryptedWorkspace?: boolean;
  onRestore: (source: MachineId, target: MachineId) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const targets = candidates.filter((candidate) => candidate.id !== machine.id);
  const target = targets.find((candidate) => candidate.id === targetId);
  const options = targets.map((candidate) => ({
    value: candidate.id,
    label: `${candidate.name} (${candidate.id})`,
  }));
  return (
    <CollapsibleSection title={t('settings.identityRestore.advanced', 'Advanced settings')}>
      <CompactRow
        inset={false}
        label={t('settings.identityRestore.title', 'Restore old machine identity')}
        helper={t(
          'settings.identityRestore.help',
          'Reconnect this daemon to its old conversations after losing local configuration. Deleted files and agent state are not restored.'
        )}
      >
        <Button variant="secondary" size="small" onClick={() => setConfirm(true)}>
          {t('settings.identityRestore.choose', 'Choose old identity')}
        </Button>
      </CompactRow>
      <AlertDialog.Root
        open={confirm}
        onOpenChange={(open) => {
          if (!pending) setConfirm(open);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('settings.identityRestore.title', 'Restore old machine identity')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                'settings.identityRestore.confirm',
                'Only continue if no machine is running with the old identity. Its dedicated machine credentials will be revoked. This daemon will restart; its newer conversations stay under the current identity.'
              )}
              {encryptedWorkspace ? (
                <>
                  {' '}
                  {t(
                    'settings.identityRestore.encryptedNotice',
                    'Encrypted workspaces require pairing again.'
                  )}
                </>
              ) : null}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <CompactRow
            inset={false}
            label={t('settings.identityRestore.current', 'Current machine name')}
          >
            <span>{machine.name}</span>
          </CompactRow>
          <Select.Root
            items={options}
            value={targetId}
            onValueChange={(value) => setTargetId(value)}
            disabled={pending}
          >
            <Select.Trigger
              aria-label={t('settings.identityRestore.target', 'Old machine identity')}
            >
              <Select.Value
                placeholder={t('settings.identityRestore.target', 'Old machine identity')}
              />
            </Select.Trigger>
            <Select.Content>
              {options.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  {option.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          {targets.length === 0 ? (
            <p>
              {t(
                'settings.identityRestore.empty',
                'No other offline machine identities owned by you are available in this workspace.'
              )}
            </p>
          ) : null}
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={pending}>
              {t('common.cancel', 'Cancel')}
            </AlertDialog.Cancel>
            <Button
              disabled={!target || pending}
              onClick={() => {
                if (!target || pending) return;
                setPending(true);
                void onRestore(machine.id, target.id)
                  .then(() => {
                    setConfirm(false);
                    toast.success(
                      t(
                        'settings.identityRestore.accepted',
                        'Restore accepted. The daemon will restart to finish.'
                      )
                    );
                  })
                  .catch((error: unknown) => {
                    toast.error(
                      t('settings.identityRestore.failed', 'Identity restore was not confirmed'),
                      {
                        description: error instanceof Error ? error.message : undefined,
                      }
                    );
                  })
                  .finally(() => setPending(false));
              }}
            >
              {t('settings.identityRestore.submit', 'Old identity is unused — restore and restart')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </CollapsibleSection>
  );
}

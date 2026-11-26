import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useWorkspaceRecoveryReady } from './settings/e2ee/recovery-vault-section';

const DISMISS_STORAGE_PREFIX = 'lody.e2ee.recoveryNoticeDismissed.v1:';

function dismissalKey(accountId: string | null | undefined, workspaceId: string) {
  return `${DISMISS_STORAGE_PREFIX}${accountId ?? ''}:${workspaceId}`;
}

function readDismissed(accountId: string | null | undefined, workspaceId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(dismissalKey(accountId, workspaceId)) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(accountId: string | null | undefined, workspaceId: string) {
  try {
    globalThis.localStorage?.setItem(dismissalKey(accountId, workspaceId), '1');
  } catch {
    /* Storage restrictions never block dismissal in the current session. */
  }
}

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    flexWrap: 'wrap',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    flexShrink: 0,
  },
});

/** Single-line dismissible reminder on encrypted chat landing when no recovery backup is verified yet. */
export function E2eeRecoveryNotice({
  workspaceId,
  accountId,
  onSetup,
}: {
  workspaceId: string;
  accountId?: string | null;
  onSetup: () => void;
}) {
  const { t } = useTranslation();
  const recoveryReady = useWorkspaceRecoveryReady(workspaceId, accountId);
  const [dismissed, setDismissed] = useState(() => readDismissed(accountId, workspaceId));

  if (recoveryReady !== false || dismissed) return null;

  return (
    <Alert.Root tone="warning" data-testid="e2ee-chat-recovery-notice">
      <div {...stylex.props(styles.row)}>
        <Alert.Description>{t('e2ee.chat.recoveryNotice')}</Alert.Description>
        <div {...stylex.props(styles.actions)}>
          <Button
            size="small"
            variant="secondary"
            data-testid="e2ee-chat-recovery-setup"
            onClick={onSetup}
          >
            {t('e2ee.chat.setupRecovery')}
          </Button>
          <Button
            size="small"
            variant="ghost"
            icon
            data-testid="e2ee-chat-recovery-dismiss"
            aria-label={t('common.close')}
            onClick={() => {
              writeDismissed(accountId, workspaceId);
              setDismissed(true);
            }}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </Alert.Root>
  );
}

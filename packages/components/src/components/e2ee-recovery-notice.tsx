import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { E2eeShieldKeyArt } from './e2ee/e2ee-illustrations';
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
  } catch {}
}

const styles = stylex.create({
  card: {
    position: 'relative',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: { default: 'center', '@media (max-width: 520px)': 'flex-start' },
    gap: { default: space[4], '@media (max-width: 520px)': space[3] },
    padding: space[4],
    paddingInlineEnd: space[8],
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    color: colors.label,
  },
  body: {
    display: 'flex',
    flexGrow: 1,
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[4],
    rowGap: space[2],
    minWidth: 0,
  },
  copy: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    flexGrow: 1,
    flexBasis: '16rem',
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    color: colors.label,
  },
  message: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
  },
  close: {
    position: 'absolute',
    top: space[2],
    insetInlineEnd: space[2],
  },
});

/** Dismissible card on the encrypted chat landing while no recovery backup is verified yet. */
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
    <section
      aria-labelledby="e2ee-chat-recovery-notice-title"
      data-testid="e2ee-chat-recovery-notice"
      {...stylex.props(styles.card)}
    >
      <E2eeShieldKeyArt attention />
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.copy)}>
          <p id="e2ee-chat-recovery-notice-title" {...stylex.props(styles.title)}>
            {t('e2ee.chat.recoveryNoticeTitle')}
          </p>
          <p {...stylex.props(styles.message)}>{t('e2ee.chat.recoveryNotice')}</p>
        </div>
        <Button
          size="small"
          variant="secondary"
          shape="pill"
          data-testid="e2ee-chat-recovery-setup"
          onClick={onSetup}
        >
          {t('e2ee.chat.setupRecovery')}
        </Button>
      </div>
      <div {...stylex.props(styles.close)}>
        <Button
          size="small"
          variant="ghost"
          icon
          shape="pill"
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
    </section>
  );
}

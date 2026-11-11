import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    margin: 0,
    padding: space[3],
    color: colors.secondaryLabel,
    fontSize: '0.9em',
  },
});

/** This device has not yet confirmed whether it holds the workspace's encrypted
 * identity. Local work stays available; sending and sync wait. Not a failure:
 * checking continues on its own, and Retry only asks again sooner. The host's
 * original failure code stays visible for diagnosis. */
export function WorkspaceHostIdentityNotice({
  code,
  onRetry,
}: {
  code: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-live="polite" {...stylex.props(styles.notice)}>
      <span>{t('e2ee.content.hostIdentityPending')}</span>
      <code>{code}</code>
      <Button type="button" variant="secondary" size="small" onClick={onRetry}>
        {t('e2ee.content.retryHostIdentity')}
      </Button>
    </div>
  );
}

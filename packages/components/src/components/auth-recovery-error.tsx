import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { WifiOff, TriangleAlert, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { useAuthSignOut } from '../providers/convex-provider';

const styles = stylex.create({
  announcement: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
  icon: { display: 'inline-flex', alignItems: 'center', width: 14, height: 14 },
  trigger: { pointerEvents: 'auto' },
  warning: { color: colors.warning },
  panel: { width: 'min(320px, calc(100vw - 32px))' },
  heading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    marginTop: space[4],
  },
  error: { color: colors.destructive, fontSize: text.footnoteSize, marginTop: space[3] },
});

type RecoveryStatusProps = {
  onRetry: () => void;
  isRecovering?: boolean;
  isOffline?: boolean;
};

export function AuthRecoveryErrorView({
  onRetry,
  onSignOut,
  isRecovering = false,
  isOffline = false,
}: RecoveryStatusProps & {
  onSignOut: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const title = isOffline
    ? t('authRecovery.offlineTitle')
    : isRecovering
      ? t('authRecovery.reconnectingTitle')
      : t('authRecovery.failedTitle');
  const description = isOffline
    ? t('authRecovery.offlineDescription')
    : isRecovering
      ? t('authRecovery.reconnectingDescription')
      : t('authRecovery.failedDescription');

  return (
    <div>
      <span role="status" {...stylex.props(styles.announcement)}>
        {title}
      </span>
      <Popover.Root modal={false}>
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="mini"
              icon
              aria-label={title}
              title={title}
              className={stylex.props(styles.trigger).className}
            />
          }
        >
          <span
            {...stylex.props(styles.icon, (isOffline || !isRecovering) && styles.warning)}
            aria-hidden="true"
          >
            {isOffline ? (
              <WifiOff size={14} />
            ) : isRecovering ? (
              <Spinner />
            ) : (
              <TriangleAlert size={14} />
            )}
          </span>
        </Popover.Trigger>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className={stylex.props(styles.panel).className}
        >
          <div {...stylex.props(styles.heading)}>
            <Popover.Title>{title}</Popover.Title>
            <Popover.Close
              render={
                <Button
                  variant="ghost"
                  size="mini"
                  icon
                  aria-label={t('authRecovery.closeDetails')}
                />
              }
            >
              <X size={14} aria-hidden="true" />
            </Popover.Close>
          </div>
          <Popover.Description>{description}</Popover.Description>
          {signOutFailed ? (
            <p role="alert" {...stylex.props(styles.error)}>
              {t('authRecovery.signInFailed')}
            </p>
          ) : null}
          <div {...stylex.props(styles.actions)}>
            <Button
              size="small"
              disabled={signingOut || isRecovering || isOffline}
              onClick={onRetry}
            >
              {isRecovering && !isOffline
                ? t('authRecovery.reconnectingTitle')
                : t('authRecovery.retry')}
            </Button>
            <Button
              variant="ghost"
              size="small"
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true);
                setSignOutFailed(false);
                void Promise.resolve()
                  .then(onSignOut)
                  .catch(() => setSignOutFailed(true))
                  .finally(() => setSigningOut(false));
              }}
            >
              {signingOut ? t('authRecovery.signingInAgain') : t('authRecovery.signInAgain')}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}

export function AuthRecoveryError(props: RecoveryStatusProps) {
  const signOut = useAuthSignOut();
  return <AuthRecoveryErrorView {...props} onSignOut={signOut} />;
}

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
import { sidebarSurface } from './sidebar-surface';

const styles = stylex.create({
  entry: { display: 'flex', alignItems: 'center' },
  announcement: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
  trigger: {
    pointerEvents: 'auto',
    outlineStyle: 'solid',
    outlineColor: 'transparent',
    outlineWidth: 2,
    outlineOffset: 2,
    boxShadow: {
      default: 'none',
      ':focus-visible':
        '0 0 0 1px color-mix(in oklab, hsl(var(--sidebar-ring) / 1) 40%, transparent)',
    },
  },
  iconStack: { display: 'grid', width: space[4], height: space[4], placeItems: 'center' },
  icon: {
    gridColumnStart: 1,
    gridRowStart: 1,
    display: 'flex',
    width: space[4],
    height: space[4],
    alignItems: 'center',
    justifyContent: 'center',
    transitionProperty: {
      default: 'opacity,filter,transform',
      '@media (prefers-reduced-motion: reduce)': 'opacity',
    },
    transitionDuration: '150ms',
    transitionTimingFunction: 'var(--ease-out)',
  },
  visibleIcon: { scale: '100%', opacity: 1, filter: 'none' },
  hiddenIcon: { scale: '90%', opacity: 0, filter: 'blur(2px)' },
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
    <div {...stylex.props(styles.entry)}>
      <span role="status" {...stylex.props(styles.announcement)}>
        {title}
      </span>
      <Popover.Root modal={false}>
        <Popover.Trigger
          render={
            <button
              type="button"
              aria-label={title}
              title={title}
              {...stylex.props(sidebarSurface.iconButton, styles.trigger)}
            />
          }
        >
          <span {...stylex.props(styles.iconStack)} aria-hidden="true">
            {[
              { active: isOffline, icon: <WifiOff size={16} strokeWidth={1.5} /> },
              { active: !isOffline && isRecovering, icon: <Spinner size="small" label={null} /> },
              {
                active: !isOffline && !isRecovering,
                icon: <TriangleAlert size={16} strokeWidth={1.5} />,
              },
            ].map(({ active, icon }, index) => (
              <span
                key={index}
                {...stylex.props(
                  styles.icon,
                  active ? styles.visibleIcon : styles.hiddenIcon,
                  index !== 1 && styles.warning
                )}
              >
                {icon}
              </span>
            ))}
          </span>
        </Popover.Trigger>
        <Popover.Content side="top" align="start" sideOffset={8} xstyle={styles.panel}>
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

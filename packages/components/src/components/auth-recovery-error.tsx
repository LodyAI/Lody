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
import { cn } from '@/lib/utils';

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
              className={cn(
                stylex.props(sidebarSurface.iconButton, styles.trigger).className,
                'outline-hidden focus-visible:ring-1 focus-visible:ring-sidebar-ring/40'
              )}
            />
          }
        >
          <span className="grid size-4 place-items-center" aria-hidden="true">
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
                className={cn(
                  'col-start-1 row-start-1 flex size-4 items-center justify-center transition-[opacity,filter,transform] duration-150 ease-out motion-reduce:transition-opacity',
                  active ? 'scale-100 opacity-100 blur-none' : 'scale-90 opacity-0 blur-[2px]',
                  index !== 1 && stylex.props(styles.warning).className
                )}
              >
                {icon}
              </span>
            ))}
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

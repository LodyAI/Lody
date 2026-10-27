import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { useTranslation } from 'react-i18next';
import { useAtom, useAtomValue } from 'jotai';
import { notificationPromptDismissedAtom, userAtom, currentWorkspaceSlugAtom } from '@/atoms';
import { cn } from '@/lib/utils';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { COMPOSER_ELEVATION_CLASS } from '@/components/chat/composer-surface';

// `Notification.permission` is a synchronous browser round trip (~3ms in Chrome),
// and this prompt remounts with every conversation. Cache it only while a
// permission-change listener keeps the cache honest (settings can grant or deny
// while the page lives); without the Permissions API, read it each time.
let cachedNotificationPermission: NotificationPermission | null = null;
let notificationPermissionWatch: 'idle' | 'pending' | 'active' = 'idle';

function readNotificationPermission(): NotificationPermission {
  if (notificationPermissionWatch === 'active' && cachedNotificationPermission !== null) {
    return cachedNotificationPermission;
  }
  const permission = Notification.permission;
  if (
    notificationPermissionWatch === 'idle' &&
    typeof navigator.permissions?.query === 'function'
  ) {
    notificationPermissionWatch = 'pending';
    navigator.permissions.query({ name: 'notifications' }).then(
      (status) => {
        status.addEventListener('change', () => {
          cachedNotificationPermission = null;
        });
        notificationPermissionWatch = 'active';
      },
      () => {
        // Unsupported descriptor: keep reading directly.
      }
    );
  }
  if (notificationPermissionWatch === 'active') cachedNotificationPermission = permission;
  return permission;
}

export interface NotificationPermissionPromptProps {
  /** Whether the session has completed (used as trigger to show the prompt) */
  sessionCompleted: boolean;
  /** Additional class names */
  className?: string;
}

/**
 * A prompt that appears after an AI response completes, asking the user
 * if they want to enable push notifications.
 *
 * Shows only when:
 * - User hasn't dismissed the prompt before
 * - Browser supports notifications
 * - Notification permission is not already granted or denied
 * - A session has just completed
 */
export function NotificationPermissionPrompt({
  sessionCompleted,
  className,
}: NotificationPermissionPromptProps) {
  const { t } = useTranslation();
  const { openSettings } = useOpenSettings();
  const user = useAtomValue(userAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const [dismissed, setDismissed] = useAtom(notificationPromptDismissedAtom);
  const [visible, setVisible] = useState(false);
  const [hasShownForThisSession, setHasShownForThisSession] = useState(false);
  const prevSessionCompletedRef = useRef(sessionCompleted);
  if (prevSessionCompletedRef.current && !sessionCompleted) {
    // Session reset (new session started) — allow showing prompt again
    setHasShownForThisSession(false);
  }
  prevSessionCompletedRef.current = sessionCompleted;

  const notificationSupported = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return 'Notification' in window && typeof Notification === 'function';
  }, []);

  // Determine if we should show the prompt. The permission read goes last: it
  // is the only check that costs a browser round trip.
  const shouldShow = useMemo(() => {
    // Don't show if user is not logged in
    if (!user) return false;
    // Don't show if already dismissed
    if (dismissed) return false;
    // Don't show if notifications not supported
    if (!notificationSupported) return false;
    // Only show after session completion
    if (!sessionCompleted) return false;
    // Don't show again if already shown for this session
    if (hasShownForThisSession) return false;
    // Don't show if permission already granted or denied
    return readNotificationPermission() === 'default';
  }, [user, dismissed, notificationSupported, sessionCompleted, hasShownForThisSession]);

  // Show the prompt with a slight delay after session completion
  useEffect(() => {
    if (shouldShow && !visible) {
      const timer = window.setTimeout(() => {
        setVisible(true);
        setHasShownForThisSession(true);
      }, 1000); // 1 second delay
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [shouldShow, visible]);

  const handleEnable = useCallback(() => {
    setVisible(false);
    // Open the general settings (modal on desktop, route on mobile).
    if (workspaceSlug) {
      openSettings('preferences');
    }
  }, [openSettings, workspaceSlug]);

  // Permanently dismiss - won't show again
  const handleDismiss = useCallback(() => {
    setVisible(false);
    setDismissed(true);
  }, [setDismissed]);

  // Temporarily close - will show again on next session completion
  const handleClose = useCallback(() => {
    setVisible(false);
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <ConversationColumn {...stylex.props(styles.column)}>
      {/* The same surface as the composer it sits above, not a status tint: this
          asks a question, it does not report a condition, and `--status-info`
          painted the whole card amber next to otherwise neutral chrome. Colour
          is left to the one primary action. */}
      <div
        className={cn(
          stylex.props(styles.prompt).className,
          'dark:border-input-border/70 dark:bg-input/90',
          COMPOSER_ELEVATION_CLASS,
          className
        )}
      >
        <div {...stylex.props(styles.iconWell)}>
          <Bell {...stylex.props(styles.icon, styles.muted)} />
        </div>
        <div {...stylex.props(styles.body)}>
          <p {...stylex.props(styles.title)}>
            {t('notifications.prompt.title', 'Enable notifications?')}
          </p>
          <p {...stylex.props(styles.description)}>
            {t('notifications.prompt.description', 'Get notified when your AI tasks complete.')}
          </p>
          <div {...stylex.props(styles.actions)}>
            <Button size="small" onClick={handleEnable}>
              {t('notifications.prompt.enable', 'Enable')}
            </Button>
            <Button
              variant="ghost"
              size="small"
              onClick={handleDismiss}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('notifications.prompt.dontRemind', "Don't remind me")}
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          size="mini"
          icon
          onClick={handleClose}
          className={cn(
            stylex.props(styles.close).className,
            'text-muted-foreground/70 hover:text-foreground'
          )}
          aria-label={t('common.close', 'Close')}
        >
          <X {...stylex.props(styles.icon)} />
        </Button>
      </div>
    </ConversationColumn>
  );
}

const enter = stylex.keyframes({
  from: {
    opacity: 0,
    transform: 'translate3d(0, calc(var(--spacing) * 2), 0) scale3d(1, 1, 1) rotate(0)',
    filter: 'blur(0)',
  },
});

const styles = stylex.create({
  column: { marginBottom: themeSpace[2] },
  prompt: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[3],
    borderRadius: themeRadius.xl,
    borderWidth: '0.5px',
    borderStyle: 'solid',
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    borderColor: 'hsl(var(--foreground) / 0.1)',
    backgroundColor: themeColors.composer,
    animationName: enter,
    animationDuration: themeDuration[300],
    animationTimingFunction: 'ease',
    transitionDuration: themeDuration[300],
  },
  iconWell: {
    display: 'flex',
    height: themeSpace[6],
    width: themeSpace[6],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--foreground) / 0.06)',
  },
  icon: { height: themeSpace[3.5], width: themeSpace[3.5] },
  muted: { color: themeColors.mutedForeground },
  body: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  title: { fontWeight: themeFontWeight.medium, color: themeColors.foreground },
  description: {
    marginTop: themeSpace[0.5],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  actions: { marginTop: themeSpace[2], display: 'flex', alignItems: 'center', gap: themeSpace[2] },
  close: { flexShrink: 0 },
});

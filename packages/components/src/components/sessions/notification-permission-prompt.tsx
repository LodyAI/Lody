import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { useTranslation } from 'react-i18next';
import { useAtom, useAtomValue } from 'jotai';
import { notificationPromptDismissedAtom, userAtom, currentWorkspaceSlugAtom } from '@/atoms';
import { cn } from '@/lib/utils';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { ConversationColumn } from '@/components/shared/conversation-column';

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

  const permissionStatus = useMemo(() => {
    if (!notificationSupported) return 'denied';
    return Notification.permission;
  }, [notificationSupported]);

  // Determine if we should show the prompt
  const shouldShow = useMemo(() => {
    // Don't show if user is not logged in
    if (!user) return false;
    // Don't show if already dismissed
    if (dismissed) return false;
    // Don't show if notifications not supported
    if (!notificationSupported) return false;
    // Don't show if permission already granted or denied
    if (permissionStatus !== 'default') return false;
    // Only show after session completion
    if (!sessionCompleted) return false;
    // Don't show again if already shown for this session
    if (hasShownForThisSession) return false;

    return true;
  }, [
    user,
    dismissed,
    notificationSupported,
    permissionStatus,
    sessionCompleted,
    hasShownForThisSession,
  ]);

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
    <ConversationColumn className="mb-2">
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-2 duration-300',
          'border-status-info/20 bg-status-info/10',
          className
        )}
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-status-info/[0.12]">
          <Bell className="h-3.5 w-3.5 text-status-info" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-foreground">
            {t('notifications.prompt.title', 'Enable notifications?')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('notifications.prompt.description', 'Get notified when your AI tasks complete.')}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="small" onClick={handleEnable}>
              {t('notifications.prompt.enable', 'Enable')}
            </Button>
            <Button
              variant="ghost"
              size="small"
              onClick={handleDismiss}
              className="text-status-info hover:bg-status-info/10 hover:text-status-info"
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
          className="shrink-0 text-status-info/70 hover:bg-status-info/10 hover:text-status-info"
          aria-label={t('common.close', 'Close')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </ConversationColumn>
  );
}

import type { SessionGoalMessage } from '@lody/shared';

export function isAppForeground(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
  );
}

export type SessionCompletionNotificationStatus =
  | 'running'
  | 'initializing'
  | 'requestPermission'
  | 'idle';

export type ShouldNotifySessionCompletionInput = {
  initialized: boolean;
  supportsTerminalNotifications?: boolean;
  enabled: boolean;
  previousStatusType: SessionCompletionNotificationStatus | undefined;
  currentStatusType: SessionCompletionNotificationStatus;
  latestGoal: SessionGoalMessage | null | undefined;
};

export function shouldNotifySessionCompletion({
  initialized,
  supportsTerminalNotifications,
  enabled,
  previousStatusType,
  currentStatusType,
}: ShouldNotifySessionCompletionInput): boolean {
  return (
    !supportsTerminalNotifications &&
    initialized &&
    enabled &&
    previousStatusType !== undefined &&
    previousStatusType !== 'idle' &&
    currentStatusType === 'idle'
  );
}

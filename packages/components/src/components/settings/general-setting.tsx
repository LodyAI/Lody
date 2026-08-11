import { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ElectronAutoLaunchStatusResult,
  GetNotificationPermissionStatusResult,
  OpenSystemNotificationSettingsResult,
  SetElectronAutoLaunchResult,
} from '@lody/shared';
import { Trash2 } from 'lucide-react';
import { Loading } from '@/ui';
import { Button } from '@/ui/button';
import { Switch } from '@/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { toast } from 'sonner';
import {
  electronSessionCompletionNotificationsEnabledAtom,
  mobileKeyboardActionAtom,
  queuedMessageBehaviorAtom,
  sessionSidebarCodeChangesOnlyAtom,
  userAtom,
} from '@/atoms';
import { useAtom, useAtomValue } from 'jotai';
import { CompactRow, CompactSection } from './compact-layout';
import { settingContainerClass } from '.';
import { AutoArchiveSection } from './auto-archive-setting';
import { ExperimentalFeaturesSection } from './experimental-features-setting';
import {
  getOneSignalPermissionState,
  getOneSignalPushSubscriptionOptedIn,
  initOneSignal,
} from '@/lib/onesignal';
import { isNativeAppShell } from '@/lib/native-platform';
import { usePostHog } from '@posthog/react';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { ClearCacheConfirmDialog, useClearCache } from './clear-cache';
import { useIsMobile } from '@/hooks/use-mobile';
import { isMobileKeyboardAction } from '@/lib/mobile-keyboard-action';
import { MobileGeneralSettings } from '@/components/mobile/mobile-general-settings';
import { PathLaunchersSettings } from './path-launchers-setting';
import { QueuedMessageBehaviorControl } from './queued-message-behavior-control';
import { CliDaemonSetting } from './cli-daemon-setting';
import { useAppCapability } from '@/lib/app-platform';

type ElectronPlatform = 'darwin' | 'win32' | 'linux' | 'unknown';

type ElectronNotificationPermissionStatusResult = GetNotificationPermissionStatusResult;

function normalizeElectronPlatform(platform: string | undefined): ElectronPlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform;
  }
  return 'unknown';
}

function getDesktopNotificationHintKey(platform: ElectronPlatform): string {
  switch (platform) {
    case 'darwin':
      return 'settings.notifications.desktopHint.darwin';
    case 'win32':
      return 'settings.notifications.desktopHint.win32';
    case 'linux':
      return 'settings.notifications.desktopHint.linux';
    default:
      return 'settings.notifications.desktopHint.unknown';
  }
}

/**
 * Fetches a boolean "enabled" Electron setting from the main process on mount and
 * feeds it into local state. No-op outside Electron or before the preload bridge
 * exposes the getter. Shared by the prevent-sleep and run-local-agent toggles.
 */
function useElectronEnabledSetting(
  isElectron: boolean,
  apiMethod: 'getPreventSleepEnabled' | 'getCliAutoStartEnabled',
  setEnabled: (enabled: boolean) => void
) {
  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const getter = window.api?.[apiMethod];
    if (!isElectron || !getter) {
      return undefined;
    }

    let active = true;
    void getter().then((result) => {
      if (active && typeof result?.enabled === 'boolean') {
        setEnabled(result.enabled);
      }
    });
    return () => {
      active = false;
    };
  }, [isElectron, apiMethod, setEnabled]);
}

/**
 * 通用设置页面组件
 * 包含通知、输入和桌面客户端设置，支持移动端响应式布局
 */
export function GeneralSettingsComponent() {
  const { t } = useTranslation();
  const githubIntegrationAvailable = useAppCapability('githubIntegration');
  const postHog = usePostHog();
  const user = useAtomValue(userAtom);
  const [electronCompletionNotificationsEnabled, setElectronCompletionNotificationsEnabled] =
    useAtom(electronSessionCompletionNotificationsEnabledAtom);
  const [mobileKeyboardAction, setMobileKeyboardAction] = useAtom(mobileKeyboardActionAtom);
  const [sessionSidebarCodeChangesOnly, setSessionSidebarCodeChangesOnly] = useAtom(
    sessionSidebarCodeChangesOnlyAtom
  );
  const [queuedMessageBehavior, setQueuedMessageBehavior] = useAtom(queuedMessageBehaviorAtom);
  const [preventSleepEnabled, setPreventSleepEnabled] = useState(true);
  const [cliAutoStartEnabled, setCliAutoStartEnabled] = useState(true);
  const [cliAutoStartLoading, setCliAutoStartLoading] = useState(false);
  const clearCache = useClearCache();
  const isMobile = useIsMobile();
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const isNative = !isElectron && isNativeAppShell();
  const showMobileInputSettings = isMobile || isNative;
  const selectedMobileKeyboardAction = isMobileKeyboardAction(mobileKeyboardAction)
    ? mobileKeyboardAction
    : 'send';
  const electronPlatform = useMemo(() => {
    if (!isElectron || typeof window === 'undefined') {
      return 'unknown';
    }
    return normalizeElectronPlatform(window.__LODY_PLATFORM__?.os);
  }, [isElectron]);
  const [notificationSupported, setNotificationSupported] = useState(isNative);
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermission>('default');
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [oneSignalReady, setOneSignalReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [autoLaunchEnabled, setAutoLaunchEnabled] = useState(false);
  const [autoLaunchSupported, setAutoLaunchSupported] = useState(false);
  const [autoLaunchLoading, setAutoLaunchLoading] = useState(false);
  const isSwitchDisabled = isElectron
    ? !notificationSupported || isProcessing
    : !notificationSupported || !oneSignalReady || isProcessing;
  const autoLaunchSwitchDisabled = !autoLaunchSupported || autoLaunchLoading;

  const readElectronNotificationPermission =
    useCallback(async (): Promise<ElectronNotificationPermissionStatusResult> => {
      if (typeof window === 'undefined') {
        return {
          supported: false,
          permission: 'default',
          source: 'renderer',
          error: 'Window is not available',
        };
      }

      const rendererSupported = 'Notification' in window && typeof Notification === 'function';
      const rendererPermission: NotificationPermission = rendererSupported
        ? Notification.permission
        : 'default';

      const reader = window.api?.getNotificationPermissionStatus;
      if (reader) {
        try {
          const result = await reader();
          if (
            result &&
            typeof result === 'object' &&
            typeof result.supported === 'boolean' &&
            (result.permission === 'granted' ||
              result.permission === 'denied' ||
              result.permission === 'default')
          ) {
            if (
              result.supported &&
              result.source === 'renderer' &&
              result.permission === 'default'
            ) {
              return {
                ...result,
                supported: rendererSupported,
                permission: rendererPermission,
              };
            }
            return result;
          }
        } catch (error) {
          return {
            supported: false,
            permission: 'default',
            source: 'renderer',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      return {
        supported: rendererSupported,
        permission: rendererPermission,
        source: 'renderer',
      };
    }, []);

  const readOneSignalPushSubscriptionEnabled = useCallback(async (): Promise<
    boolean | undefined
  > => {
    if (typeof window === 'undefined' || isElectron) {
      return undefined;
    }

    const oneSignal = await initOneSignal().catch(() => null);
    if (!oneSignal) {
      return undefined;
    }
    return getOneSignalPushSubscriptionOptedIn(oneSignal);
  }, [isElectron]);

  const syncNotificationPermission = useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    if (isElectron) {
      const result = await readElectronNotificationPermission();
      setNotificationSupported(result.supported);
      setPermissionStatus(result.permission);
      setNotificationsEnabled(
        result.supported &&
          result.permission === 'granted' &&
          electronCompletionNotificationsEnabled
      );
      return;
    }

    if (isNative) {
      // notificationSupported is seeded from isNative, so it is already true here.
      try {
        const oneSignal = await initOneSignal();
        const supported = Boolean(oneSignal);
        setOneSignalReady(supported);

        if (!oneSignal) {
          setPermissionStatus('default');
          setNotificationsEnabled(false);
          return;
        }

        const currentPermission = await getOneSignalPermissionState(oneSignal);
        setPermissionStatus(currentPermission);
        if (currentPermission !== 'granted') {
          setNotificationsEnabled(false);
          return;
        }

        const pushSubscriptionEnabled = await getOneSignalPushSubscriptionOptedIn(oneSignal);
        setNotificationsEnabled(pushSubscriptionEnabled ?? false);
      } catch (error) {
        console.error('Failed to sync native notification permission', error);
        setOneSignalReady(false);
        setPermissionStatus('default');
        setNotificationsEnabled(false);
      }
      return;
    }

    const supported = 'Notification' in window && typeof Notification === 'function';
    setNotificationSupported(supported);
    if (!supported) {
      setPermissionStatus('default');
      setNotificationsEnabled(false);
      return;
    }

    const currentPermission = Notification.permission;
    setPermissionStatus(currentPermission);
    if (currentPermission !== 'granted') {
      setNotificationsEnabled(false);
      return;
    }

    const webPushSubscriptionEnabled = await readOneSignalPushSubscriptionEnabled();
    if (typeof webPushSubscriptionEnabled === 'boolean') {
      setNotificationsEnabled(webPushSubscriptionEnabled);
      return;
    }

    if (!oneSignalReady) {
      // Web push status is managed by OneSignal subscription state, not browser permission only.
      setNotificationsEnabled(false);
      return;
    }

    // Keep the previous state if SDK state is temporarily unavailable.
    setNotificationsEnabled((previous) => previous);
  }, [
    electronCompletionNotificationsEnabled,
    isElectron,
    isNative,
    oneSignalReady,
    readElectronNotificationPermission,
    readOneSignalPushSubscriptionEnabled,
  ]);

  useEffect(() => {
    void syncNotificationPermission();

    if (typeof window === 'undefined') {
      return undefined;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncNotificationPermission();
      }
    };

    const handleWindowFocus = () => {
      void syncNotificationPermission();
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [syncNotificationPermission]);

  useEffect(() => {
    if (!isElectron) {
      return undefined;
    }
    void syncNotificationPermission();
    return undefined;
  }, [electronCompletionNotificationsEnabled, isElectron, syncNotificationPermission]);

  useEffect(() => {
    if (isElectron || !oneSignalReady) {
      return undefined;
    }
    void syncNotificationPermission();
    return undefined;
  }, [isElectron, oneSignalReady, syncNotificationPermission]);

  useEffect(() => {
    if (typeof window === 'undefined' || window.__LODY_ELECTRON__ === true) {
      return undefined;
    }

    let active = true;
    void initOneSignal()
      .then((oneSignal) => {
        if (!active || !oneSignal?.Notifications) {
          return;
        }
        setOneSignalReady(true);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setOneSignalReady(false);
        console.error('OneSignal init failed', error);
      });

    return () => {
      active = false;
    };
  }, [isElectron]);

  useEffect(() => {
    const getAutoLaunchStatus = window.api?.getAutoLaunchStatus;
    if (!isElectron || typeof window === 'undefined' || !getAutoLaunchStatus) {
      setAutoLaunchSupported(false);
      setAutoLaunchEnabled(false);
      return undefined;
    }

    let active = true;
    const loadAutoLaunchStatus = async () => {
      try {
        const result: ElectronAutoLaunchStatusResult = await getAutoLaunchStatus();
        if (!active) return;
        setAutoLaunchSupported(result.supported);
        setAutoLaunchEnabled(result.enabled);
      } catch {
        if (!active) return;
        setAutoLaunchSupported(false);
        setAutoLaunchEnabled(false);
      }
    };

    void loadAutoLaunchStatus();
    return () => {
      active = false;
    };
  }, [isElectron]);

  useElectronEnabledSetting(isElectron, 'getPreventSleepEnabled', setPreventSleepEnabled);
  useElectronEnabledSetting(isElectron, 'getCliAutoStartEnabled', setCliAutoStartEnabled);

  const permissionLabel = useMemo(() => {
    if (isElectron && !notificationsEnabled) {
      return t('settings.notifications.disabledDesktop');
    }
    switch (permissionStatus) {
      case 'granted':
        return t('settings.notifications.permissionGranted');
      case 'denied':
        return t(
          isElectron
            ? 'settings.notifications.permissionDeniedStatusDesktop'
            : isNative
            ? 'settings.notifications.permissionDeniedStatusNative'
            : 'settings.notifications.permissionDeniedStatus'
        );
      default:
        return t('settings.notifications.permissionDefault');
    }
  }, [isElectron, isNative, notificationsEnabled, permissionStatus, t]);

  const disableReason = useMemo(() => {
    if (!notificationSupported) {
      return t('settings.notifications.reason.notSupported');
    }
    if (!isElectron && !oneSignalReady) {
      return t('settings.notifications.reason.notReady');
    }
    return undefined;
  }, [isElectron, notificationSupported, oneSignalReady, t]);

  const desktopHint = useMemo(() => {
    return t(getDesktopNotificationHintKey(electronPlatform));
  }, [electronPlatform, t]);

  const openSystemNotificationSettings =
    useCallback(async (): Promise<OpenSystemNotificationSettingsResult> => {
      if (typeof window === 'undefined') {
        return { opened: false, platform: 'unknown', error: 'Window is not available' };
      }

      const opener = window.api?.openSystemNotificationSettings;
      if (!opener) {
        return {
          opened: false,
          platform: window.__LODY_PLATFORM__?.os ?? 'unknown',
          error: 'openSystemNotificationSettings is not available',
        };
      }

      try {
        return await opener();
      } catch (error) {
        return {
          opened: false,
          platform: window.__LODY_PLATFORM__?.os ?? 'unknown',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }, []);

  const handleToggleNotifications = async (checked: boolean) => {
    if (!notificationSupported) {
      return;
    }

    const previousValue = notificationsEnabled;
    const previousElectronEnabled = electronCompletionNotificationsEnabled;
    setIsProcessing(true);

    try {
      if (isElectron) {
        if (!checked) {
          setElectronCompletionNotificationsEnabled(false);
          setNotificationsEnabled(false);
          return;
        }

        const initialPermission = await readElectronNotificationPermission();
        setNotificationSupported(initialPermission.supported);
        setPermissionStatus(initialPermission.permission);
        if (!initialPermission.supported) {
          setElectronCompletionNotificationsEnabled(false);
          setNotificationsEnabled(false);
          toast.error(t('settings.notifications.unsupportedDesktop'));
          return;
        }

        let currentPermission = initialPermission.permission;
        if (
          currentPermission !== 'granted' &&
          typeof Notification === 'function' &&
          typeof Notification.requestPermission === 'function'
        ) {
          try {
            currentPermission = await Notification.requestPermission();
            setPermissionStatus(currentPermission);
          } catch {
            currentPermission = initialPermission.permission;
          }
        }

        if (currentPermission !== 'granted') {
          setElectronCompletionNotificationsEnabled(false);
          setNotificationsEnabled(false);
          const openResult = await openSystemNotificationSettings();
          toast.error(t('settings.notifications.permissionDenied'), {
            description: openResult.opened
              ? t('settings.notifications.permissionDeniedDescriptionDesktopOpened', {
                  hint: desktopHint,
                })
              : t('settings.notifications.permissionDeniedDescriptionDesktop', {
                  hint: desktopHint,
                }),
          });
          return;
        }

        setElectronCompletionNotificationsEnabled(true);
        setNotificationsEnabled(true);
        return;
      }

      if (!oneSignalReady) {
        toast.error(t('settings.notifications.notReady'));
        return;
      }

      const oneSignal = await initOneSignal();
      if (!oneSignal?.Notifications) {
        toast.error(t('settings.notifications.notReady'));
        return;
      }

      if (checked) {
        const pushSurface = isNative ? 'native' : 'web';
        // push/permission_prompt_shown (spec §8f.3, P0, tier A): the OneSignal
        // OS permission prompt is about to be requested from settings.
        capturePostHogEvent(postHog, 'push/permission_prompt_shown', {
          surface: pushSurface,
          source: 'settings',
        });

        const result = (await oneSignal.Notifications.requestPermission()) ? 'granted' : 'denied';
        setPermissionStatus(result);

        if (result !== 'granted') {
          // push/permission_denied (spec §8f.3, P1, tier A).
          capturePostHogEvent(postHog, 'push/permission_denied', {
            surface: pushSurface,
            source: 'settings',
          });
          toast.error(t('settings.notifications.permissionDenied'), {
            description: t('settings.notifications.permissionDeniedDescription'),
          });
          setNotificationsEnabled(false);
          return;
        }

        // push/permission_granted (spec §8f.3, P1, tier A).
        capturePostHogEvent(postHog, 'push/permission_granted', {
          surface: pushSurface,
          source: 'settings',
        });

        if (user) {
          await oneSignal.User.PushSubscription.optIn();
          await oneSignal.login(user?.id);
          setNotificationsEnabled(true);
          // push/subscribed + push/token_registered (spec §8f.3, P0/P0): the
          // user opted in and OneSignal logged in the external id, so this
          // install is now a registered push target. We never send the raw
          // token; OneSignal owns it.
          capturePostHogEvent(postHog, 'push/subscribed', {
            surface: pushSurface,
            source: 'settings',
          });
          capturePostHogEvent(postHog, 'push/token_registered', {
            surface: pushSurface,
            source: 'settings',
          });
        }
      } else {
        await oneSignal.User.PushSubscription.optOut();
        setNotificationsEnabled(false);
      }
    } catch (error) {
      console.error('Failed to toggle notifications', error);
      toast.error(t('settings.notifications.error'), {
        description: t('settings.notifications.errorDescription'),
      });
      if (isElectron) {
        setElectronCompletionNotificationsEnabled(previousElectronEnabled);
        void syncNotificationPermission();
      } else if (isNative) {
        void syncNotificationPermission();
      } else if (typeof window !== 'undefined' && notificationSupported) {
        setPermissionStatus(Notification.permission);
      }
      setNotificationsEnabled(previousValue);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleToggleAutoLaunch = async (checked: boolean) => {
    if (!isElectron || !window.api?.setAutoLaunchEnabled) {
      return;
    }

    const previous = autoLaunchEnabled;
    setAutoLaunchEnabled(checked);
    setAutoLaunchLoading(true);
    try {
      const result: SetElectronAutoLaunchResult = await window.api.setAutoLaunchEnabled(checked);
      if (!result.ok) {
        setAutoLaunchEnabled(previous);
        toast.error(t('settings.general.autoLaunch.toggleFailed', 'Failed to update auto launch'));
      } else {
        setAutoLaunchEnabled(result.enabled);
      }
    } catch {
      setAutoLaunchEnabled(previous);
      toast.error(t('settings.general.autoLaunch.toggleFailed', 'Failed to update auto launch'));
    } finally {
      setAutoLaunchLoading(false);
    }
  };

  const handleToggleCliAutoStart = async (checked: boolean) => {
    if (!isElectron || !window.api?.setCliAutoStartEnabled) {
      return;
    }

    const previous = cliAutoStartEnabled;
    setCliAutoStartEnabled(checked);
    setCliAutoStartLoading(true);
    try {
      const result = await window.api.setCliAutoStartEnabled(checked);
      if (result?.ok && typeof result.enabled === 'boolean') {
        setCliAutoStartEnabled(result.enabled);
      } else {
        setCliAutoStartEnabled(previous);
        toast.error(t('settings.general.cliAutoStart.toggleFailed', 'Failed to update auto start'));
      }
    } catch {
      setCliAutoStartEnabled(previous);
      toast.error(t('settings.general.cliAutoStart.toggleFailed', 'Failed to update auto start'));
    } finally {
      setCliAutoStartLoading(false);
    }
  };

  if (isMobile) return <MobileGeneralSettings />;

  return (
    <>
      <div className={settingContainerClass}>
        {showMobileInputSettings ? (
          <CompactSection title={t('settings.input.title')}>
            <CompactRow
              label={t('settings.input.mobileKeyboardAction.label')}
              helper={t('settings.input.mobileKeyboardAction.helper')}
            >
              <Select
                value={selectedMobileKeyboardAction}
                onValueChange={(value) => {
                  if (isMobileKeyboardAction(value)) {
                    setMobileKeyboardAction(value);
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="send">
                    {t('settings.input.mobileKeyboardAction.send')}
                  </SelectItem>
                  <SelectItem value="newline">
                    {t('settings.input.mobileKeyboardAction.newline')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </CompactRow>
          </CompactSection>
        ) : null}

        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/60 text-sm">
          <CompactRow
            label={t(
              'settings.general.sessions.queuedMessageBehavior.label',
              'Queued message behavior'
            )}
            helper={t(
              'settings.general.sessions.queuedMessageBehavior.helper',
              'Choose whether messages sent while the agent is working wait in the queue or steer the active response.'
            )}
          >
            <QueuedMessageBehaviorControl
              value={queuedMessageBehavior}
              onChange={setQueuedMessageBehavior}
            />
          </CompactRow>
          <CompactRow
            label={t(
              'settings.general.sessions.codeOnlyLineChanges.label',
              'Show code-only line changes'
            )}
            helper={t(
              'settings.general.sessions.codeOnlyLineChanges.helper',
              'When enabled, session sidebar line counts exclude docs, tests, and dev files.'
            )}
          >
            <Switch
              id="session-sidebar-code-changes-only-toggle"
              checked={sessionSidebarCodeChangesOnly}
              onCheckedChange={setSessionSidebarCodeChangesOnly}
            />
          </CompactRow>

          <CompactRow
            label={
              isElectron
                ? t('settings.notifications.enableToggleDesktop')
                : t('settings.notifications.enableToggle')
            }
            helper={
              <span className="flex flex-col gap-0.5">
                <span>{permissionLabel}</span>
                {disableReason && !isProcessing ? <span>{disableReason}</span> : null}
                {isElectron && permissionStatus !== 'granted' ? <span>{desktopHint}</span> : null}
                {!notificationSupported ? (
                  <span className="text-destructive">
                    {isElectron
                      ? t('settings.notifications.unsupportedDesktop')
                      : t('settings.notifications.unsupported')}
                  </span>
                ) : null}
              </span>
            }
            alignTop
          >
            {isProcessing ? (
              <Loading size="sm" className="h-5 w-9" />
            ) : (
              <Switch
                id="notification-toggle"
                checked={notificationsEnabled}
                disabled={isSwitchDisabled}
                onCheckedChange={(checked) => {
                  void handleToggleNotifications(checked);
                }}
              />
            )}
          </CompactRow>
        </div>
        {isElectron && (
          <CompactSection title={t('settings.general.autoLaunch.title', 'Startup')}>
            <CliDaemonSetting />
            <CompactRow
              label={t('settings.general.autoLaunch.label', 'Launch at startup')}
              helper={t(
                'settings.general.autoLaunch.helper',
                'Automatically run Lody when you sign in'
              )}
            >
              {autoLaunchLoading ? (
                <Loading size="sm" className="h-5 w-9" />
              ) : (
                <Switch
                  id="auto-launch-toggle"
                  checked={autoLaunchEnabled}
                  disabled={autoLaunchSwitchDisabled}
                  onCheckedChange={(checked) => {
                    void handleToggleAutoLaunch(checked);
                  }}
                />
              )}
            </CompactRow>
            <div id="cli-auto-start" className="scroll-mt-24">
              <CompactRow
                label={t('settings.general.cliAutoStart.label', 'Run local agent')}
                helper={t(
                  'settings.general.cliAutoStart.helper',
                  'Lody runs an agent on this computer to work on your local projects. Turn this off to use Lody only as a control panel for agents running on other machines.'
                )}
                alignTop
              >
                {cliAutoStartLoading ? (
                  <Loading size="sm" className="h-5 w-9" />
                ) : (
                  <Switch
                    id="cli-auto-start-toggle"
                    checked={cliAutoStartEnabled}
                    onCheckedChange={(checked) => {
                      void handleToggleCliAutoStart(checked);
                    }}
                  />
                )}
              </CompactRow>
            </div>
            <div id="prevent-sleep" className="scroll-mt-24">
              <CompactRow label={t('settings.general.preventSleep.label', 'Prevent sleep')}>
                <Switch
                  id="prevent-sleep-toggle"
                  checked={preventSleepEnabled}
                  onCheckedChange={(checked) => {
                    void (async () => {
                      setPreventSleepEnabled(checked);
                      const result = await window.api?.setPreventSleepEnabled?.(checked);
                      if (typeof result?.enabled === 'boolean') {
                        setPreventSleepEnabled(result.enabled);
                      }
                    })();
                  }}
                />
              </CompactRow>
            </div>
          </CompactSection>
        )}

        {githubIntegrationAvailable ? <AutoArchiveSection /> : null}

        <ExperimentalFeaturesSection />

        {isElectron && (
          <div id="path-launchers" className="scroll-mt-24">
            <PathLaunchersSettings isElectron={isElectron} platform={electronPlatform} />
          </div>
        )}

        {/* Clear local cache stays last in General settings. */}
        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/60 text-sm">
          <CompactRow
            label={t('settings.cache.clearCache.label')}
            helper={t('settings.cache.clearCache.description')}
          >
            <Button variant="outline" size="sm" onClick={() => clearCache.setDialogOpen(true)}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.cache.clearCache.button')}
            </Button>
          </CompactRow>
        </div>
      </div>
      <ClearCacheConfirmDialog
        open={clearCache.dialogOpen}
        onOpenChange={clearCache.setDialogOpen}
        isClearing={clearCache.isClearing}
        onConfirm={() => void clearCache.confirmClear()}
      />
    </>
  );
}

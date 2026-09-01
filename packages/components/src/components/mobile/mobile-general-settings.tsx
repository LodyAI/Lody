import { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GetNotificationPermissionStatusResult,
  OpenSystemNotificationSettingsResult,
} from '@lody/shared';
import { useAtom, useAtomValue } from 'jotai';
import { Loading } from '@/ui';
import { Switch } from '@/ui/switch';
import { toast } from 'sonner';
import {
  autoArchiveOnPrClosedAtom,
  autoArchiveOnPrMergedAtom,
  electronSessionCompletionNotificationsEnabledAtom,
  iosLiveActivitiesEnabledAtom,
  mobileKeyboardActionAtom,
  queuedMessageBehaviorAtom,
  sessionSidebarCodeChangesOnlyAtom,
  userAtom,
} from '@/atoms';
import {
  MobileSettingsRow,
  MobileSettingsRowGroup,
  MobileSettingsSection,
} from '@/components/mobile/mobile-settings-row';
import {
  MobileInlinePickerCoordinator,
  MobileInlinePickerRowSlot,
  type MobileInlinePickerOption,
} from '@/components/mobile/mobile-inline-picker';
import { MobileSettingsPickerTrigger } from '@/components/mobile/mobile-settings-picker-trigger';
import {
  getOneSignalPermissionState,
  getOneSignalPushSubscriptionOptedIn,
  initOneSignal,
} from '@/lib/onesignal';
import { isNativeAppShell, isNativeIOSAppShell } from '@/lib/native-platform';
import { ClearCacheConfirmDialog, useClearCache } from '@/components/settings/clear-cache';
import { useIsMobile } from '@/hooks/use-mobile';
import { isMobileKeyboardAction } from '@/lib/mobile-keyboard-action';
import { usePostHog } from '@posthog/react';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { QueuedMessageBehaviorControl } from '@/components/settings/queued-message-behavior-control';
import { useAppCapability } from '@/lib/app-platform';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { useElectronAutoLaunch } from '@/hooks/use-electron-auto-launch';

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

export function MobileGeneralSettings() {
  const { t } = useTranslation();
  const githubIntegrationAvailable = useAppCapability('githubIntegration');
  const postHog = usePostHog();
  const user = useAtomValue(userAtom);
  const [electronCompletionNotificationsEnabled, setElectronCompletionNotificationsEnabled] =
    useAtom(electronSessionCompletionNotificationsEnabledAtom);
  const [mobileKeyboardAction, setMobileKeyboardAction] = useAtom(mobileKeyboardActionAtom);
  const [iosLiveActivitiesEnabled, setIosLiveActivitiesEnabled] = useAtom(
    iosLiveActivitiesEnabledAtom
  );
  const [sessionSidebarCodeChangesOnly, setSessionSidebarCodeChangesOnly] = useAtom(
    sessionSidebarCodeChangesOnlyAtom
  );
  const [queuedMessageBehavior, setQueuedMessageBehavior] = useAtom(queuedMessageBehaviorAtom);
  const [autoArchiveOnPrMerged, setAutoArchiveOnPrMerged] = useAtom(autoArchiveOnPrMergedAtom);
  const [autoArchiveOnPrClosed, setAutoArchiveOnPrClosed] = useAtom(autoArchiveOnPrClosedAtom);
  const [preventSleepEnabled, setPreventSleepEnabled] = useState(true);
  const clearCache = useClearCache();
  const isMobile = useIsMobile();
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const autoLaunch = useElectronAutoLaunch(isElectron);
  const isNative = !isElectron && isNativeAppShell();
  const isNativeIOS = !isElectron && isNativeIOSAppShell();
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
  const isSwitchDisabled = isElectron
    ? !notificationSupported || isProcessing
    : !notificationSupported || !oneSignalReady || isProcessing;

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

      const reader = getIpcServices()?.notifications.getPermissionStatus.bind(
        getIpcServices()!.notifications
      );
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
    const services = getIpcServices();
    const getPreventSleepEnabled = services
      ? services.app.getPreventSleepEnabled.bind(services.app)
      : undefined;
    if (!isElectron || typeof window === 'undefined' || !getPreventSleepEnabled) {
      return undefined;
    }

    let active = true;
    void getPreventSleepEnabled().then((result) => {
      if (active && typeof result?.enabled === 'boolean') {
        setPreventSleepEnabled(result.enabled);
      }
    });
    return () => {
      active = false;
    };
  }, [isElectron]);

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

      const opener = getIpcServices()?.notifications.openSystemSettings.bind(
        getIpcServices()!.notifications
      );
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
        // push/permission_prompt_shown (spec §8f.3, P0, tier A).
        capturePostHogEvent(postHog, 'push/permission_prompt_shown', {
          surface: pushSurface,
          source: 'mobile_settings',
        });

        const result = (await oneSignal.Notifications.requestPermission()) ? 'granted' : 'denied';
        setPermissionStatus(result);

        if (result !== 'granted') {
          capturePostHogEvent(postHog, 'push/permission_denied', {
            surface: pushSurface,
            source: 'mobile_settings',
          });
          toast.error(t('settings.notifications.permissionDenied'), {
            description: t('settings.notifications.permissionDeniedDescription'),
          });
          setNotificationsEnabled(false);
          return;
        }

        capturePostHogEvent(postHog, 'push/permission_granted', {
          surface: pushSurface,
          source: 'mobile_settings',
        });

        if (user) {
          await oneSignal.User.PushSubscription.optIn();
          await oneSignal.login(user?.id);
          setNotificationsEnabled(true);
          // push/subscribed + push/token_registered (spec §8f.3, P0).
          capturePostHogEvent(postHog, 'push/subscribed', {
            surface: pushSurface,
            source: 'mobile_settings',
          });
          capturePostHogEvent(postHog, 'push/token_registered', {
            surface: pushSurface,
            source: 'mobile_settings',
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

  const keyboardActionOptions: MobileInlinePickerOption<'send' | 'newline'>[] = [
    {
      value: 'send',
      label: t('settings.input.mobileKeyboardAction.send'),
      searchText: String(t('settings.input.mobileKeyboardAction.send')),
    },
    {
      value: 'newline',
      label: t('settings.input.mobileKeyboardAction.newline'),
      searchText: String(t('settings.input.mobileKeyboardAction.newline')),
    },
  ];
  const selectedKeyboardActionLabel =
    selectedMobileKeyboardAction === 'send'
      ? t('settings.input.mobileKeyboardAction.send')
      : t('settings.input.mobileKeyboardAction.newline');

  return (
    <>
      <MobileInlinePickerCoordinator>
        {/* Notifications surface above the keyboard-action row because
            users come here far more often to fix "I'm not getting
            notifications" than to flip the return-key behavior. */}
        <MobileSettingsSection>
          <MobileSettingsRow
            label={
              isElectron
                ? t('settings.notifications.enableToggleDesktop')
                : t('settings.notifications.enableToggle')
            }
            helper={
              <div className="flex flex-col gap-0.5">
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
              </div>
            }
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
          </MobileSettingsRow>
        </MobileSettingsSection>

        {isNativeIOS ? (
          <MobileSettingsSection title={t('settings.liveActivities.title', 'Dynamic Island')}>
            <MobileSettingsRow
              label={t('settings.liveActivities.enableToggle', 'Enable Dynamic Island')}
              helper={t(
                'settings.liveActivities.description',
                'Show running conversations and permission requests in Live Activities.'
              )}
            >
              <Switch
                id="ios-live-activities-toggle"
                checked={iosLiveActivitiesEnabled}
                onCheckedChange={setIosLiveActivitiesEnabled}
              />
            </MobileSettingsRow>
          </MobileSettingsSection>
        ) : null}

        {showMobileInputSettings ? (
          <MobileSettingsSection title={t('settings.input.title')}>
            <MobileInlinePickerRowSlot>
              <MobileSettingsRow label={t('settings.input.mobileKeyboardAction.label')}>
                <MobileSettingsPickerTrigger
                  id="settings-keyboard-action"
                  ariaLabel={String(t('settings.input.mobileKeyboardAction.label'))}
                  value={selectedMobileKeyboardAction}
                  options={keyboardActionOptions}
                  onChange={(value) => {
                    if (isMobileKeyboardAction(value)) {
                      setMobileKeyboardAction(value);
                    }
                  }}
                  triggerLabel={selectedKeyboardActionLabel}
                />
              </MobileSettingsRow>
            </MobileInlinePickerRowSlot>
          </MobileSettingsSection>
        ) : null}
      </MobileInlinePickerCoordinator>

      {githubIntegrationAvailable ? (
        <MobileSettingsSection title={t('settings.autoArchive.title', 'Auto-archive sessions')}>
          <MobileSettingsRowGroup>
            <MobileSettingsRow
              label={t('settings.autoArchive.onPrMerged', 'When the PR is merged')}
            >
              <Switch checked={autoArchiveOnPrMerged} onCheckedChange={setAutoArchiveOnPrMerged} />
            </MobileSettingsRow>
            <MobileSettingsRow
              label={t('settings.autoArchive.onPrClosed', 'When the PR is closed')}
            >
              <Switch checked={autoArchiveOnPrClosed} onCheckedChange={setAutoArchiveOnPrClosed} />
            </MobileSettingsRow>
          </MobileSettingsRowGroup>
        </MobileSettingsSection>
      ) : null}

      <MobileSettingsSection title={t('settings.general.sessions.title', 'Sessions')}>
        <MobileSettingsRowGroup>
          <MobileSettingsRow
            label={t(
              'settings.general.sessions.queuedMessageBehavior.label',
              'Queued message behavior'
            )}
            helper={t(
              'settings.general.sessions.queuedMessageBehavior.helper',
              'Choose whether messages sent while the agent is working wait in the queue or steer the active response.'
            )}
            stack
          >
            <QueuedMessageBehaviorControl
              value={queuedMessageBehavior}
              onChange={setQueuedMessageBehavior}
              className="w-full"
            />
          </MobileSettingsRow>
          <MobileSettingsRow
            label={t(
              'settings.general.sessions.codeOnlyLineChanges.label',
              'Show code-only line changes'
            )}
          >
            <Switch
              id="session-sidebar-code-changes-only-toggle"
              checked={sessionSidebarCodeChangesOnly}
              onCheckedChange={setSessionSidebarCodeChangesOnly}
            />
          </MobileSettingsRow>
          <MobileSettingsRow
            label={
              <p className="text-[0.95rem] font-medium leading-tight">
                {t('settings.cache.clearCache.label')}
              </p>
            }
            helper={t('settings.cache.clearCache.description')}
            onClick={() => clearCache.setDialogOpen(true)}
          />
        </MobileSettingsRowGroup>
      </MobileSettingsSection>

      {isElectron && (
        <MobileSettingsSection title={t('settings.general.autoLaunch.title', 'Startup')}>
          <MobileSettingsRowGroup>
            <MobileSettingsRow label={t('settings.general.autoLaunch.label', 'Launch at startup')}>
              {autoLaunch.enabledLoading ? (
                <Loading size="sm" className="h-5 w-9" />
              ) : (
                <Switch
                  id="auto-launch-toggle"
                  checked={autoLaunch.enabled}
                  disabled={!autoLaunch.supported || autoLaunch.loading}
                  onCheckedChange={(checked) => {
                    void autoLaunch.updateEnabled(checked);
                  }}
                />
              )}
            </MobileSettingsRow>
            <MobileSettingsRow
              label={t('settings.general.autoLaunch.hideWindowLabel', 'Hide window on auto-launch')}
              helper={t(
                'settings.general.autoLaunch.hideWindowHelper',
                'Keep the main window hidden when Lody starts automatically after sign-in'
              )}
            >
              {autoLaunch.hideWindowLoading ? (
                <Loading size="sm" className="h-5 w-9" />
              ) : (
                <Switch
                  id="auto-launch-hide-window-toggle"
                  checked={autoLaunch.hideWindowOnAutoLaunch}
                  disabled={!autoLaunch.enabled || autoLaunch.loading}
                  onCheckedChange={(checked) => {
                    void autoLaunch.updateHideWindow(checked);
                  }}
                />
              )}
            </MobileSettingsRow>
            <MobileSettingsRow label={t('settings.general.preventSleep.label', 'Prevent sleep')}>
              <Switch
                id="prevent-sleep-toggle"
                checked={preventSleepEnabled}
                onCheckedChange={(checked) => {
                  void (async () => {
                    setPreventSleepEnabled(checked);
                    const result = await getIpcServices()?.app.setPreventSleepEnabled(checked);
                    if (typeof result?.enabled === 'boolean') {
                      setPreventSleepEnabled(result.enabled);
                    }
                  })();
                }}
              />
            </MobileSettingsRow>
          </MobileSettingsRowGroup>
        </MobileSettingsSection>
      )}

      <ClearCacheConfirmDialog
        open={clearCache.dialogOpen}
        onOpenChange={clearCache.setDialogOpen}
        isClearing={clearCache.isClearing}
        onConfirm={() => void clearCache.confirmClear()}
      />
    </>
  );
}

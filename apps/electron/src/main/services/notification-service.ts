import { productWindows } from '../window-state'
import { Notification, shell, systemPreferences, type BrowserWindow } from 'electron'
import type {
  GetNotificationPermissionStatusResult,
  NotificationPermissionState,
  OpenSystemNotificationSettingsResult,
  ShowSessionCompletionNotificationInput,
  ShowSessionCompletionNotificationResult
} from '../types'
import { formatUnknownError } from '../utils'
import { showNativeNotification } from './notification-delivery'

function getNotificationSettingsUrls(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
      'x-apple.systempreferences:com.apple.preference.notifications'
    ]
  }
  if (platform === 'win32') {
    return ['ms-settings:notifications']
  }
  return []
}

function normalizeNotificationAuthorizationStatus(
  authorizationStatus: string | undefined
): NotificationPermissionState {
  if (!authorizationStatus) {
    return 'default'
  }

  const normalized = authorizationStatus.toLowerCase()
  if (normalized === 'authorized' || normalized === 'granted') {
    return 'granted'
  }
  if (normalized === 'denied' || normalized === 'restricted') {
    return 'denied'
  }
  return 'default'
}

function focusWindow(window: BrowserWindow): void {
  if (window.isMinimized()) {
    window.restore()
  }
  if (!window.isVisible()) {
    window.show()
  }
  window.focus()
}

export class NotificationService {
  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  getPermissionStatus(): GetNotificationPermissionStatusResult {
    const supported = Notification.isSupported()
    if (!supported) {
      return { supported: false, permission: 'default', source: 'renderer' }
    }

    const maybeGetter = (
      systemPreferences as unknown as {
        getNotificationSettings?: () => {
          authorizationStatus?: string
        }
      }
    ).getNotificationSettings

    if (typeof maybeGetter === 'function') {
      try {
        const settings = maybeGetter.call(systemPreferences)
        const permission = normalizeNotificationAuthorizationStatus(settings?.authorizationStatus)
        return {
          supported: true,
          permission,
          source: 'system'
        }
      } catch (error) {
        return {
          supported: true,
          permission: 'default',
          source: 'system',
          error: formatUnknownError(error)
        }
      }
    }

    return {
      supported: true,
      permission: 'default',
      source: 'renderer'
    }
  }

  async openSystemSettings(): Promise<OpenSystemNotificationSettingsResult> {
    const platform = process.platform
    const urls = getNotificationSettingsUrls(platform)
    if (urls.length === 0) {
      return {
        opened: false,
        platform,
        error: `Unsupported platform: ${platform}`
      }
    }

    let lastError: string | undefined
    for (const target of urls) {
      try {
        await shell.openExternal(target)
        return { opened: true, platform, target }
      } catch (error) {
        lastError = formatUnknownError(error)
      }
    }

    return {
      opened: false,
      platform,
      error: lastError ?? 'Failed to open system notification settings'
    }
  }

  async showSessionCompletion(
    input: ShowSessionCompletionNotificationInput
  ): Promise<ShowSessionCompletionNotificationResult> {
    if (!Notification.isSupported()) {
      return { shown: false, reason: 'notification_not_supported' }
    }

    if ([...productWindows].some((window) => window.isFocused())) {
      return { shown: false, reason: 'app_foreground' }
    }
    const title = input.title.trim()
    const body = input.body.trim()
    if (!title || !body) {
      return { shown: false, reason: 'title_or_body_empty' }
    }

    const notification = new Notification({
      title,
      body
    })

    notification.on('click', () => {
      const mainWindow = this.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        return
      }

      focusWindow(mainWindow)
      const contents = mainWindow.webContents
      if (!contents || contents.isDestroyed()) {
        return
      }

      contents.send('app.sessionCompletionClick', {
        sessionId: input.sessionId,
        workspaceSlug: input.workspaceSlug
      })
    })

    return await showNativeNotification(notification)
  }
}

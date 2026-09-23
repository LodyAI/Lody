import type { Event, Notification } from 'electron'
import type { ShowSessionCompletionNotificationResult } from '../types.ts'

function formatNotificationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function showNativeNotification(
  notification: Notification,
  activeNotifications: Set<Notification>
): Promise<ShowSessionCompletionNotificationResult> {
  // Electron detaches the native click delegate when the JS wrapper is collected.
  // Delivery success must not end its lifetime while the user can still click it.
  activeNotifications.add(notification)
  const release = (): void => {
    activeNotifications.delete(notification)
    notification.removeListener('click', release)
    notification.removeListener('close', release)
    notification.removeListener('failed', release)
  }
  notification.once('click', release)
  notification.once('close', release)
  notification.once('failed', release)

  return new Promise((resolve) => {
    let settled = false

    const onShow = (): void => settle({ shown: true })
    const onFailed = (_event: Event, error: string): void => {
      settle({ shown: false, reason: error })
    }
    const settle = (result: ShowSessionCompletionNotificationResult): void => {
      if (settled) return
      settled = true
      notification.removeListener('show', onShow)
      notification.removeListener('failed', onFailed)
      resolve(result)
    }

    notification.once('show', onShow)
    notification.once('failed', onFailed)

    try {
      notification.show()
    } catch (error) {
      release()
      settle({ shown: false, reason: formatNotificationError(error) })
    }
  })
}

import type { Event, Notification } from 'electron'
import type { ShowSessionCompletionNotificationResult } from '../types.ts'

function formatNotificationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function showNativeNotification(
  notification: Notification
): Promise<ShowSessionCompletionNotificationResult> {
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
      settle({ shown: false, reason: formatNotificationError(error) })
    }
  })
}

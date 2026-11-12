import { ProductWindowIpcService } from '../product-window-ipc-service'
import { IpcMethod } from 'electron-ipc-decorator'
import type { ShowSessionCompletionNotificationInput } from '@lody/shared/electron-ipc'
import { getIpcServiceDeps } from '../ipc-service-deps'

function isShowSessionCompletionNotificationInput(
  payload: unknown
): payload is ShowSessionCompletionNotificationInput {
  return (
    !!payload &&
    typeof payload === 'object' &&
    typeof (payload as ShowSessionCompletionNotificationInput).sessionId === 'string' &&
    typeof (payload as ShowSessionCompletionNotificationInput).title === 'string' &&
    typeof (payload as ShowSessionCompletionNotificationInput).body === 'string' &&
    ((payload as ShowSessionCompletionNotificationInput).allowWhileForeground === undefined ||
      typeof (payload as ShowSessionCompletionNotificationInput).allowWhileForeground === 'boolean')
  )
}

export class NotificationsIpc extends ProductWindowIpcService {
  static override readonly groupName = 'notifications'

  @IpcMethod()
  async getPermissionStatus() {
    return getIpcServiceDeps().notificationService.getPermissionStatus()
  }

  @IpcMethod()
  async openSystemSettings() {
    return await getIpcServiceDeps().notificationService.openSystemSettings()
  }

  private readonly pairingHints = new Map<string, number>()

  @IpcMethod()
  async showDevicePairingRequest(input: { requestId: string; language: 'en' | 'zh' }) {
    if (
      !input ||
      typeof input.requestId !== 'string' ||
      !/^[0-9a-f]{32}$/.test(input.requestId) ||
      !['en', 'zh'].includes(input.language)
    )
      return { shown: false }
    const now = Date.now()
    for (const [id, expiry] of this.pairingHints) if (expiry <= now) this.pairingHints.delete(id)
    if (this.pairingHints.has(input.requestId) || this.pairingHints.size >= 10)
      return { shown: false }
    this.pairingHints.set(input.requestId, now + 600_000)
    return getIpcServiceDeps().notificationService.showDevicePairingRequest(input.language)
  }

  @IpcMethod()
  async showSessionCompletion(payload: ShowSessionCompletionNotificationInput) {
    if (!isShowSessionCompletionNotificationInput(payload)) {
      return { shown: false, reason: 'invalid_payload' }
    }
    return await getIpcServiceDeps().notificationService.showSessionCompletion(payload)
  }
}

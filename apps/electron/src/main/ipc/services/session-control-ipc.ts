import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import { IPC_PUSH_CHANNELS, type SessionControlSendInput } from '@lody/shared/electron-ipc'
import type { LocalSessionControlRequest } from '@lody/shared/message'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class SessionControlIpc extends IpcService {
  static override readonly groupName = 'sessionControl'

  @IpcMethod()
  async send(payload: SessionControlSendInput) {
    if (!payload || typeof payload !== 'object') {
      return { ok: false as const, error: 'invalid_request' }
    }
    const { requestId, message } = payload
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      return { ok: false as const, error: 'invalid_request' }
    }
    const { event } = getIpcContext()
    return await getIpcServiceDeps().cliService.sendLocalSessionControl(
      message as LocalSessionControlRequest,
      {
        onResponse: (response) => {
          if (event.sender.isDestroyed()) return
          event.sender.send(IPC_PUSH_CHANNELS.sessionControlResponse, {
            requestId,
            response
          })
        }
      }
    )
  }
}

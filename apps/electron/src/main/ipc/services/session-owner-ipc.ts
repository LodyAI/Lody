import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import {
  SessionOwnerRequestSchema,
  type SessionOwnerEvent,
  type SessionOwnerResult
} from '@lody/shared/session-owner-protocol'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { assertProductWindowSender } from '../assert-sender'

export class SessionOwnerIpc extends IpcService {
  static override readonly groupName = 'sessionOwner'

  @IpcMethod()
  config() {
    const { event } = getIpcContext()
    assertProductWindowSender(event)
    return getIpcServiceDeps().sessionOwnerService.configure(event.sender)
  }

  @IpcMethod()
  request(payload: unknown) {
    const { event } = getIpcContext()
    assertProductWindowSender(event)
    return getIpcServiceDeps().sessionOwnerService.request(
      event.sender,
      SessionOwnerRequestSchema.parse(payload)
    )
  }

  @IpcMethod()
  ready() {
    const { event } = getIpcContext()
    if (event.senderFrame !== event.sender.mainFrame)
      throw new Error('Untrusted session owner frame')
    getIpcServiceDeps().sessionOwnerService.markReady(event.sender)
  }

  @IpcMethod()
  reply(requestId: string, result: SessionOwnerResult) {
    const { event } = getIpcContext()
    if (event.senderFrame !== event.sender.mainFrame)
      throw new Error('Untrusted session owner frame')
    getIpcServiceDeps().sessionOwnerService.reply(event.sender, requestId, result)
  }

  @IpcMethod()
  publish(payload: SessionOwnerEvent) {
    const { event } = getIpcContext()
    if (event.senderFrame !== event.sender.mainFrame)
      throw new Error('Untrusted session owner frame')
    getIpcServiceDeps().sessionOwnerService.publish(event.sender, payload)
  }
}

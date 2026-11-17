import { ipcMain, type IpcMainEvent } from 'electron'
import { getIpcContext, IpcService } from 'electron-ipc-decorator'
import { assertProductWindowSender } from './assert-sender'

/** All decorated product IPC methods share the same main-frame admission check. */
export abstract class ProductWindowIpcService extends IpcService {
  protected override registerMethod<TOutput>(
    methodName: string,
    handler: (...args: any[]) => Promise<TOutput> | TOutput
  ) {
    super.registerMethod(methodName, (...args) => {
      assertProductWindowSender(
        getIpcContext().event,
        `${(this.constructor as typeof IpcService).groupName}.${methodName}`
      )
      return handler(...args)
    })
  }
}

/** Send has no rejection promise: discard foreign messages without touching services. */
export function onProductWindowMessage(
  channel: string,
  handler: (event: IpcMainEvent, payload?: unknown) => void
) {
  ipcMain.on(channel, (event, payload: unknown) => {
    try {
      assertProductWindowSender(event)
    } catch {
      return
    }
    handler(event, payload)
  })
}

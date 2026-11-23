import { BrowserWindow, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron'
import { isTrustedProductRendererUrl } from './product-renderer-url'
import { productWindows } from '../window-state'

export function assertProductWindowSender(
  event: IpcMainInvokeEvent | IpcMainEvent,
  channel?: string
): void {
  const mainWindow = BrowserWindow.fromWebContents(event.sender)
  const registered = mainWindow && productWindows.has(mainWindow)
  const hasAllowedUrl = isTrustedProductRendererUrl(event.senderFrame?.url, {
    mainDirectory: __dirname,
    platform: process.platform,
    devRendererUrl: process.env['ELECTRON_RENDERER_URL'],
    channel
  })

  if (
    !registered ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    !hasAllowedUrl
  ) {
    throw new Error('Rejected IPC from an untrusted renderer')
  }
}

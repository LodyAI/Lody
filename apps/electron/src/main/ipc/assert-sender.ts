import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { productWindows } from '../window-state'

export function assertProductWindowSender(event: IpcMainInvokeEvent): void {
  const mainWindow = BrowserWindow.fromWebContents(event.sender)
  const registered = mainWindow && productWindows.has(mainWindow)
  const senderUrl = event.senderFrame?.url
  const devRendererUrl = process.env['ELECTRON_RENDERER_URL']
  let hasAllowedUrl = false
  try {
    const parsedSender = new URL(senderUrl ?? '')
    hasAllowedUrl = devRendererUrl
      ? parsedSender.origin === new URL(devRendererUrl).origin
      : parsedSender.protocol === 'file:' &&
        parsedSender.pathname.endsWith('/out/renderer/index.html')
  } catch {
    hasAllowedUrl = false
  }

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

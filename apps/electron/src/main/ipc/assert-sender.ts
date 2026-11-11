import { BrowserWindow, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productWindows } from '../window-state'

const RECOVERY_CHANNELS = new Set(['app.requestRendererReload', 'app.reportRendererFatalError'])

export function assertProductWindowSender(
  event: IpcMainInvokeEvent | IpcMainEvent,
  channel?: string
): void {
  const mainWindow = BrowserWindow.fromWebContents(event.sender)
  const registered = mainWindow && productWindows.has(mainWindow)
  const senderUrl = event.senderFrame?.url
  const devRendererUrl = process.env['ELECTRON_RENDERER_URL']
  let hasAllowedUrl = false
  try {
    const parsedSender = new URL(senderUrl ?? '')
    const recoveryAllowed = channel !== undefined && RECOVERY_CHANNELS.has(channel)
    if (devRendererUrl) {
      const devUrl = new URL(devRendererUrl)
      const isRecovery = parsedSender.pathname === new URL('recovery.html', devUrl).pathname
      hasAllowedUrl = parsedSender.origin === devUrl.origin && (!isRecovery || recoveryAllowed)
    } else if (parsedSender.protocol === 'file:') {
      const senderPath = fileURLToPath(parsedSender)
      hasAllowedUrl = [
        'index.html',
        'devbar.html',
        ...(recoveryAllowed ? ['recovery.html'] : [])
      ].some((entry) => senderPath === resolve(__dirname, '../renderer', entry))
    }
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

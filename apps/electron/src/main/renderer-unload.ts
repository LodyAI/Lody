import { dialog, type BrowserWindow } from 'electron'
import { translateAppText as t } from './menu'
import { getMainWindow, productWindows, setAppQuitting } from './window-state'

/** Windows closing for app quit; a Stay answer settles the request as kept. */
const quitCloses = new Map<BrowserWindow, (closed: boolean) => void>()

/**
 * Electron cancels an unload silently when a renderer `beforeunload` listener
 * vetoes it. Surface every veto of a product document (close, reload, quit)
 * through one native Stay/Leave confirmation; Leave ignores the veto.
 */
export function installRendererUnloadConfirmation(window: BrowserWindow): void {
  window.webContents.on('will-prevent-unload', (event) => {
    const quitClose = quitCloses.get(window)
    // A hidden or minimized parent would hide the sheet; show what is being kept.
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
    const response = dialog.showMessageBoxSync(window, {
      type: 'warning',
      message: t('desktop.unloadConfirm.title'),
      detail: t('desktop.unloadConfirm.detail'),
      buttons: [
        t('desktop.unloadConfirm.stay'),
        t(quitClose ? 'desktop.unloadConfirm.quit' : 'desktop.unloadConfirm.leave')
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response === 1) {
      event.preventDefault()
      return
    }
    quitClose?.(false)
  })
}

/**
 * Quit preparation: close product windows one at a time so every document runs
 * `beforeunload` before main stops relays or the CLI. The first Stay cancels
 * quit and leaves the app running; windows closed before it stay closed, as in
 * Electron's own quit. The main window closes last.
 */
export async function closeProductWindowsForQuit(): Promise<boolean> {
  const main = getMainWindow()
  const windows = [...productWindows].sort(
    (left, right) => Number(left === main) - Number(right === main)
  )
  // Hide-on-close handlers must let quit closes through.
  setAppQuitting(true)
  for (const window of windows) {
    if (window.isDestroyed()) continue
    // A destroyed BrowserWindow throws on `webContents`; read it while it is live.
    const contents = window.webContents
    const closed = await new Promise<boolean>((resolve) => {
      const onClosed = (): void => settle(true)
      // A hung or dead renderer never answers `beforeunload`; without this the
      // quit would wait forever. Its in-memory sends are lost either way.
      const onStuck = (): void => {
        if (!window.isDestroyed()) window.destroy()
      }
      const settle = (value: boolean): void => {
        quitCloses.delete(window)
        window.removeListener('closed', onClosed)
        window.removeListener('unresponsive', onStuck)
        contents.removeListener('render-process-gone', onStuck)
        resolve(value)
      }
      window.once('closed', onClosed)
      window.once('unresponsive', onStuck)
      contents.once('render-process-gone', onStuck)
      quitCloses.set(window, settle)
      window.close()
    })
    if (!closed) {
      setAppQuitting(false)
      return false
    }
  }
  return true
}

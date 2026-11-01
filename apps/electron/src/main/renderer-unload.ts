import { dialog, type BrowserWindow } from 'electron'
import { translateAppText as t } from './menu'
import { getMainWindow, productWindows, setAppQuitting } from './window-state'

/** Windows closing for app quit; a Stay answer settles the request as kept. */
type QuitClose = {
  settle: (closed: boolean) => void
  approved: boolean
  confirmation?: AbortController
}
const quitCloses = new Map<BrowserWindow, QuitClose>()

/**
 * Electron cancels an unload silently when a renderer `beforeunload` listener
 * vetoes it. Surface every veto of a product document (close, reload, quit)
 * through one native Stay/Leave confirmation; Leave ignores the veto.
 */
export function installRendererUnloadConfirmation(window: BrowserWindow): void {
  window.webContents.on('will-prevent-unload', (event) => {
    const quitClose = quitCloses.get(window)
    if (quitClose?.approved) {
      quitClose.approved = false
      event.preventDefault()
      return
    }
    if (quitClose?.confirmation) return
    if (quitClose) console.info('[Electron] Quit renderer unload veto', { windowId: window.id })
    // A hidden or minimized parent would hide the sheet; show what is being kept.
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
    const options = {
      type: 'warning' as const,
      message: t('desktop.unloadConfirm.title'),
      detail: t('desktop.unloadConfirm.detail'),
      buttons: [
        t('desktop.unloadConfirm.stay'),
        t(quitClose ? 'desktop.unloadConfirm.quit' : 'desktop.unloadConfirm.leave')
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }
    if (quitClose) {
      const controller = new AbortController()
      quitClose.confirmation = controller
      const windowId = window.id
      // Keep the original veto. Only a fresh close after Leave may consume the
      // approval. A synchronous dialog here freezes the quit deadline on macOS.
      void Promise.resolve()
        .then(() => {
          if (quitCloses.get(window) !== quitClose) return undefined
          console.info('[Electron] Quit renderer confirmation opening', { windowId })
          const response = dialog.showMessageBox(window, { ...options, signal: controller.signal })
          console.info('[Electron] Quit renderer confirmation opened', { windowId })
          return response
        })
        .then((result) => {
          if (!result || quitCloses.get(window) !== quitClose || window.isDestroyed()) return
          console.info('[Electron] Quit renderer confirmation answered', {
            windowId,
            leave: result.response === 1
          })
          if (result.response !== 1) {
            quitClose.settle(false)
            return
          }
          quitClose.approved = true
          window.close()
        })
        .catch(() => {
          if (quitCloses.get(window) !== quitClose) return
          console.warn('[Electron] Quit renderer confirmation failed', { windowId })
          quitClose.settle(false)
        })
      return
    }
    const response = dialog.showMessageBoxSync(window, options)
    if (response === 1) {
      event.preventDefault()
      return
    }
  })
}

/**
 * Quit preparation: close product windows one at a time so every document runs
 * `beforeunload` before main stops relays or the CLI. The first Stay cancels
 * quit and leaves the app running; windows closed before it stay closed, as in
 * Electron's own quit. The main window closes last.
 */
export async function closeProductWindowsForQuit(
  reportUnconfirmed: () => void = () => {}
): Promise<boolean> {
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
    const windowId = window.id
    console.info('[Electron] Quit renderer closing', { windowId })
    const closed = await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onClosed = (): void => settle(true)
      // A hung or dead renderer never answers `beforeunload`; without this the
      // quit would wait forever. Its in-memory sends are lost either way.
      const onStuck = (): void => {
        if (quitCloses.get(window) !== entry) return
        const destroyed = window.isDestroyed()
        console.warn('[Electron] Quit renderer persistence unconfirmed', { windowId, destroyed })
        reportUnconfirmed()
        if (!destroyed) window.destroy()
        // A missing closed event must not make the armed deadline a silent no-op.
        settle(true)
      }
      const settle = (value: boolean): void => {
        if (quitCloses.get(window) !== entry) return
        clearTimeout(timer)
        quitCloses.delete(window)
        window.removeListener('closed', onClosed)
        window.removeListener('unresponsive', onStuck)
        contents.removeListener('render-process-gone', onStuck)
        contents.removeListener('did-start-navigation', onNavigation)
        entry.confirmation?.abort()
        resolve(value)
      }
      const entry: QuitClose = { settle, approved: false }
      const onNavigation = (
        _event: unknown,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean
      ): void => {
        if (isMainFrame && !isInPlace) settle(false)
      }
      window.once('closed', onClosed)
      window.once('unresponsive', onStuck)
      contents.once('render-process-gone', onStuck)
      contents.on('did-start-navigation', onNavigation)
      quitCloses.set(window, entry)
      // Electron does not guarantee an unresponsive event for a pending close.
      timer = setTimeout(onStuck, 15_000)
      console.info('[Electron] Quit renderer deadline armed', { windowId })
      console.info('[Electron] Quit renderer close requested', { windowId })
      window.close()
      console.info('[Electron] Quit renderer close returned', { windowId })
    })
    console.info('[Electron] Quit renderer settled', { windowId, closed })
    if (!closed) {
      setAppQuitting(false)
      return false
    }
  }
  return true
}

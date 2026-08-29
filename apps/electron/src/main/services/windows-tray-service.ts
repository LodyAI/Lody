import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { formatUnknownError } from '../utils'

type WindowsTrayServiceOptions = {
  iconPath: string
  productName: string
  openOrFocusMainWindow: () => BrowserWindow
}

export class WindowsTrayService {
  private tray: Tray | null = null

  constructor(private readonly options: WindowsTrayServiceOptions) {}

  start(): boolean {
    if (process.platform !== 'win32') {
      return false
    }

    if (this.tray) {
      return true
    }

    try {
      const trayIcon = nativeImage.createFromPath(this.options.iconPath)
      this.tray = trayIcon.isEmpty() ? new Tray(this.options.iconPath) : new Tray(trayIcon)
    } catch (error) {
      console.warn(`[Tray] Failed to create tray icon: ${formatUnknownError(error)}`)
      return false
    }

    const contextMenu = Menu.buildFromTemplate([
      {
        label: `Open ${this.options.productName}`,
        click: () => {
          this.options.openOrFocusMainWindow()
        }
      },
      {
        label: 'Open DevTools',
        click: () => {
          this.openDevTools()
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit()
        }
      }
    ])

    this.tray.setToolTip(this.options.productName)
    this.tray.setContextMenu(contextMenu)
    // Left click opens the app directly; the context menu stays on right click.
    this.tray.on('click', () => {
      this.options.openOrFocusMainWindow()
    })

    return true
  }

  stop(): void {
    if (!this.tray) {
      return
    }
    this.tray.destroy()
    this.tray = null
  }

  private openDevTools(): void {
    try {
      const window = this.options.openOrFocusMainWindow()
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        console.warn('[Tray] Open DevTools ignored because the main window is destroyed')
        return
      }

      if (!window.webContents.isDevToolsOpened()) {
        console.info('[Tray] Opening DevTools for main window')
        window.webContents.openDevTools({ mode: 'detach', activate: true })
      } else {
        console.info('[Tray] Focusing existing DevTools for main window')
      }

      setTimeout(() => {
        if (window.isDestroyed() || window.webContents.isDestroyed()) {
          return
        }
        window.webContents.devToolsWebContents?.focus()
      }, 0)
    } catch (error) {
      console.warn(`[Tray] Failed to open DevTools: ${formatUnknownError(error)}`)
    }
  }
}

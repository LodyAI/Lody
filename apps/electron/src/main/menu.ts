import { app, BrowserWindow, Menu, shell } from 'electron'
import { closeFocusedTabOrWindow } from './close-focused-tab-or-window'
import type { AppUpdaterService } from './services/app-updater-service'
import en from '../../../../locales/en.json'
import zhCN from '../../../../locales/zh_CN.json'

type SupportedLocale = 'en' | 'zh_CN'

const localeResources: Record<SupportedLocale, Record<string, string>> = {
  en: en as Record<string, string>,
  zh_CN: zhCN as Record<string, string>
}

function t(locale: SupportedLocale, key: string, vars?: Record<string, string>): string {
  const resources = localeResources[locale] ?? localeResources.en
  let value = resources[key] ?? localeResources.en[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replace(`{{${k}}}`, v)
    }
  }
  return value
}

type SetupApplicationMenuOptions = {
  appUpdaterService: AppUpdaterService
  getMainWindow: () => BrowserWindow | null
  openOrFocusMainWindow: () => BrowserWindow
}

let currentLocale: SupportedLocale = 'en'
let menuOptions: SetupApplicationMenuOptions | null = null

function sendMenuAction(action: string): void {
  if (!menuOptions) {
    return
  }
  let window = menuOptions.getMainWindow()
  if (!window || window.isDestroyed()) {
    window = menuOptions.openOrFocusMainWindow()
  }
  const contents = window.webContents
  if (contents.isDestroyed()) {
    return
  }
  if (contents.isLoading()) {
    contents.once('did-finish-load', () => {
      if (!contents.isDestroyed()) {
        contents.send('app.menuAction', action)
      }
    })
    return
  }
  contents.send('app.menuAction', action)
}

function handleCloseFocusedTabOrWindow(targetWindow?: Electron.BaseWindow): void {
  const focused =
    targetWindow && 'webContents' in targetWindow
      ? (targetWindow as BrowserWindow)
      : BrowserWindow.getFocusedWindow()
  closeFocusedTabOrWindow({
    focused,
    mainWindow: menuOptions?.getMainWindow() ?? null,
    sendCloseCurrentTabOrWindow: () => sendMenuAction('close-current-tab-or-window')
  })
}

function buildAndSetMenu(): void {
  if (!menuOptions) {
    return
  }
  const { appUpdaterService } = menuOptions
  const locale = currentLocale
  const isMac = process.platform === 'darwin'
  const appName = app.name

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (Lody) — macOS only
    ...(isMac
      ? [
          {
            label: appName,
            submenu: [
              {
                label: t(locale, 'menu.about', { appName }),
                click: () => sendMenuAction('about')
              },
              { type: 'separator' as const },
              {
                label: t(locale, 'menu.settings'),
                accelerator: 'CmdOrCtrl+,' as const,
                // Show ⌘, in the menu but don't register the accelerator — the renderer's
                // command registry owns the binding (so it shows + is rebindable in the
                // keyboard-shortcuts settings page). Clicking the item still works.
                registerAccelerator: false,
                click: () => sendMenuAction('settings')
              },
              {
                label: t(locale, 'menu.checkForUpdates'),
                click: () => {
                  void appUpdaterService.checkForUpdates()
                  sendMenuAction('check-updates')
                }
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ] as Electron.MenuItemConstructorOptions[]
          }
        ]
      : []),

    // File menu
    {
      label: t(locale, 'menu.file'),
      submenu: [
        {
          label: t(locale, 'menu.openProject'),
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('import-project')
        },
        {
          label: t(locale, 'menu.newSession'),
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new-session')
        },
        {
          label: t(locale, 'menu.close'),
          accelerator: 'CmdOrCtrl+W',
          click: (_item, targetWindow) => handleCloseFocusedTabOrWindow(targetWindow)
        },
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: t(locale, 'menu.settings'),
                accelerator: 'CmdOrCtrl+,' as const,
                // See the macOS Settings item above — display ⌘, but let the renderer
                // command registry own the binding.
                registerAccelerator: false,
                click: () => sendMenuAction('settings')
              },
              {
                label: t(locale, 'menu.checkForUpdates'),
                click: () => {
                  void appUpdaterService.checkForUpdates()
                  sendMenuAction('check-updates')
                }
              },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ])
      ] as Electron.MenuItemConstructorOptions[]
    },

    // Edit menu
    {
      label: t(locale, 'menu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              {
                label: 'Speech',
                submenu: [{ role: 'startSpeaking' as const }, { role: 'stopSpeaking' as const }]
              }
            ]
          : [])
      ] as Electron.MenuItemConstructorOptions[]
    },

    // View menu
    {
      label: t(locale, 'menu.view'),
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },

    // Window menu
    {
      label: t(locale, 'menu.window'),
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const }
            ]
          : [
              {
                label: t(locale, 'menu.closeWindow'),
                click: () => menuOptions?.getMainWindow()?.close()
              }
            ])
      ] as Electron.MenuItemConstructorOptions[]
    },

    // Help menu
    {
      label: t(locale, 'menu.help'),
      role: 'help' as const,
      submenu: [
        {
          label: t(locale, 'menu.documentation'),
          click: () => {
            void shell.openExternal('https://lody.ai/docs')
          }
        },
        {
          label: t(locale, 'menu.feedback'),
          click: () => {
            void shell.openExternal('https://feedback.lody.ai')
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

export function setupApplicationMenu(options: SetupApplicationMenuOptions): void {
  menuOptions = options
  buildAndSetMenu()
}

export function setMenuLanguage(locale: string): void {
  if (locale === 'en' || locale === 'zh_CN') {
    currentLocale = locale
  } else {
    currentLocale = 'en'
  }
  buildAndSetMenu()
}

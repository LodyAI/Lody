import { app, BrowserWindow, safeStorage } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import dns from 'node:dns'
import { writeHeapSnapshot } from 'node:v8'
import icon from '../../resources/icon.png?asset'
import macIcon from '../../build/icon-mac.padded.png?asset'
import { acquireSingleInstanceLock, registerOpenUrlHandler } from './deep-link'
import { registerLodyProtocolClient } from './protocol-client'
import { registerIpcServices } from './ipc/register-services'
import { openMainWindow, openOrFocusMainWindow, setMainWindowProductReloadTarget } from './window'
import { getMainWindow, setAppQuitting, setWindowsTrayAvailable } from './window-state'
import { CliService } from './services/cli-service'
import { TerminalRelay } from './services/terminal-relay'
import { LoroDataPlaneRelay } from './services/loro-data-plane-relay'
import { NotificationService } from './services/notification-service'
import { AuthService } from './services/auth-service'
import { authClient } from './auth'
import { AppUpdaterService } from './services/app-updater-service'
import { shouldConstructUpdaterEnabled } from './services/app-updater-sparkle-policy'
import { GlobalShortcutsService } from './services/global-shortcuts-service'
import { WindowsTrayService } from './services/windows-tray-service'
import {
  WindowBadgeService,
  bindWindowBadgeToBrowserWindows
} from './services/window-badge-service'
import { setupApplicationMenu } from './menu'
import { isRendererReloadShortcut } from './reload-shortcut'
import {
  flushElectronMainErrorReporting,
  installElectronMainErrorReporting
} from './posthog-error-reporting'
import { IPC_PUSH_CHANNELS } from '@lody/shared/electron-ipc'
import { PublicBrowserService } from './services/public-browser-service'
import { desktopInstallationProfile, isLocalPlatform } from './platform'
import { mainPlatformKind } from './platform'
import { getLocalLoroDataPlaneSocketPath } from '@lody/shared/node/local-ipc'
import { getLocalTerminalSocketPath } from '@lody/shared/node/local-terminal'
import { getInitialDesktopPath, markOnboardingCompleted } from './onboarding-state'
import { extractDeepLinkFromArgv } from './deep-link-url'
import { shouldHideMainWindowOnAutoLaunch } from './auto-launch-policy'
import {
  getAutoLaunchInvocationStatus,
  getHideWindowOnAutoLaunchEnabled
} from './auto-launch-settings'

// On Linux, Electron/Chromium auto-detects the keyring backend for GNOME and KDE
// desktops, but falls back to basic-text (unencrypted) on other desktops like
// Sway, Hyprland, Niri, etc. — even when gnome-keyring-daemon is running and the
// org.freedesktop.secrets D-Bus service is available.
// Default to gnome-libsecret only when no --password-store flag was explicitly
// provided AND the desktop is not one Chromium already handles.
// Chromium auto-selects gnome-libsecret for: GNOME, Unity, Cinnamon, XFCE,
// Pantheon, Deepin, UKUI; and kwallet for KDE.
if (
  process.platform === 'linux' &&
  !process.argv.some((arg) => arg.startsWith('--password-store'))
) {
  const desktop = (process.env.XDG_CURRENT_DESKTOP ?? '').toUpperCase()
  const chromiumHandled = [
    'GNOME',
    'KDE',
    'UNITY',
    'CINNAMON',
    'XFCE',
    'PANTHEON',
    'DEEPIN',
    'UKUI'
  ]
  const isAutoDetected = chromiumHandled.some((d) => desktop.includes(d))
  if (!isAutoDetected) {
    app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
  }
}

const LODY_PROTOCOL = desktopInstallationProfile.desktopProtocol
const PRODUCT_NAME = desktopInstallationProfile.desktopProductName
const DESKTOP_FILE_NAME = `${desktopInstallationProfile.desktopAppId}.desktop`
const DEEP_LINK_DEBUG_PREFIX = '[electron-auth-debug]'
const IS_E2E = !app.isPackaged && process.env.LODY_E2E === '1'

type E2EBootDiagnostic = { stage: string; error?: string }
type E2EGlobal = typeof globalThis & {
  __LODY_E2E_BOOT_DIAGNOSTIC__?: E2EBootDiagnostic
  __LODY_E2E_WRITE_HEAP_SNAPSHOT__?: (path: string) => string
}

if (IS_E2E) {
  ;(globalThis as E2EGlobal).__LODY_E2E_WRITE_HEAP_SNAPSHOT__ = (path) => writeHeapSnapshot(path)
}

function recordE2EBootDiagnostic(stage: string, error?: unknown): void {
  if (!IS_E2E) return
  const diagnostic: E2EBootDiagnostic = { stage }
  if (error !== undefined) {
    diagnostic.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  }
  const e2eGlobal = globalThis as E2EGlobal
  e2eGlobal.__LODY_E2E_BOOT_DIAGNOSTIC__ = diagnostic
}

function logDeepLinkDebug(message: string, meta?: Record<string, unknown>): void {
  if (meta) {
    console.info(DEEP_LINK_DEBUG_PREFIX, message, meta)
    return
  }
  console.info(DEEP_LINK_DEBUG_PREFIX, message)
}

app.setName(PRODUCT_NAME)
if (process.platform === 'linux') {
  // KDE resolves task-manager icons through the desktop file whose basename
  // matches the Wayland app_id / X11 WM_CLASS. Keep this dynamic because the
  // cloud and local desktop compositions intentionally use different IDs.
  // Electron 39 implements this API, but its bundled declaration omits it.
  const linuxApp = app as typeof app & { setDesktopName(name: string): void }
  linuxApp.setDesktopName(DESKTOP_FILE_NAME)
}
if (!isLocalPlatform()) {
  installElectronMainErrorReporting()
}

try {
  dns.setDefaultResultOrder('ipv4first')
} catch (error) {
  console.warn('[Auth] Failed to set DNS result order to ipv4first', error)
}

if (!isLocalPlatform()) {
  authClient.setupMain({
    csp: false,
    bridges: true,
    scheme: false,
    // Pin the target to the main window so Better Auth events always reach the
    // visible renderer that owns login state and CLI restart.
    getWindow: () => getMainWindow()
  })
  logDeepLinkDebug('authClient.setupMain initialized', {
    csp: false,
    bridges: true,
    scheme: false
  })
}

function createGlobalShortcutsService(iconPath: string): GlobalShortcutsService {
  return new GlobalShortcutsService(
    [
      {
        id: 'app.focus',
        handler: () => {
          openOrFocusMainWindow({ icon: iconPath })
        }
      }
    ],
    {
      onTriggered: (payload) => {
        const target =
          getMainWindow() ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
        target?.webContents.send(IPC_PUSH_CHANNELS.appGlobalShortcut, payload)
      }
    }
  )
}

registerLodyProtocolClient({
  protocol: LODY_PROTOCOL,
  productName: PRODUCT_NAME,
  desktopFileName: DESKTOP_FILE_NAME,
  iconPath: icon,
  log: logDeepLinkDebug
})

const hasSingleInstanceLock = acquireSingleInstanceLock()
logDeepLinkDebug('single instance lock status evaluated', { hasSingleInstanceLock })
if (hasSingleInstanceLock) {
  registerOpenUrlHandler()
}

if (hasSingleInstanceLock) {
  recordE2EBootDiagnostic('waiting-for-app-ready')
  const appReady = app.whenReady().then(() => {
    recordE2EBootDiagnostic('initializing-services')
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(macIcon)

    logDeepLinkDebug('app.whenReady resolved', {
      isDefaultProtocolClient: app.isDefaultProtocolClient(LODY_PROTOCOL),
      protocol: LODY_PROTOCOL
    })
    const authService = new AuthService()
    const cliService = new CliService({
      resolveBootstrapSession: async () => {
        return await authService.getBootstrapSession()
      }
    })
    const terminalRelay = new TerminalRelay(getLocalTerminalSocketPath(mainPlatformKind))
    const loroDataPlaneRelay = new LoroDataPlaneRelay(
      getLocalLoroDataPlaneSocketPath(mainPlatformKind)
    )
    loroDataPlaneRelay.setEnabled(cliService.getCliAutoStartEnabled())

    const appUpdaterService = new AppUpdaterService({
      enabled: shouldConstructUpdaterEnabled({
        localPlatform: isLocalPlatform(),
        forceEnable: process.env.LODY_ELECTRON_ENABLE_UPDATER === '1'
      })
    })
    const notificationService = new NotificationService(() => getMainWindow())
    const windowsTrayService = new WindowsTrayService({
      iconPath: icon,
      productName: PRODUCT_NAME,
      openOrFocusMainWindow: () => openOrFocusMainWindow({ icon })
    })
    const windowBadgeService = new WindowBadgeService()
    const publicBrowserService = new PublicBrowserService(() => getMainWindow())
    bindWindowBadgeToBrowserWindows(windowBadgeService)

    if (!isLocalPlatform() && !safeStorage.isEncryptionAvailable()) {
      const isLinux = process.platform === 'linux'
      const hint = isLinux
        ? 'gnome-libsecret was already configured automatically. ' +
          'Ensure gnome-keyring-daemon is running, or try launching with ' +
          '--password-store=kwallet5 or --password-store=basic'
        : 'Check that your OS keychain is configured and accessible.'
      console.warn(
        `[Auth] safeStorage encryption is not available. Authentication may fail. ${hint}`
      )
    }

    electronApp.setAppUserModelId(desktopInstallationProfile.desktopAppId)
    const globalShortcutsService = createGlobalShortcutsService(icon)
    globalShortcutsService.registerAll()
    app.once('will-quit', () => globalShortcutsService.dispose())
    app.on('browser-window-created', (_, window) => {
      // Keep Electron's native Cmd/Ctrl zoom shortcuts available. The toolkit
      // blocks Minus and shifted Equal by default when zoom is not enabled.
      optimizer.watchWindowShortcuts(window, { zoom: true })
      // electron-toolkit deliberately blocks the production reload shortcut.
      // Restore the normal desktop-app behavior requested by the user while
      // leaving Cmd/Ctrl+Shift+R and DevTools handling unchanged.
      window.webContents.on('before-input-event', (event, input) => {
        if (isRendererReloadShortcut(input, process.platform)) {
          event.preventDefault()
          window.webContents.reload()
        }
      })
    })

    const completeOnboarding = (window: BrowserWindow) => {
      markOnboardingCompleted()
      setMainWindowProductReloadTarget(window)
    }
    registerIpcServices({
      cliService,
      appUpdaterService,
      authService,
      notificationService,
      terminalRelay,
      publicBrowserService,
      loroDataPlaneRelay,
      windowBadgeService,
      globalShortcutsService,
      getMainWindow,
      completeOnboarding
    })

    setupApplicationMenu({
      appUpdaterService,
      getMainWindow,
      openOrFocusMainWindow: () => openOrFocusMainWindow({ icon })
    })
    const initialPath = getInitialDesktopPath()
    const loginItemSettings = getAutoLaunchInvocationStatus()
    const hideWindowOnAutoLaunch = shouldHideMainWindowOnAutoLaunch({
      preferenceEnabled: getHideWindowOnAutoLaunchEnabled(),
      launchedAtLogin: loginItemSettings.launchedAtLogin,
      initialPath,
      hasInitialDeepLink: Boolean(extractDeepLinkFromArgv(process.argv))
    })
    recordE2EBootDiagnostic('opening-main-window')
    openMainWindow({ icon, initialPath, hideWindowOnAutoLaunch })
    recordE2EBootDiagnostic('main-window-opened')
    console.info('[Electron] Initial desktop surface selected', {
      initialPath,
      hideWindowOnAutoLaunch
    })
    setWindowsTrayAvailable(windowsTrayService.start())
    cliService.autoStart(getMainWindow()?.webContents ?? undefined)
    appUpdaterService.start()

    app.on('activate', () => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length === 0) {
        openMainWindow({ icon })
        return
      }
      openOrFocusMainWindow({ icon })
    })

    let cliShutdownComplete = false
    app.on('before-quit', (event) => {
      setAppQuitting(true)
      setWindowsTrayAvailable(false)
      windowsTrayService.stop()
      windowBadgeService.reset()
      terminalRelay.destroy()
      loroDataPlaneRelay.destroy()
      appUpdaterService.stop()
      publicBrowserService.destroyAll()

      if (cliShutdownComplete) {
        // Cleanup already ran on the first pass; let this quit proceed.
        cliService.killAllProcesses()
        return
      }

      // Defer the quit until the embedded CLI has actually exited. Killing it
      // fire-and-forget would let the app exit while the CLI is still shutting
      // down, orphaning it holding the local ports + terminal socket and breaking
      // the next launch. shutdownForQuit() SIGTERMs, waits briefly, then SIGKILLs.
      event.preventDefault()
      void Promise.allSettled([
        cliService.shutdownForQuit(),
        flushElectronMainErrorReporting()
      ]).finally(() => {
        cliShutdownComplete = true
        app.quit()
      })
    })

    process.on('exit', () => {
      setWindowsTrayAvailable(false)
      windowsTrayService.stop()
      terminalRelay.destroy()
      loroDataPlaneRelay.destroy()
      cliService.killAllProcesses()
      appUpdaterService.stop()
      publicBrowserService.destroyAll()
    })
  })
  void appReady.catch((error: unknown) => {
    recordE2EBootDiagnostic('failed', error)
    console.error('[Electron] Fatal error while creating the main window', error)
    if (!IS_E2E) app.exit(1)
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

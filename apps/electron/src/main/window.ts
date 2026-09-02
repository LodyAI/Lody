import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  consumePendingDeepLink,
  getMainWindow,
  isAppQuitting,
  isWindowsTrayAvailable,
  setMainWindow
} from './window-state'
import {
  getMainWindowConstructorOptions,
  shouldMaximizeMainWindowOnLaunch,
  trackMainWindowState
} from './window-persistence'
import {
  getInitialMainWindowThemeSource,
  getMainWindowBackgroundColor,
  getMainWindowTitleBarOverlay,
  resolveNativeWindowTheme
} from './window-theme'
import { readStartupThemeSource } from './theme-settings'
import { formatUnknownError, normalizeExternalHttpUrl } from './utils'
import { describeDeepLinkForAuthDebug } from './auth-debug'
import { serializePreferredSystemLanguagesArgument } from '../system-language-argument'
import { serializeInitialWindowThemeArgument } from '../initial-window-theme-argument'
import {
  clearMountWatchdog,
  clearUnresponsiveWatchdog,
  disposeWatchdogState,
  isInRecovery,
  loadRecoveryPage,
  persistRendererFatalError,
  requestRendererReload,
  setReloadTarget,
  startMountWatchdog,
  startUnresponsiveWatchdog,
  type ReloadTarget,
  type RecoveryContext
} from './renderer-recovery'

type CreateMainWindowOptions = {
  icon: string
  initialPath?: '/' | '/onboarding'
  hideWindowOnAutoLaunch?: boolean
  onDidFinishLoad?: () => void
}

const DEEP_LINK_DEBUG_PREFIX = '[electron-auth-debug]'

// How long to wait after did-finish-load for the renderer to call
// notifyRendererMounted. Boot work like authClient bootstrap, IndexedDB warm
// up, and Loro Streams catch-up can take a few seconds even on fast machines;
// we'd rather err on the long side than spuriously open DevTools.
const MOUNT_WATCHDOG_TIMEOUT_MS = 20_000

// How long Electron's `unresponsive` must persist before we surface a dialog.
// `unresponsive` fires when the renderer event loop blocks for a few seconds;
// most of those resolve on their own (GC, jank, sync layout). Only show the
// dialog after a longer outage so we don't pester the user.
const UNRESPONSIVE_DIALOG_DELAY_MS = 10_000
const pendingInitialMaximize = new WeakSet<BrowserWindow>()

function logDeepLinkDebug(message: string, meta?: Record<string, unknown>): void {
  if (meta) {
    console.info(DEEP_LINK_DEBUG_PREFIX, message, meta)
    return
  }
  console.info(DEEP_LINK_DEBUG_PREFIX, message)
}

function readConsoleMessageDetails(args: unknown[]): Record<string, unknown> | null {
  const firstArg = args[0]
  if (firstArg && typeof firstArg === 'object' && 'message' in firstArg) {
    const details = firstArg as Record<string, unknown>
    return {
      level: details.level,
      message: details.message,
      lineNumber: details.lineNumber,
      sourceId: details.sourceId
    }
  }

  const [level, message, lineNumber, sourceId] = args
  if (typeof message !== 'string') {
    return null
  }

  return { level, message, lineNumber, sourceId }
}

function shouldLogConsoleMessage(details: Record<string, unknown>): boolean {
  const level = details.level
  if (typeof level === 'number') {
    return level >= 2
  }
  if (typeof level === 'string') {
    return level === 'warn' || level === 'warning' || level === 'error'
  }
  return true
}

type LoadFailureDetails = {
  errorCode?: unknown
  errorDescription?: unknown
  validatedURL?: unknown
  isMainFrame?: unknown
}

function readLoadFailureDetails(args: unknown[]): LoadFailureDetails {
  const firstArg = args[0]
  if (firstArg && typeof firstArg === 'object' && 'errorCode' in firstArg) {
    const details = firstArg as Record<string, unknown>
    return {
      errorCode: details.errorCode,
      errorDescription: details.errorDescription,
      validatedURL: details.validatedURL,
      isMainFrame: details.isMainFrame
    }
  }

  const [errorCode, errorDescription, validatedURL, isMainFrame] = args
  return { errorCode, errorDescription, validatedURL, isMainFrame }
}

function formatLoadFailure(details: LoadFailureDetails): string {
  return [
    `errorCode: ${String(details.errorCode)}`,
    `errorDescription: ${String(details.errorDescription)}`,
    `validatedURL: ${String(details.validatedURL)}`,
    `isMainFrame: ${String(details.isMainFrame)}`
  ].join('\n')
}

function resolveMainRendererTarget(initialPath: '/' | '/onboarding' = '/'): ReloadTarget {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return {
      type: 'url',
      url: new URL(initialPath, process.env['ELECTRON_RENDERER_URL']).toString()
    }
  }
  return {
    type: 'file',
    filePath: join(__dirname, '../renderer/index.html'),
    ...(initialPath === '/' ? {} : { hash: initialPath })
  }
}

function resolveRecoveryTarget(): ReloadTarget {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return {
      type: 'url',
      url: new URL('recovery.html', process.env['ELECTRON_RENDERER_URL']).toString()
    }
  }
  return { type: 'file', filePath: join(__dirname, '../renderer/recovery.html') }
}

function loadRendererTarget(window: BrowserWindow, target: ReloadTarget): Promise<void> {
  if (target.type === 'url') {
    return window.loadURL(target.url)
  }
  return window.loadFile(target.filePath, target.hash ? { hash: target.hash } : undefined)
}

function isTrustedNavigation(url: string, targets: readonly ReloadTarget[]): boolean {
  if (!URL.canParse(url)) return false

  const candidate = new URL(url)
  candidate.hash = ''
  candidate.search = ''
  return targets.some((target) => {
    if (target.type === 'url') return candidate.origin === new URL(target.url).origin
    return candidate.href === pathToFileURL(target.filePath).href
  })
}

function installNavigationGuard(window: BrowserWindow, targets: readonly ReloadTarget[]): void {
  const preventUntrustedNavigation = (event: { url: string; preventDefault: () => void }): void => {
    if (isTrustedNavigation(event.url, targets)) return

    event.preventDefault()
    const externalUrl = normalizeExternalHttpUrl(event.url)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
    console.warn('[Electron] Blocked main window navigation', { url: event.url })
  }

  window.webContents.on('will-navigate', preventUntrustedNavigation)
  window.webContents.on('will-redirect', preventUntrustedNavigation)
}

async function showUnresponsiveDialog(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return
  let response: number
  try {
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Wait', 'Reload window', 'Force quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Lody is unresponsive',
      message: 'Lody is not responding.',
      detail:
        'You can keep waiting, reload the window (your in-progress edits in this window will be lost), or force-quit the app.'
    })
    response = result.response
  } catch (error) {
    console.error('[Electron] Failed to show unresponsive dialog', formatUnknownError(error))
    return
  }
  if (response === 1) {
    requestRendererReload(window)
    return
  }
  if (response === 2) {
    app.exit(1)
    return
  }
  // User chose "Wait". Electron only fires `unresponsive` on the first stall;
  // if the window stays stuck after the dialog closes, no follow-up event
  // re-arms our watchdog. Re-arm here so we ask again after another stall.
  if (!window.isDestroyed()) {
    startUnresponsiveWatchdog(window, {
      timeoutMs: UNRESPONSIVE_DIALOG_DELAY_MS,
      onTimeout: () => {
        void showUnresponsiveDialog(window)
      }
    })
  }
}

function attachMainWindowDiagnostics(window: BrowserWindow, recoveryTarget: ReloadTarget): void {
  const { webContents } = window

  const showRecovery = (context: RecoveryContext): void => {
    void persistRendererFatalError({
      scope: context.source,
      message: context.message,
      details: context.details,
      copied: false
    })
    loadRecoveryPage(window, recoveryTarget, context)
  }

  window.on('unresponsive', () => {
    console.error('[Electron] Main window became unresponsive')
    // The recovery page already shows Reload / Copy buttons of its own; don't
    // stack a second "unresponsive" dialog on top of it. If recovery itself
    // hangs the user can close the window from the OS.
    if (isInRecovery(window)) return
    startUnresponsiveWatchdog(window, {
      timeoutMs: UNRESPONSIVE_DIALOG_DELAY_MS,
      onTimeout: () => {
        void showUnresponsiveDialog(window)
      }
    })
  })
  window.on('responsive', () => {
    console.info('[Electron] Main window became responsive')
    clearUnresponsiveWatchdog(window)
  })

  webContents.on('did-fail-load', (_event, ...args: unknown[]) => {
    const details = readLoadFailureDetails(args)
    console.error('[Electron] Main window failed to load', details)
    // Sub-frame failures (e.g. an iframe) shouldn't take over the whole window.
    if (details.isMainFrame === false) return
    // ERR_ABORTED (-3) fires when navigation is interrupted by another load
    // (including our own loadFile to recovery.html). Ignore it.
    if (details.errorCode === -3) return
    if (isInRecovery(window)) return
    showRecovery({
      message: 'Lody could not load its window.',
      details: formatLoadFailure(details),
      source: 'did-fail-load'
    })
  })

  webContents.on('did-fail-provisional-load', (_event, ...args: unknown[]) => {
    // Often transient (DNS, cert). The main 'did-fail-load' will fire if the
    // load actually fails — don't pre-empt it.
    console.error('[Electron] Main window provisional load failed', readLoadFailureDetails(args))
  })

  webContents.on('preload-error', (_event, preloadPath, error) => {
    const formatted = formatUnknownError(error)
    console.error('[Electron] Main window preload failed', { preloadPath, error: formatted })
    if (isInRecovery(window)) return
    showRecovery({
      message: 'Lody preload script failed to initialize.',
      details: `Preload: ${preloadPath}\n${formatted}`,
      source: 'preload-error'
    })
  })

  webContents.on('console-message', (_event, ...args: unknown[]) => {
    const details = readConsoleMessageDetails(args)
    if (!details || !shouldLogConsoleMessage(details)) {
      return
    }
    console.warn('[Electron] Renderer console message', details)
  })

  webContents.on('render-process-gone', (_event, details) => {
    console.error('[Electron] Renderer process gone', {
      reason: details.reason,
      exitCode: details.exitCode
    })
    // 'clean-exit' is normal shutdown — don't surface it.
    if (details.reason === 'clean-exit') return
    if (isInRecovery(window)) return
    showRecovery({
      message: 'The Lody window crashed.',
      details: `Reason: ${details.reason}\nExit code: ${details.exitCode}`,
      source: 'render-process-gone'
    })
  })

  webContents.on('devtools-opened', () => {
    console.info('[Electron] DevTools opened')
  })
  webContents.on('devtools-focused', () => {
    console.info('[Electron] DevTools focused')
  })
  webContents.on('devtools-closed', () => {
    console.info('[Electron] DevTools closed')
  })
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const shouldMaximizeOnLaunch = shouldMaximizeMainWindowOnLaunch()
  nativeTheme.themeSource = getInitialMainWindowThemeSource(
    options.initialPath,
    readStartupThemeSource()
  )
  const resolvedTheme = resolveNativeWindowTheme(nativeTheme.shouldUseDarkColors)
  const window = new BrowserWindow({
    ...getMainWindowConstructorOptions(),
    show: false,
    backgroundColor: getMainWindowBackgroundColor(resolvedTheme),
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon: options.icon } : {}),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 16 } }
      : {}),
    // Windows: hide the native title bar (its neutral gray clashes with the
    // app canvas) and keep only the OS-drawn caption buttons as an overlay
    // tinted to match the theme.
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: getMainWindowTitleBarOverlay(resolvedTheme)
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Chromium's packaged locale resources are intentionally English-only.
      // Carry Electron's OS-level preference into preload so first-run product
      // language detection does not mistake the available .pak for user intent.
      additionalArguments: [
        serializePreferredSystemLanguagesArgument(app.getPreferredSystemLanguages()),
        // Preload applies this as the `.dark`/`.light` class on `<html>`. The
        // window's `backgroundColor` above only covers what the document does
        // not paint, and `tailwind/index.css` paints `body` from the theme
        // class — so without this the first frame is the LIGHT canvas even in
        // a dark window, until React mounts and corrects it.
        serializeInitialWindowThemeArgument(resolvedTheme)
      ],
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  if (options.hideWindowOnAutoLaunch && shouldMaximizeOnLaunch) {
    pendingInitialMaximize.add(window)
  }
  trackMainWindowState(window)
  const mainTarget = resolveMainRendererTarget(options.initialPath)
  const recoveryTarget = resolveRecoveryTarget()
  installNavigationGuard(window, [mainTarget, recoveryTarget])
  setReloadTarget(window, mainTarget)
  attachMainWindowDiagnostics(window, recoveryTarget)

  window.on('ready-to-show', () => {
    if (options.hideWindowOnAutoLaunch) {
      return
    }
    if (shouldMaximizeOnLaunch) {
      pendingInitialMaximize.delete(window)
      window.maximize()
    }
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    const externalUrl = normalizeExternalHttpUrl(details.url)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
    return { action: 'deny' }
  })

  window.webContents.on('did-finish-load', () => {
    options.onDidFinishLoad?.()
    // Only watch the main app's mount; the recovery page never calls
    // notifyRendererMounted and would always trip the timer.
    if (isInRecovery(window)) return
    startMountWatchdog(window, {
      timeoutMs: MOUNT_WATCHDOG_TIMEOUT_MS,
      onTimeout: () => {
        console.error(
          '[Electron] Renderer did not report mounted within',
          MOUNT_WATCHDOG_TIMEOUT_MS,
          'ms — the boot may be stuck.'
        )
        if (is.dev && !window.isDestroyed()) {
          try {
            window.webContents.openDevTools({ mode: 'detach' })
          } catch (error) {
            console.warn('[Electron] openDevTools after stuck boot failed', error)
          }
        }
      }
    })
  })

  window.on('closed', () => {
    clearMountWatchdog(window)
    clearUnresponsiveWatchdog(window)
    disposeWatchdogState(window)
  })

  void loadRendererTarget(window, mainTarget).catch((error: unknown) => {
    console.error('[Electron] Failed to load renderer', formatUnknownError(error))
  })

  return window
}

type OpenMainWindowOptions = {
  icon: string
  initialPath?: '/' | '/onboarding'
  hideWindowOnAutoLaunch?: boolean
}

export function focusMainWindow(window: BrowserWindow): void {
  if (window.isMinimized()) {
    window.restore()
  }
  if (pendingInitialMaximize.delete(window)) {
    window.maximize()
  }
  if (!window.isVisible()) {
    window.show()
  }
  app.focus({ steal: true })
  window.focus()
}

export function openMainWindow(options: OpenMainWindowOptions): BrowserWindow {
  let windowRef: BrowserWindow | null = null
  const window = createMainWindow({
    icon: options.icon,
    initialPath: options.initialPath,
    hideWindowOnAutoLaunch: options.hideWindowOnAutoLaunch,
    onDidFinishLoad: () => {
      const target = windowRef
      const pendingDeepLink = consumePendingDeepLink()
      if (pendingDeepLink) {
        if (!target || target.isDestroyed()) {
          logDeepLinkDebug('pending deep link dropped because window reference is unavailable')
        } else {
          target.webContents.send('app.deepLink', pendingDeepLink)
          logDeepLinkDebug('pending deep link sent to renderer after did-finish-load', {
            pendingDeepLink: describeDeepLinkForAuthDebug(pendingDeepLink)
          })
        }
      } else {
        logDeepLinkDebug('main window finished load without a pending deep link')
      }
    }
  })
  windowRef = window

  setMainWindow(window)

  // Push fullscreen state to the renderer so it can collapse the macOS
  // traffic-light insets (sidebar header, top-bar padding, drag strip) while
  // the lights are auto-hidden in native fullscreen.
  const sendFullscreenState = () => {
    if (!window.isDestroyed()) {
      window.webContents.send('app.fullscreen', window.isFullScreen())
    }
  }
  window.on('enter-full-screen', sendFullscreenState)
  window.on('leave-full-screen', sendFullscreenState)

  window.on('close', (event) => {
    if (isAppQuitting()) {
      return
    }

    const shouldHideOnClose =
      process.platform === 'darwin' || (process.platform === 'win32' && isWindowsTrayAvailable())
    if (!shouldHideOnClose) {
      return
    }

    event.preventDefault()

    // On macOS, hiding a window that's in native fullscreen leaves its dedicated
    // fullscreen Space behind with no visible window — the user sees a black
    // screen instead of returning to the desktop. Exit fullscreen first and wait
    // for `leave-full-screen` (setFullScreen is async/animated) before hiding.
    if (process.platform === 'darwin' && window.isFullScreen()) {
      window.once('leave-full-screen', () => {
        if (!window.isDestroyed()) {
          window.hide()
        }
      })
      window.setFullScreen(false)
      return
    }

    window.hide()
  })

  window.on('closed', () => {
    if (getMainWindow() === window) {
      setMainWindow(null)
    }
  })

  return window
}

export function setMainWindowProductReloadTarget(window: BrowserWindow): void {
  setReloadTarget(window, resolveMainRendererTarget('/'))
}

export function openOrFocusMainWindow(options: OpenMainWindowOptions): BrowserWindow {
  const mainWindow = getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow(mainWindow)
    return mainWindow
  }

  return openMainWindow(options)
}

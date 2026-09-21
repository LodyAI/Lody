import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { installContextMenu } from './context-menu'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  consumePendingDeepLink,
  getMainWindow,
  isAppQuitting,
  isWarmWindow,
  isWindowsTrayAvailable,
  markWarmWindow,
  setMainWindow,
  productWindows
} from './window-state'
import {
  getMainWindowConstructorOptions,
  shouldMaximizeMainWindowOnLaunch,
  trackMainWindowState
} from './window-persistence'
import {
  getInitialMainWindowThemeSource,
  getMainWindowBackgroundColor,
  getMainWindowTitleBarOverlay
} from './window-theme'
import { formatUnknownError, normalizeExternalHttpUrl } from './utils'
import { describeDeepLinkForAuthDebug } from './auth-debug'
import { captureElectronMainException } from './posthog-error-reporting'
import { createRendererProcessGoneHandling } from './renderer-process-gone'
import { createRendererHangWatchdog } from './renderer-hang-watchdog'
import { recordRendererHang, registerRendererHangDocument } from './renderer-hang-diagnostics'
import { resolveMainWindowRuntimePolicy } from './window-runtime-policy'
import { IPC_PUSH_CHANNELS, type ElectronWindowTarget } from '@lody/shared/electron-ipc'
import { serializePreferredSystemLanguagesArgument } from '../system-language-argument'
import { isDevbarRendererEnabled } from './services/devbar/service'
import { devbarRendererEntry } from './services/devbar/control'
import {
  clearMountWatchdog,
  disposeWatchdogState,
  isInRecovery,
  loadRecoveryPage,
  persistRendererFatalError,
  requestRendererReload,
  setReloadTarget,
  startMountWatchdog,
  type ReloadTarget,
  type RecoveryContext
} from './renderer-recovery'

let productWindowIcon = ''

type CreateMainWindowOptions = {
  icon?: string
  initialPath?: string
  auxiliary?: boolean
  hideWindowOnAutoLaunch?: boolean
  onDidFinishLoad?: () => void
  /**
   * Keeps a hidden spare auxiliary window alive for the next open instead of
   * showing it. The renderer binds a concrete target later, so the window boots
   * on a neutral route and must never present itself to the user.
   */
  warm?: boolean
}

// Neutral route a warm spare boots on. `window=workspace` marks it auxiliary
// (its own session storage); `warm=1` tells the renderer to keep the neutral
// shell until a target is bound instead of redirecting into a workspace.
export const WARM_WINDOW_INITIAL_PATH = '/?window=workspace&warm=1'

const DEEP_LINK_DEBUG_PREFIX = '[electron-auth-debug]'

// How long to wait after did-finish-load for the renderer to call
// notifyRendererMounted. Boot work like authClient bootstrap, IndexedDB warm
// up, and Loro Streams catch-up can take a few seconds even on fast machines;
// we'd rather err on the long side than spuriously open DevTools.
const MOUNT_WATCHDOG_TIMEOUT_MS = 20_000

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

function resolveMainRendererTarget(
  initialPath = '/',
  devbarEnabled = isDevbarRendererEnabled(),
  auxiliary = false
): ReloadTarget {
  const rendererEntry = devbarRendererEntry(devbarEnabled, auxiliary)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    // The dev server keeps index.html on plain history paths; only the Devbar
    // entry loads as <entry>.html#/<route> since it runs hash history on http.
    const path =
      rendererEntry === 'index.html'
        ? initialPath
        : initialPath === '/'
          ? rendererEntry
          : `${rendererEntry}#${initialPath}`
    return {
      type: 'url',
      url: new URL(path, process.env['ELECTRON_RENDERER_URL']).toString()
    }
  }
  return {
    type: 'file',
    filePath: join(__dirname, `../renderer/${rendererEntry}`),
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

function readCurrentRendererPath(window: BrowserWindow): string {
  try {
    const current = new URL(window.webContents.getURL())
    if (current.hash.startsWith('#/')) return current.hash.slice(1)
    if (!current.pathname.endsWith('.html') && current.pathname.startsWith('/')) {
      return `${current.pathname}${current.search}`
    }
  } catch {
    // A window still navigating has no route worth preserving.
  }
  return '/'
}

export async function reloadMainWindowForDevbar(
  window: BrowserWindow,
  enabled: boolean
): Promise<void> {
  const target = resolveMainRendererTarget(readCurrentRendererPath(window), enabled)
  setReloadTarget(window, target)
  await loadRendererTarget(window, target)
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

  const hangWatchdog = createRendererHangWatchdog({
    now: Date.now,
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
    record: (event, incident, details) => recordRendererHang(window, event, incident, details),
    showDialog: async () => {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Wait', 'Reload window', 'Force quit'],
        defaultId: 0,
        cancelId: 0,
        title: 'Lody is unresponsive',
        message: 'Lody is not responding.',
        detail:
          'You can keep waiting, reload the window (your in-progress edits in this window will be lost), or force-quit the app.'
      })
      return response
    },
    reload: () => requestRendererReload(window),
    quit: () => app.exit(1)
  })
  window.on('unresponsive', () => {
    if (!isInRecovery(window)) hangWatchdog.unresponsive()
  })
  window.on('responsive', () => hangWatchdog.responsive())
  webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) hangWatchdog.navigation()
  })
  webContents.on('render-process-gone', () => hangWatchdog.navigation())
  window.once('closed', () => hangWatchdog.dispose())

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
    if (isInRecovery(window)) return
    const handling = createRendererProcessGoneHandling(details)
    if (!handling) return

    // This executes in main because the crashing renderer cannot finish its own
    // telemetry request. The recovery page stays open afterwards, so this
    // best-effort flush is never raced by an automatic product reload.
    void captureElectronMainException(handling.report.error, {
      component: handling.report.component,
      extra: handling.report.extra
    })
    showRecovery(handling.recovery)
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
  const shouldMaximizeOnLaunch = !options.auxiliary && shouldMaximizeMainWindowOnLaunch()
  const runtimePolicy = resolveMainWindowRuntimePolicy({
    isPackaged: app.isPackaged,
    e2eFlag: process.env['LODY_E2E'],
    showE2EWindowFlag: process.env['LODY_E2E_SHOW_WINDOW']
  })
  if (options.icon) productWindowIcon = options.icon
  if (!options.auxiliary)
    nativeTheme.themeSource = getInitialMainWindowThemeSource(
      options.initialPath === '/onboarding' ? '/onboarding' : '/'
    )
  const resolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const window = new BrowserWindow({
    ...getMainWindowConstructorOptions(),
    ...(options.auxiliary ? { width: 1000, height: 760 } : {}),
    show: false,
    backgroundColor: getMainWindowBackgroundColor(resolvedTheme),
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon: productWindowIcon } : {}),
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
      backgroundThrottling: runtimePolicy.backgroundThrottling,
      // Chromium's packaged locale resources are intentionally English-only.
      // Carry Electron's OS-level preference into preload so first-run product
      // language detection does not mistake the available .pak for user intent.
      additionalArguments: [
        serializePreferredSystemLanguagesArgument(app.getPreferredSystemLanguages())
      ],
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  if (options.hideWindowOnAutoLaunch && shouldMaximizeOnLaunch) {
    pendingInitialMaximize.add(window)
  }
  productWindows.add(window)
  if (options.warm) markWarmWindow(window)
  window.once('closed', () => {
    productWindows.delete(window)
    if (getMainWindow() === window) {
      setMainWindow(
        [...productWindows].find(
          (candidate) => !candidate.isDestroyed() && !isWarmWindow(candidate)
        ) ?? null
      )
    }
    // A hidden spare must not keep the process alive once the last real window
    // closes, and holding it while the app idles would only waste memory. A
    // later auxiliary request can prime a replacement when the option remains on.
    if (!isAppQuitting()) {
      const hasRealWindow = [...productWindows].some(
        (candidate) => !candidate.isDestroyed() && !isWarmWindow(candidate)
      )
      if (!hasRealWindow) {
        for (const candidate of [...productWindows]) {
          if (!candidate.isDestroyed() && isWarmWindow(candidate)) {
            candidate.destroy()
          }
        }
      }
    }
  })
  if (!options.auxiliary) trackMainWindowState(window)
  const initialDevbarEnabled = isDevbarRendererEnabled()
  const mainTarget = resolveMainRendererTarget(
    options.initialPath,
    initialDevbarEnabled,
    options.auxiliary
  )
  const standardTarget = resolveMainRendererTarget(options.initialPath, false)
  const devbarTarget = resolveMainRendererTarget(options.initialPath, true)
  const recoveryTarget = resolveRecoveryTarget()
  const trustedTargets = [standardTarget, devbarTarget, recoveryTarget]
  installNavigationGuard(window, trustedTargets)
  registerRendererHangDocument(window, (url) => isTrustedNavigation(url, trustedTargets))
  installContextMenu(window)
  setReloadTarget(window, mainTarget)
  attachMainWindowDiagnostics(window, recoveryTarget)

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

  window.on('ready-to-show', () => {
    // A warm spare stays hidden until it is claimed for a concrete target.
    if (options.warm) {
      return
    }
    if (options.hideWindowOnAutoLaunch) {
      return
    }
    if (!runtimePolicy.showWhenReady) {
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
        if (is.dev && !options.warm && !window.isDestroyed()) {
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

/**
 * Creates the hidden spare auxiliary window. It boots the renderer on a neutral
 * route so the next `openSessionWindow` can bind a real target without paying
 * the full cold-boot cost.
 */
export function createWarmWindow(options: { icon?: string } = {}): BrowserWindow {
  return createMainWindow({
    icon: options.icon,
    auxiliary: true,
    warm: true,
    initialPath: WARM_WINDOW_INITIAL_PATH
  })
}

/**
 * Hands a claimed warm window its concrete route and presents it. The renderer
 * navigates client-side; the themed shell is already painted, so the window is
 * shown immediately without a blank frame.
 */
export function bindMainWindowTarget(window: BrowserWindow, target: ElectronWindowTarget): void {
  if (window.isDestroyed()) return
  window.webContents.send(IPC_PUSH_CHANNELS.appWindowTarget, target)
  if (window.isMinimized()) {
    window.restore()
  }
  if (!window.isVisible()) {
    window.show()
  }
  app.focus({ steal: true })
  window.focus()
}

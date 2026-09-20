import { app } from 'electron'
import { extractDeepLinkFromArgv, parseDeepLinkArg } from './deep-link-url'
import { consumePendingDeepLink, getMainWindow, setPendingDeepLink } from './window-state'
import { readDesktopLoginCallback } from './services/desktop-login'
import { focusMainWindow } from './window'
import { publishDeepLinkToPrimary, startDeepLinkIpcListener } from './deep-link-ipc'
import { describeDeepLinkForAuthDebug, describeUrlForAuthDebug, logAuthDebug } from './auth-debug'

let stopIpcListener: (() => void) | null = null
let lastHandledDeepLink: string | null = null
let lastHandledAt = 0
const USE_DEEP_LINK_IPC_FALLBACK = process.platform === 'win32'
let authCallbackHandler: ((token: string) => Promise<void>) | null = null

export function initializeAuthDeepLinks(handler: (token: string) => Promise<void>): void {
  authCallbackHandler = handler
  const pending = consumePendingDeepLink()
  if (!pending) return
  const token = readDesktopLoginCallback(pending)
  if (token !== null) void handler(token)
  else setPendingDeepLink(pending)
}

function shouldSkipDuplicateDeepLink(url: string): boolean {
  const now = Date.now()
  if (lastHandledDeepLink === url && now - lastHandledAt < 5000) {
    return true
  }
  lastHandledDeepLink = url
  lastHandledAt = now
  return false
}

export function handleDeepLink(url: string): void {
  logAuthDebug('handleDeepLink received URL', {
    deepLink: describeDeepLinkForAuthDebug(url)
  })
  const parsedDeepLink = parseDeepLinkArg(url)
  if (!parsedDeepLink) {
    logAuthDebug('handleDeepLink ignored URL because parseDeepLinkArg returned null', {
      deepLink: describeDeepLinkForAuthDebug(url)
    })
    return
  }
  const authToken = readDesktopLoginCallback(parsedDeepLink)
  if (authToken !== null && authCallbackHandler) {
    // Authentication belongs to main even if there is no mounted product page.
    void authCallbackHandler(authToken)
    const window = getMainWindow()
    if (window && !window.isDestroyed()) focusMainWindow(window)
    return
  }
  if (shouldSkipDuplicateDeepLink(parsedDeepLink)) {
    logAuthDebug('handleDeepLink skipped duplicate deep link', {
      deepLink: describeDeepLinkForAuthDebug(parsedDeepLink)
    })
    return
  }

  logAuthDebug('handleDeepLink accepted deep link', {
    deepLink: describeDeepLinkForAuthDebug(parsedDeepLink)
  })
  setPendingDeepLink(parsedDeepLink)

  const window = getMainWindow()
  if (!window || window.isDestroyed()) {
    logAuthDebug('handleDeepLink deferred because main window is unavailable')
    return
  }

  logAuthDebug('handleDeepLink focusing main window')
  focusMainWindow(window)

  const contents = window.webContents
  if (contents.isDestroyed()) {
    logAuthDebug('handleDeepLink aborted because webContents is destroyed')
    return
  }
  if (contents.isLoading()) {
    logAuthDebug('handleDeepLink deferred because webContents is still loading')
    return
  }

  const currentUrl = contents.getURL()
  if (!currentUrl || currentUrl === 'about:blank') {
    logAuthDebug('handleDeepLink deferred because current renderer URL is not ready', {
      currentUrl: describeUrlForAuthDebug(currentUrl)
    })
    return
  }

  logAuthDebug('handleDeepLink sending deep link to renderer', {
    deepLink: describeDeepLinkForAuthDebug(parsedDeepLink),
    currentUrl: describeUrlForAuthDebug(currentUrl)
  })
  contents.send('app.deepLink', parsedDeepLink)
  setPendingDeepLink(null)
}

export function acquireSingleInstanceLock(): boolean {
  const deepLinkFromArgv = extractDeepLinkFromArgv(process.argv)
  if (!app.isPackaged && process.env.LODY_E2E === '1') {
    logAuthDebug('skipping single-instance lock for isolated Electron E2E')
    return true
  }
  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  logAuthDebug('requestSingleInstanceLock completed', {
    gotSingleInstanceLock,
    deepLinkFromArgv: describeDeepLinkForAuthDebug(deepLinkFromArgv)
  })
  if (!gotSingleInstanceLock) {
    if (USE_DEEP_LINK_IPC_FALLBACK && deepLinkFromArgv) {
      logAuthDebug('publishing deep link to primary instance via IPC fallback', {
        deepLink: describeDeepLinkForAuthDebug(deepLinkFromArgv)
      })
      publishDeepLinkToPrimary(deepLinkFromArgv)
    }
    app.quit()
    return false
  }

  if (USE_DEEP_LINK_IPC_FALLBACK && !stopIpcListener) {
    logAuthDebug('starting deep-link IPC listener for Windows fallback')
    stopIpcListener = startDeepLinkIpcListener((url) => handleDeepLink(url))
    app.on('will-quit', () => {
      stopIpcListener?.()
      stopIpcListener = null
    })
  }

  app.on('second-instance', (_event, argv) => {
    const urlArg = extractDeepLinkFromArgv(argv)
    logAuthDebug('second-instance event received', {
      urlArg: describeDeepLinkForAuthDebug(urlArg),
      argvLength: argv.length
    })
    if (urlArg) {
      handleDeepLink(urlArg)
    }

    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      return
    }
    focusMainWindow(mainWindow)
  })

  return true
}

export function registerOpenUrlHandler(): void {
  app.on('open-url', (event, url) => {
    logAuthDebug('open-url event received', {
      deepLink: describeDeepLinkForAuthDebug(url)
    })
    const parsedDeepLink = parseDeepLinkArg(url)
    if (!parsedDeepLink) {
      logAuthDebug('open-url ignored because parseDeepLinkArg returned null', {
        deepLink: describeDeepLinkForAuthDebug(url)
      })
      return
    }

    event.preventDefault()
    logAuthDebug('open-url forwarding parsed deep link', {
      deepLink: describeDeepLinkForAuthDebug(parsedDeepLink)
    })
    handleDeepLink(parsedDeepLink)
  })
}

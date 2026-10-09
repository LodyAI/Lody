import { desktopInstallationProfile } from './platform'
import { getDesktopCallbackProtocol } from './desktop-channel'
import { parseDeepLinkArg, resolveDesktopDeepLink } from './deep-link-url'
import { app, dialog, shell } from 'electron'
import { consumePendingDeepLink, getMainWindow, setPendingDeepLink } from './window-state'
import { readDesktopLoginCallback } from './services/desktop-login'
import { focusMainWindow } from './window'
import { describeDeepLinkForAuthDebug, describeUrlForAuthDebug, logAuthDebug } from './auth-debug'

let lastHandledDeepLink: string | null = null
let lastHandledAt = 0
let authCallbackHandler: ((token: string) => Promise<void>) | null = null

export function initializeAuthDeepLinks(handler: (token: string) => Promise<void>): void {
  authCallbackHandler = handler
  const pending = consumePendingDeepLink()
  if (!pending) return
  const token = readLoginCallback(pending)
  if (token !== null) void handler(token)
  else setPendingDeepLink(pending)
}

function readLoginCallback(url: string): string | null {
  return (
    readDesktopLoginCallback(url, getDesktopCallbackProtocol(desktopInstallationProfile)) ??
    readDesktopLoginCallback(url, desktopInstallationProfile.desktopProtocol)
  )
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
  const intake = parseDeepLinkArg(url)
  const route = intake ? resolveDesktopDeepLink(intake) : null
  if (route?.kind === 'forward' || route?.kind === 'unsupported') {
    // Never bounce to the shared scheme: only Stable's private alias is a handoff.
    // Do not include URLs/tokens in native error messages or rejected-promise logs.
    void app
      .whenReady()
      .then(async () => {
        try {
          if (route.kind === 'forward' && app.getApplicationNameForProtocol(route.url)) {
            await shell.openExternal(route.url)
            return
          }
        } catch {
          /* Report a redacted failure below. */
        }
        await dialog.showMessageBox({
          type: 'error',
          title: 'Unable to open Lody link',
          message:
            route.kind === 'forward'
              ? 'This link requires Lody Stable. Install or open the latest Stable version and try again.'
              : 'This version of Lody does not support this link. Update Lody and try again.'
        })
      })
      .catch(() => {})
    return
  }
  const parsedDeepLink = route?.kind === 'local' ? route.url : null
  if (!parsedDeepLink) {
    logAuthDebug('handleDeepLink ignored URL because parseDeepLinkArg returned null', {
      deepLink: describeDeepLinkForAuthDebug(url)
    })
    return
  }
  const authToken = readLoginCallback(parsedDeepLink)
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

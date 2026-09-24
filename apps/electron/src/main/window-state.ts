import type { BrowserWindow } from 'electron'
import { extractDeepLinkFromArgv } from './deep-link-url'

let mainWindow: BrowserWindow | null = null
let pendingDeepLink: string | null = extractDeepLinkFromArgv(process.argv)
let appQuitting = false
let windowsTrayAvailable = false

// Only product windows enter this set; embedded browsers and recovery probes do not.
export const productWindows = new Set<BrowserWindow>()

// Warm spare windows are product windows (they need product IPC to boot) but
// must never be treated as a user-facing window: they never become the main
// window fallback and never count as a visible product surface.
const warmWindows = new WeakSet<BrowserWindow>()

export function markWarmWindow(window: BrowserWindow): void {
  warmWindows.add(window)
}

export function unmarkWarmWindow(window: BrowserWindow): void {
  warmWindows.delete(window)
}

export function isWarmWindow(window: BrowserWindow): boolean {
  return warmWindows.has(window)
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window
}

export function setPendingDeepLink(url: string | null): void {
  pendingDeepLink = url
}

export function consumePendingDeepLink(): string | null {
  const next = pendingDeepLink
  pendingDeepLink = null
  return next
}

export function setAppQuitting(quitting: boolean): void {
  appQuitting = quitting
}

export function isAppQuitting(): boolean {
  return appQuitting
}

export function setWindowsTrayAvailable(available: boolean): void {
  windowsTrayAvailable = available
}

export function isWindowsTrayAvailable(): boolean {
  return windowsTrayAvailable
}

export function registerProductWindow(window: BrowserWindow, warm: boolean): void {
  productWindows.add(window)
  if (warm) markWarmWindow(window)
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
}

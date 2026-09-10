import type { BrowserWindow } from 'electron'
import { extractDeepLinkFromArgv } from './deep-link-url'

let mainWindow: BrowserWindow | null = null
let pendingDeepLink: string | null = extractDeepLinkFromArgv(process.argv)
let appQuitting = false
let windowsTrayAvailable = false

// Only product windows enter this set; embedded browsers and recovery probes do not.
export const productWindows = new Set<BrowserWindow>()

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

import type { BrowserWindow } from 'electron'
import type { AppUpdaterService } from '../services/app-updater-service'
import type { AuthService } from '../services/auth-service'
import type { E2eeDeviceService } from '../services/e2ee-device-service'
import type { E2eeUserService } from '../services/e2ee-user-service'
import type { CliService } from '../services/cli-service'
import type { GlobalShortcutsService } from '../services/global-shortcuts-service'
import type { LoroDataPlaneRelay } from '../services/loro-data-plane-relay'
import type { NotificationService } from '../services/notification-service'
import type { PublicBrowserService } from '../services/public-browser-service'
import type { TerminalRelay } from '../services/terminal-relay'
import type { WindowBadgeService } from '../services/window-badge-service'

export type IpcServiceDeps = {
  cliService: CliService
  appUpdaterService: AppUpdaterService
  authService: AuthService
  e2eeDeviceService: E2eeDeviceService
  e2eeUserService: E2eeUserService
  notificationService: NotificationService
  terminalRelay: TerminalRelay
  publicBrowserService: PublicBrowserService
  loroDataPlaneRelay: LoroDataPlaneRelay
  windowBadgeService: WindowBadgeService
  globalShortcutsService: GlobalShortcutsService
  getMainWindow: () => BrowserWindow | null
  completeOnboarding: (window: BrowserWindow) => void
}

let deps: IpcServiceDeps | null = null

export function setIpcServiceDeps(next: IpcServiceDeps): void {
  deps = next
}

export function getIpcServiceDeps(): IpcServiceDeps {
  if (!deps) {
    throw new Error('IPC service deps not set')
  }
  return deps
}

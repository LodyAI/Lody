import { access } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { BrowserWindow, nativeTheme, shell, systemPreferences } from 'electron'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import {
  GLOBAL_SHORTCUT_DEFAULTS,
  IPC_PUSH_CHANNELS,
  LaunchLocalPathInputSchema,
  PathLauncherProbeSchema,
  type NativeThemeSource,
  type RendererFatalErrorReport,
  type SetGlobalShortcutInput,
  type WindowBadgeInput
} from '@lody/shared/electron-ipc'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { setMenuLanguage } from '../../menu'
import { hasPathLauncher, launchLocalPath } from '../../services/local-path-launcher-service'
import { parseWindowBadge } from '../../services/window-badge-service'
import {
  findWindow,
  markRendererMounted,
  persistRendererFatalError,
  requestRendererReload
} from '../../renderer-recovery'
import { applyResolvedWindowTheme, resolveNativeWindowTheme } from '../../window-theme'
import { formatUnknownError, normalizeExternalHttpUrl } from '../../utils'
import {
  applyAutoLaunchSettings,
  getAutoLaunchEnabled,
  getHideWindowOnAutoLaunchEnabled,
  setHideWindowOnAutoLaunchEnabled
} from '../../auto-launch-settings'

const autoLaunchSupported = process.platform === 'darwin' || process.platform === 'win32'

function getAutoLaunchStatus() {
  if (!autoLaunchSupported) {
    return {
      supported: false,
      enabled: false,
      hideWindowOnAutoLaunch: false
    }
  }
  try {
    const enabled = getAutoLaunchEnabled()
    return {
      supported: true,
      enabled,
      hideWindowOnAutoLaunch: getHideWindowOnAutoLaunchEnabled()
    }
  } catch (error) {
    return {
      supported: true,
      enabled: false,
      hideWindowOnAutoLaunch: getHideWindowOnAutoLaunchEnabled(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function isSetGlobalShortcutInput(value: unknown): value is SetGlobalShortcutInput {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { id?: unknown; binding?: unknown }
  if (typeof candidate.id !== 'string') return false
  if (!(candidate.id in GLOBAL_SHORTCUT_DEFAULTS)) return false
  return candidate.binding === null || typeof candidate.binding === 'string'
}

function syncNativeThemeWindows(): void {
  const resolvedTheme = resolveNativeWindowTheme(nativeTheme.shouldUseDarkColors)
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    applyResolvedWindowTheme(window, resolvedTheme, process.platform)
    window.webContents.send(IPC_PUSH_CHANNELS.appNativeTheme, resolvedTheme)
  }
}

let osAppearanceWatchInstalled = false

export function installNativeThemeWatch(): void {
  if (osAppearanceWatchInstalled) return
  osAppearanceWatchInstalled = true
  nativeTheme.on('updated', syncNativeThemeWindows)
  if (process.platform === 'darwin') {
    systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () => {
      setImmediate(syncNativeThemeWindows)
    })
  }
}

export class AppIpc extends IpcService {
  static override readonly groupName = 'app'

  @IpcMethod()
  async getFullscreen() {
    const { event } = getIpcContext()
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
  }

  @IpcMethod()
  async completeOnboarding() {
    const { event } = getIpcContext()
    const { getMainWindow, completeOnboarding } = getIpcServiceDeps()
    const mainWindow = getMainWindow()
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      return { ok: false as const, error: 'untrusted_sender' as const }
    }
    try {
      completeOnboarding(mainWindow)
      return { ok: true as const }
    } catch (error) {
      return {
        ok: false as const,
        error: 'completion_failed' as const,
        message: formatUnknownError(error)
      }
    }
  }

  @IpcMethod()
  async getAutoLaunchStatus() {
    return getAutoLaunchStatus()
  }

  @IpcMethod()
  async setAutoLaunchEnabled(enabledRaw: boolean) {
    if (typeof enabledRaw !== 'boolean') {
      const status = getAutoLaunchStatus()
      return {
        ok: false,
        supported: status.supported,
        enabled: status.enabled,
        hideWindowOnAutoLaunch: status.hideWindowOnAutoLaunch,
        error: 'invalid_enabled_flag'
      }
    }
    if (!autoLaunchSupported) {
      return {
        ok: false,
        supported: false,
        enabled: false,
        hideWindowOnAutoLaunch: false,
        error: 'unsupported_platform'
      }
    }
    try {
      applyAutoLaunchSettings(enabledRaw)
      const status = getAutoLaunchStatus()
      return {
        ok: true,
        supported: status.supported,
        enabled: status.enabled,
        hideWindowOnAutoLaunch: status.hideWindowOnAutoLaunch
      }
    } catch (error) {
      const status = getAutoLaunchStatus()
      return {
        ok: false,
        supported: status.supported,
        enabled: status.enabled,
        hideWindowOnAutoLaunch: status.hideWindowOnAutoLaunch,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  @IpcMethod()
  async setAutoLaunchHideWindow(enabledRaw: boolean) {
    if (typeof enabledRaw !== 'boolean') {
      const status = getAutoLaunchStatus()
      return {
        ok: false,
        supported: status.supported,
        enabled: status.enabled,
        hideWindowOnAutoLaunch: status.hideWindowOnAutoLaunch,
        error: 'invalid_enabled_flag'
      }
    }
    if (!autoLaunchSupported) {
      return {
        ok: false,
        supported: false,
        enabled: false,
        hideWindowOnAutoLaunch: false,
        error: 'unsupported_platform'
      }
    }

    const previous = getHideWindowOnAutoLaunchEnabled()
    try {
      setHideWindowOnAutoLaunchEnabled(enabledRaw)
      const status = getAutoLaunchStatus()
      return {
        ok: true,
        supported: status.supported,
        enabled: status.enabled,
        hideWindowOnAutoLaunch: status.hideWindowOnAutoLaunch
      }
    } catch (error) {
      try {
        setHideWindowOnAutoLaunchEnabled(previous)
      } catch {
        // Preserve the original failure for the renderer.
      }
      const status = getAutoLaunchStatus()
      return {
        ok: false,
        supported: status.supported,
        enabled: status.enabled,
        hideWindowOnAutoLaunch: status.hideWindowOnAutoLaunch,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  @IpcMethod()
  async getGlobalShortcuts() {
    return getIpcServiceDeps().globalShortcutsService.list()
  }

  @IpcMethod()
  async setGlobalShortcut(input: SetGlobalShortcutInput) {
    if (!isSetGlobalShortcutInput(input)) {
      return { ok: false as const, error: 'invalid' as const }
    }
    return getIpcServiceDeps().globalShortcutsService.setBinding(input)
  }

  @IpcMethod()
  async setGlobalShortcutsSuspended(suspended: boolean) {
    getIpcServiceDeps().globalShortcutsService.setSuspended(suspended === true)
  }

  @IpcMethod()
  async setWindowBadge(badgeRaw: WindowBadgeInput) {
    const badge = parseWindowBadge(badgeRaw)
    if (!badge) {
      return { ok: false as const, error: 'invalid_badge' }
    }
    const { event } = getIpcContext()
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return { ok: false as const, error: 'unknown_window' }
    }
    getIpcServiceDeps().windowBadgeService.setBadge(win.id, badge)
    return { ok: true as const }
  }

  @IpcMethod()
  async openExternalUrl(urlRaw: string) {
    const externalUrl = normalizeExternalHttpUrl(urlRaw)
    if (!externalUrl) {
      return { opened: false, error: 'invalid_url' }
    }
    try {
      await shell.openExternal(externalUrl)
      return { opened: true, url: externalUrl }
    } catch (error) {
      return { opened: false, url: externalUrl, error: formatUnknownError(error) }
    }
  }

  @IpcMethod()
  async revealLocalPath(pathRaw: unknown) {
    if (typeof pathRaw !== 'string') {
      return { revealed: false as const, error: 'invalid_path' }
    }
    const targetPath = pathRaw.trim()
    if (!targetPath || !isAbsolute(targetPath)) {
      return { revealed: false as const, error: 'invalid_path' }
    }
    try {
      await access(targetPath)
    } catch {
      return { revealed: false as const, error: 'not_found' }
    }
    shell.showItemInFolder(targetPath)
    return { revealed: true as const }
  }

  // Hands a workspace file to the OS default handler — the same thing a
  // double-click in Finder/Explorer does. It is the only way to see a file the
  // in-app viewer refuses (too large, unsupported), so the renderer offers it
  // beside `revealLocalPath` on those error states.
  @IpcMethod()
  async openLocalPath(pathRaw: unknown) {
    if (typeof pathRaw !== 'string') {
      return { opened: false as const, error: 'invalid_path' }
    }
    const targetPath = pathRaw.trim()
    if (!targetPath || !isAbsolute(targetPath)) {
      return { opened: false as const, error: 'invalid_path' }
    }
    try {
      await access(targetPath)
    } catch {
      return { opened: false as const, error: 'not_found' }
    }
    // `shell.openPath` resolves to '' on success and to the failure message
    // otherwise; it never rejects.
    const failure = await shell.openPath(targetPath)
    if (failure) {
      return { opened: false as const, error: failure }
    }
    return { opened: true as const }
  }

  @IpcMethod()
  async launchLocalPath(payload: unknown) {
    const parsed = LaunchLocalPathInputSchema.safeParse(payload)
    if (!parsed.success) {
      return { launched: false as const, error: 'invalid_payload' }
    }
    return await launchLocalPath(parsed.data)
  }

  @IpcMethod()
  async probePathLaunchers(payload: unknown) {
    const parsed = PathLauncherProbeSchema.safeParse(payload)
    if (!parsed.success) {
      return { availableIds: [] }
    }
    const availability = await Promise.all(
      parsed.data.launchers.map(async ({ launcherId, input }) => ({
        launcherId,
        available: await hasPathLauncher(input)
      }))
    )
    return {
      availableIds: availability
        .filter(({ available }) => available)
        .map(({ launcherId }) => launcherId)
    }
  }

  @IpcMethod()
  async setPreventSleepEnabled(enabledRaw: boolean) {
    const { cliService } = getIpcServiceDeps()
    if (typeof enabledRaw !== 'boolean') {
      return { ok: false, enabled: cliService.getPreventSleepEnabled() }
    }
    cliService.setPreventSleepEnabled(enabledRaw)
    return { ok: true, enabled: enabledRaw }
  }

  @IpcMethod()
  async getPreventSleepEnabled() {
    return { enabled: getIpcServiceDeps().cliService.getPreventSleepEnabled() }
  }

  @IpcMethod()
  async setLanguage(locale: string) {
    if (typeof locale === 'string') {
      setMenuLanguage(locale)
    }
  }

  @IpcMethod()
  async setNativeTheme(source: NativeThemeSource) {
    if (source === 'dark' || source === 'light' || source === 'system') {
      nativeTheme.themeSource = source
      syncNativeThemeWindows()
    }
  }

  @IpcMethod()
  async notifyRendererMounted() {
    const { event } = getIpcContext()
    const window = findWindow(event.sender)
    if (window) markRendererMounted(window)
  }

  @IpcMethod()
  async reportRendererFatalError(payloadRaw: RendererFatalErrorReport) {
    if (!payloadRaw || typeof payloadRaw !== 'object') return
    const payload = payloadRaw as Record<string, unknown>
    void persistRendererFatalError({
      scope: typeof payload.scope === 'string' ? payload.scope : 'unknown',
      message: typeof payload.message === 'string' ? payload.message : '(no message)',
      details: typeof payload.details === 'string' ? payload.details : '',
      copied: payload.copied === true
    })
  }

  @IpcMethod()
  async requestRendererReload() {
    const { event } = getIpcContext()
    const window = findWindow(event.sender)
    if (window) requestRendererReload(window)
  }
}

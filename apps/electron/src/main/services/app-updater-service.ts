import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { loadSparkleBridge, type SparkleBridge } from 'electron-sparkle-updater'
import type {
  CheckForElectronUpdateResult,
  ElectronUpdaterState,
  QuitAndInstallElectronUpdateResult
} from '@lody/shared/electron-ipc'
import { IPC_PUSH_CHANNELS } from '@lody/shared/electron-ipc'
import { formatUnknownError } from '../utils'
import { setAppQuitting } from '../window-state'
import {
  resolveLinuxDebInstallPlan,
  runLinuxDebInstall,
  type LinuxDebInstallPlan
} from './app-updater-linux-install'
import { readUpdaterReleaseMetadata } from './app-updater-metadata'
import { sparkleEventToStatePatch } from './app-updater-sparkle-events'
import {
  resolveSparkleAddonPath,
  resolveSparkleAppcastUrl,
  shouldUseSparkleUpdater,
  sparklePackageJsonPathFromModuleEntry
} from './app-updater-sparkle-policy'

const SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER = 'SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER'

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000
const LODY_UPDATER_STATE_EVENT = IPC_PUSH_CHANNELS.updaterState

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function readFiniteNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record ? record[key] : undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function readVersionPrereleaseChannel(version: string): string | undefined {
  const trimmed = version.trim()
  if (!trimmed) return undefined
  const [, prereleasePart] = trimmed.split('-', 2)
  if (!prereleasePart) return undefined

  const [channel] = prereleasePart.split('.', 1)
  const normalized = readNonEmptyString(channel)?.toLowerCase()
  if (!normalized) return undefined
  return normalized
}

// electron-updater defaults to `console`, and a packaged desktop app has no
// terminal attached, so every install failure it reports is lost. Keep the
// updater's own log next to the app data instead.
function createUpdaterLogger() {
  const logPath = join(app.getPath('userData'), 'updater.log')
  const write = (level: string, message: unknown): void => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} [${level}] ${String(message)}\n`)
    } catch {
      // Logging must never break the update flow.
    }
  }
  return {
    info: (message: unknown) => write('info', message),
    warn: (message: unknown) => write('warn', message),
    error: (message: unknown) => write('error', message)
  }
}

export class AppUpdaterService {
  private state: ElectronUpdaterState = {
    phase: 'idle',
    currentVersion: app.getVersion()
  }
  private started = false
  private listenersAttached = false
  private checkInFlight = false
  private intervalRef: NodeJS.Timeout | null = null
  private sparkleBridge: SparkleBridge | null = null
  /** Package electron-updater has on disk, cleared when a newer one supersedes it. */
  private downloadedFile: string | undefined
  private errorCount = 0
  private installInFlight = false

  constructor(private readonly options: { enabled?: boolean } = {}) {}

  getState(): ElectronUpdaterState {
    return this.state
  }

  start(): void {
    if (this.started) return
    this.started = true

    if (!this.isUpdaterEnabled()) {
      this.setState({
        phase: 'disabled',
        disabledReason: 'updater_disabled_in_dev'
      })
      return
    }

    const sparkleBridge = this.tryLoadSparkleBridge()
    if (sparkleBridge) {
      this.sparkleBridge = sparkleBridge
      this.attachSparkleEventHandler(sparkleBridge)
      sparkleBridge.setAutomaticChecks(true)
      return
    }

    autoUpdater.logger = createUpdaterLogger()
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false

    if (!app.isPackaged) {
      autoUpdater.forceDevUpdateConfig = true
    }

    const updateChannel = this.resolveUpdateChannel()
    autoUpdater.channel = updateChannel
    autoUpdater.allowPrerelease = updateChannel !== 'latest'

    const updateUrl = readNonEmptyString(import.meta.env.VITE_ELECTRON_UPDATE_URL)
    if (updateUrl) {
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: updateUrl
      })
    }

    this.attachListeners()
    void this.checkForUpdates()
    this.intervalRef = setInterval(() => {
      void this.checkForUpdates()
    }, UPDATE_CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.intervalRef) {
      clearInterval(this.intervalRef)
      this.intervalRef = null
    }
  }

  async checkForUpdates(): Promise<CheckForElectronUpdateResult> {
    if (!this.isUpdaterEnabled()) {
      return {
        started: false,
        error: 'updater_disabled'
      }
    }
    if (this.sparkleBridge) {
      try {
        this.setState({
          phase: 'checking',
          error: undefined,
          checkedAtMs: Date.now(),
          percent: undefined,
          bytesPerSecond: undefined,
          transferred: undefined,
          total: undefined
        })
        this.sparkleBridge.checkForUpdates()
        return { started: true }
      } catch (error) {
        const message = formatUnknownError(error)
        this.setState({
          phase: 'error',
          error: message,
          checkedAtMs: Date.now()
        })
        return {
          started: false,
          error: message
        }
      }
    }
    if (this.checkInFlight) {
      return {
        started: false,
        error: 'check_in_progress'
      }
    }

    this.checkInFlight = true
    this.setState({
      phase: 'checking',
      error: undefined
    })

    try {
      await autoUpdater.checkForUpdates()
      return { started: true }
    } catch (error) {
      const message = formatUnknownError(error)
      this.recordError(message)
      return {
        started: false,
        error: message
      }
    } finally {
      this.checkInFlight = false
    }
  }

  async quitAndInstall(): Promise<QuitAndInstallElectronUpdateResult> {
    if (this.sparkleBridge) {
      try {
        setAppQuitting(true)
        this.sparkleBridge.installUpdateNow()
        return { ok: true }
      } catch (error) {
        setAppQuitting(false)
        const message = formatUnknownError(error)
        this.setState({
          phase: 'error',
          error: message
        })
        return {
          ok: false,
          error: message
        }
      }
    }

    if (this.state.phase !== 'downloaded') {
      return {
        ok: false,
        error: 'update_not_downloaded'
      }
    }

    const linuxPlan = resolveLinuxDebInstallPlan({
      platform: process.platform,
      downloadedFile: this.downloadedFile,
      appImagePath: process.env.APPIMAGE
    })
    if (linuxPlan) return await this.installLinuxDeb(linuxPlan)

    try {
      // Ensure macOS close handlers don't hide windows and block updater-triggered quit.
      setAppQuitting(true)
      const errorsBeforeInstall = this.errorCount
      autoUpdater.quitAndInstall(false, true)
      // electron-updater reports install failures through its `error` event and
      // returns normally, so a plain `ok: true` here would leave the renderer
      // spinning on an install that never started. The event listener is
      // synchronous, so a failure is already recorded by now. The phase itself
      // is no longer the signal: a downloaded package stays `downloaded` so the
      // user can retry.
      if (this.errorCount !== errorsBeforeInstall) {
        setAppQuitting(false)
        return {
          ok: false,
          error: this.state.error ?? 'update_install_failed'
        }
      }
      return { ok: true }
    } catch (error) {
      setAppQuitting(false)
      const message = formatUnknownError(error)
      this.setState({
        phase: 'error',
        error: message
      })
      return {
        ok: false,
        error: message
      }
    }
  }

  /**
   * Install a `.deb` without entering electron-updater's blocking
   * `spawnSync`, so the app stays responsive while polkit holds its password
   * prompt open. Quitting is ours too: it must happen only after the package
   * manager has actually succeeded.
   */
  private async installLinuxDeb(
    plan: LinuxDebInstallPlan
  ): Promise<QuitAndInstallElectronUpdateResult> {
    // The window stays interactive during the prompt, so a second click would
    // raise a second password prompt for the same install.
    if (this.installInFlight) {
      return {
        ok: false,
        error: 'update_install_in_progress'
      }
    }

    this.installInFlight = true
    try {
      const result = await runLinuxDebInstall(plan, (command, args) =>
        spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      )
      if (!result.ok) {
        this.recordError(result.error)
        return {
          ok: false,
          error: result.error
        }
      }
    } finally {
      this.installInFlight = false
    }

    // Close handlers must not hide windows and block the updater-driven quit.
    setAppQuitting(true)
    app.relaunch()
    app.quit()
    return { ok: true }
  }

  /**
   * Record a failure without discarding an installable package. A failed check
   * or a failed install leaves the downloaded update on disk, and dropping the
   * phase to `error` would hide both the sidebar banner and the About panel's
   * install button, which is the only way to retry.
   */
  private recordError(message: string): void {
    this.errorCount += 1
    this.setState({
      phase: this.downloadedFile ? 'downloaded' : 'error',
      error: message,
      checkedAtMs: Date.now()
    })
  }

  private tryLoadSparkleBridge(): SparkleBridge | null {
    if (
      !shouldUseSparkleUpdater({
        platform: process.platform,
        isPackaged: app.isPackaged,
        sparkleAvailable: true
      })
    ) {
      return null
    }

    const log = (message: string): void => {
      console.log(`[sparkle] ${message}`)
    }

    let resolvedPackageJsonPath: string | undefined
    try {
      resolvedPackageJsonPath = sparklePackageJsonPathFromModuleEntry(
        createRequire(import.meta.url).resolve('electron-sparkle-updater')
      )
    } catch {
      resolvedPackageJsonPath = undefined
    }

    const addonPath = resolveSparkleAddonPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      resolvedPackageJsonPath,
      exists: existsSync
    })
    if (!addonPath) {
      log('native addon not found')
      return null
    }

    const bridge = loadSparkleBridge({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      addonPath,
      log
    })
    if (!bridge) return null

    const initialized = bridge.init({
      appcastUrl: resolveSparkleAppcastUrl({
        configuredAppcastUrl: readNonEmptyString(process.env.SPARKLE_APPCAST_URL)
      }),
      publicEdKey:
        readNonEmptyString(process.env.SPARKLE_ED_PUBLIC_KEY) ?? SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER
    })
    if (!initialized) {
      log('init failed')
      return null
    }
    return bridge
  }

  private attachSparkleEventHandler(bridge: SparkleBridge): void {
    if (typeof bridge.setEventHandler !== 'function') {
      console.log('[sparkle] native bridge has no event handler; renderer progress will not update')
      return
    }
    bridge.setEventHandler((event) => {
      try {
        const patch = sparkleEventToStatePatch(event, Date.now())
        if (patch) this.setState(patch)
      } catch (error) {
        console.log(`[sparkle] event handler failed: ${formatUnknownError(error)}`)
      }
    })
  }

  private isUpdaterEnabled(): boolean {
    if (this.options.enabled === false) return false
    if (app.isPackaged) return true
    return process.env.LODY_ELECTRON_ENABLE_DEV_UPDATER === '1'
  }

  private resolveUpdateChannel(): string {
    const configuredChannel = readNonEmptyString(import.meta.env.VITE_ELECTRON_UPDATE_CHANNEL)
    if (configuredChannel) return configuredChannel.toLowerCase()

    if (!app.isPackaged) {
      return 'next'
    }

    const prereleaseChannel = readVersionPrereleaseChannel(app.getVersion())
    if (prereleaseChannel) return prereleaseChannel

    return 'latest'
  }

  private attachListeners(): void {
    if (this.listenersAttached) return
    this.listenersAttached = true

    autoUpdater.on('checking-for-update', () => {
      this.setState({
        phase: 'checking',
        error: undefined,
        checkedAtMs: Date.now(),
        percent: undefined,
        bytesPerSecond: undefined,
        transferred: undefined,
        total: undefined
      })
    })

    autoUpdater.on('update-available', (payload) => {
      const record = readObject(payload)
      const version = readNonEmptyString(record?.version)
      // A newer version supersedes whatever is cached; electron-updater cleans
      // that directory, so the old path would point at a deleted file.
      this.downloadedFile = undefined
      this.setState({
        phase: 'downloading',
        availableVersion: version,
        downloadedVersion: undefined,
        ...readUpdaterReleaseMetadata(payload, version),
        checkedAtMs: Date.now(),
        error: undefined
      })
    })

    autoUpdater.on('update-not-available', () => {
      this.setState({
        phase: 'up_to_date',
        availableVersion: undefined,
        downloadedVersion: undefined,
        percent: undefined,
        bytesPerSecond: undefined,
        transferred: undefined,
        total: undefined,
        checkedAtMs: Date.now(),
        error: undefined
      })
    })

    autoUpdater.on('download-progress', (payload) => {
      const record = readObject(payload)
      this.setState({
        phase: 'downloading',
        percent: readFiniteNumber(record, 'percent'),
        bytesPerSecond: readFiniteNumber(record, 'bytesPerSecond'),
        transferred: readFiniteNumber(record, 'transferred'),
        total: readFiniteNumber(record, 'total')
      })
    })

    autoUpdater.on('update-downloaded', (payload) => {
      const record = readObject(payload)
      const version = readNonEmptyString(record?.version)
      const targetVersion = version ?? this.state.availableVersion
      this.downloadedFile = readNonEmptyString(record?.downloadedFile)
      this.setState({
        phase: 'downloaded',
        downloadedVersion: version,
        availableVersion: targetVersion,
        ...readUpdaterReleaseMetadata(payload, targetVersion),
        checkedAtMs: Date.now(),
        error: undefined
      })
    })

    autoUpdater.on('error', (error) => {
      this.recordError(formatUnknownError(error))
    })
  }

  private setState(nextPartialState: Partial<ElectronUpdaterState>): void {
    this.state = {
      ...this.state,
      ...nextPartialState,
      currentVersion: app.getVersion()
    }
    this.emitState()
  }

  private emitState(): void {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (browserWindow.isDestroyed()) continue
      const webContents = browserWindow.webContents
      if (!webContents || webContents.isDestroyed()) continue
      webContents.send(LODY_UPDATER_STATE_EVENT, this.state)
    }
  }
}

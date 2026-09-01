import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type {
  CheckForElectronUpdateResult,
  ElectronUpdaterState,
  QuitAndInstallElectronUpdateResult
} from '@lody/shared/electron-ipc'
import { IPC_PUSH_CHANNELS } from '@lody/shared/electron-ipc'
import { formatUnknownError } from '../utils'
import { setAppQuitting } from '../window-state'
import { readUpdaterReleaseMetadata } from './app-updater-metadata'

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
      this.setState({
        phase: 'error',
        error: message,
        checkedAtMs: Date.now()
      })
      return {
        started: false,
        error: message
      }
    } finally {
      this.checkInFlight = false
    }
  }

  quitAndInstall(): QuitAndInstallElectronUpdateResult {
    if (this.state.phase !== 'downloaded') {
      return {
        ok: false,
        error: 'update_not_downloaded'
      }
    }

    try {
      // Ensure macOS close handlers don't hide windows and block updater-triggered quit.
      setAppQuitting(true)
      autoUpdater.quitAndInstall(false, true)
      // electron-updater reports install failures through its `error` event and
      // returns normally, so a plain `ok: true` here would leave the renderer
      // spinning on an install that never started. The event listener is
      // synchronous, so a failure is already recorded in state by now.
      const stateAfterInstall = this.getState()
      if (stateAfterInstall.phase === 'error') {
        setAppQuitting(false)
        return {
          ok: false,
          error: stateAfterInstall.error ?? 'update_install_failed'
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
      this.setState({
        phase: 'error',
        error: formatUnknownError(error),
        checkedAtMs: Date.now()
      })
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

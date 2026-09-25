import { app, powerMonitor } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getLodyDataDir } from '@lody/shared/node/installation-profile'
import { desktopInstallationProfile, mainPlatformKind } from './platform'
import {
  createDesktopLog,
  createMainThreadLagProbe,
  describePreviousDesktopRun,
  mirrorConsoleToDesktopLog,
  parseDesktopRunRecord,
  type DesktopLog,
  type DesktopRunRecord
} from './desktop-log-core'

const RUN_RECORD_FILE = 'desktop-run-state.json'
const MAIN_LAG_INTERVAL_MS = 1_000
const MAIN_LAG_WARN_THRESHOLD_MS = 2_000

const noopLog: DesktopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flushSync: () => {}
}

let installed: DesktopLog | null = null
let activeRun: { path: string; record: DesktopRunRecord } | null = null

/** The desktop log, or a no-op before `installDesktopLog` ran. */
export function getDesktopLog(): DesktopLog {
  return installed ?? noopLog
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

function readRunRecord(path: string): DesktopRunRecord | null {
  try {
    return parseDesktopRunRecord(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeRunRecord(path: string, record: DesktopRunRecord): void {
  try {
    writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  } catch {
    // Best effort: a missing record only weakens the next run's diagnosis.
  }
}

/**
 * Must run after `desktop-bootstrap` has fixed `userData`, before any other
 * main-process work, so startup failures are captured too.
 */
export function installDesktopLog(): DesktopLog {
  if (installed) return installed
  try {
    return installDesktopLogUnsafe()
  } catch (error) {
    // Diagnostics must never keep the desktop from starting.
    installed = noopLog
    console.error('[desktop-log] disabled after an installation error', error)
    return noopLog
  }
}

function installDesktopLogUnsafe(): DesktopLog {
  const log = createDesktopLog({
    logDir: join(getLodyDataDir(mainPlatformKind), 'logs'),
    scopePrefix: `desktop:${process.pid}`
  })
  installed = log

  log.info(
    'lifecycle',
    `${desktopInstallationProfile.desktopProductName} ${app.getVersion()} main process started (pid=${
      process.pid
    } ppid=${process.ppid} electron=${process.versions.electron} chrome=${
      process.versions.chrome
    } node=${process.versions.node} platform=${process.platform}/${process.arch} packaged=${
      app.isPackaged
    } channel=${desktopInstallationProfile.releaseChannel})`
  )

  mirrorConsoleToDesktopLog(console, log)

  // `uncaughtExceptionMonitor` observes without replacing Electron's default
  // handling, which an `uncaughtException` listener would suppress.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    log.error('fatal', `${origin} in main process: ${describeError(error)}`)
    log.flushSync()
  })
  process.on('warning', (warning) => {
    log.warn('process', `${warning.name}: ${warning.message}`)
  })
  process.on('exit', (code) => {
    log.info('lifecycle', `main process exiting (code=${code})`)
    log.flushSync()
  })

  app.on('before-quit', () => log.info('lifecycle', 'before-quit'))
  app.on('will-quit', () => {
    log.info('lifecycle', 'will-quit')
    if (activeRun) writeRunRecord(activeRun.path, { ...activeRun.record, cleanExit: true })
    log.flushSync()
  })
  app.on('quit', (_event, exitCode) => {
    log.info('lifecycle', `quit (exitCode=${exitCode})`)
    log.flushSync()
  })
  app.on('window-all-closed', () => log.info('lifecycle', 'window-all-closed'))
  app.on('render-process-gone', (_event, webContents, details) => {
    const level = details.reason === 'clean-exit' ? 'info' : 'error'
    let url = '<unavailable>'
    try {
      url = new URL(webContents.getURL()).origin
    } catch {
      // Destroyed or non-URL contents.
    }
    log[level](
      'renderer',
      `render-process-gone reason=${details.reason} exitCode=${details.exitCode} origin=${url}`
    )
  })
  app.on('child-process-gone', (_event, details) => {
    const level = details.reason === 'clean-exit' ? 'info' : 'error'
    log[level](
      'child-process',
      `child-process-gone type=${details.type} reason=${details.reason} exitCode=${
        details.exitCode
      }${details.name ? ` name=${details.name}` : ''}${
        details.serviceName ? ` service=${details.serviceName}` : ''
      }`
    )
  })

  const cpuMs = () => {
    const usage = process.cpuUsage()
    return (usage.user + usage.system) / 1000
  }
  const lagTimer = setInterval(
    createMainThreadLagProbe({
      log,
      now: () => Date.now(),
      cpuMs,
      intervalMs: MAIN_LAG_INTERVAL_MS,
      warnThresholdMs: MAIN_LAG_WARN_THRESHOLD_MS
    }),
    MAIN_LAG_INTERVAL_MS
  )
  lagTimer.unref()

  void app.whenReady().then(() => {
    log.info('lifecycle', 'app ready')
    powerMonitor.on('suspend', () => log.info('power', 'suspend'))
    powerMonitor.on('resume', () => log.info('power', 'resume'))
    powerMonitor.on('shutdown', () => log.info('power', 'shutdown'))
  })

  return log
}

/**
 * Records this process as the desktop's current run and reports whether the
 * previous run quit cleanly. Call only once this process owns the desktop
 * (after the single-instance lock): a second launch that immediately hands its
 * URL to the primary must not overwrite the primary's record.
 */
export function beginDesktopRunRecord(): void {
  if (activeRun) return
  const log = getDesktopLog()
  const path = join(app.getPath('userData'), RUN_RECORD_FILE)
  const previousRun = describePreviousDesktopRun(readRunRecord(path))
  if (previousRun) log.warn('lifecycle', previousRun)
  const record: DesktopRunRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cleanExit: false
  }
  activeRun = { path, record }
  writeRunRecord(path, record)
}

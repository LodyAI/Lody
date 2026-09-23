import { PreparedWindow } from './prepared-window'
import { isLocalPlatform } from './platform'
import { app, BrowserWindow } from 'electron'
import type { ElectronWindowTarget } from '@lody/shared/electron-ipc'
import type { DevbarWarmPool } from '@lody/shared/devbar'
import type { ProcessMetric } from 'electron'
import { WindowWarmPool, type WarmWindowEntry } from './window-warm-pool'
import { adoptPreparedMainWindow, bindMainWindowTarget, createWarmWindow } from './window'
import { isAppQuitting, isWarmWindow, productWindows } from './window-state'
import {
  isWindowWarmupEnabled as isWindowWarmupSettingEnabled,
  isWindowWarmupEnvironmentAllowed,
  setWindowWarmupSetting
} from './window-warm-settings'

/**
 * Keeps one hidden auxiliary renderer booted and ready for reuse when the
 * developer-only experiment is enabled. Opening an auxiliary window claims
 * the spare and primes a replacement after it is shown, so the second and later
 * windows skip the full renderer cold boot.
 *
 * The pool is disabled for E2E (the harness counts and inspects windows) and
 * It is off by default and can also be turned off explicitly with
 * `LODY_DISABLE_WINDOW_WARMUP=1`.
 */
export function isWindowWarmupEnabled(): boolean {
  return isWindowWarmupSettingEnabled()
}

// A spare that never reports ready (renderer crash, recovery page) must not
// occupy the single pool slot forever.
const WARM_READY_TIMEOUT_MS = 30_000

const pool = new WindowWarmPool((entry) => {
  const window = BrowserWindow.fromId(entry.windowId)
  return Boolean(window && !window.isDestroyed())
})

const warmWindows = new Map<number, BrowserWindow>()
let warmReadyTimer: NodeJS.Timeout | null = null
let warmClaimCount = 0
let prepared: PreparedWindow | null = null
let requested: { source: BrowserWindow; target: ElectronWindowTarget; requestId: string } | null =
  null
let stopWatchingSource: (() => void) | null = null

function clearPreparation(): void {
  requested = null
  stopWatchingSource?.()
  stopWatchingSource = null
  const previous = prepared
  prepared = null
  if (previous?.isClaimed) previous.fail()
  previous?.dispose()
}

/** macOS prepares one real Session; other platforms retain neutral-shell warmup. */
export function prepareWindow(
  source: BrowserWindow,
  target: ElectronWindowTarget,
  requestId: string
): void {
  if (
    process.platform !== 'darwin' ||
    !isLocalPlatform() ||
    !isWindowWarmupEnabled() ||
    !target.sessionId ||
    source.isDestroyed() ||
    !source.isVisible() ||
    isWarmWindow(source) ||
    prepared?.isClaimed
  )
    return
  if (requested?.source === source && requested.requestId === requestId) return
  if (prepared?.matches(target) && prepared.sourceId === source.webContents.id) {
    prepared.renew(requestId)
    requested = { source, target, requestId }
    return
  }
  clearPreparation()
  requested = { source, target, requestId }
  const close = (): void => clearPreparation()
  source.once('closed', close)
  stopWatchingSource = () => source.removeListener('closed', close)
  beginPreparation()
  scheduleWindowWarmUp()
}

function beginPreparation(): void {
  if (!requested || prepared || !isWindowWarmupEnabled()) return
  const entry = pool.claimReady()
  if (!entry) return
  clearWarmReadyTimer()
  const window = warmWindows.get(entry.windowId)
  if (!window || window.isDestroyed()) return
  const request = requested
  const candidate = new PreparedWindow(
    window,
    request.source.webContents.id,
    request.requestId,
    request.target,
    () => {
      warmWindows.delete(window.id)
      if (prepared === candidate) {
        prepared = null
        requested = null
        stopWatchingSource?.()
        stopWatchingSource = null
        scheduleWindowWarmUp()
      }
    }
  )
  prepared = candidate
  window.webContents.once('render-process-gone', () => candidate.fail())
  window.once('unresponsive', () => candidate.fail())
  candidate.start()
}

export function cancelPreparedWindow(sourceId: number, requestId: string): void {
  if (requested?.source.webContents.id !== sourceId || requested.requestId !== requestId) return
  if (prepared) prepared.cancel(sourceId, requestId)
  else clearPreparation()
}

export function handlePreparedWindowState(senderId: number, raw: unknown): void {
  prepared?.update(senderId, raw)
}

function clearWarmReadyTimer(): void {
  if (warmReadyTimer) {
    clearTimeout(warmReadyTimer)
    warmReadyTimer = null
  }
}

function primeWindowWarmPool(): void {
  if (
    !isWindowWarmupEnabled() ||
    isAppQuitting() ||
    pool.hasSpare() ||
    prepared ||
    ![...productWindows].some((window) => !window.isDestroyed() && !isWarmWindow(window))
  ) {
    return
  }

  let window: BrowserWindow
  try {
    window = createWarmWindow()
  } catch (error) {
    console.warn('[Electron] Failed to create warm window', error)
    return
  }

  const entry: WarmWindowEntry = { windowId: window.id, webContentsId: window.webContents.id }
  warmWindows.set(window.id, window)
  pool.beginWarming(entry)

  warmReadyTimer = setTimeout(() => {
    warmReadyTimer = null
    if (pool.phase !== 'warming') return
    console.warn('[Electron] Warm window did not become ready in time; dropping it')
    if (!window.isDestroyed()) {
      window.destroy()
    }
  }, WARM_READY_TIMEOUT_MS)
  warmReadyTimer.unref?.()

  window.once('closed', () => {
    if (warmWindows.has(window.id)) clearWarmReadyTimer()
    warmWindows.delete(window.id)
    pool.forget(entry)
  })
}

function discardWarmSpare(): void {
  clearPreparation()
  clearWarmReadyTimer()
  for (const [windowId, window] of warmWindows) {
    if (!window.isDestroyed()) window.destroy()
    warmWindows.delete(windowId)
  }
}

/** Enable or disable this developer-only experiment at runtime. */
export function setWindowWarmupEnabled(enabled: boolean): void {
  setWindowWarmupSetting(enabled && isWindowWarmupEnvironmentAllowed())
  if (!isWindowWarmupEnabled()) {
    discardWarmSpare()
    return
  }
  scheduleWindowWarmUp()
}

function warmRendererRssBytes(metrics: ProcessMetric[]): number | null {
  const spare = [...warmWindows.values()][0]
  if (!spare || spare.isDestroyed()) return null
  let pid: number
  try {
    pid = spare.webContents.getOSProcessId()
  } catch {
    return null
  }
  const metric = metrics.find((candidate) => candidate.pid === pid)
  const workingSetSize = metric?.memory?.workingSetSize
  return typeof workingSetSize === 'number' && Number.isFinite(workingSetSize)
    ? workingSetSize * 1024
    : null
}

export function getWindowWarmupMetrics(metrics: ProcessMetric[]): DevbarWarmPool {
  const enabled = isWindowWarmupEnabled()
  return {
    enabled,
    phase: enabled ? (prepared ? (prepared.ready ? 'ready' : 'warming') : pool.phase) : 'disabled',
    spareRssBytes: enabled ? warmRendererRssBytes(metrics) : null,
    spareCount: enabled ? warmWindows.size : 0,
    claimCount: warmClaimCount
  }
}

/**
 * Schedules a spare for the next open without competing with the visible
 * window's first paint. Safe to call repeatedly; an existing spare is kept.
 */
export function scheduleWindowWarmUp(): void {
  if (!isWindowWarmupEnabled()) return
  setImmediate(() => primeWindowWarmPool())
}

/**
 * Claims the ready spare for a concrete target, or returns null so the caller
 * falls back to a cold auxiliary window.
 */
export function claimWarmWindow(target: ElectronWindowTarget): BrowserWindow | null {
  const candidate = prepared
  if (candidate && !candidate.isClaimed && candidate.matches(target)) {
    const window = candidate.window
    stopWatchingSource?.()
    stopWatchingSource = null
    adoptPreparedMainWindow(window, target)
    warmClaimCount++
    window.once('show', scheduleWindowWarmUp)
    candidate.claim(() => {
      warmWindows.delete(window.id)
      if (prepared === candidate) {
        prepared = null
        requested = null
      }
      if (!window.isDestroyed()) {
        window.show()
        app.focus({ steal: true })
        window.focus()
        window.webContents.setBackgroundThrottling(candidate.originalThrottling)
      }
    })
    return window
  }
  // A different target must never inherit a speculative view or its acknowledgement.
  if (!candidate || !candidate.isClaimed) clearPreparation()
  const entry = pool.claimReady()
  if (!entry) return null

  clearWarmReadyTimer()
  const window = warmWindows.get(entry.windowId) ?? BrowserWindow.fromId(entry.windowId)
  warmWindows.delete(entry.windowId)
  if (!window || window.isDestroyed()) {
    pool.forget(entry)
    return null
  }

  bindMainWindowTarget(window, target)
  warmClaimCount++
  window.once('show', scheduleWindowWarmUp)
  return window
}

/** Renderer signalled its shell painted; promote the warming spare to ready. */
export function handleWindowWarmReady(webContentsId: number): void {
  if (pool.markReady(webContentsId)) {
    clearWarmReadyTimer()
    beginPreparation()
  }
}

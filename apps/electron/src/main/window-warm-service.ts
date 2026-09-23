import { BrowserWindow } from 'electron'
import type { ElectronWindowTarget } from '@lody/shared/electron-ipc'
import type { DevbarWarmPool } from '@lody/shared/devbar'
import type { ProcessMetric } from 'electron'
import { WindowWarmPool, type WarmWindowEntry } from './window-warm-pool'
import { bindMainWindowTarget, createWarmWindow } from './window'
import { isAppQuitting } from './window-state'
import {
  isWindowWarmupEnabled as isWindowWarmupSettingEnabled,
  isWindowWarmupEnvironmentAllowed,
  setWindowWarmupSetting
} from './window-warm-settings'

/**
 * Keeps one hidden auxiliary renderer booted and ready for reuse when the
 * developer-only experiment is enabled. Opening an auxiliary window claims
 * the spare and immediately primes a replacement, so the second and later
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

function clearWarmReadyTimer(): void {
  if (warmReadyTimer) {
    clearTimeout(warmReadyTimer)
    warmReadyTimer = null
  }
}

function primeWindowWarmPool(): void {
  if (!isWindowWarmupEnabled() || isAppQuitting() || pool.hasSpare()) {
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
    phase: enabled ? pool.phase : 'disabled',
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
  scheduleWindowWarmUp()
  return window
}

/** Renderer signalled its shell painted; promote the warming spare to ready. */
export function handleWindowWarmReady(webContentsId: number): void {
  if (pool.markReady(webContentsId)) {
    clearWarmReadyTimer()
  }
}

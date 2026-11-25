import type { BrowserWindow } from 'electron'
import { IPC_PUSH_CHANNELS } from '@lody/shared/electron-ipc'
import { adoptAuxiliaryReloadPath, createMainWindow, focusMainWindow } from './window'
import { getTodayWindowPath, type TodayWindowTarget } from './today-window-target'
import { isLocalPlatform } from './platform'
import { createTodayWindowLifecycle } from './today-window-lifecycle'
import {
  isAppQuitting,
  isWarmWindow,
  markWarmWindow,
  productWindows,
  unmarkWarmWindow
} from './window-state'

const TODAY_WINDOW_BOOT_LOG_PREFIX = '[today-window] boot timeline'
const TODAY_WINDOW_REOPEN_LOG_PREFIX = '[today-window] reopen'

const TODAY_WINDOW_SIZE = { width: 440, height: 760, minWidth: 320, minHeight: 360 }

const lifecycle = createTodayWindowLifecycle<BrowserWindow>({
  create: (target) => {
    const requestedAt = Date.now()
    const window = createMainWindow({
      auxiliary: true,
      companion: TODAY_WINDOW_SIZE,
      initialPath: getTodayWindowPath(target)
    })
    traceTodayWindowBoot(window, requestedAt)
    return window
  },
  focus: focusMainWindow,
  bindChannel: IPC_PUSH_CHANNELS.appTodayWindowTarget,
  canPark: (window) =>
    isLocalPlatform() &&
    !isAppQuitting() &&
    [...productWindows].some(
      (candidate) => candidate !== window && !candidate.isDestroyed() && !isWarmWindow(candidate)
    ),
  setParked: (window, parked) => (parked ? markWarmWindow(window) : unmarkWarmWindow(window)),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
  revealDeadlineMs: 1_500,
  onReopened: (window, target, shown) => {
    adoptAuxiliaryReloadPath(window, getTodayWindowPath(target))
    console.info(`${TODAY_WINDOW_REOPEN_LOG_PREFIX} ${JSON.stringify({ shown })}`)
  }
})

export function openTodayWindow(target: TodayWindowTarget): void {
  lifecycle.open(target)
}

/** The Today window committed the day it was bound to; show it if it is reopening. */
export function revealTodayWindow(window: BrowserWindow, bindingId: number): void {
  lifecycle.committed(window, bindingId)
}

/**
 * Logs main's milestones of a cold Today window open, relative to the request,
 * with the renderer's own boot timeline (`today-window-boot-timeline.ts`).
 */
function traceTodayWindowBoot(window: BrowserWindow, requestedAt: number): void {
  const elapsed = () => Date.now() - requestedAt
  const milestones: Record<string, number> = { created: elapsed() }
  window.webContents.once('did-finish-load', () => {
    milestones['didFinishLoad'] = elapsed()
  })
  window.once('ready-to-show', () => {
    milestones['readyToShow'] = elapsed()
  })
  window.once('show', () => {
    milestones['shown'] = elapsed()
  })
  window.webContents.on('console-message', (event) => {
    if (!event.message.startsWith(TODAY_WINDOW_BOOT_LOG_PREFIX)) return
    let renderer: Record<string, number> = {}
    try {
      renderer = JSON.parse(event.message.slice(TODAY_WINDOW_BOOT_LOG_PREFIX.length))
    } catch {
      return
    }
    const { timeOrigin, ...phases } = renderer
    const report = {
      main: { ...milestones },
      // Request to the renderer's navigation start; renderer phases count from there.
      ...(typeof timeOrigin === 'number' ? { rendererStart: timeOrigin - requestedAt } : {}),
      renderer: phases
    }
    console.info(`${TODAY_WINDOW_BOOT_LOG_PREFIX} ${JSON.stringify(report)}`)
  })
}

export function closeTodayWindow(window: BrowserWindow): void {
  lifecycle.close(window)
}

export function isTodayWindow(window: BrowserWindow | null): window is BrowserWindow {
  return !!window && lifecycle.has(window)
}

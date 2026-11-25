import type { BrowserWindow } from 'electron'
import { createMainWindow, focusMainWindow } from './window'
import { getTodayWindowPath, type TodayWindowTarget } from './today-window-target'

const TODAY_WINDOW_BOOT_LOG_PREFIX = '[today-window] boot timeline'

const TODAY_WINDOW_SIZE = { width: 440, height: 760, minWidth: 320, minHeight: 360 }

/** One Today window per workspace: opening it again raises the existing one. */
const todayWindows = new Map<string, BrowserWindow>()

export function openTodayWindow(target: TodayWindowTarget): void {
  const existing = todayWindows.get(target.workspace)
  if (existing && !existing.isDestroyed()) {
    focusMainWindow(existing)
    return
  }
  const requestedAt = Date.now()
  const window = createMainWindow({
    auxiliary: true,
    companion: TODAY_WINDOW_SIZE,
    initialPath: getTodayWindowPath(target)
  })
  traceTodayWindowBoot(window, requestedAt)
  todayWindows.set(target.workspace, window)
  window.once('closed', () => {
    if (todayWindows.get(target.workspace) === window) todayWindows.delete(target.workspace)
  })
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

export function isTodayWindow(window: BrowserWindow | null): window is BrowserWindow {
  return !!window && !window.isDestroyed() && [...todayWindows.values()].includes(window)
}

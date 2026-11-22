import type { BrowserWindow } from 'electron'
import { createMainWindow, focusMainWindow } from './window'
import { getTodayWindowPath, type TodayWindowTarget } from './today-window-target'

const TODAY_WINDOW_SIZE = { width: 440, height: 760, minWidth: 320, minHeight: 360 }

/** One Today window per workspace: opening it again raises the existing one. */
const todayWindows = new Map<string, BrowserWindow>()

export function openTodayWindow(target: TodayWindowTarget): void {
  const existing = todayWindows.get(target.workspace)
  if (existing && !existing.isDestroyed()) {
    focusMainWindow(existing)
    return
  }
  const window = createMainWindow({
    auxiliary: true,
    companion: TODAY_WINDOW_SIZE,
    initialPath: getTodayWindowPath(target)
  })
  todayWindows.set(target.workspace, window)
  window.once('closed', () => {
    if (todayWindows.get(target.workspace) === window) todayWindows.delete(target.workspace)
  })
}

export function isTodayWindow(window: BrowserWindow | null): window is BrowserWindow {
  return !!window && !window.isDestroyed() && [...todayWindows.values()].includes(window)
}

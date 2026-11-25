import type { BrowserWindow } from 'electron'
import { createMainWindow, focusMainWindow } from './window'
import { getTodayWindowPath, type TodayWindowTarget } from './today-window-target'
import { getTodayWindowConstructorOptions, trackTodayWindowBounds } from './window-persistence'

/** One Today window per workspace: opening it again raises the existing one. */
const todayWindows = new Map<string, BrowserWindow>()
let activeTodayWorkspace: string | null = null

export function setActiveTodayWorkspace(workspace: string | null): void {
  if (workspace) {
    activeTodayWorkspace = workspace
  }
}

export function openTodayWindow(
  target: TodayWindowTarget,
  options?: { stealFocus?: boolean }
): void {
  activeTodayWorkspace = target.workspace
  const existing = todayWindows.get(target.workspace)
  if (existing && !existing.isDestroyed()) {
    focusMainWindow(existing)
    return
  }
  const window = createMainWindow({
    auxiliary: true,
    companion: getTodayWindowConstructorOptions(),
    initialPath: getTodayWindowPath(target)
  })
  trackTodayWindowBounds(window)
  if (options?.stealFocus) {
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) {
        focusMainWindow(window)
      }
    })
  }
  todayWindows.set(target.workspace, window)
  window.once('closed', () => {
    if (todayWindows.get(target.workspace) === window) todayWindows.delete(target.workspace)
  })
}

function findActiveTodayWindow(workspace: string | null): BrowserWindow | null {
  if (workspace) {
    const match = todayWindows.get(workspace)
    if (match && !match.isDestroyed()) return match
  }
  for (const candidate of todayWindows.values()) {
    if (!candidate.isDestroyed()) return candidate
  }
  return null
}

/**
 * Sticky-note style toggle:
 * - Visible and focused -> close immediately.
 * - Open but unfocused/minimized/hidden -> raise and focus.
 * - Not open -> open for the active workspace at its persisted bounds and focus.
 */
export function toggleTodayWindow(workspace?: string | null): boolean {
  const targetWorkspace = workspace ?? activeTodayWorkspace
  const existing = findActiveTodayWindow(targetWorkspace)
  if (existing) {
    if (existing.isVisible() && existing.isFocused()) {
      existing.close()
    } else {
      focusMainWindow(existing)
    }
    return true
  }
  if (!targetWorkspace) return false
  openTodayWindow({ workspace: targetWorkspace }, { stealFocus: true })
  return true
}

export function isTodayWindow(window: BrowserWindow | null): window is BrowserWindow {
  return !!window && !window.isDestroyed() && [...todayWindows.values()].includes(window)
}

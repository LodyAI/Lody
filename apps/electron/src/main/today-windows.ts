import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type HandlerDetails,
  type WindowOpenHandlerResponse
} from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC_PUSH_CHANNELS } from '@lody/shared/electron-ipc'
import { adoptAuxiliaryReloadPath, createMainWindow, focusMainWindow } from './window'
import { getTodayWindowPath, type TodayWindowTarget } from './today-window-target'
import { isLocalPlatform } from './platform'
import { createTodayWindowLifecycle } from './today-window-lifecycle'
import { getTodayWindowConstructorOptions, trackTodayWindowBounds } from './window-persistence'
import {
  getMainWindow,
  isAppQuitting,
  isWarmWindow,
  markCompanionWindow,
  markWarmWindow,
  registerProductWindow,
  productWindows,
  unmarkWarmWindow
} from './window-state'

const TODAY_WINDOW_BOOT_LOG_PREFIX = '[today-window] boot timeline'
const TODAY_WINDOW_REOPEN_LOG_PREFIX = '[today-window] reopen'

const lifecycle = createTodayWindowLifecycle<BrowserWindow>({
  create: (target, options) => {
    const requestedAt = Date.now()
    const window = createMainWindow({
      auxiliary: true,
      companion: getTodayWindowConstructorOptions(),
      initialPath: getTodayWindowPath(target)
    })
    trackTodayWindowBounds(window)
    if (options?.stealFocus) {
      window.once('ready-to-show', () => {
        if (!window.isDestroyed()) focusMainWindow(window)
      })
    }
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

type Companion = {
  owner: BrowserWindow
  window: BrowserWindow
  name: string
  target: TodayWindowTarget
  ready: boolean
  cancelReveal: () => void
  openedAt: number
}

const preparations = new WeakMap<
  BrowserWindow,
  {
    name: string
    target: TodayWindowTarget
    openedAt: number
  }
>()
const companions = new Map<string, Companion>()
let activeTodayWorkspace: string | null = null

export function setActiveTodayWorkspace(workspace: string | null): void {
  if (workspace) activeTodayWorkspace = workspace
}

export function openTodayWindow(
  target: TodayWindowTarget,
  options?: { stealFocus?: boolean }
): void {
  setActiveTodayWorkspace(target.workspace)
  const companion = companions.get(target.workspace)
  if (companion) {
    if (companion.ready) focusMainWindow(companion.window)
    return
  }
  lifecycle.open(target, options)
}

export function prepareTodayCompanion(
  owner: BrowserWindow,
  target: TodayWindowTarget
): string | null {
  if (isAppQuitting()) return null
  if (
    !isLocalPlatform() ||
    owner !== getMainWindow() ||
    companions.has(target.workspace) ||
    lifecycle.hasWorkspace(target.workspace)
  ) {
    openTodayWindow(target)
    return null
  }
  const name = `lody-today-${randomUUID()}`
  preparations.set(owner, { name, target, openedAt: performance.now() })
  return name
}

export function allowTodayCompanion(
  owner: BrowserWindow,
  details: HandlerDetails,
  options: BrowserWindowConstructorOptions
): WindowOpenHandlerResponse | undefined {
  const preparation = preparations.get(owner)
  if (!preparation || details.url !== 'about:blank' || details.frameName !== preparation.name)
    return
  preparations.delete(owner)
  if (
    performance.now() - preparation.openedAt > 2_000 ||
    owner !== getMainWindow() ||
    isAppQuitting()
  ) {
    return { action: 'deny' }
  }
  const { target, name } = preparation
  if (companions.has(target.workspace) || lifecycle.hasWorkspace(target.workspace)) {
    return { action: 'deny' }
  }
  return {
    action: 'allow',
    outlivesOpener: true,
    overrideBrowserWindowOptions: { ...options, ...getTodayWindowConstructorOptions() },
    createWindow: (browserOptions) => {
      const window = new BrowserWindow(browserOptions)
      trackTodayWindowBounds(window)
      const companion: Companion = {
        owner,
        window,
        name,
        target,
        ready: false,
        openedAt: preparation.openedAt,
        cancelReveal: () => {}
      }
      setActiveTodayWorkspace(target.workspace)
      companions.set(target.workspace, companion)
      registerProductWindow(window, false)
      markCompanionWindow(window, owner)
      const blockNavigation = (event: { preventDefault(): void }) => event.preventDefault()
      window.webContents.on('will-navigate', blockNavigation)
      window.webContents.on('will-frame-navigate', blockNavigation)
      window.webContents.on('will-redirect', blockNavigation)
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      const ownerContents = owner.webContents
      const fallback = () => {
        if (window.isDestroyed()) return
        const pin = window.isAlwaysOnTop()
        window.hide()
        companions.delete(target.workspace)
        try {
          if (!isAppQuitting()) lifecycle.open(companion.target).setAlwaysOnTop(pin)
        } catch (error) {
          console.error('[today-window] Standalone handoff failed', error)
        } finally {
          if (!window.isDestroyed()) window.destroy()
        }
      }
      const sendFullscreen = () => {
        if (!ownerContents.isDestroyed()) {
          ownerContents.send(IPC_PUSH_CHANNELS.appTodayCompanionFullscreen, {
            name,
            fullscreen: window.isFullScreen()
          })
        }
      }
      window.on('enter-full-screen', sendFullscreen)
      window.on('leave-full-screen', sendFullscreen)
      const deadline = setTimeout(fallback, 1_500)
      companion.cancelReveal = () => clearTimeout(deadline)
      owner.once('closed', fallback)
      ownerContents.once('render-process-gone', fallback)
      ownerContents.once('did-navigate', fallback)
      window.once('closed', () => {
        clearTimeout(deadline)
        owner.removeListener('closed', fallback)
        if (!ownerContents.isDestroyed()) {
          ownerContents.removeListener('render-process-gone', fallback)
          ownerContents.removeListener('did-navigate', fallback)
        }
        if (companions.get(target.workspace) === companion) companions.delete(target.workspace)
      })
      return window.webContents
    }
  }
}

export function updateTodayCompanion(
  owner: BrowserWindow,
  name: string,
  action:
    | { type: 'show' }
    | { type: 'pin'; pinned: boolean }
    | { type: 'target'; target: TodayWindowTarget }
): boolean {
  const companion = [...companions.values()].find(
    (entry) => entry.owner === owner && entry.name === name
  )
  if (!companion || companion.window.isDestroyed()) throw new Error('Unknown Today companion')
  if (action.type === 'show' && !companion.ready) {
    companion.ready = true
    focusMainWindow(companion.window)
    companion.cancelReveal()
    console.info(
      `[today-window] shared ${JSON.stringify({ shown: Math.round(performance.now() - companion.openedAt) })}`
    )
  }
  if (action.type === 'pin') companion.window.setAlwaysOnTop(action.pinned)
  if (action.type === 'target' && companion.target.workspace === action.target.workspace) {
    companion.target = action.target
  }
  return companion.window.isAlwaysOnTop()
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

function findOpenTodayWindow(workspace?: string): { window: BrowserWindow; ready: boolean } | null {
  const companion = workspace ? companions.get(workspace) : companions.values().next().value
  return companion ?? lifecycle.getOpenWindow(workspace)
}

/**
 * Sticky-note style toggle:
 * - Visible and focused -> close immediately.
 * - Open but unfocused/minimized/hidden -> raise and focus.
 * - Not open -> open for the active workspace at its persisted bounds and focus.
 */
export function toggleTodayWindow(workspace?: string | null): boolean {
  const targetWorkspace = workspace ?? activeTodayWorkspace
  const existing = findOpenTodayWindow(targetWorkspace ?? undefined) ?? findOpenTodayWindow()
  if (existing) {
    if (!existing.ready) return true
    const { window } = existing
    if (window.isVisible() && window.isFocused()) {
      window.close()
    } else {
      focusMainWindow(window)
    }
    return true
  }
  if (!targetWorkspace) return false
  openTodayWindow({ workspace: targetWorkspace }, { stealFocus: true })
  return true
}

export function isTodayWindow(window: BrowserWindow | null): window is BrowserWindow {
  return !!window && lifecycle.has(window)
}

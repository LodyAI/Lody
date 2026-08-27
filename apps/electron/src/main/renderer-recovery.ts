import { app, BrowserWindow, type WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_LOG_BYTES = 4 * 1024 * 1024

let cachedLogFilePath: string | null = null

function resolveLogFilePath(): string {
  if (cachedLogFilePath) return cachedLogFilePath
  try {
    cachedLogFilePath = path.join(app.getPath('logs'), 'renderer-fatal.log')
  } catch {
    cachedLogFilePath = path.join(app.getPath('userData'), 'renderer-fatal.log')
  }
  return cachedLogFilePath
}

export type ReloadTarget =
  | { type: 'url'; url: string }
  | { type: 'file'; filePath: string; hash?: string }

type RendererWatchdogState = {
  reloadTarget: ReloadTarget | null
  mountTimer: NodeJS.Timeout | null
  unresponsiveTimer: NodeJS.Timeout | null
  hasNotifiedMounted: boolean
  inRecovery: boolean
}

const watchdogStates = new WeakMap<BrowserWindow, RendererWatchdogState>()

function getState(window: BrowserWindow): RendererWatchdogState {
  let state = watchdogStates.get(window)
  if (!state) {
    state = {
      reloadTarget: null,
      mountTimer: null,
      unresponsiveTimer: null,
      hasNotifiedMounted: false,
      inRecovery: false
    }
    watchdogStates.set(window, state)
  }
  return state
}

export function setReloadTarget(window: BrowserWindow, target: ReloadTarget): void {
  getState(window).reloadTarget = target
}

export function markRendererMounted(window: BrowserWindow): void {
  const state = getState(window)
  state.hasNotifiedMounted = true
  state.inRecovery = false
  if (state.mountTimer) {
    clearTimeout(state.mountTimer)
    state.mountTimer = null
  }
}

export function startMountWatchdog(
  window: BrowserWindow,
  options: { timeoutMs: number; onTimeout: () => void }
): void {
  const state = getState(window)
  if (state.mountTimer) clearTimeout(state.mountTimer)
  state.hasNotifiedMounted = false
  state.mountTimer = setTimeout(() => {
    state.mountTimer = null
    if (state.hasNotifiedMounted || state.inRecovery) return
    if (window.isDestroyed()) return
    options.onTimeout()
  }, options.timeoutMs)
}

export function clearMountWatchdog(window: BrowserWindow): void {
  const state = getState(window)
  if (state.mountTimer) {
    clearTimeout(state.mountTimer)
    state.mountTimer = null
  }
}

export function startUnresponsiveWatchdog(
  window: BrowserWindow,
  options: { timeoutMs: number; onTimeout: () => void }
): void {
  const state = getState(window)
  if (state.unresponsiveTimer) clearTimeout(state.unresponsiveTimer)
  state.unresponsiveTimer = setTimeout(() => {
    state.unresponsiveTimer = null
    if (window.isDestroyed()) return
    options.onTimeout()
  }, options.timeoutMs)
}

export function clearUnresponsiveWatchdog(window: BrowserWindow): void {
  const state = getState(window)
  if (state.unresponsiveTimer) {
    clearTimeout(state.unresponsiveTimer)
    state.unresponsiveTimer = null
  }
}

function loadTarget(window: BrowserWindow, target: ReloadTarget): Promise<void> {
  if (target.type === 'url') {
    return window.loadURL(target.url)
  }
  return window.loadFile(target.filePath, target.hash ? { hash: target.hash } : undefined)
}

export function requestRendererReload(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const state = getState(window)
  state.hasNotifiedMounted = false
  state.inRecovery = false
  const target = state.reloadTarget
  if (target) {
    void loadTarget(window, target).catch((error) => {
      console.error('[Electron] Failed to reload renderer', error)
    })
    return
  }
  window.webContents.reload()
}

export type RecoveryContext = {
  /** Short, human-readable error title (e.g. "Renderer process crashed"). */
  message: string
  /** Multi-line diagnostics (URL, codes, stack) appended to the title. */
  details: string
  /** Where the failure was observed (e.g. "render-process-gone"). */
  source: string
}

const RECOVERY_HASH_MESSAGE_LIMIT = 2048
const RECOVERY_HASH_DETAILS_LIMIT = 8192

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, limit) + '\n…(truncated; see logs)'
}

export function loadRecoveryPage(
  window: BrowserWindow,
  target: ReloadTarget,
  context: RecoveryContext
): void {
  if (window.isDestroyed()) return
  const state = getState(window)
  if (state.inRecovery) return
  state.inRecovery = true
  // Keep the URL hash under Chromium's practical limit. The full payload
  // also lands on disk via persistRendererFatalError so we don't lose it.
  const hash = new URLSearchParams({
    message: truncate(context.message, RECOVERY_HASH_MESSAGE_LIMIT),
    details: truncate(context.details, RECOVERY_HASH_DETAILS_LIMIT),
    source: context.source
  }).toString()
  if (target.type === 'url') {
    const recoveryUrl = new URL(target.url)
    recoveryUrl.hash = hash
    void window.loadURL(recoveryUrl.toString()).catch((error) => {
      console.error('[Electron] Failed to load recovery URL', { url: target.url, error })
    })
    return
  }
  void window.loadFile(target.filePath, { hash }).catch((error) => {
    console.error('[Electron] Failed to load recovery file', { filePath: target.filePath, error })
  })
}

export type RendererFatalPayload = {
  scope: string
  message: string
  details: string
  copied: boolean
}

export async function persistRendererFatalError(payload: RendererFatalPayload): Promise<void> {
  const filePath = resolveLogFilePath()
  const entry =
    `\n[${new Date().toISOString()}] scope=${payload.scope} copied=${payload.copied}\n` +
    `${payload.message}\n` +
    (payload.details ? `${payload.details}\n` : '') +
    '----\n'

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    let existing = ''
    try {
      existing = await fs.readFile(filePath, 'utf8')
    } catch {
      // First entry — log file doesn't exist yet.
    }
    let combined = existing + entry
    if (combined.length > MAX_LOG_BYTES) {
      combined = combined.slice(combined.length - MAX_LOG_BYTES)
    }
    await fs.writeFile(filePath, combined, 'utf8')
  } catch (error) {
    console.error('[Electron] Failed to persist renderer fatal log', { filePath, error })
  }
}

export function getRendererFatalLogPath(): string {
  return resolveLogFilePath()
}

export function isInRecovery(window: BrowserWindow): boolean {
  return getState(window).inRecovery
}

export function disposeWatchdogState(window: BrowserWindow): void {
  const state = watchdogStates.get(window)
  if (!state) return
  if (state.mountTimer) clearTimeout(state.mountTimer)
  if (state.unresponsiveTimer) clearTimeout(state.unresponsiveTimer)
  watchdogStates.delete(window)
}

export function findWindow(sender: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender)
}

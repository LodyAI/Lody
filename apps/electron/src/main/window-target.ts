import { app, type BrowserWindow } from 'electron'
import { IPC_PUSH_CHANNELS, type ElectronWindowTarget } from '@lody/shared/electron-ipc'
import { setReloadTarget, type ReloadTarget } from './renderer-recovery'
import { unmarkWarmWindow } from './window-state'

export function getWindowTargetPath(target: ElectronWindowTarget): string {
  const path = `/${target.workspace}` + (target.sessionId ? `/sessions/${target.sessionId}` : '')
  const search = new URLSearchParams({ window: target.sessionId ? 'session' : 'workspace' })
  if (target.sessionId) search.set('tab', `session:${target.sessionId}`)
  return `${path}?${search}`
}

/** Adopt the spare before sending navigation or exposing it to native window lifecycle events. */
export function presentWindowTarget(
  window: BrowserWindow,
  target: ElectronWindowTarget,
  reloadTarget: ReloadTarget
): void {
  if (window.isDestroyed()) return
  unmarkWarmWindow(window)
  setReloadTarget(window, reloadTarget)
  window.webContents.send(IPC_PUSH_CHANNELS.appWindowTarget, target)
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  app.focus({ steal: true })
  window.focus()
}

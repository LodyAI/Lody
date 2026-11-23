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

const pendingTargets = new Map<
  number,
  {
    target: ElectronWindowTarget
    reveal: () => void
    cancel: () => void
  }
>()

/** Only the claimed renderer's matching content acknowledgement can reveal it. */
export function handleWindowContentReady(webContentsId: number, raw: unknown): void {
  const pending = pendingTargets.get(webContentsId)
  if (!pending || !raw || typeof raw !== 'object') return
  const target = raw as Partial<ElectronWindowTarget>
  if (
    target.workspace !== pending.target.workspace ||
    target.sessionId !== pending.target.sessionId
  )
    return
  pending.reveal()
}

/** Adopt immediately, but present only after the target content has painted. */
export function presentWindowTarget(
  window: BrowserWindow,
  target: ElectronWindowTarget,
  reloadTarget: ReloadTarget
): void {
  if (window.isDestroyed()) return
  const id = window.webContents.id
  pendingTargets.get(id)?.cancel()
  unmarkWarmWindow(window)
  setReloadTarget(window, reloadTarget)
  const throttling = window.webContents.getBackgroundThrottling()
  window.webContents.setBackgroundThrottling(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    clearTimeout(timer)
    pendingTargets.delete(id)
    window.removeListener('closed', cancel)
    if (!window.isDestroyed()) window.webContents.setBackgroundThrottling(throttling)
  }
  const reveal = () => {
    cancel()
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    app.focus({ steal: true })
    window.focus()
  }
  pendingTargets.set(id, { target, reveal, cancel })
  window.once('closed', cancel)
  // A failed renderer must still expose its recovery UI; no opaque cover is used.
  timer = setTimeout(reveal, 5000)
  timer.unref?.()
  window.webContents.send(IPC_PUSH_CHANNELS.appWindowTarget, target)
}

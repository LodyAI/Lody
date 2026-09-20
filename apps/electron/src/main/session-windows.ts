import { createMainWindow } from './window'
import { claimWarmWindow, scheduleWindowWarmUp } from './window-warm-service'

export type WindowTarget = { workspace: string; sessionId?: string }

export function parseWindowTarget(raw: unknown): WindowTarget {
  const target = raw as Partial<WindowTarget> | null
  if (
    !target ||
    typeof target.workspace !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(target.workspace) ||
    (target.sessionId !== undefined &&
      (typeof target.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(target.sessionId)))
  ) {
    throw new Error('Invalid window target')
  }
  return { workspace: target.workspace, sessionId: target.sessionId }
}

export function openSessionWindow(target: WindowTarget): void {
  // Reuse the pre-warmed spare when one has finished booting; it already has
  // the app shell painted and is bound to the target without a reload.
  if (claimWarmWindow(target)) {
    return
  }

  const path = `/${target.workspace}` + (target.sessionId ? `/sessions/${target.sessionId}` : '')
  const search = new URLSearchParams({ window: target.sessionId ? 'session' : 'workspace' })
  if (target.sessionId) search.set('tab', `session:${target.sessionId}`)
  const window = createMainWindow({ auxiliary: true, initialPath: `${path}?${search}` })
  // Let the first requested auxiliary window reach its first paint before
  // allocating a replacement renderer. Subsequent opens still reuse the spare.
  window.once('ready-to-show', scheduleWindowWarmUp)
}

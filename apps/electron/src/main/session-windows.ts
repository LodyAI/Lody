import { createMainWindow } from './window'

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
  const path = `/${target.workspace}` + (target.sessionId ? `/sessions/${target.sessionId}` : '')
  const search = new URLSearchParams({ window: target.sessionId ? 'session' : 'workspace' })
  if (target.sessionId) search.set('tab', `session:${target.sessionId}`)
  createMainWindow({ auxiliary: true, initialPath: `${path}?${search}` })
}

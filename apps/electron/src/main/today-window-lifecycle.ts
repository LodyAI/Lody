import type { TodayWindowTarget } from './today-window-target'

type TodayLifecycleWindow = {
  isDestroyed(): boolean
  isFullScreen(): boolean
  setFullScreen(flag: boolean): void
  hide(): void
  close(): void
  destroy(): void
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
  once(event: 'closed' | 'leave-full-screen', listener: () => void): unknown
  webContents: {
    send(channel: string, payload: unknown): void
    on(event: 'render-process-gone', listener: () => void): unknown
    on(
      event: 'did-start-navigation',
      listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
    ): unknown
  }
}

type TodayWindowLifecycleDeps<W extends TodayLifecycleWindow> = {
  create(target: TodayWindowTarget): W
  focus(window: W): void
  bindChannel: string
  canPark(window: W): boolean
  setParked(window: W, parked: boolean): void
  setTimer(callback: () => void, ms: number): () => void
  revealDeadlineMs: number
  onReopened(window: W, target: TodayWindowTarget, elapsedMs: number): void
}

type Entry<W> = {
  window: W
  bindingId: number
  ready: boolean
  pending: { cancel(): void; requestedAt: number; target: TodayWindowTarget } | null
}

export function createTodayWindowLifecycle<W extends TodayLifecycleWindow>(
  deps: TodayWindowLifecycleDeps<W>
) {
  const entries = new Map<string, Entry<W>>()
  let parked: Entry<W> | null = null

  const park = (entry: Entry<W>) => {
    const { window } = entry
    parked?.window.destroy()
    parked = entry
    deps.setParked(window, true)
    window.webContents.send(deps.bindChannel, null)
    if (window.isFullScreen()) {
      window.once('leave-full-screen', () => {
        if (parked === entry && !window.isDestroyed()) window.hide()
      })
      window.setFullScreen(false)
    } else {
      window.hide()
    }
  }

  const create = (target: TodayWindowTarget): W => {
    const window = deps.create(target)
    const entry: Entry<W> = { window, bindingId: 0, ready: false, pending: null }
    entries.set(target.workspace, entry)
    window.on('close', (event) => {
      if (parked === entry || !entry.ready || !deps.canPark(window)) return
      event.preventDefault()
      park(entry)
    })
    window.webContents.on('render-process-gone', () => {
      entry.ready = false
      if (parked === entry && !window.isDestroyed()) window.destroy()
    })
    window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return
      entry.ready = false
      if (parked === entry && !window.isDestroyed()) window.destroy()
    })
    window.once('closed', () => {
      entry.pending?.cancel()
      if (parked === entry) parked = null
      if (entries.get(target.workspace) === entry) entries.delete(target.workspace)
    })
    return window
  }

  return {
    open(target: TodayWindowTarget): W {
      const entry = entries.get(target.workspace)
      if (!entry || entry.window.isDestroyed()) return create(target)
      const { window } = entry
      if (parked === entry) {
        parked = null
        entry.ready = false
        entry.bindingId += 1
        const cancel = deps.setTimer(() => {
          const shouldReopen = deps.canPark(window)
          window.destroy()
          if (shouldReopen) create(target)
        }, deps.revealDeadlineMs)
        entry.pending = { cancel, target, requestedAt: performance.now() }
        window.webContents.send(deps.bindChannel, {
          member: target.member,
          date: target.date,
          bindingId: entry.bindingId
        })
      } else if (!entry.pending) {
        deps.focus(window)
      }
      return window
    },
    committed(window: W, bindingId: number): void {
      for (const entry of entries.values()) {
        if (entry.window !== window || parked === entry) continue
        if (entry.pending && entry.bindingId !== bindingId) return
        entry.ready = true
        if (!entry.pending) return
        const { cancel, target, requestedAt } = entry.pending
        entry.pending = null
        cancel()
        deps.setParked(window, false)
        deps.focus(window)
        deps.onReopened(window, target, Math.round(performance.now() - requestedAt))
        return
      }
    },
    close(window: W): void {
      for (const entry of entries.values()) {
        if (entry.window !== window) continue
        entry.ready = false
        window.close()
        return
      }
    },
    hasWorkspace(workspace: string): boolean {
      const entry = entries.get(workspace)
      return !!entry && !entry.window.isDestroyed()
    },
    has(window: unknown): boolean {
      return [...entries.values()].some(
        (entry) => entry.window === window && !entry.window.isDestroyed()
      )
    }
  }
}

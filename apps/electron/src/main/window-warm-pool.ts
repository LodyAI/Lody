/**
 * Tracks the single spare auxiliary renderer kept warm for reuse by the next
 * window open. The pool owns no Electron objects: it only holds window ids and
 * asks a caller-supplied `isAlive` predicate before handing one out, so the
 * lifecycle transitions can be tested without an Electron runtime.
 *
 * A warm window moves through `warming` (created, renderer still booting) to
 * `ready` (renderer reported its shell painted). `claimReady` is the only way a
 * window leaves the pool for real use; a claimed window is never returned.
 */
export type WarmWindowEntry = {
  /** `BrowserWindow.id`. */
  windowId: number
  /** `webContents.id`, used to correlate the renderer's ready signal. */
  webContentsId: number
}

export type WarmWindowPoolPhase = 'idle' | 'warming' | 'ready'

export class WindowWarmPool {
  private warming: WarmWindowEntry | null = null
  private ready: WarmWindowEntry | null = null
  private readonly isAlive: (entry: WarmWindowEntry) => boolean

  constructor(isAlive: (entry: WarmWindowEntry) => boolean = () => true) {
    this.isAlive = isAlive
  }

  get phase(): WarmWindowPoolPhase {
    if (this.ready && this.isAlive(this.ready)) return 'ready'
    if (this.warming && this.isAlive(this.warming)) return 'warming'
    return 'idle'
  }

  /** True while a spare exists, whether or not it has finished booting. */
  hasSpare(): boolean {
    return this.phase !== 'idle'
  }

  /**
   * Registers a newly created window as the warming spare. A second call while
   * a live spare exists is ignored so only one renderer is ever warmed.
   */
  beginWarming(entry: WarmWindowEntry): void {
    if (this.hasSpare()) return
    this.warming = entry
  }

  /**
   * Promotes the warming window once its renderer has painted. Returns true
   * only for the currently warming webContents; an unknown or duplicate signal
   * is rejected so callers can drop the extra window instead of leaking it.
   */
  markReady(webContentsId: number): boolean {
    const warming = this.warming
    if (!warming || warming.webContentsId !== webContentsId) return false
    if (!this.isAlive(warming)) {
      this.warming = null
      return false
    }
    this.warming = null
    if (this.ready && !this.isAlive(this.ready)) {
      this.ready = null
    }
    // Only one ready spare is useful; a duplicate ready signal is rejected.
    if (this.ready) return false
    this.ready = warming
    return true
  }

  /**
   * Takes the ready spare for reuse. Returns null when nothing has finished
   * booting, in which case the caller must fall back to a cold window.
   */
  claimReady(): WarmWindowEntry | null {
    const ready = this.ready
    this.ready = null
    if (!ready || !this.isAlive(ready)) return null
    return ready
  }

  /** Drops a window that closed or failed from either phase. */
  forget(entry: WarmWindowEntry): void {
    if (this.warming?.windowId === entry.windowId) this.warming = null
    if (this.ready?.windowId === entry.windowId) this.ready = null
  }

  /** Drops a window by renderer id when only the webContents id is known. */
  forgetWebContents(webContentsId: number): void {
    if (this.warming?.webContentsId === webContentsId) this.warming = null
    if (this.ready?.webContentsId === webContentsId) this.ready = null
  }
}

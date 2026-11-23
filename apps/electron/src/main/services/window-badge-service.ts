import { app, BrowserWindow } from 'electron'

/**
 * Per-window badge contribution: how many sessions in this window's workspace
 * are unread or waiting-on-permission for the current user.
 *
 * The renderer is responsible for filtering by workspace + ownership; the
 * main process just sums what the windows report.
 */
export type WindowBadge = {
  unread: number
  waiting: number
}

export type AggregatedBadge = {
  unread: number
  waiting: number
  /** True iff at least one window has any waiting-permission count. */
  bounce: boolean
}

const ZERO_BADGE: WindowBadge = { unread: 0, waiting: 0 }

/**
 * Pure aggregator. Sums unread and waiting counts across all windows. We sum
 * (rather than max) so multi-window setups across workspaces accumulate
 * correctly: two windows with 3 unread in workspace A + 2 unread in workspace
 * B should surface "5 things to read" on the dock.
 *
 * `bounce` is purely a signal — the caller decides whether to translate it
 * into a real dock bounce, and only on rising edge.
 */
export function aggregateBadges(badges: Iterable<WindowBadge>): AggregatedBadge {
  let unread = 0
  let waiting = 0
  for (const b of badges) {
    unread += b.unread
    waiting += b.waiting
  }
  return { unread, waiting, bounce: waiting > 0 }
}

export function badgeTotalCount(b: AggregatedBadge): number {
  return b.unread + b.waiting
}

export function parseWindowBadge(raw: unknown): WindowBadge | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const unread = r.unread
  const waiting = r.waiting
  if (typeof unread !== 'number' || !Number.isInteger(unread) || unread < 0) return undefined
  if (typeof waiting !== 'number' || !Number.isInteger(waiting) || waiting < 0) return undefined
  return { unread, waiting }
}

type DockApi = Pick<NonNullable<typeof app.dock>, 'setBadge' | 'bounce'>
type AppApi = Pick<typeof app, 'setBadgeCount'>
type Platform = NodeJS.Platform

type WindowBadgeServiceOptions = {
  platform?: Platform
  /** Allow tests to inject mock dock/app APIs. */
  getDock?: () => DockApi | undefined
  getApp?: () => AppApi
}

export class WindowBadgeService {
  private readonly badges = new Map<number, WindowBadge>()
  private last: AggregatedBadge = { unread: 0, waiting: 0, bounce: false }
  private readonly platform: Platform
  private readonly getDock: () => DockApi | undefined
  private readonly getApp: () => AppApi

  constructor(options: WindowBadgeServiceOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.getDock = options.getDock ?? (() => app.dock)
    this.getApp = options.getApp ?? (() => app)
  }

  setBadge(windowId: number, badge: WindowBadge): void {
    this.badges.set(windowId, badge)
    this.apply()
  }

  clearWindow(windowId: number): void {
    if (!this.badges.has(windowId)) return
    this.badges.delete(windowId)
    this.apply()
  }

  /** Force-clear all state and the OS badge. Use on quit. */
  reset(): void {
    this.badges.clear()
    this.last = { unread: 0, waiting: 0, bounce: false }
    this.write(this.last, false)
  }

  /** Visible for tests. */
  getAggregated(): AggregatedBadge {
    return this.last
  }

  private apply(): void {
    const next = aggregateBadges(this.badges.values())
    const shouldBounce = next.bounce && !this.last.bounce
    this.last = next
    this.write(next, shouldBounce)
  }

  private write(next: AggregatedBadge, bounce: boolean): void {
    const total = badgeTotalCount(next)
    if (this.platform === 'darwin') {
      const dock = this.getDock()
      if (!dock) return
      try {
        dock.setBadge(total > 0 ? String(total) : '')
        if (bounce) dock.bounce('informational')
      } catch (error) {
        console.warn('[WindowBadgeService] failed to update dock badge', error)
      }
      return
    }
    if (this.platform === 'win32') {
      // No Windows taskbar badge: the overlay-icon dot rendered far too large
      // on the taskbar button and looked bad, so we dropped it rather than
      // fight Windows' overlay sizing. unread/waiting still drive in-app UI.
      return
    }
    // Linux Unity launcher and similar; no-op on other DEs.
    try {
      this.getApp().setBadgeCount(total)
    } catch (error) {
      console.warn('[WindowBadgeService] failed to update badge count', error)
    }
  }
}

/** Wire `BrowserWindow` lifecycle into the service so closed windows drop their contributions. */
export function bindWindowBadgeToBrowserWindows(service: WindowBadgeService): void {
  // 'browser-window-removed' isn't on Electron's TS types in this version,
  // so hook each window's `closed` event when it's created instead.
  app.on('browser-window-created', (_event, window: BrowserWindow) => {
    const { id } = window
    // A crashed/reloaded renderer cannot run React's unmount cleanup. Its old
    // contribution must not survive a new workspace owner taking over.
    window.webContents.on('render-process-gone', () => service.clearWindow(id))
    window.webContents.on(
      'did-start-navigation',
      (_navigationEvent, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) service.clearWindow(id)
      }
    )
    window.once('closed', () => {
      service.clearWindow(id)
    })
  })
}

export const ZERO_WINDOW_BADGE = ZERO_BADGE

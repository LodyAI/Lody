import { WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import {
  ELECTRON_PUBLIC_BROWSER_STATE_CHANNEL,
  type ElectronPublicBrowserBounds,
  type ElectronPublicBrowserResult,
  type ElectronPublicBrowserState
} from '@lody/shared/electron-ipc'
import { parseBrowserAddress } from '@lody/shared/browser-url'
import { formatUnknownError } from '../utils'
import { isNavigationAbortError, mergePublicBrowserState } from './public-browser-state'

type PublicBrowserRecord = {
  browserId: string
  view: WebContentsView
  window: BrowserWindow
  state: ElectronPublicBrowserState
  visible: boolean
  lastUsedAt: number
  navigationSequence: number
}

const MAX_PUBLIC_BROWSER_RECORDS = 8

const toPartitionName = (browserId: string): string =>
  `lody-public-browser-${browserId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 120)}`

const toState = (
  record: PublicBrowserRecord,
  patch: Partial<ElectronPublicBrowserState> = {}
): ElectronPublicBrowserState =>
  mergePublicBrowserState(
    record.state,
    {
      committedUrl: record.view.webContents.getURL() || undefined,
      committedTitle: record.view.webContents.getTitle() || undefined,
      canGoBack: record.view.webContents.navigationHistory.canGoBack(),
      canGoForward: record.view.webContents.navigationHistory.canGoForward()
    },
    patch
  )

/**
 * The only check on a public-browser navigation is engine routing: the address must parse as
 * public-web, so a loopback address goes to Managed Preview instead of being shown from this
 * machine. That is a check on the hostname TEXT, not on where it resolves — a public name
 * with a loopback `A` record (`localtest.me`, `127.0.0.1.nip.io`) still renders here, showing
 * this machine's own loopback rather than the agent's. That is a routing miss, not an
 * exposure: it is the user's own machine, reachable from their own Chrome. Resolving every
 * hostname to close it is exactly the guard removed below, and it cost every fake-IP proxy
 * user their browser.
 *
 * There is deliberately NO network guard here — no resolver check, no per-request hostname
 * policy. This view is a plain sandboxed `WebContentsView` with no preload, no script
 * injection, no page capture, and no agent-facing tool; the only thing that reads what it
 * renders is the person looking at it. It is therefore strictly less capable than the user's
 * own Chrome, which happily reaches the same LAN, and a DNS guard bought nothing except a
 * broken browser for everyone behind a fake-IP proxy. If this view ever gains a non-human
 * reader — agent DOM access, screenshots, a preload bridge — that guard must come back,
 * attached to the agent-driven path rather than to human navigation.
 */
const assertPublicUrl = (rawUrl: string): string => {
  const parsed = parseBrowserAddress(rawUrl)
  if (parsed.engine !== 'public-web') {
    throw new Error('Public browser only accepts public HTTP(S) destinations.')
  }
  return parsed.logicalUrl
}

const normalizeBounds = (window: BrowserWindow, bounds: ElectronPublicBrowserBounds): Rectangle => {
  const [contentWidth, contentHeight] = window.getContentSize()
  const normalized = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
  if (
    normalized.x < 0 ||
    normalized.y < 0 ||
    normalized.width < 1 ||
    normalized.height < 1 ||
    normalized.x + normalized.width > contentWidth ||
    normalized.y + normalized.height > contentHeight
  ) {
    throw new Error('Public browser bounds are outside the main window content area.')
  }
  return {
    x: normalized.x,
    y: normalized.y,
    width: Math.min(normalized.width, contentWidth - normalized.x),
    height: Math.min(normalized.height, contentHeight - normalized.y)
  }
}

export class PublicBrowserService {
  private readonly records = new Map<string, PublicBrowserRecord>()
  private readonly observedWindows = new WeakSet<BrowserWindow>()

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  create(browserId: string, bounds: ElectronPublicBrowserBounds): ElectronPublicBrowserResult {
    try {
      const existing = this.records.get(browserId)
      if (existing && !existing.window.isDestroyed() && !existing.view.webContents.isDestroyed()) {
        existing.view.setBounds(normalizeBounds(existing.window, bounds))
        existing.view.setVisible(true)
        existing.visible = true
        existing.lastUsedAt = performance.now()
        this.publish(existing)
        return { ok: true, state: existing.state }
      }
      if (existing) this.destroy(browserId)

      const window = this.getMainWindow()
      if (!window || window.isDestroyed()) {
        return { ok: false, error: 'The main Electron window is not available.' }
      }

      const capacityFailure = this.evictHiddenRecordAtCapacity()
      if (capacityFailure) return { ok: false, error: capacityFailure }
      const view = new WebContentsView({
        webPreferences: {
          partition: toPartitionName(browserId),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          disableBlinkFeatures: 'WebRTC',
          spellcheck: false
        }
      })
      const record: PublicBrowserRecord = {
        browserId,
        view,
        window,
        state: {
          browserId,
          phase: 'idle',
          canGoBack: false,
          canGoForward: false
        },
        visible: true,
        lastUsedAt: performance.now(),
        navigationSequence: 0
      }
      this.records.set(browserId, record)
      this.configureSession(record)
      this.configureWebContents(record)
      window.contentView.addChildView(view)
      view.setBounds(normalizeBounds(window, bounds))
      view.setVisible(true)
      if (!this.observedWindows.has(window)) {
        this.observedWindows.add(window)
        window.once('closed', () => this.destroyWindowRecords(window))
      }
      this.publish(record)
      return { ok: true, state: record.state }
    } catch (error) {
      const partialRecord = this.records.get(browserId)
      if (partialRecord) this.disposeRecord(partialRecord)
      return { ok: false, error: formatUnknownError(error) }
    }
  }

  async navigate(browserId: string, rawUrl: string): Promise<ElectronPublicBrowserResult> {
    const record = this.records.get(browserId)
    if (!record) return { ok: false, error: 'Public browser surface has not been created.' }
    const navigationSequence = ++record.navigationSequence
    try {
      record.lastUsedAt = performance.now()
      const url = assertPublicUrl(rawUrl)
      if (record.navigationSequence !== navigationSequence) {
        return { ok: true, state: record.state }
      }
      if (record.state.phase === 'ready' && record.view.webContents.getURL() === url) {
        this.publish(record, { phase: 'ready', error: undefined, blockedUrl: undefined })
        return { ok: true, state: record.state }
      }
      this.publish(record, { phase: 'loading', url, error: undefined, blockedUrl: undefined })
      await record.view.webContents.loadURL(url)
      if (record.navigationSequence !== navigationSequence) {
        return { ok: true, state: record.state }
      }
      return { ok: true, state: record.state }
    } catch (error) {
      if (record.navigationSequence !== navigationSequence || isNavigationAbortError(error)) {
        return { ok: true, state: record.state }
      }
      const message = formatUnknownError(error)
      this.publish(record, { phase: 'error', error: message })
      return { ok: false, error: message }
    }
  }

  goBack(browserId: string): ElectronPublicBrowserResult {
    const record = this.records.get(browserId)
    if (!record) return { ok: false, error: 'Public browser surface has not been created.' }
    if (!record.view.webContents.navigationHistory.canGoBack()) {
      return { ok: false, error: 'No previous public browser history entry.' }
    }
    record.navigationSequence += 1
    record.view.webContents.navigationHistory.goBack()
    return { ok: true, state: record.state }
  }

  goForward(browserId: string): ElectronPublicBrowserResult {
    const record = this.records.get(browserId)
    if (!record) return { ok: false, error: 'Public browser surface has not been created.' }
    if (!record.view.webContents.navigationHistory.canGoForward()) {
      return { ok: false, error: 'No next public browser history entry.' }
    }
    record.navigationSequence += 1
    record.view.webContents.navigationHistory.goForward()
    return { ok: true, state: record.state }
  }

  reload(browserId: string): ElectronPublicBrowserResult {
    const record = this.records.get(browserId)
    if (!record) return { ok: false, error: 'Public browser surface has not been created.' }
    record.navigationSequence += 1
    record.view.webContents.reload()
    return { ok: true, state: record.state }
  }

  stop(browserId: string): ElectronPublicBrowserResult {
    const record = this.records.get(browserId)
    if (!record) return { ok: false, error: 'Public browser surface has not been created.' }
    record.navigationSequence += 1
    record.view.webContents.stop()
    this.publish(record, { phase: record.view.webContents.getURL() ? 'ready' : 'idle' })
    return { ok: true, state: record.state }
  }

  setBounds(browserId: string, bounds: ElectronPublicBrowserBounds): ElectronPublicBrowserResult {
    const record = this.records.get(browserId)
    if (!record) return { ok: false, error: 'Public browser surface has not been created.' }
    try {
      record.view.setBounds(normalizeBounds(record.window, bounds))
      return { ok: true, state: record.state }
    } catch (error) {
      return { ok: false, error: formatUnknownError(error) }
    }
  }

  setVisible(browserId: string, visible: boolean): ElectronPublicBrowserResult {
    const record = this.records.get(browserId)
    if (!record) return { ok: false, error: 'Public browser surface has not been created.' }
    record.view.setVisible(visible)
    record.visible = visible
    record.lastUsedAt = performance.now()
    return { ok: true, state: record.state }
  }

  destroy(browserId: string): ElectronPublicBrowserResult {
    const record = this.records.get(browserId)
    if (!record) return { ok: false, error: 'Public browser surface has not been created.' }
    this.disposeRecord(record)
    return { ok: true, state: record.state }
  }

  destroyAll(): void {
    for (const browserId of [...this.records.keys()]) this.destroy(browserId)
  }

  private configureSession(record: PublicBrowserRecord): void {
    const browserSession = record.view.webContents.session
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    browserSession.on('will-download', (event) => event.preventDefault())
  }

  private configureWebContents(record: PublicBrowserRecord): void {
    const contents = record.view.webContents
    contents.setWindowOpenHandler((details) => {
      void this.navigate(record.browserId, details.url)
      return { action: 'deny' }
    })
    // Both events, as `installNavigationGuard` in `window.ts` does. `will-navigate`
    // does not fire for a server-side 3xx, so a public page redirecting to loopback
    // would otherwise commit here — the engine split has to hold for the hop the
    // server chose, not only the one the page did.
    const enforceEngineRouting = (details: { url: string; preventDefault: () => void }): void => {
      try {
        if (parseBrowserAddress(details.url).engine === 'public-web') return
      } catch {
        // The structured error is published below.
      }
      details.preventDefault()
      this.publish(record, {
        phase: 'error',
        error: 'Navigation left the public web boundary.',
        blockedUrl: details.url
      })
    }
    contents.on('will-navigate', enforceEngineRouting)
    contents.on('will-redirect', enforceEngineRouting)
    contents.on('did-start-loading', () => {
      this.publish(record, { phase: 'loading', error: undefined, blockedUrl: undefined })
    })
    contents.on('did-stop-loading', () => {
      this.publish(
        record,
        record.state.phase === 'error' ? {} : { phase: contents.getURL() ? 'ready' : 'idle' }
      )
    })
    contents.on('did-navigate', (_event, url) => this.publish(record, { url }))
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) this.publish(record, { url })
    })
    contents.on('page-title-updated', (_event, title) => this.publish(record, { title }))
    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || isNavigationAbortError({ errno: errorCode })) return
        this.publish(record, {
          phase: 'error',
          url: validatedURL,
          error: errorDescription
        })
      }
    )
    contents.on('render-process-gone', (_event, details) => {
      this.publish(record, {
        phase: 'crashed',
        error: `Public browser renderer exited: ${details.reason}`
      })
    })
  }

  private publish(
    record: PublicBrowserRecord,
    patch: Partial<ElectronPublicBrowserState> = {}
  ): void {
    record.state = toState(record, patch)
    if (!record.window.isDestroyed()) {
      record.window.webContents.send(ELECTRON_PUBLIC_BROWSER_STATE_CHANNEL, record.state)
    }
  }

  private evictHiddenRecordAtCapacity(): string | null {
    if (this.records.size < MAX_PUBLIC_BROWSER_RECORDS) return null
    const candidate = [...this.records.values()]
      .filter((record) => !record.visible)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]
    if (!candidate) {
      return `Public browser capacity reached (${MAX_PUBLIC_BROWSER_RECORDS}) with no hidden surface available for eviction.`
    }
    this.destroy(candidate.browserId)
    return null
  }

  private destroyWindowRecords(window: BrowserWindow): void {
    for (const record of [...this.records.values()]) {
      if (record.window === window) this.destroy(record.browserId)
    }
  }

  private disposeRecord(record: PublicBrowserRecord): void {
    this.records.delete(record.browserId)
    if (!record.window.isDestroyed()) record.window.contentView.removeChildView(record.view)
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close()
  }
}

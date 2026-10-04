import { BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type {
  SessionOwnerEvent,
  SessionOwnerRequest,
  SessionOwnerResult
} from '@lody/shared/session-owner-protocol'
import { isLocalPlatform, readLocalPlatformSnapshot } from '../platform'
import { productWindows } from '../window-state'

/** Main owns the hidden data renderer and fences every document incarnation. */
export class SessionOwnerService {
  private owner: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private clients = new Map<WebContents, { id: string; leases: Set<string> }>()
  private pending = new Map<
    string,
    {
      resolve: (result: SessionOwnerResult) => void
      clientId: string
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private stopping = false
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private workspace: ReturnType<typeof readLocalPlatformSnapshot> | null = null

  get enabled(): boolean {
    return isLocalPlatform() && process.env['LODY_SHARED_SESSION_OWNER'] !== '0'
  }

  configure(sender: WebContents): { enabled: boolean } {
    if (this.enabled) {
      this.attach(sender)
      void this.ensureOwner().catch((error) =>
        console.error('[Session owner] Startup failed', error)
      )
    }
    return { enabled: this.enabled }
  }

  isOwner(sender: WebContents): boolean {
    return this.owner !== null && !this.owner.isDestroyed() && sender === this.owner.webContents
  }

  private ensureOwner(): Promise<void> {
    if (this.ready) return this.ready
    if (this.stopping || !this.enabled)
      return Promise.reject(new Error('Session owner unavailable'))
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    const window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    this.owner = window
    this.startupTimer = setTimeout(() => this.lost(window), 30_000)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.once('render-process-gone', () => this.lost(window))
    window.once('unresponsive', () => this.lost(window))
    window.once('closed', () => this.lost(window))
    const load =
      is.dev && process.env['ELECTRON_RENDERER_URL']
        ? window.loadURL(new URL('session-owner.html', process.env['ELECTRON_RENDERER_URL']).href)
        : window.loadFile(join(__dirname, '../renderer/session-owner.html'))
    void load.catch(() => this.lost(window))
    return this.ready
  }

  private lost(window: BrowserWindow): void {
    if (this.owner !== window) return
    clearTimeout(this.startupTimer)
    this.owner = null
    this.ready = null
    this.rejectReady?.(new Error('Session owner stopped'))
    this.resolveReady = null
    this.rejectReady = null
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer)
      request.resolve({ ok: false, error: 'Session owner stopped; command outcome may be unknown' })
      this.pending.delete(id)
    }
    for (const [sender, client] of this.clients) {
      if (sender.isDestroyed()) continue
      if (!this.stopping)
        for (const leaseId of client.leases)
          sender.send('sessionOwner.event', {
            kind: 'lost',
            clientId: client.id,
            leaseId,
            generation: '',
            sequence: 0,
            error: 'Session owner stopped'
          } satisfies SessionOwnerEvent)
      client.leases.clear()
    }
    if (!window.isDestroyed()) window.destroy()
  }

  private attach(sender: WebContents) {
    let client = this.clients.get(sender)
    if (client) return client
    client = { id: crypto.randomUUID(), leases: new Set<string>() }
    this.clients.set(sender, client)
    const expected = client
    const release = () => {
      const previous = this.clients.get(sender)
      if (!previous || previous !== expected) return
      this.clients.delete(sender)
      if (this.owner && !this.owner.isDestroyed())
        this.owner.webContents.send('sessionOwner.releaseClient', previous.id)
      for (const [id, request] of this.pending)
        if (request.clientId === previous.id) {
          clearTimeout(request.timer)
          this.pending.delete(id)
          request.resolve({ ok: false, error: 'Session view closed' })
        }
      setImmediate(() => {
        if (!productWindows.size && !this.clients.size) void this.shutdown().catch(console.error)
      })
    }
    sender.once('destroyed', release)
    sender.once('did-navigate', release)
    return client
  }

  async request(sender: WebContents, request: SessionOwnerRequest): Promise<SessionOwnerResult> {
    const snapshot = await (this.workspace ??= readLocalPlatformSnapshot())
    if (!snapshot) this.workspace = null
    if (!snapshot || request.workspaceId !== snapshot.workspace.workspaceId)
      throw new Error('Session owner workspace mismatch')
    const client = this.attach(sender)
    await this.ensureOwner()
    if (sender.isDestroyed() || this.clients.get(sender) !== client)
      throw new Error('Session view closed')
    if (request.method === 'open') client.leases.add(request.leaseId)
    if (request.method === 'close') client.leases.delete(request.leaseId)
    return this.forward(client.id, request)
  }

  private forward(
    clientId: string,
    request: SessionOwnerRequest | 'shutdown'
  ): Promise<SessionOwnerResult> {
    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({
          ok: false,
          error: 'Session owner request timed out; command outcome may be unknown'
        })
      }, 30_000)
      this.pending.set(requestId, { resolve, timer, clientId })
      this.owner?.webContents.send('sessionOwner.request', { requestId, clientId, request })
    })
  }

  markReady(sender: WebContents): void {
    if (!this.isOwner(sender)) throw new Error('Untrusted session owner')
    clearTimeout(this.startupTimer)
    this.resolveReady?.()
    this.resolveReady = null
    this.rejectReady = null
  }

  reply(sender: WebContents, requestId: string, result: SessionOwnerResult): void {
    if (!this.isOwner(sender)) throw new Error('Untrusted session owner')
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(result)
  }

  publish(sender: WebContents, event: SessionOwnerEvent): void {
    if (!this.isOwner(sender)) throw new Error('Untrusted session owner')
    for (const [target, client] of this.clients)
      if (
        client.id === event.clientId &&
        client.leases.has(event.leaseId) &&
        !target.isDestroyed()
      ) {
        target.send('sessionOwner.event', event)
        return
      }
  }

  async shutdown(): Promise<void> {
    if (!this.owner || this.stopping) return
    this.stopping = true
    const window = this.owner
    try {
      await this.ready
      const result = await this.forward('', 'shutdown')
      if (!result.ok) throw new Error(result.error)
    } finally {
      this.lost(window)
      this.stopping = false
    }
  }
}

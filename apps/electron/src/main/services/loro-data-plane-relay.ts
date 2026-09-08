import net from 'node:net'
import type { WebContents } from 'electron'
import {
  createJsonLineSplitter,
  LocalLoroDataPlaneServerMessageSchema,
  LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlaneServerMessage
} from '@lody/shared/local-loro-data-plane'

// Liveness watchdog (plan-mandated idle watchdog for the data plane): ping the
// daemon on an interval and treat a silent socket as dead — a stalled push
// channel must surface as `disconnected` (renderers show degraded state and
// rejoin on recovery), never as a permanently stale UI.
const PING_INTERVAL_MS = 15_000
const IDLE_TIMEOUT_MS = 45_000

// Redial backoff while any renderer is attached: the daemon restarting (or
// starting after Electron) must never require a window reload to resync.
const REDIAL_MIN_DELAY_MS = 1_000
const REDIAL_MAX_DELAY_MS = 30_000

// Hard memory cap for renderer→daemon frames queued while the daemon socket is
// applying backpressure. Renderer traffic is CRDT deltas (small); hitting
// this means the daemon stopped reading entirely, so reconnecting (and letting
// join reconciliation reconverge) beats buffering without bound. This is a
// safety net, NOT flow control — ordinary backpressure just queues and drains.
const PENDING_DAEMON_WRITES_MAX_BYTES = 64 * 1024 * 1024

type PendingDaemonWrite = {
  line: string
}

type RendererSendChannel = 'loro.event' | 'loro.status'

const RENDERER_DISPOSAL_ERROR_MESSAGES = new Set([
  'Object has been destroyed',
  'Render frame was disposed before WebFrameMain could be accessed'
])

function isRendererDisposalError(error: unknown): boolean {
  return error instanceof Error && RENDERER_DISPOSAL_ERROR_MESSAGES.has(error.message)
}

/**
 * Persistent bridge between renderer windows and the CLI data-plane push server.
 * This holds one long-lived socket to the daemon: it forwards renderer client
 * messages and fans server pushes out to EVERY attached renderer via
 * `webContents.send` (a dumb broadcast pipe — protocol v3 messages are
 * peer-addressed, and renderer adapters filter by workspaceId + peerId), plus a
 * connection-status channel the renderer's transport uses to drive resync.
 *
 * Peer lifecycle: the relay records which peerIds each WebContents has used and
 * synthesizes a `detach` for them when the window is destroyed or navigates
 * (reload) — a dead renderer cannot send its own goodbye, and without it the
 * daemon would hold its room subscriptions for the life of the shared socket.
 */
export class LoroDataPlaneRelay {
  private readonly socketPath: string
  private readonly createSocket: (socketPath: string) => net.Socket
  private readonly afterRendererAliveCheck?: (
    sender: WebContents,
    channel: RendererSendChannel
  ) => void
  private socket: net.Socket | null = null
  private connecting: Promise<void> | null = null
  private connected = false
  private enabled = true
  private destroyed = false
  private readonly senders = new Set<WebContents>()
  // sender → (peerId → workspaceId), for synthesized detach.
  private readonly sendersPeers = new Map<WebContents, Map<string, string>>()
  private redialTimer: NodeJS.Timeout | null = null
  private redialAttempt = 0
  private pingTimer: NodeJS.Timeout | null = null
  private lastInboundAt = 0
  private e2eReconnectWaiter: { reject: (error: Error) => void; resolve: () => void } | null = null
  // Drain-aware outbound queue for the daemon socket (see write()).
  private daemonWriteBlocked = false
  private pendingDaemonWrites: PendingDaemonWrite[] = []
  private pendingDaemonBytes = 0

  constructor(
    socketPath: string,
    createSocket: (socketPath: string) => net.Socket = (path) => net.createConnection(path),
    afterRendererAliveCheck?: (sender: WebContents, channel: RendererSendChannel) => void
  ) {
    this.socketPath = socketPath
    this.createSocket = createSocket
    this.afterRendererAliveCheck = afterRendererAliveCheck
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled || this.destroyed) return
    this.enabled = enabled

    if (enabled) {
      if (this.senders.size > 0) {
        void this.ensureConnected().catch(() => this.scheduleRedial())
      }
      return
    }

    this.clearRedialTimer()
    this.stopPingLoop()
    this.clearPendingDaemonWrites()
    this.sendersPeers.clear()
    const socket = this.socket
    this.socket = null
    this.setConnected(false)
    socket?.destroy(new Error('loro_data_plane_relay_disabled'))
  }

  attachSender(sender: WebContents | undefined): void {
    if (!sender || sender.isDestroyed()) return
    if (!this.senders.has(sender)) {
      this.senders.add(sender)
      const releasePeers = (): void => this.releaseSenderPeers(sender)
      sender.once('destroyed', () => this.releaseSender(sender))
      // A main-frame navigation (incl. reload) tears down the JS context: its
      // adapters are gone and will rejoin with fresh peerIds, so detach the old
      // ones server-side.
      sender.on('did-navigate', releasePeers)
      // Seed the newly-attached renderer with the current connection state so its
      // transport can join immediately when the daemon is already reachable.
      this.sendToRenderer(sender, 'loro.status', this.connected)
    }
    if (this.enabled) {
      void this.ensureConnected().catch(() => this.scheduleRedial())
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  /** Drop the local socket so E2E can reproduce a network interruption. */
  async triggerNetworkJitterForE2E(): Promise<boolean> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      throw new Error('loro_data_plane_socket_unavailable')
    }
    if (this.e2eReconnectWaiter) {
      throw new Error('loro_data_plane_reconnect_already_pending')
    }
    const reconnected = new Promise<void>((resolve, reject) => {
      this.e2eReconnectWaiter = { reject, resolve }
    })
    const closed = new Promise<void>((resolve) => socket.once('close', resolve))
    socket.destroy()
    await closed
    const disconnected = !this.connected
    await reconnected
    return disconnected
  }

  getAttachedRendererCountForE2E(): number {
    return this.senders.size
  }

  send(message: LocalLoroDataPlaneClientMessage, sender?: WebContents): void {
    this.attachSender(sender)
    if (!this.enabled) return
    this.trackPeer(message, sender)
    void this.ensureConnected()
      .then(() => this.write(message))
      .catch(() => {
        // Drop while disconnected; protocol v3 recovers by design — the status
        // channel flips on reconnect, adapters rejoin, and join reconciliation
        // re-uploads anything the daemon is missing.
        this.scheduleRedial()
      })
  }

  destroy(): void {
    this.destroyed = true
    this.clearRedialTimer()
    this.stopPingLoop()
    this.clearPendingDaemonWrites()
    this.socket?.destroy()
    this.socket = null
    this.connecting = null
    this.senders.clear()
    this.sendersPeers.clear()
    this.e2eReconnectWaiter?.reject(new Error('loro_data_plane_relay_destroyed'))
    this.e2eReconnectWaiter = null
  }

  private trackPeer(message: LocalLoroDataPlaneClientMessage, sender?: WebContents): void {
    if (!sender || message.type === 'ping') return
    let peers = this.sendersPeers.get(sender)
    if (!peers) {
      peers = new Map()
      this.sendersPeers.set(sender, peers)
    }
    if (message.type === 'detach') {
      peers.delete(message.peerId)
      return
    }
    peers.set(message.peerId, message.workspaceId)
  }

  private releaseSenderPeers(sender: WebContents): void {
    const peers = this.sendersPeers.get(sender)
    this.sendersPeers.delete(sender)
    if (!peers || peers.size === 0 || !this.connected) return
    for (const [peerId, workspaceId] of peers) {
      try {
        this.write({
          type: 'detach',
          protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
          workspaceId,
          peerId
        })
      } catch {
        // Socket already gone — the daemon drops these peers on disconnect.
        return
      }
    }
  }

  private releaseSender(sender: WebContents): void {
    this.senders.delete(sender)
    this.releaseSenderPeers(sender)
  }

  private async ensureConnected(): Promise<void> {
    if (this.destroyed) throw new Error('loro_data_plane_relay_destroyed')
    if (!this.enabled) throw new Error('loro_data_plane_relay_disabled')
    if (this.socket && !this.socket.destroyed) return
    if (this.connecting) return await this.connecting

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = this.createSocket(this.socketPath)
      this.socket = socket
      const splitLines = createJsonLineSplitter({
        onLine: (line) => this.handleLine(socket, line),
        // Defense-in-depth: a compliant daemon never sends an oversized frame
        // (sender-side budget); cap main-process buffering against a
        // non-compliant one and skip the frame rather than kill the socket.
        maxBufferBytes: LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES,
        onOverflow: () => {
          console.warn('[loro-data-plane-relay] oversized frame from daemon dropped')
        }
      })

      socket.once('connect', () => {
        this.connecting = null
        this.redialAttempt = 0
        this.lastInboundAt = Date.now()
        this.startPingLoop(socket)
        this.setConnected(true)
        if (this.e2eReconnectWaiter) {
          this.write({
            type: 'ping',
            protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION
          })
        }
        resolve()
      })
      socket.once('error', (error) => {
        this.connecting = null
        reject(error)
      })
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null
        this.connecting = null
        this.stopPingLoop()
        // Frames queued for the dead socket are dropped: protocol v3+ recovers
        // by design (adapters rejoin on reconnect and join reconciliation
        // re-uploads anything the daemon is missing).
        this.clearPendingDaemonWrites()
        this.setConnected(false)
        this.scheduleRedial()
      })
      socket.on('data', (chunk) => {
        this.lastInboundAt = Date.now()
        // Raw bytes on purpose: the splitter owns the stateful UTF-8 decode, so
        // a multi-byte character split across two socket chunks is not mangled
        // into U+FFFD (flock bundles carry file paths as literal UTF-8 JSON).
        splitLines(chunk)
      })
      socket.on('drain', () => this.flushPendingDaemonWrites(socket))
    })

    return await this.connecting
  }

  private scheduleRedial(): void {
    if (this.destroyed || !this.enabled || this.redialTimer) return
    if (this.senders.size === 0) return
    if (this.socket && !this.socket.destroyed) return
    const delay = Math.min(
      REDIAL_MAX_DELAY_MS,
      REDIAL_MIN_DELAY_MS * 2 ** Math.min(this.redialAttempt, 30)
    )
    this.redialAttempt += 1
    this.redialTimer = setTimeout(() => {
      this.redialTimer = null
      void this.ensureConnected().catch(() => this.scheduleRedial())
    }, delay)
    this.redialTimer.unref?.()
  }

  private clearRedialTimer(): void {
    if (this.redialTimer) {
      clearTimeout(this.redialTimer)
      this.redialTimer = null
    }
  }

  private startPingLoop(socket: net.Socket): void {
    this.stopPingLoop()
    this.pingTimer = setInterval(() => {
      if (socket.destroyed) {
        this.stopPingLoop()
        return
      }
      if (Date.now() - this.lastInboundAt > IDLE_TIMEOUT_MS) {
        // Silent stall: no pong (or any frame) for the idle window. Drop the
        // socket; the close handler flips status and schedules a redial.
        console.warn('[loro-data-plane-relay] daemon socket idle; reconnecting')
        socket.destroy()
        return
      }
      try {
        socket.write(
          `${JSON.stringify({
            type: 'ping',
            protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION
          })}\n`
        )
      } catch {
        socket.destroy()
      }
    }, PING_INTERVAL_MS)
    this.pingTimer.unref?.()
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  // Drain-aware writes: backpressure from the daemon queues frames here (and
  // pauses direct writes) instead of destroying the socket — a busy daemon just
  // reads slower. Only the PENDING_DAEMON_WRITES_MAX_BYTES safety net (daemon
  // stopped reading entirely) still reconnects.
  private write(message: LocalLoroDataPlaneClientMessage): void {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      throw new Error('loro_data_plane_socket_unavailable')
    }
    const line = `${JSON.stringify(message)}\n`
    if (this.daemonWriteBlocked || this.pendingDaemonWrites.length > 0) {
      if (this.pendingDaemonBytes + line.length > PENDING_DAEMON_WRITES_MAX_BYTES) {
        console.warn('[loro-data-plane-relay] daemon socket write queue exceeded; reconnecting')
        socket.destroy()
        throw new Error('loro_data_plane_socket_backpressure')
      }
      this.pendingDaemonWrites.push({ line })
      this.pendingDaemonBytes += line.length
      return
    }
    this.daemonWriteBlocked = !socket.write(line)
  }

  private flushPendingDaemonWrites(socket: net.Socket): void {
    this.daemonWriteBlocked = false
    while (this.pendingDaemonWrites.length > 0) {
      if (socket.destroyed) {
        this.clearPendingDaemonWrites()
        return
      }
      const pending = this.pendingDaemonWrites[0]
      if (pending === undefined) {
        return
      }
      this.pendingDaemonWrites.shift()
      this.pendingDaemonBytes -= pending.line.length
      if (!socket.write(pending.line)) {
        this.daemonWriteBlocked = true
        return
      }
    }
  }

  private clearPendingDaemonWrites(): void {
    this.daemonWriteBlocked = false
    this.pendingDaemonWrites = []
    this.pendingDaemonBytes = 0
  }

  private handleLine(socket: net.Socket, line: string): void {
    if (socket.destroyed) return
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      socket.destroy()
      return
    }
    const parsed = LocalLoroDataPlaneServerMessageSchema.safeParse(raw)
    if (!parsed.success) return
    if (parsed.data.type === 'pong') {
      // Liveness only; `lastInboundAt` was already refreshed on the data event.
      const waiter = this.e2eReconnectWaiter
      this.e2eReconnectWaiter = null
      waiter?.resolve()
      return
    }
    this.publish(parsed.data)
  }

  private publish(message: LocalLoroDataPlaneServerMessage): void {
    for (const sender of this.senders) {
      this.sendToRenderer(sender, 'loro.event', message)
    }
  }

  private setConnected(next: boolean): void {
    if (this.connected === next) return
    this.connected = next
    for (const sender of this.senders) {
      this.sendToRenderer(sender, 'loro.status', next)
    }
  }

  private sendToRenderer(
    sender: WebContents,
    channel: RendererSendChannel,
    payload: LocalLoroDataPlaneServerMessage | boolean
  ): void {
    if (sender.isDestroyed()) {
      this.releaseSender(sender)
      return
    }
    try {
      this.afterRendererAliveCheck?.(sender, channel)
      sender.send(channel, payload)
    } catch (error) {
      if (!isRendererDisposalError(error)) throw error
      this.releaseSender(sender)
    }
  }
}

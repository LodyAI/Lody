import net from 'node:net'
import { type WebContents } from 'electron'
import {
  TerminalClientMessageSchema,
  TerminalServerEventSchema,
  type TerminalClientMessage,
  type TerminalOpenResult,
  type TerminalServerEvent,
  type TerminalSnapshot
} from '@lody/shared/terminal-protocol'

const REQUEST_TIMEOUT_MS = 10_000

type PendingRequest = {
  resolve: (event: TerminalServerEvent) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

function isResponseEvent(event: TerminalServerEvent): boolean {
  return event.type === 'terminals' || event.type === 'opened' || event.type === 'error'
}

function getEventTerminalId(event: TerminalServerEvent): string | null {
  return 'terminalId' in event && typeof event.terminalId === 'string' ? event.terminalId : null
}

function toDaemonUnavailableError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(
    message.startsWith('daemon_unavailable:') ? message : `daemon_unavailable:${message}`
  )
}

export class TerminalRelay {
  private readonly socketPath: string
  private readonly createSocket: (socketPath: string) => net.Socket
  private socket: net.Socket | null = null
  private connecting: Promise<void> | null = null
  private buffer = ''
  private requestSeq = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly senders = new Set<WebContents>()
  private readonly senderTerminalIds = new Map<WebContents, Set<string>>()

  constructor(
    socketPath: string,
    createSocket: (socketPath: string) => net.Socket = (path) => net.createConnection(path)
  ) {
    this.socketPath = socketPath
    this.createSocket = createSocket
  }

  attachSender(sender: WebContents | undefined): void {
    if (!sender || sender.isDestroyed()) return
    if (!this.senders.has(sender)) {
      this.senders.add(sender)
      sender.once('destroyed', () => {
        this.senders.delete(sender)
        this.senderTerminalIds.delete(sender)
      })
    }
  }

  async list(sessionId: string, sender?: WebContents): Promise<TerminalSnapshot[]> {
    this.attachSender(sender)
    const event = await this.request({
      type: 'list',
      sessionId
    })
    if (event.type !== 'terminals') {
      throw new Error(`unexpected_terminal_response:${event.type}`)
    }
    return event.terminals
  }

  async open(
    params: { sessionId: string; cols: number; rows: number },
    sender?: WebContents
  ): Promise<TerminalOpenResult> {
    this.attachSender(sender)
    const event = await this.request({
      type: 'open',
      sessionId: params.sessionId,
      cols: params.cols,
      rows: params.rows
    })
    if (event.type !== 'opened') {
      throw new Error(`unexpected_terminal_response:${event.type}`)
    }
    return {
      terminalId: event.terminalId,
      ...(event.cwd ? { cwd: event.cwd } : {})
    }
  }

  send(message: TerminalClientMessage, sender?: WebContents): void {
    this.attachSender(sender)
    void this.ensureConnected()
      .then(() => {
        this.write(message)
        this.trackSenderTerminalMessage(message, sender)
      })
      .catch((error: unknown) => {
        this.publish({
          type: 'error',
          ...('terminalId' in message ? { terminalId: message.terminalId } : {}),
          code: 'daemon_unavailable',
          message: error instanceof Error ? error.message : String(error)
        })
      })
  }

  destroy(): void {
    this.socket?.destroy()
    this.socket = null
    this.connecting = null
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`terminal_relay_destroyed:${requestId}`))
    }
    this.pending.clear()
    this.senders.clear()
    this.senderTerminalIds.clear()
  }

  private async request(message: TerminalClientMessage): Promise<TerminalServerEvent> {
    const requestId = String(++this.requestSeq)
    try {
      await this.ensureConnected()
    } catch (error) {
      throw toDaemonUnavailableError(error)
    }

    const requestMessage = TerminalClientMessageSchema.parse({
      ...message,
      requestId
    })

    const response = new Promise<TerminalServerEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('terminal_request_timeout'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timeout })
    })

    try {
      this.write(requestMessage)
    } catch (error) {
      const pending = this.pending.get(requestId)
      if (pending) {
        this.pending.delete(requestId)
        clearTimeout(pending.timeout)
      }
      throw toDaemonUnavailableError(error)
    }
    return await response
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return
    }
    if (this.connecting) {
      return await this.connecting
    }

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = this.createSocket(this.socketPath)
      this.socket = socket
      this.buffer = ''
      // Events of a destroyed or replaced socket must not reject requests or
      // feed bytes into its successor.
      const current = (): boolean => this.socket === socket

      socket.once('connect', () => {
        if (current()) this.connecting = null
        resolve()
      })
      socket.once('error', (error) => {
        if (current()) {
          this.connecting = null
          this.rejectAllPending(error)
        }
        reject(error)
      })
      socket.on('close', () => {
        if (!current()) return
        this.socket = null
        this.connecting = null
        this.rejectAllPending(new Error('terminal_socket_closed'))
      })
      socket.on('data', (chunk) => {
        if (current() && !socket.destroyed) this.handleData(chunk.toString('utf8'))
      })
    })

    return await this.connecting
  }

  // `message` is already validated by every caller (request() parses it, send()
  // receives the safeParse'd data from the IPC boundary), so we serialize directly
  // instead of re-parsing on every keystroke/input chunk. The daemon validates again
  // on receipt at the trust boundary.
  private write(message: TerminalClientMessage): void {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      throw new Error('terminal_socket_unavailable')
    }
    socket.write(`${JSON.stringify(message)}\n`)
  }

  private handleData(chunk: string): void {
    this.buffer += chunk
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line) {
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch (error) {
          this.handleProtocolError(error)
          return
        }
        const parsed = TerminalServerEventSchema.safeParse(raw)
        if (!parsed.success) {
          this.handleProtocolError(parsed.error)
          return
        }
        this.handleEvent(parsed.data)
      }
      newlineIndex = this.buffer.indexOf('\n')
    }
  }

  private handleProtocolError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const relayError = new Error(`invalid_terminal_server_event:${message}`)
    this.rejectAllPending(relayError)
    this.publish({
      type: 'error',
      code: 'invalid_server_event',
      message
    })
    this.socket?.destroy()
  }

  private handleEvent(event: TerminalServerEvent): void {
    if (event.requestId && isResponseEvent(event)) {
      const pending = this.pending.get(event.requestId)
      if (pending) {
        this.pending.delete(event.requestId)
        clearTimeout(pending.timeout)
        if (event.type === 'error') {
          const prefix = `${event.code}:`
          pending.reject(
            new Error(
              event.message.startsWith(prefix) ? event.message : `${prefix}${event.message}`
            )
          )
        } else {
          pending.resolve(event)
        }
        return
      }
    }

    this.publish(event)
  }

  private publish(event: TerminalServerEvent): void {
    const terminalId = getEventTerminalId(event)
    for (const sender of this.senders) {
      const canReceiveTerminalEvent =
        !terminalId || this.senderTerminalIds.get(sender)?.has(terminalId) === true
      if (!sender.isDestroyed() && canReceiveTerminalEvent) {
        sender.send('terminal.event', event)
      }
    }
    if (event.type === 'exit') {
      for (const terminalIds of this.senderTerminalIds.values()) {
        terminalIds.delete(event.terminalId)
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private trackSenderTerminalMessage(
    message: TerminalClientMessage,
    sender: WebContents | undefined
  ): void {
    if (!sender || sender.isDestroyed()) return
    if (message.type !== 'attach') return
    const terminalIds = this.senderTerminalIds.get(sender) ?? new Set<string>()
    terminalIds.add(message.terminalId)
    this.senderTerminalIds.set(sender, terminalIds)
  }
}

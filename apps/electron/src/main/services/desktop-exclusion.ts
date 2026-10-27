import { createServer, createConnection, type Socket } from 'node:net'
import {
  formatDesktopHandoffLine,
  MAX_DESKTOP_HANDOFF_BYTES,
  parseDesktopHandoffLine
} from './desktop-deep-link-handoff'

// Independent of appId/userData and the CLI Host lease (17788). All cloud
// desktop channels participate, including control-only windows.
export const CLOUD_DESKTOP_LOCK = { host: '127.0.0.1', port: 17790 } as const
const HANDOFF_REQUEST_TIMEOUT_MS = 800
const MAX_HANDOFF_RESPONSE_BYTES = 1024

export type DesktopLeaseEndpoint = { host: string; port: number }

export type DesktopLease = { port: number; close: () => Promise<void> }

export type DesktopLeaseOptions = {
  /** Accepts a channel-neutral resource link from a losing channel's launch. */
  onDeepLink?: (url: string) => void
  requestTimeoutMs?: number
}

/** OS ownership, without a PID file or stale-file removal race. */
export async function acquireDesktopLease(
  endpoint: DesktopLeaseEndpoint = CLOUD_DESKTOP_LOCK,
  options: DesktopLeaseOptions = {}
): Promise<DesktopLease | null> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(options.requestTimeoutMs ?? HANDOFF_REQUEST_TIMEOUT_MS, () =>
      socket.destroy()
    )

    let buffer = ''
    let handled = false
    socket.on('data', (chunk) => {
      if (handled) return
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer, 'utf8') > MAX_DESKTOP_HANDOFF_BYTES) {
        handled = true
        socket.end(`${JSON.stringify({ ok: false, error: 'invalid_request' })}\n`)
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      const url = parseDesktopHandoffLine(buffer.slice(0, newline))
      if (!url || !options.onDeepLink) {
        socket.end(`${JSON.stringify({ ok: false, error: 'unsupported' })}\n`)
        return
      }
      try {
        options.onDeepLink(url)
        socket.end(`${JSON.stringify({ ok: true })}\n`)
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: 'rejected' })}\n`)
      }
    })
  })
  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false)
      else reject(error)
    })
    server.listen({ ...endpoint, exclusive: true }, () => resolve(true))
  })
  if (!listening) {
    for (const socket of sockets) socket.destroy()
    return null
  }
  // A lease does not keep an otherwise stopped process alive. Production never
  // closes it on will-quit: process exit releases it after normal child shutdown.
  server.unref()
  let closing: Promise<void> | undefined
  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
      }))
  }
}

/**
 * Hands a channel-neutral deep link to the desktop that owns the lease. Used by
 * a losing channel before it quits, so the OS-selected entry can still open the
 * destination in the installation the user is already running.
 */
export async function handOffDesktopDeepLink(
  url: string,
  endpoint: DesktopLeaseEndpoint = CLOUD_DESKTOP_LOCK,
  timeoutMs = HANDOFF_REQUEST_TIMEOUT_MS
): Promise<boolean> {
  const line = formatDesktopHandoffLine(url)
  if (!line) return false

  let socket: Socket
  try {
    socket = createConnection(endpoint)
  } catch {
    return false
  }
  return await new Promise<boolean>((resolve) => {
    let buffer = ''
    let settled = false
    const finish = (accepted: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(accepted)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(false))
    socket.once('connect', () => socket.write(line))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer, 'utf8') > MAX_HANDOFF_RESPONSE_BYTES) {
        finish(false)
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const value = JSON.parse(buffer.slice(0, newline)) as { ok?: unknown }
        finish(value?.ok === true)
      } catch {
        finish(false)
      }
    })
  })
}

import { createServer, type AddressInfo, type ListenOptions } from 'node:net'

// Independent of appId/userData and the CLI Host lease (17788). All cloud
// desktop channels participate, including control-only windows.
export const CLOUD_DESKTOP_LOCK = { host: '127.0.0.1', port: 17790 } as const

export type DesktopLease = { port: number; close: () => Promise<void> }

/** OS ownership, without a PID file or stale-file removal race. */
export async function acquireDesktopLease(
  endpoint: Pick<ListenOptions, 'host' | 'port'> = CLOUD_DESKTOP_LOCK
): Promise<DesktopLease | null> {
  const server = createServer((socket) => socket.destroy())
  const listening = await new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false)
      else reject(error)
    })
    server.listen({ ...endpoint, exclusive: true }, () => resolve(true))
  })
  if (!listening) return null
  // A lease does not keep an otherwise stopped process alive. Production never
  // closes it on will-quit: process exit releases it after normal child shutdown.
  server.unref()
  let closing: Promise<void> | undefined
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }))
  }
}

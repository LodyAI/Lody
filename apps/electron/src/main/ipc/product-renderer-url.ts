import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const RECOVERY_CHANNELS = new Set(['app.requestRendererReload', 'app.reportRendererFatalError'])

/** Match an installed product document using the target platform's path rules. */
export function isTrustedProductRendererUrl(
  senderUrl: string | undefined,
  options: {
    mainDirectory: string
    platform: NodeJS.Platform
    devRendererUrl?: string
    channel?: string
  }
): boolean {
  try {
    const sender = new URL(senderUrl ?? '')
    const recoveryAllowed = options.channel !== undefined && RECOVERY_CHANNELS.has(options.channel)
    if (options.devRendererUrl) {
      const dev = new URL(options.devRendererUrl)
      const isRecovery = sender.pathname === new URL('recovery.html', dev).pathname
      return sender.origin === dev.origin && (!isRecovery || recoveryAllowed)
    }
    if (sender.protocol !== 'file:') return false
    const windows = options.platform === 'win32'
    const paths = windows ? win32 : posix
    const normalize = (value: string) => (windows ? win32.normalize(value).toLowerCase() : value)
    const senderPath = normalize(fileURLToPath(sender, { windows }))
    return ['index.html', 'devbar.html', ...(recoveryAllowed ? ['recovery.html'] : [])].some(
      (entry) =>
        senderPath === normalize(paths.resolve(options.mainDirectory, '../renderer', entry))
    )
  } catch {
    return false
  }
}

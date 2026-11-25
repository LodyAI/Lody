import { usageSharingRevision } from '@lody/shared/node/usage-sharing'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { PostHog } from 'posthog-node'
import { isLocalPlatform } from './platform'
import { redactedTelemetryException } from '@lody/platform/telemetry'

const DEFAULT_FLUSH_TIMEOUT_MS = 2000

let client: PostHog | null = null
let handlersInstalled = false
let fatalExitInProgress = false

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = readNonEmpty(value)
    if (trimmed !== undefined) return trimmed
  }
  return undefined
}

function resolveApiKey(): string | undefined {
  return firstNonEmpty(
    import.meta.env.VITE_PUBLIC_POSTHOG_KEY,
    process.env.LODY_POSTHOG_KEY,
    process.env.POSTHOG_API_KEY
  )
}

function resolveHost(): string | undefined {
  return firstNonEmpty(import.meta.env.VITE_PUBLIC_POSTHOG_HOST, process.env.POSTHOG_HOST)?.replace(
    /\/+$/,
    ''
  )
}

function getClient(): PostHog | null {
  if (client) return client
  if (isLocalPlatform()) return null

  const apiKey = resolveApiKey()
  const host = resolveHost()
  if (apiKey === undefined || host === undefined) return null

  client = new PostHog(apiKey, {
    host,
    fetchRetryCount: 0,
    flushAt: 1
  })

  return client
}

export async function flushElectronMainErrorReporting(
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS
): Promise<void> {
  if (!client) return

  try {
    await Promise.race([
      client.flush().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ])
  } catch {
    // best-effort: telemetry flush must never reject into quit/crash paths
  }
}

export async function captureElectronMainException(
  error: unknown,
  context?: { component?: string; extra?: Record<string, unknown> }
): Promise<void> {
  if (!usageSharingRevision(true)) return
  const posthog = getClient()
  if (!posthog) return

  try {
    // Main serves multiple workspaces/windows. It cannot authorize plaintext
    // diagnostics using one renderer's mode, so keep only fixed diagnostics.
    const pending = posthog.captureImmediate({
      event: '$exception',
      distinctId: randomUUID(),
      properties: {
        $lib: 'lody-electron-main',
        $lib_version: app.getVersion(),
        $exception_list: redactedTelemetryException(context?.extra, error).$exception_list
      }
    })
    await Promise.race([
      pending.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_FLUSH_TIMEOUT_MS))
    ])
  } catch {
    return
  }
}

function exitAfterFatalException(): void {
  setTimeout(() => {
    app.exit(1)
  }, DEFAULT_FLUSH_TIMEOUT_MS).unref()
}

export function installElectronMainErrorReporting(): void {
  if (handlersInstalled) return
  handlersInstalled = true

  process.on('uncaughtException', (error, origin) => {
    console.error('[Electron] Uncaught exception in main process', error)
    if (fatalExitInProgress) {
      app.exit(1)
      return
    }

    fatalExitInProgress = true
    exitAfterFatalException()
    void captureElectronMainException(error, {
      component: 'electron-main',
      extra: { source: 'uncaughtException', origin }
    }).finally(() => {
      app.exit(1)
    })
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[Electron] Unhandled rejection in main process', reason)
    void captureElectronMainException(reason, {
      component: 'electron-main',
      extra: { source: 'unhandledRejection' }
    })
  })
}

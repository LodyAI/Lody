import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PostHog } from 'posthog-node'
import { persistElectronMainFatalLog } from './electron-main-fatal-log'
import { isLocalPlatform } from './platform'

const DEFAULT_FLUSH_TIMEOUT_MS = 2000
const INSTALL_ID_FILE_NAME = 'posthog-main-install-id'

let client: PostHog | null = null
let distinctId: string | null = null
let handlersInstalled = false
let exitTraceHandlerInstalled = false
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

function resolveRuntimeEnv(): string {
  return firstNonEmpty(import.meta.env.VITE_LODY_ENV, process.env.LODY_ENV) ?? 'unknown'
}

function resolveInstallIdPath(): string | null {
  try {
    return path.join(app.getPath('userData'), INSTALL_ID_FILE_NAME)
  } catch {
    return null
  }
}

function resolveDistinctId(): string {
  if (distinctId !== null) return distinctId

  const filePath = resolveInstallIdPath()
  if (filePath === null) {
    distinctId = `electron-main-${randomUUID()}`
    return distinctId
  }

  try {
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8').trim()
      if (existing) {
        distinctId = existing
        return distinctId
      }
    }

    const generated = `electron-main-${randomUUID()}`
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, generated, 'utf8')
    distinctId = generated
    return distinctId
  } catch {
    distinctId = `electron-main-${randomUUID()}`
    return distinctId
  }
}

function getClient(): PostHog | null {
  if (client) return client
  if (isLocalPlatform()) return null

  const apiKey = resolveApiKey()
  const host = resolveHost()
  if (apiKey === undefined || host === undefined) return null

  client = new PostHog(apiKey, {
    host,
    flushAt: 1
  })

  return client
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : String(error))
}

function baseProperties(): Record<string, unknown> {
  return {
    $lib: 'lody-electron-main',
    $lib_version: app.getVersion(),
    platform: 'electron',
    electron_process: 'main',
    app_version: app.getVersion(),
    env: resolveRuntimeEnv(),
    release: `lody-electron@${app.getVersion()}`,
    install_id: resolveDistinctId()
  }
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
  const posthog = getClient()
  if (!posthog) return

  try {
    posthog.captureException(normalizeError(error), resolveDistinctId(), {
      ...baseProperties(),
      ...(context?.component !== undefined && context.component.length > 0
        ? { component: context.component }
        : {}),
      ...(context?.extra ?? {})
    })
  } catch {
    return
  }

  await flushElectronMainErrorReporting()
}

function exitAfterFatalException(): void {
  setTimeout(() => {
    app.exit(1)
  }, DEFAULT_FLUSH_TIMEOUT_MS).unref()
}

export function persistElectronMainExitTrace(error: unknown, origin: string): void {
  try {
    persistElectronMainFatalLog(app.getPath('logs'), {
      error,
      origin,
      version: app.getVersion()
    })
  } catch {
    // Best effort. Never mask the exception that is forcing the app to exit.
  }
}

export function installElectronMainExitTraceLogging(): void {
  if (exitTraceHandlerInstalled) return
  exitTraceHandlerInstalled = true

  // Observe fatal exceptions without changing Node's default exit semantics. The
  // cloud composition also installs an uncaughtException handler below so it can
  // flush telemetry, but the monitor keeps disk diagnostics available in local
  // builds and records each exception only once.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    persistElectronMainExitTrace(error, origin)
  })
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

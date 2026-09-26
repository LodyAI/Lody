import { formatWithOptions } from 'node:util'
import {
  appendDailyLogSync,
  formatDailyLogLine,
  type DailyLogLevel
} from '@lody/shared/node/daily-log-file'

/**
 * Electron main writes its diagnostics into the CLI's daily log
 * (`<data dir>/logs/<YYYY-MM-DD>.log`), so one file shows the desktop, the
 * embedded CLI it supervises, and how each ended. Before this, main-process
 * output went only to stdout, which a Finder-launched app discards.
 *
 * Writes are synchronous and batched per tick: the lines that matter most are
 * written just before the process dies, where an asynchronous write is lost.
 */

export type DesktopLog = {
  debug: (scope: string, message: string) => void
  info: (scope: string, message: string) => void
  warn: (scope: string, message: string) => void
  error: (scope: string, message: string) => void
  /** Writes everything buffered, synchronously. Call from exit/crash paths. */
  flushSync: () => void
}

export type DesktopLogOptions = {
  logDir: string
  /** Prefix for every scope, e.g. `desktop:1234`. */
  scopePrefix: string
  now?: () => Date
  append?: (logDir: string, text: string, at: Date) => void
  scheduleFlush?: (flush: () => void) => void
}

// Obvious credential shapes that main-process diagnostics were never written to
// persist: bearer tokens and credential-like URL query parameters.
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi
const SECRET_QUERY_PATTERN =
  /([?&#](?:token|access_token|refresh_token|id_token|session_token|ott|code|code_verifier|state|password|secret|key|api_key)=)[^&#\s"'<>]+/gi

export function redactDesktopLogText(text: string): string {
  return text.replace(BEARER_PATTERN, '$1[redacted]').replace(SECRET_QUERY_PATTERN, '$1[redacted]')
}

export function formatConsoleArgs(args: readonly unknown[]): string {
  return formatWithOptions({ depth: 4, breakLength: Infinity, colors: false }, ...args)
}

export function createDesktopLog(options: DesktopLogOptions): DesktopLog {
  const now = options.now ?? (() => new Date())
  const append =
    options.append ??
    ((logDir: string, text: string, at: Date) => {
      appendDailyLogSync(logDir, text, at)
    })
  const scheduleFlush = options.scheduleFlush ?? ((flush: () => void) => setImmediate(flush))
  let pending = ''
  let scheduled = false

  const flushSync = () => {
    scheduled = false
    if (!pending) return
    const text = pending
    pending = ''
    // The file follows the same clock as the line timestamps.
    append(options.logDir, text, now())
  }

  const write = (level: DailyLogLevel, scope: string, message: string) => {
    pending += formatDailyLogLine({
      time: now(),
      level,
      scope: scope ? `${options.scopePrefix}:${scope}` : options.scopePrefix,
      message: redactDesktopLogText(message)
    })
    if (scheduled) return
    scheduled = true
    scheduleFlush(flushSync)
  }

  return {
    debug: (scope, message) => write('DEBUG', scope, message),
    info: (scope, message) => write('INFO', scope, message),
    warn: (scope, message) => write('WARN', scope, message),
    error: (scope, message) => write('ERROR', scope, message),
    flushSync
  }
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'

const CONSOLE_LEVELS: Record<ConsoleMethod, keyof Omit<DesktopLog, 'flushSync'>> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug'
}

export type ConsoleMirrorOptions = {
  now?: () => number
  /** Console lines persisted per window; explicit traces are never limited. */
  maxLinesPerWindow?: number
  windowMs?: number
}

const CONSOLE_MIRROR_MAX_LINES = 500
const CONSOLE_MIRROR_WINDOW_MS = 10_000

/**
 * Tees main-process `console` output into the desktop log. The original method
 * still runs, so development terminals are unchanged. Renderer console messages
 * reach main through `console.warn`, so a renderer error loop is rate-limited
 * here rather than filling the log and the main thread with synchronous writes;
 * the dropped count is reported when the next window opens.
 */
export function mirrorConsoleToDesktopLog(
  target: Console,
  log: DesktopLog,
  options: ConsoleMirrorOptions = {}
): () => void {
  const now = options.now ?? (() => performance.now())
  const maxLines = options.maxLinesPerWindow ?? CONSOLE_MIRROR_MAX_LINES
  const windowMs = options.windowMs ?? CONSOLE_MIRROR_WINDOW_MS
  let windowStartedAt = now()
  let linesInWindow = 0
  let dropped = 0

  const admit = (): boolean => {
    const at = now()
    if (at - windowStartedAt >= windowMs) {
      if (dropped > 0) {
        log.warn(
          'console',
          `suppressed ${dropped} console line(s) over the ${windowMs}ms rate limit of ${maxLines}`
        )
      }
      windowStartedAt = at
      linesInWindow = 0
      dropped = 0
    }
    if (linesInWindow >= maxLines) {
      dropped += 1
      return false
    }
    linesInWindow += 1
    return true
  }

  const originals = new Map<ConsoleMethod, Console[ConsoleMethod]>()
  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    const original = target[method]
    originals.set(method, original)
    target[method] = (...args: unknown[]) => {
      original.apply(target, args)
      try {
        if (admit()) log[CONSOLE_LEVELS[method]]('', formatConsoleArgs(args))
      } catch {
        // Diagnostics must never break the caller.
      }
    }
  }
  return () => {
    for (const [method, original] of originals) target[method] = original
  }
}

export type DesktopRunRecord = {
  pid: number
  startedAt: string
  cleanExit: boolean
}

export function parseDesktopRunRecord(raw: string): DesktopRunRecord | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    if (
      typeof record.pid !== 'number' ||
      typeof record.startedAt !== 'string' ||
      typeof record.cleanExit !== 'boolean'
    ) {
      return null
    }
    return { pid: record.pid, startedAt: record.startedAt, cleanExit: record.cleanExit }
  } catch {
    return null
  }
}

/**
 * A run record left with `cleanExit: false` means the previous desktop process
 * never reached `will-quit`: it crashed, was force-quit, or was killed by the OS.
 */
export function describePreviousDesktopRun(previous: DesktopRunRecord | null): string | null {
  if (!previous || previous.cleanExit) return null
  return `previous desktop run pid=${previous.pid} startedAt=${previous.startedAt} ended without a clean quit (crash, force quit, or OS kill); check DiagnosticReports for a matching crash report`
}

/** Warns when the main-process event loop is blocked; a blocked main process freezes every window. */
export function createMainThreadLagProbe(options: {
  log: DesktopLog
  now: () => number
  cpuMs: () => number
  intervalMs: number
  warnThresholdMs: number
}): () => void {
  let expectedAt = options.now() + options.intervalMs
  let previousAt = options.now()
  let previousCpuMs = options.cpuMs()
  return () => {
    const now = options.now()
    const lateMs = now - expectedAt
    const elapsedMs = now - previousAt
    const cpuMs = options.cpuMs()
    const cpuDeltaMs = cpuMs - previousCpuMs
    expectedAt = now + options.intervalMs
    previousAt = now
    previousCpuMs = cpuMs
    if (lateMs < options.warnThresholdMs) return
    options.log.warn(
      'event-loop',
      `main process timer fired ${Math.round(lateMs)}ms late (elapsed=${Math.round(
        elapsedMs
      )}ms cpu=${Math.round(cpuDeltaMs)}ms cpuRatio=${
        elapsedMs > 0 ? (cpuDeltaMs / elapsedMs).toFixed(2) : '0.00'
      })`
    )
  }
}

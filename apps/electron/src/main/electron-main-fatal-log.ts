import fs from 'node:fs'
import path from 'node:path'

const MAX_LOG_BYTES = 4 * 1024 * 1024

export type ElectronMainFatalLogEntry = {
  error: unknown
  origin: string
  version: string
  timestamp?: Date
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }
  return typeof error === 'string' ? error : String(error)
}

export function persistElectronMainFatalLog(
  logDirectory: string,
  entry: ElectronMainFatalLogEntry
): void {
  try {
    const filePath = path.join(logDirectory, 'electron-main-fatal.log')
    const timestamp = (entry.timestamp ?? new Date()).toISOString()
    const record =
      `\n[${timestamp}] version=${entry.version} origin=${entry.origin}\n` +
      `${formatError(entry.error)}\n` +
      '----\n'

    fs.mkdirSync(logDirectory, { recursive: true })
    let existing = ''
    try {
      existing = fs.readFileSync(filePath, 'utf8')
    } catch {
      // First entry or an unreadable old log: preserve the current fatal stack.
    }
    const combined = Buffer.from(existing + record, 'utf8')
    const bounded =
      combined.length > MAX_LOG_BYTES
        ? combined.subarray(combined.length - MAX_LOG_BYTES)
        : combined
    fs.writeFileSync(filePath, bounded)
  } catch {
    // A fatal-path diagnostic must never replace the original exception.
  }
}

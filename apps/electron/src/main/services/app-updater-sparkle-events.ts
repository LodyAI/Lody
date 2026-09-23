import type { ElectronUpdaterState } from '@lody/shared/electron-ipc'

const MAX_RELEASE_NOTES_LENGTH = 64 * 1024

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_RELEASE_NOTES_LENGTH) return undefined
  return trimmed
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function readDownloadPercent(record: Record<string, unknown>): number | undefined {
  const percent = readFiniteNumber(record.percent)
  if (percent !== undefined) return percent

  const transferred = readFiniteNumber(record.transferred)
  const total = readFiniteNumber(record.total)
  if (transferred === undefined || total === undefined || total <= 0) return undefined
  return (transferred / total) * 100
}

export function sparkleEventToStatePatch(
  event: unknown,
  nowMs: number
): Partial<ElectronUpdaterState> | null {
  const record = readObject(event)
  const type = readNonEmptyString(record?.type)
  if (!record || !type) return null

  switch (type) {
    case 'checking':
      return {
        phase: 'checking',
        error: undefined,
        checkedAtMs: nowMs,
        percent: undefined,
        bytesPerSecond: undefined,
        transferred: undefined,
        total: undefined
      }
    case 'update-available': {
      const version = readNonEmptyString(record.version)
      return {
        phase: 'downloading',
        availableVersion: version,
        downloadedVersion: undefined,
        releaseName: readNonEmptyString(record.releaseName),
        releaseDate: readNonEmptyString(record.releaseDate),
        releaseNotes: readNonEmptyString(record.releaseNotes),
        releaseNotesByLocale: undefined,
        checkedAtMs: nowMs,
        error: undefined
      }
    }
    case 'download-progress':
      return {
        phase: 'downloading',
        percent: readDownloadPercent(record),
        bytesPerSecond: undefined,
        transferred: readFiniteNumber(record.transferred),
        total: readFiniteNumber(record.total)
      }
    case 'update-downloaded': {
      const version = readNonEmptyString(record.version)
      return {
        phase: 'downloaded',
        downloadedVersion: version,
        availableVersion: version,
        checkedAtMs: nowMs,
        error: undefined
      }
    }
    case 'update-not-available':
      return {
        phase: 'up_to_date',
        availableVersion: undefined,
        downloadedVersion: undefined,
        percent: undefined,
        bytesPerSecond: undefined,
        transferred: undefined,
        total: undefined,
        checkedAtMs: nowMs,
        error: undefined
      }
    case 'error': {
      const message = readNonEmptyString(record.message)
      if (!message) return null
      return {
        phase: 'error',
        error: message,
        checkedAtMs: nowMs
      }
    }
    default:
      return null
  }
}

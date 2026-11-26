import type { ElectronUpdaterState } from '@lody/shared/electron-ipc'
import { SUPPORTED_LANGUAGES } from '@lody/shared/language'

const MAX_RELEASE_NOTES_LENGTH = 64 * 1024

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_RELEASE_NOTES_LENGTH) return undefined
  return trimmed
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readReleaseNotes(value: unknown): string | undefined {
  const direct = readNonEmptyString(value)
  if (direct) return direct

  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    const line = readNonEmptyString(item)
    if (line) return line
    const entry = readObject(item)
    const note = readNonEmptyString(entry?.note)
    if (note) return note
  }
  return undefined
}

function readReleaseNotesByLocale(
  value: unknown
): ElectronUpdaterState['releaseNotesByLocale'] | undefined {
  const locales = readObject(value)
  if (!locales) return undefined

  const result: NonNullable<ElectronUpdaterState['releaseNotesByLocale']> = {}
  let hasAny = false
  for (const lang of SUPPORTED_LANGUAGES) {
    const note = readNonEmptyString(locales[lang])
    if (note) {
      result[lang] = note
      hasAny = true
    }
  }
  return hasAny ? result : undefined
}

export function readUpdaterReleaseMetadata(
  value: unknown,
  expectedVersion: string | undefined
): Pick<
  ElectronUpdaterState,
  'releaseName' | 'releaseDate' | 'releaseNotes' | 'releaseNotesByLocale'
> {
  const record = readObject(value)
  const vendor = readObject(record?.vendor)
  const lodyChangelog = readObject(vendor?.lodyChangelog)
  const contentVersion = readNonEmptyString(lodyChangelog?.contentVersion)
  const releaseNotesByLocale =
    expectedVersion && contentVersion === expectedVersion
      ? readReleaseNotesByLocale(lodyChangelog?.locales)
      : undefined

  return {
    releaseName: readNonEmptyString(record?.releaseName),
    releaseDate: readNonEmptyString(record?.releaseDate),
    releaseNotes: readReleaseNotes(record?.releaseNotes),
    releaseNotesByLocale
  }
}

import path from 'node:path'

/**
 * Pure save-dialog naming for the image preview export. Kept apart from
 * `image-export-service.ts` so it stays importable (and testable) without the
 * `electron` runtime.
 */

const FALLBACK_SAVE_FILE_NAME = 'image.png'

/** Structurally compatible with `Electron.FileFilter`. */
export type SaveFileFilter = { name: string; extensions: string[] }

/**
 * A save-dialog default only, and it arrives from the renderer, so reduce it to
 * a base name: a path there would silently point the dialog somewhere the user
 * never chose.
 */
export function resolveSaveFileName(rawFileName: string): string {
  const trimmed = rawFileName.trim().replace(/[\\/]+$/, '')
  // `path.basename` only knows the host separator; a renderer name can carry
  // either one.
  const baseName = trimmed.split(/[\\/]/).pop() ?? ''
  if (!baseName || baseName === '.' || baseName === '..') {
    return FALLBACK_SAVE_FILE_NAME
  }
  return baseName
}

/**
 * One filter for the file's own extension so the dialog defaults to keeping it,
 * plus an escape hatch. An extensionless name gets the all-files filter alone —
 * inventing an extension would rename the user's file behind their back.
 */
export function buildSaveFileFilters(fileName: string): SaveFileFilter[] {
  const extension = path.extname(fileName).replace(/^\./, '').toLowerCase()
  const allFiles: SaveFileFilter = { name: 'All Files', extensions: ['*'] }
  if (!extension) {
    return [allFiles]
  }
  return [{ name: extension.toUpperCase(), extensions: [extension] }, allFiles]
}

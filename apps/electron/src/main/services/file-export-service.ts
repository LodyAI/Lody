import { promises as fs } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, shell } from 'electron'
import type {
  RevealLocalPathInput,
  RevealLocalPathResult,
  SaveFileBytesInput,
  SaveFileBytesResult
} from '@lody/shared/electron-ipc'
import { formatUnknownError } from '../utils'
import { buildSaveFileFilters, resolveSaveFileName } from './image-export-core'

/**
 * The main-process half of "download this workspace file". The renderer owns the
 * bytes — a file on a remote machine only ever exists there, as a File Preview
 * response — so main contributes exactly the two things it can: the native save
 * dialog and the write.
 */
export async function saveFileBytes(
  window: BrowserWindow | null,
  input: SaveFileBytesInput
): Promise<SaveFileBytesResult> {
  const fileName = resolveSaveFileName(input.fileName)
  const saveDialogOptions = {
    defaultPath: fileName,
    filters: buildSaveFileFilters(fileName)
  }

  try {
    const result =
      window && !window.isDestroyed()
        ? await dialog.showSaveDialog(window, saveDialogOptions)
        : await dialog.showSaveDialog(saveDialogOptions)
    if (result.canceled || !result.filePath) {
      return { saved: false, canceled: true }
    }

    await fs.writeFile(result.filePath, Buffer.from(input.bytes))
    return { saved: true, path: result.filePath }
  } catch (error) {
    return { saved: false, error: formatUnknownError(error) }
  }
}

/**
 * Reveal a path in the OS file manager, with the item selected.
 *
 * Deliberately `showItemInFolder` and never `openPath`: the path arrives from
 * the renderer, and `openPath` on a file would hand it to whatever application
 * claims that extension. A relative path is rejected rather than resolved,
 * because there is no meaningful cwd to resolve it against in the main process.
 */
export async function revealLocalPath(input: RevealLocalPathInput): Promise<RevealLocalPathResult> {
  if (!path.isAbsolute(input.path)) {
    return { revealed: false, error: 'path_not_absolute' }
  }

  try {
    // `showItemInFolder` reports nothing back, so a missing path would look like
    // a success while no window opened. Check first and say so instead.
    await fs.stat(input.path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      revealed: false,
      error: code === 'ENOENT' ? 'path_not_found' : formatUnknownError(error)
    }
  }

  try {
    shell.showItemInFolder(input.path)
    return { revealed: true }
  } catch (error) {
    return { revealed: false, error: formatUnknownError(error) }
  }
}

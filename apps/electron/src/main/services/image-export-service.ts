import { BrowserWindow, Menu, clipboard, dialog, nativeImage } from 'electron'
import { promises as fs } from 'node:fs'
import type {
  CopyImageToClipboardResult,
  ImagePreviewMenuAction,
  SaveImageFileInput,
  SaveImageFileResult,
  ShowImagePreviewMenuInput,
  ShowImagePreviewMenuResult
} from '@lody/shared/electron-ipc'
import { formatUnknownError } from '../utils'
import { buildSaveFileFilters, resolveSaveFileName } from './image-export-core'

/**
 * The main-process half of the image preview's right-click menu: the native
 * menu itself, the system clipboard, and the save dialog. The renderer owns the
 * image bytes (the preview runs on `blob:` URLs) and sends them per action.
 */

/**
 * Resolves once the menu closes, with the action the user picked or `null`.
 *
 * The click handler and the close callback race in Electron, so the resolve is
 * deferred one tick past close — resolving inside `callback` directly can report
 * `null` for a menu item the user did click.
 */
export async function showImagePreviewMenu(
  window: BrowserWindow | null,
  input: ShowImagePreviewMenuInput
): Promise<ShowImagePreviewMenuResult> {
  if (!window || window.isDestroyed()) {
    return { action: null }
  }

  return await new Promise<ShowImagePreviewMenuResult>((resolve) => {
    let selected: ImagePreviewMenuAction | null = null
    const menu = Menu.buildFromTemplate(
      input.items.map((item) => ({
        label: item.label,
        click: () => {
          selected = item.action
        }
      }))
    )
    menu.popup({
      window,
      callback: () => {
        setImmediate(() => resolve({ action: selected }))
      }
    })
  })
}

export function copyImageToClipboard(pngBytes: ArrayBuffer): CopyImageToClipboardResult {
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(pngBytes))
    if (image.isEmpty()) {
      // `createFromBuffer` reports an undecodable buffer as an empty image, and
      // writing that clears the clipboard instead of failing.
      return { copied: false, error: 'unsupported_image' }
    }
    clipboard.writeImage(image)
    return { copied: true }
  } catch (error) {
    return { copied: false, error: formatUnknownError(error) }
  }
}

export async function saveImageFile(
  window: BrowserWindow | null,
  input: SaveImageFileInput
): Promise<SaveImageFileResult> {
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

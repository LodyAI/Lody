import { BrowserWindow, Menu, clipboard, nativeImage } from 'electron'
import type {
  CopyImageToClipboardResult,
  ImagePreviewMenuAction,
  SaveImageFileInput,
  SaveImageFileResult,
  ShowImagePreviewMenuInput,
  ShowImagePreviewMenuResult
} from '@lody/shared/electron-ipc'
import { formatUnknownError } from '../utils'
import { saveFileBytes } from './file-export-service'

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
  // Identical to any other "renderer holds the bytes" save, so it shares the one
  // dialog + write implementation rather than keeping a second copy of it.
  return await saveFileBytes(window, input)
}

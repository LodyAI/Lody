import { ProductWindowIpcService } from '../product-window-ipc-service'
import { BrowserWindow } from 'electron'
import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import {
  CopyImageToClipboardInputSchema,
  SaveImageFileInputSchema,
  ShowImagePreviewMenuInputSchema,
  type CopyImageToClipboardInput,
  type SaveImageFileInput,
  type ShowImagePreviewMenuInput
} from '@lody/shared/electron-ipc'
import {
  copyImageToClipboard,
  saveImageFile,
  showImagePreviewMenu
} from '../../services/image-export-service'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class ImageIpc extends ProductWindowIpcService {
  static override readonly groupName = 'image'

  @IpcMethod()
  async showPreviewMenu(payload: ShowImagePreviewMenuInput) {
    const parsed = ShowImagePreviewMenuInputSchema.safeParse(payload)
    if (!parsed.success) {
      return { action: null }
    }
    const { event } = getIpcContext()
    const window =
      BrowserWindow.fromWebContents(event.sender) ?? getIpcServiceDeps().getMainWindow()
    return await showImagePreviewMenu(window, parsed.data)
  }

  @IpcMethod()
  async copyToClipboard(payload: CopyImageToClipboardInput) {
    const parsed = CopyImageToClipboardInputSchema.safeParse(payload)
    if (!parsed.success) {
      return { copied: false, error: 'invalid_payload' }
    }
    return copyImageToClipboard(parsed.data.pngBytes)
  }

  @IpcMethod()
  async saveAs(payload: SaveImageFileInput) {
    const parsed = SaveImageFileInputSchema.safeParse(payload)
    if (!parsed.success) {
      return { saved: false as const, error: 'invalid_payload' }
    }
    const { event } = getIpcContext()
    const window =
      BrowserWindow.fromWebContents(event.sender) ?? getIpcServiceDeps().getMainWindow()
    return await saveImageFile(window, parsed.data)
  }
}

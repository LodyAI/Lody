import { BrowserWindow, dialog } from 'electron'
import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import { z } from 'zod'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcServiceDeps } from '../ipc-service-deps'
import {
  createWorkspaceBundleService,
  type WorkspaceBundleService
} from '../../services/workspace-bundle-service'

const BUNDLE_FILTERS = [{ name: 'Lody workspace bundle', extensions: ['lodybundle'] }]
const WorkspaceInputSchema = z
  .object({ workspaceId: z.string().min(1).max(200), workspaceName: z.string().max(500) })
  .strict()
const ImportInputSchema = z
  .object({ workspaceId: z.string().min(1).max(200), token: z.string().uuid() })
  .strict()

let service: WorkspaceBundleService | null = null

/** Shows a dialog attached to the requesting window when it still exists. */
function forRequestingWindow<O, R>(
  show: ((window: BrowserWindow, options: O) => Promise<R>) & ((options: O) => Promise<R>),
  options: O
): Promise<R> {
  const owner = BrowserWindow.fromWebContents(getIpcContext().event.sender)
  return owner && !owner.isDestroyed() ? show(owner, options) : show(options)
}

const sendersWithCleanup = new Set<number>()

function bundleService(): WorkspaceBundleService {
  if (service) return service
  const { cliService } = getIpcServiceDeps()
  service = createWorkspaceBundleService({
    machineId: () => cliService.getLocalMachineId(),
    send: (message) => cliService.sendWorkspaceBundleControl(message),
    chooseSavePath: async (defaultName) => {
      const result = await forRequestingWindow(dialog.showSaveDialog, {
        defaultPath: defaultName,
        filters: BUNDLE_FILTERS
      })
      return result.canceled || !result.filePath ? null : result.filePath
    },
    chooseOpenPath: async () => {
      const result = await forRequestingWindow(dialog.showOpenDialog, {
        properties: ['openFile'],
        filters: BUNDLE_FILTERS
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }
  })
  return service
}

/** Workspace export/import from Settings; the import path stays in main. */
export class WorkspaceBundleIpc extends ProductWindowIpcService {
  static override readonly groupName = 'workspaceBundle'

  @IpcMethod()
  async exportWorkspace(input: unknown) {
    return await bundleService().exportWorkspace(WorkspaceInputSchema.parse(input))
  }

  @IpcMethod()
  async chooseImportFile() {
    const sender = getIpcContext().event.sender
    if (!sendersWithCleanup.has(sender.id)) {
      sendersWithCleanup.add(sender.id)
      const senderId = sender.id
      sender.once('destroyed', () => {
        sendersWithCleanup.delete(senderId)
        service?.forgetSender(senderId)
      })
    }
    return await bundleService().chooseImportFile(sender.id)
  }

  @IpcMethod()
  async previewImport(input: unknown) {
    const { workspaceId, token } = ImportInputSchema.parse(input)
    return await bundleService().previewImport({
      senderId: getIpcContext().event.sender.id,
      workspaceId,
      token
    })
  }

  @IpcMethod()
  async importWorkspace(input: unknown) {
    const { workspaceId, token } = ImportInputSchema.parse(input)
    return await bundleService().importWorkspace({
      senderId: getIpcContext().event.sender.id,
      workspaceId,
      token
    })
  }
}

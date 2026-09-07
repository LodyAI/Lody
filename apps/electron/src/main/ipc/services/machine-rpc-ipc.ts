import type { WebContents } from 'electron'
import {
  FilePreviewV3ErrorSchema,
  LocalMachineRpcRequestSchema
} from '@lody/shared/local-machine-rpc'
import { LocalFileResolutionSchema } from '@lody/shared/local-file-preview'
import { localFileResources } from '../../services/local-file-resource-protocol'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import type { LocalMachineRpcRequest } from '@lody/shared/local-machine-rpc'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class MachineRpcIpc extends IpcService {
  static override readonly groupName = 'machineRpc'

  @IpcMethod()
  async previewFile(message: LocalMachineRpcRequest) {
    const parsed = LocalMachineRpcRequestSchema.parse(message)
    if (parsed.method !== 'file/resolve-local') throw new Error('Invalid preview request.')
    const { event } = getIpcContext()
    const owner = event.sender
    const generation = getResourceOwner(owner)
    const result = await getIpcServiceDeps().cliService.sendLocalMachineRpc(parsed)
    if (owner.isDestroyed() || resourceOwners.get(owner.id) !== generation)
      throw new Error('Preview window closed.')
    if (!result.ok) throw new Error(result.error)
    const file = LocalFileResolutionSchema.safeParse(result.result)
    if (!file.success) return FilePreviewV3ErrorSchema.parse(result.result)
    const response = await localFileResources.preview(generation, file.data)
    if (owner.isDestroyed() || resourceOwners.get(owner.id) !== generation) {
      localFileResources.releaseOwner(generation)
      throw new Error('Preview window closed.')
    }
    return response
  }

  @IpcMethod()
  async send(message: LocalMachineRpcRequest) {
    return await getIpcServiceDeps().cliService.sendLocalMachineRpc(message)
  }
}

// Each document gets a distinct owner, including reloads to the same URL. A late
// response from the old document must never revoke a new document's resources.
const resourceOwners = new Map<number, number>()
let nextResourceOwner = 0
function getResourceOwner(owner: WebContents): number {
  const current = resourceOwners.get(owner.id)
  if (current !== undefined) return current
  const generation = ++nextResourceOwner
  resourceOwners.set(owner.id, generation)
  owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    const previous = resourceOwners.get(owner.id)
    if (previous !== undefined) localFileResources.releaseOwner(previous)
    resourceOwners.set(owner.id, ++nextResourceOwner)
  })
  owner.once('destroyed', () => {
    const previous = resourceOwners.get(owner.id)
    if (previous !== undefined) localFileResources.releaseOwner(previous)
    resourceOwners.delete(owner.id)
  })
  return generation
}

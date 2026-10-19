import { join } from 'node:path'
import { getLodyDataDir } from '@lody/shared/node/installation-profile'
import { mainPlatformKind } from '../../platform'
import {
  LocalFilePreviewRequestSchema,
  previewLocalFile,
  readFileMachineId,
  type LocalFilePreviewRequest
} from '../../services/local-file-preview'
import type { WebContents } from 'electron'
import { localFileResources } from '../../services/local-file-resource-protocol'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import type { LocalMachineRpcRequest } from '@lody/shared/local-machine-rpc'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { assertProductWindowSender } from '../assert-sender'

export class MachineRpcIpc extends IpcService {
  static override readonly groupName = 'machineRpc'

  @IpcMethod()
  async isLocalFileMachine(machineId: string) {
    assertProductWindowSender(getIpcContext().event)
    if (typeof machineId !== 'string' || !machineId) return false
    return (
      machineId ===
      (await readFileMachineId(join(getLodyDataDir(mainPlatformKind), 'credentials.json')))
    )
  }

  @IpcMethod()
  async previewFile(message: LocalFilePreviewRequest) {
    const parsed = LocalFilePreviewRequestSchema.parse(message)
    const { event } = getIpcContext()
    assertProductWindowSender(event)
    const owner = event.sender
    const generation = getResourceOwner(owner)
    const machineId = await readFileMachineId(
      join(getLodyDataDir(mainPlatformKind), 'credentials.json')
    )
    if (owner.isDestroyed() || resourceOwners.get(owner.id) !== generation)
      throw new Error('Preview window closed.')
    const response = await previewLocalFile(localFileResources, generation, parsed, machineId)
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

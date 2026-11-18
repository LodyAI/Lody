import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import {
  CloudFileIndexIpcError,
  cloudFileIndexRequestSchema,
  cloudFileIndexReleaseSchema,
  parseCloudFileIndexInput
} from '@lody/shared/cloud-file-index-ipc'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcServiceDeps } from '../ipc-service-deps'
async function safely<A>(operation: () => Promise<A>): Promise<A> {
  try {
    return await operation()
  } catch (error) {
    throw error instanceof CloudFileIndexIpcError ? error : new CloudFileIndexIpcError()
  }
}
/** Captures the real sender before awaiting authenticated workspace authority. */
export class CloudFileIndexIpc extends ProductWindowIpcService {
  static override readonly groupName = 'cloudFileIndex'
  @IpcMethod() async prepareWorkspace(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = parseCloudFileIndexInput(
        cloudFileIndexRequestSchema.pick({ workspaceId: true }),
        input
      )
      await getIpcServiceDeps().prepareCloudFileIndex?.(windowId, request.workspaceId)
    })
  }
  @IpcMethod() async observe(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = parseCloudFileIndexInput(cloudFileIndexRequestSchema, input)
      const bridge = await getIpcServiceDeps().cloudFileIndex?.(windowId, request.workspaceId)
      if (!bridge) throw new CloudFileIndexIpcError()
      return bridge.observe(windowId, request)
    })
  }
  @IpcMethod() async cancel(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = parseCloudFileIndexInput(cloudFileIndexRequestSchema, input)
      const bridge = await getIpcServiceDeps().cloudFileIndex?.(windowId, request.workspaceId)
      if (!bridge) throw new CloudFileIndexIpcError()
      return bridge.cancel(windowId, request)
    })
  }
  @IpcMethod() async unobserve(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = parseCloudFileIndexInput(cloudFileIndexReleaseSchema, input)
      const bridge = await getIpcServiceDeps().cloudFileIndex?.(windowId, request.workspaceId)
      if (!bridge) throw new CloudFileIndexIpcError()
      return bridge.unobserve(windowId, request)
    })
  }
}

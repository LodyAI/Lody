import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import {
  WorkspaceMetaIpcError,
  workspaceMetaErrorCode,
  workspaceMetaScopeSchema,
  workspaceMetaStatefulSchema,
  workspaceMetaCommitSchema,
  workspaceMetaUnobserveSchema
} from '@lody/shared/native-workspace-meta-ipc'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcServiceDeps } from '../ipc-service-deps'
function owner() {
  const value = getIpcServiceDeps().nativeWorkspaceMeta?.()
  if (!value) throw new WorkspaceMetaIpcError('unavailable')
  return value
}
async function safely<A>(work: () => Promise<A>) {
  try {
    return await work()
  } catch (error) {
    throw new WorkspaceMetaIpcError(workspaceMetaErrorCode(error))
  }
}
/** Product main-frame admission precedes exact registration and Node generation checks. */
export class WorkspaceMetaIpc extends ProductWindowIpcService {
  static override readonly groupName = 'workspaceMeta'
  @IpcMethod() async read(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => owner().read(windowId, workspaceMetaScopeSchema.parse(payload)))
  }
  @IpcMethod() async commit(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = workspaceMetaCommitSchema.safeParse(payload)
      if (!request.success) throw new WorkspaceMetaIpcError('not_committed')
      return owner().commit(
        windowId,
        request.data,
        request.data.command,
        request.data.expectedGeneration
      )
    })
  }
  @IpcMethod() async flush(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = workspaceMetaStatefulSchema.parse(payload)
      return owner().flush(windowId, request, request.expectedGeneration)
    })
  }
  @IpcMethod() async observe(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => owner().observe(windowId, workspaceMetaScopeSchema.parse(payload)))
  }
  @IpcMethod() async unobserve(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = workspaceMetaUnobserveSchema.parse(payload)
      return owner().unobserve(windowId, request, request.leaseId)
    })
  }
  @IpcMethod() async cancelObservation(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () =>
      owner().cancelObservation(windowId, workspaceMetaScopeSchema.parse(payload))
    )
  }
}

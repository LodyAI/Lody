import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import {
  NativeSessionIpcError,
  nativeSessionIpcErrorCode,
  nativeSessionIpcScopeSchema,
  nativeSessionIpcReadSchema,
  nativeSessionIpcExecuteSchema,
  nativeSessionIpcUnobserveSchema
} from '@lody/shared/native-session-ipc'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcServiceDeps } from '../ipc-service-deps'
async function safely<A>(work: () => Promise<A>): Promise<A> {
  try {
    return await work()
  } catch (error) {
    throw new NativeSessionIpcError(nativeSessionIpcErrorCode(error))
  }
}
function sessions() {
  const owner = getIpcServiceDeps().nativeSessionDomain?.()
  if (!owner) throw new NativeSessionIpcError('unavailable')
  return owner
}
/** Only registered product main frames; all identities and leases are main-owned. */
export class NativeSessionIpc extends ProductWindowIpcService {
  static override readonly groupName = 'nativeSession'
  @IpcMethod() async route(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () =>
      sessions().route(windowId, nativeSessionIpcScopeSchema.parse(payload))
    )
  }
  @IpcMethod() async read(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = nativeSessionIpcReadSchema.parse(payload)
      return sessions().read(windowId, request, request.query, request.expectedGeneration)
    })
  }
  @IpcMethod() async execute(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = nativeSessionIpcExecuteSchema.parse(payload)
      return sessions().execute(windowId, request, request.command, request.expectedGeneration)
    })
  }
  @IpcMethod() async observe(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () =>
      sessions().observe(windowId, nativeSessionIpcScopeSchema.parse(payload))
    )
  }
  @IpcMethod() async unobserve(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = nativeSessionIpcUnobserveSchema.parse(payload)
      return sessions().unobserve(windowId, request, request.leaseId)
    })
  }
  @IpcMethod() async cancelObservation(payload: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () =>
      sessions().cancelObservation(windowId, nativeSessionIpcScopeSchema.parse(payload))
    )
  }
}

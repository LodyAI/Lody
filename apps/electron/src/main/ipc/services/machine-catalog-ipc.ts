import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import { ZodError } from 'zod'
import {
  MachineCatalogIpcError,
  machineCatalogIpcEditorRequestSchema,
  machineCatalogIpcExecuteRequestSchema,
  machineCatalogIpcRequestSchema,
  machineCatalogIpcUnsubscribeSchema,
  machineCatalogIpcUploadRequestSchema,
  machineCatalogIpcErrorCode
} from '@lody/shared/machine-catalog-ipc'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcServiceDeps } from '../ipc-service-deps'

// Public failures contain finite codes only. Zod and backend causes can contain
// write-only input, private paths or credentials and must stay in main.
async function safely<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new MachineCatalogIpcError(
      error instanceof ZodError ? 'invalid_request' : machineCatalogIpcErrorCode(error)
    )
  }
}
function catalog() {
  const owner = getIpcServiceDeps().nativeMachineCatalog?.()
  if (!owner) throw new MachineCatalogIpcError('unavailable')
  return owner
}

/** The service admits a registered product window; the catalog's trusted grant
 * checks its registration, selected machine and current storage generation. */
export class MachineCatalogIpc extends ProductWindowIpcService {
  static override readonly groupName = 'machineCatalog'

  @IpcMethod()
  async read(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const request = machineCatalogIpcRequestSchema.parse(payload)
      return catalog().read(sender, request.registrationId, request.machineId)
    })
  }

  @IpcMethod()
  async beginAgentConfigEdit(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = machineCatalogIpcEditorRequestSchema.parse(payload)
      return catalog().beginAgentConfigEdit(
        sender,
        r.registrationId,
        r.machineId,
        r.id,
        r.expectedGeneration
      )
    })
  }

  @IpcMethod()
  async execute(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = machineCatalogIpcExecuteRequestSchema.parse(payload)
      return catalog().execute(
        sender,
        r.registrationId,
        r.machineId,
        r.command,
        r.expectedGeneration
      )
    })
  }

  @IpcMethod()
  async upload(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = machineCatalogIpcUploadRequestSchema.parse(payload)
      return catalog().upload(sender, r.registrationId, r.machineId, r.expectedGeneration)
    })
  }

  @IpcMethod()
  async observe(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = machineCatalogIpcRequestSchema.parse(payload)
      return catalog().observe(sender, r.registrationId, r.machineId, r.requestId)
    })
  }

  @IpcMethod()
  async unobserve(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = machineCatalogIpcUnsubscribeSchema.parse(payload)
      await catalog().unsubscribe(sender, r.registrationId, r.machineId, r.requestId, r.leaseId)
    })
  }

  @IpcMethod()
  async cancelObservation(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = machineCatalogIpcRequestSchema.parse(payload)
      return catalog().cancelObservation(sender, r.registrationId, r.machineId, r.requestId)
    })
  }
}

import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import {
  rendererSessionBodyAckSchema,
  rendererSessionBodyRegisterSchema
} from '@lody/shared/renderer-session-body-migration'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcServiceDeps } from '../ipc-service-deps'
async function controller(windowId: number, registrationId: string) {
  const result = await getIpcServiceDeps().nativeSessionBodyMigration?.(windowId, registrationId)
  if (!result) throw new Error('Session migration unavailable')
  return result
}
async function safely<A>(work: () => Promise<A>) {
  try {
    return await work()
  } catch {
    throw new Error('session_body_migration_failed')
  }
}
/** Same main-owned Meta registration, no renderer-selected workspace/namespace. */
export class SessionBodyMigrationIpc extends ProductWindowIpcService {
  static override readonly groupName = 'sessionBodyMigration'
  @IpcMethod() async register(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = rendererSessionBodyRegisterSchema.parse(input)
      return (await controller(windowId, request.registrationId)).register(
        windowId,
        request.registrationId
      )
    })
  }
  @IpcMethod() async ready(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = rendererSessionBodyRegisterSchema.parse(input)
      return (await controller(windowId, request.registrationId)).ready(
        windowId,
        request.registrationId
      )
    })
  }
  @IpcMethod() async acknowledge(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const ack = rendererSessionBodyAckSchema.parse(input)
      ;(await controller(windowId, ack.registrationId)).acknowledge(windowId, ack)
      return { acknowledged: true as const }
    })
  }
  @IpcMethod() async retire(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = rendererSessionBodyRegisterSchema.parse(input)
      ;(await controller(windowId, request.registrationId)).retire(windowId, request.registrationId)
      return { retired: true as const }
    })
  }
}

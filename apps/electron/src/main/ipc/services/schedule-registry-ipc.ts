import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import { ZodError } from 'zod'
import {
  ScheduleRegistryIpcError,
  scheduleRegistryIpcErrorCode,
  scheduleRegistryIpcRequestSchema,
  scheduleRegistryIpcExecuteRequestSchema,
  scheduleRegistryIpcStatefulRequestSchema,
  scheduleRegistryIpcUnsubscribeSchema
} from '@lody/shared/schedule-registry-ipc'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcServiceDeps } from '../ipc-service-deps'
async function safely<A>(work: () => Promise<A>): Promise<A> {
  try {
    return await work()
  } catch (error) {
    throw new ScheduleRegistryIpcError(
      error instanceof ZodError ? 'invalid_request' : scheduleRegistryIpcErrorCode(error)
    )
  }
}
function registry() {
  const owner = getIpcServiceDeps().nativeScheduleRegistry?.()
  if (!owner) throw new ScheduleRegistryIpcError('unavailable')
  return owner
}
/** Registered trusted product main frames only; domain grants recheck the exact
 * main-owned account/workspace/SR and engine generation for each operation. */
export class ScheduleRegistryIpc extends ProductWindowIpcService {
  static override readonly groupName = 'scheduleRegistry'
  @IpcMethod() async read(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = scheduleRegistryIpcRequestSchema.parse(payload)
      return registry().read(sender, r.registrationId)
    })
  }
  @IpcMethod() async execute(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = scheduleRegistryIpcExecuteRequestSchema.parse(payload)
      return registry().execute(sender, r.registrationId, r.command, r.expectedGeneration)
    })
  }
  @IpcMethod() async flush(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = scheduleRegistryIpcStatefulRequestSchema.parse(payload)
      return registry().flush(sender, r.registrationId, r.expectedGeneration)
    })
  }
  @IpcMethod() async observe(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = scheduleRegistryIpcRequestSchema.parse(payload)
      return registry().observe(sender, r.registrationId, r.requestId)
    })
  }
  @IpcMethod() async unobserve(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = scheduleRegistryIpcUnsubscribeSchema.parse(payload)
      await registry().unsubscribe(sender, r.registrationId, r.requestId, r.leaseId)
    })
  }
  @IpcMethod() async cancelObservation(payload: unknown) {
    const sender = getIpcContext().event.sender.id
    return safely(async () => {
      const r = scheduleRegistryIpcRequestSchema.parse(payload)
      return registry().cancelObservation(sender, r.registrationId, r.requestId)
    })
  }
}

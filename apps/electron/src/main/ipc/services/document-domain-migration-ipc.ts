import { z } from 'zod'
import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import {
  nativeDocumentDomainTargetSchema,
  nativeDocumentDomainCreateScheduleSchema,
  nativeDocumentDomainEnsurePreviewSchema,
  parseNativeDocumentDomainInput
} from '@lody/shared/native-document-domain-ipc'
import type { SessionId } from '@lody/shared/ids'
import { rendererDocumentDomainAckSchema } from '@lody/shared/renderer-document-domain-migration'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcServiceDeps } from '../ipc-service-deps'
const registration = z.object({ registrationId: z.uuid() }).strict()
const migration = registration.extend({ target: nativeDocumentDomainTargetSchema }).strict()
async function controller(windowId: number, registrationId: string) {
  const result = await getIpcServiceDeps().nativeDocumentDomainMigration?.(windowId, registrationId)
  if (!result) throw new Error('document_domain_migration_unavailable')
  return result
}
async function safely<A>(work: () => Promise<A>): Promise<A> {
  try {
    return await work()
  } catch {
    throw new Error('document_domain_migration_failed')
  }
}
/** The actual product frame's native Meta registration owns all scope fields. */
export class DocumentDomainMigrationIpc extends ProductWindowIpcService {
  static override readonly groupName = 'documentDomainMigration'
  @IpcMethod() async register(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = registration.parse(input)
      return (await controller(windowId, request.registrationId)).register(
        windowId,
        request.registrationId
      )
    })
  }
  @IpcMethod() async ready(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = registration.parse(input)
      return (await controller(windowId, request.registrationId)).ready(
        windowId,
        request.registrationId
      )
    })
  }
  @IpcMethod() async acknowledge(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const ack = rendererDocumentDomainAckSchema.parse(input)
      ;(await controller(windowId, ack.registrationId)).acknowledge(windowId, ack)
      return { acknowledged: true as const }
    })
  }
  @IpcMethod() async retire(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = registration.parse(input)
      ;(await controller(windowId, request.registrationId)).retire(windowId, request.registrationId)
      return { retired: true as const }
    })
  }
  @IpcMethod() async migrate(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = migration.parse(input)
      const operation = getIpcServiceDeps().migrateNativeDocumentDomain
      if (!operation) throw new Error('unavailable')
      await operation(windowId, request.registrationId, request.target)
      return { migrated: true as const }
    })
  }
  @IpcMethod() async ensurePreview(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainEnsurePreviewSchema, input)
      const operation = getIpcServiceDeps().ensureNativePreviewComments
      if (!operation) throw new Error('unavailable')
      await operation(windowId, request.registrationId, request.target.id as SessionId)
      return { created: true as const }
    })
  }
  @IpcMethod() async createSchedule(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safely(async () => {
      const request = parseNativeDocumentDomainInput(
        nativeDocumentDomainCreateScheduleSchema,
        input
      )
      const operation = getIpcServiceDeps().createNativeScheduleDefinition
      if (!operation) throw new Error('unavailable')
      await operation(windowId, request.registrationId, {
        scheduleId: request.target.id,
        draft: request.draft,
        now: request.now,
        activationId: request.activationId,
        activityId: request.activityId
      })
      return { created: true as const }
    })
  }
}

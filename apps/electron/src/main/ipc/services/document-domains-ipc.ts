import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import {
  NativeDocumentDomainIpcError,
  nativeDocumentDomainRequestSchema,
  nativeDocumentDomainExecuteSchema,
  nativeDocumentDomainReleaseSchema,
  parseNativeDocumentDomainInput
} from '@lody/shared/native-document-domain-ipc'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { getIpcServiceDeps } from '../ipc-service-deps'
async function bridge(windowId: number, registrationId: string) {
  const value = await getIpcServiceDeps().nativeDocumentDomains?.(windowId, registrationId)
  if (!value) throw new NativeDocumentDomainIpcError('unavailable')
  return value
}
async function safe<A>(operation: () => Promise<A>): Promise<A> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof NativeDocumentDomainIpcError) throw error
    throw new NativeDocumentDomainIpcError('unavailable')
  }
}
/** Every sender is captured before await; errors carry finite codes only. */
export class DocumentDomainsIpc extends ProductWindowIpcService {
  static override readonly groupName = 'documentDomains'
  @IpcMethod() async route(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainRequestSchema, input)
      return (await bridge(windowId, request.registrationId)).route(windowId, request)
    })
  }
  @IpcMethod() async read(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainRequestSchema, input)
      return (await bridge(windowId, request.registrationId)).read(windowId, request)
    })
  }
  @IpcMethod() async execute(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainExecuteSchema, input)
      return (await bridge(windowId, request.registrationId)).execute(windowId, request)
    })
  }
  @IpcMethod() async observe(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainRequestSchema, input)
      return (await bridge(windowId, request.registrationId)).observe(windowId, request)
    })
  }
  @IpcMethod() async unobserve(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainReleaseSchema, input)
      await (await bridge(windowId, request.registrationId)).unsubscribe(windowId, request)
      return { released: true as const }
    })
  }
  @IpcMethod() async cancel(input: unknown) {
    const windowId = getIpcContext().event.sender.id
    return safe(async () => {
      const request = parseNativeDocumentDomainInput(nativeDocumentDomainRequestSchema, input)
      return (await bridge(windowId, request.registrationId)).cancel(windowId, request)
    })
  }
}

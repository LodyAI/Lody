import { IpcMethod } from 'electron-ipc-decorator'
import {
  IMPORT_SOURCE_IDS,
  SorbetConnectApiKeyInputSchema,
  SorbetConnectCustomProviderInputSchema,
  SorbetImportRequestSchema,
  SorbetStartOAuthInputSchema,
  type ImportSourceId,
  type SorbetConnectApiKeyInput,
  type SorbetConnectCustomProviderInput,
  type SorbetImportRequest,
  type SorbetStartOAuthInput
} from '@lody/shared/electron-ipc'
import { getIpcServiceDeps } from '../ipc-service-deps'
import { ProductWindowIpcService } from '../product-window-ipc-service'

export class OnboardingSorbetIpc extends ProductWindowIpcService {
  static override readonly groupName = 'onboardingSorbet'

  @IpcMethod()
  async probeArrival(options?: { forceRefresh?: boolean }) {
    return await getIpcServiceDeps().onboardingSorbetService.probeArrival({
      forceRefresh: options?.forceRefresh === true
    })
  }

  @IpcMethod()
  getAuthState() {
    return getIpcServiceDeps().onboardingSorbetService.getAuthState()
  }

  @IpcMethod()
  async startOAuth(payload: SorbetStartOAuthInput) {
    const parsed = SorbetStartOAuthInputSchema.parse(payload)
    return await getIpcServiceDeps().onboardingSorbetService.startOAuth(parsed)
  }

  @IpcMethod()
  cancelOAuth() {
    return getIpcServiceDeps().onboardingSorbetService.cancelOAuth()
  }

  @IpcMethod()
  describeImport(source: ImportSourceId) {
    if (!(IMPORT_SOURCE_IDS as readonly string[]).includes(source)) {
      throw new Error(`Invalid import source: ${String(source)}`)
    }
    return getIpcServiceDeps().onboardingSorbetService.describeImport(source)
  }

  @IpcMethod()
  async runImport(payload: SorbetImportRequest) {
    const parsed = SorbetImportRequestSchema.parse(payload)
    return await getIpcServiceDeps().onboardingSorbetService.runImport(parsed)
  }

  @IpcMethod()
  async connectApiKey(payload: SorbetConnectApiKeyInput) {
    const parsed = SorbetConnectApiKeyInputSchema.parse(payload)
    return await getIpcServiceDeps().onboardingSorbetService.connectApiKey(parsed)
  }

  @IpcMethod()
  async connectCustomProvider(payload: SorbetConnectCustomProviderInput) {
    const parsed = SorbetConnectCustomProviderInputSchema.parse(payload)
    return await getIpcServiceDeps().onboardingSorbetService.connectCustomProvider(parsed)
  }

  @IpcMethod()
  async disconnectProvider(providerId: string) {
    const trimmed = typeof providerId === 'string' ? providerId.trim() : ''
    if (!trimmed) throw new Error('Invalid providerId')
    await getIpcServiceDeps().onboardingSorbetService.disconnectProvider(trimmed)
    return { ok: true as const }
  }

  @IpcMethod()
  async listConnectionSources() {
    return await getIpcServiceDeps().onboardingSorbetService.listConnectionSources()
  }
}

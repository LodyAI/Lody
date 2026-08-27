import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import {
  ElectronPublicBrowserBoundsInputSchema,
  ElectronPublicBrowserCreateInputSchema,
  ElectronPublicBrowserIdInputSchema,
  ElectronPublicBrowserNavigateInputSchema,
  ElectronPublicBrowserVisibilityInputSchema,
  type ElectronPublicBrowserBoundsInput,
  type ElectronPublicBrowserCreateInput,
  type ElectronPublicBrowserIdInput,
  type ElectronPublicBrowserNavigateInput,
  type ElectronPublicBrowserVisibilityInput
} from '@lody/shared/electron-ipc'
import { getIpcServiceDeps } from '../ipc-service-deps'

function assertTrustedSender(): void {
  const { event } = getIpcContext()
  const window = getIpcServiceDeps().getMainWindow()
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('Rejected public browser IPC from an untrusted renderer.')
  }
}

export class PublicBrowserIpc extends IpcService {
  static override readonly groupName = 'publicBrowser'

  @IpcMethod()
  async create(raw: ElectronPublicBrowserCreateInput) {
    assertTrustedSender()
    const input = ElectronPublicBrowserCreateInputSchema.parse(raw)
    return getIpcServiceDeps().publicBrowserService.create(input.browserId, input.bounds)
  }

  @IpcMethod()
  async navigate(raw: ElectronPublicBrowserNavigateInput) {
    assertTrustedSender()
    const input = ElectronPublicBrowserNavigateInputSchema.parse(raw)
    return await getIpcServiceDeps().publicBrowserService.navigate(input.browserId, input.url)
  }

  @IpcMethod()
  async back(raw: ElectronPublicBrowserIdInput) {
    assertTrustedSender()
    const input = ElectronPublicBrowserIdInputSchema.parse(raw)
    return getIpcServiceDeps().publicBrowserService.goBack(input.browserId)
  }

  @IpcMethod()
  async forward(raw: ElectronPublicBrowserIdInput) {
    assertTrustedSender()
    const input = ElectronPublicBrowserIdInputSchema.parse(raw)
    return getIpcServiceDeps().publicBrowserService.goForward(input.browserId)
  }

  @IpcMethod()
  async reload(raw: ElectronPublicBrowserIdInput) {
    assertTrustedSender()
    const input = ElectronPublicBrowserIdInputSchema.parse(raw)
    return getIpcServiceDeps().publicBrowserService.reload(input.browserId)
  }

  @IpcMethod()
  async stop(raw: ElectronPublicBrowserIdInput) {
    assertTrustedSender()
    const input = ElectronPublicBrowserIdInputSchema.parse(raw)
    return getIpcServiceDeps().publicBrowserService.stop(input.browserId)
  }

  @IpcMethod()
  async setBounds(raw: ElectronPublicBrowserBoundsInput) {
    assertTrustedSender()
    const input = ElectronPublicBrowserBoundsInputSchema.parse(raw)
    return getIpcServiceDeps().publicBrowserService.setBounds(input.browserId, input.bounds)
  }

  @IpcMethod()
  async setVisible(raw: ElectronPublicBrowserVisibilityInput) {
    assertTrustedSender()
    const input = ElectronPublicBrowserVisibilityInputSchema.parse(raw)
    return getIpcServiceDeps().publicBrowserService.setVisible(input.browserId, input.visible)
  }

  @IpcMethod()
  async destroy(raw: ElectronPublicBrowserIdInput) {
    assertTrustedSender()
    const input = ElectronPublicBrowserIdInputSchema.parse(raw)
    return getIpcServiceDeps().publicBrowserService.destroy(input.browserId)
  }
}

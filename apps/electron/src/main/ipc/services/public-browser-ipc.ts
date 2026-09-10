import { BrowserWindow } from 'electron'
import { assertProductWindowSender } from '../assert-sender'
import { PublicBrowserService } from '../../services/public-browser-service'
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

const services = new WeakMap<BrowserWindow, PublicBrowserService>()
function getWindowBrowser(): PublicBrowserService {
  const { event } = getIpcContext()
  assertProductWindowSender(event)
  const window = BrowserWindow.fromWebContents(event.sender)!
  let service = services.get(window)
  if (!service) {
    service =
      window === getIpcServiceDeps().getMainWindow()
        ? getIpcServiceDeps().publicBrowserService
        : new PublicBrowserService(() => window)
    services.set(window, service)
  }
  return service
}

export class PublicBrowserIpc extends IpcService {
  static override readonly groupName = 'publicBrowser'

  @IpcMethod()
  async create(raw: ElectronPublicBrowserCreateInput) {
    const input = ElectronPublicBrowserCreateInputSchema.parse(raw)
    return getWindowBrowser().create(input.browserId, input.bounds)
  }

  @IpcMethod()
  async navigate(raw: ElectronPublicBrowserNavigateInput) {
    const input = ElectronPublicBrowserNavigateInputSchema.parse(raw)
    return await getWindowBrowser().navigate(input.browserId, input.url)
  }

  @IpcMethod()
  async back(raw: ElectronPublicBrowserIdInput) {
    const input = ElectronPublicBrowserIdInputSchema.parse(raw)
    return getWindowBrowser().goBack(input.browserId)
  }

  @IpcMethod()
  async forward(raw: ElectronPublicBrowserIdInput) {
    const input = ElectronPublicBrowserIdInputSchema.parse(raw)
    return getWindowBrowser().goForward(input.browserId)
  }

  @IpcMethod()
  async reload(raw: ElectronPublicBrowserIdInput) {
    const input = ElectronPublicBrowserIdInputSchema.parse(raw)
    return getWindowBrowser().reload(input.browserId)
  }

  @IpcMethod()
  async stop(raw: ElectronPublicBrowserIdInput) {
    const input = ElectronPublicBrowserIdInputSchema.parse(raw)
    return getWindowBrowser().stop(input.browserId)
  }

  @IpcMethod()
  async setBounds(raw: ElectronPublicBrowserBoundsInput) {
    const input = ElectronPublicBrowserBoundsInputSchema.parse(raw)
    return getWindowBrowser().setBounds(input.browserId, input.bounds)
  }

  @IpcMethod()
  async setVisible(raw: ElectronPublicBrowserVisibilityInput) {
    const input = ElectronPublicBrowserVisibilityInputSchema.parse(raw)
    return getWindowBrowser().setVisible(input.browserId, input.visible)
  }

  @IpcMethod()
  async destroy(raw: ElectronPublicBrowserIdInput) {
    const input = ElectronPublicBrowserIdInputSchema.parse(raw)
    return getWindowBrowser().destroy(input.browserId)
  }
}

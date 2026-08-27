import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class CliIpc extends IpcService {
  static override readonly groupName = 'cli'

  @IpcMethod()
  async getOutputBacklog() {
    return getIpcServiceDeps().cliService.getOutputBacklog()
  }

  @IpcMethod()
  async getState() {
    const { event } = getIpcContext()
    const { cliService } = getIpcServiceDeps()
    cliService.attachCliStateSender(event.sender)
    return cliService.getCliState()
  }

  @IpcMethod()
  async restart() {
    const { event } = getIpcContext()
    const { cliService } = getIpcServiceDeps()
    cliService.attachCliStateSender(event.sender)
    return await cliService.restartAutoStart()
  }

  @IpcMethod()
  async terminate() {
    const { event } = getIpcContext()
    const { cliService } = getIpcServiceDeps()
    cliService.attachCliStateSender(event.sender)
    return await cliService.terminateAutoStart()
  }

  @IpcMethod()
  async getAutoStartEnabled() {
    return { enabled: getIpcServiceDeps().cliService.getCliAutoStartEnabled() }
  }

  @IpcMethod()
  async setAutoStartEnabled(enabledRaw: boolean) {
    const { event } = getIpcContext()
    const { cliService, loroDataPlaneRelay } = getIpcServiceDeps()
    if (typeof enabledRaw !== 'boolean') {
      return { ok: false, enabled: cliService.getCliAutoStartEnabled() }
    }
    cliService.attachCliStateSender(event.sender)
    cliService.setCliAutoStartEnabled(enabledRaw)
    loroDataPlaneRelay.setEnabled(enabledRaw)
    return { ok: true, enabled: enabledRaw }
  }
}

import { IpcMethod, IpcService } from 'electron-ipc-decorator'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class UpdaterIpc extends IpcService {
  static override readonly groupName = 'updater'

  @IpcMethod()
  async getState() {
    return getIpcServiceDeps().appUpdaterService.getState()
  }

  @IpcMethod()
  async checkForUpdates() {
    return await getIpcServiceDeps().appUpdaterService.checkForUpdates()
  }

  @IpcMethod()
  async quitAndInstall() {
    return await getIpcServiceDeps().appUpdaterService.quitAndInstall()
  }
}

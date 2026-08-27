import { IpcMethod, IpcService } from 'electron-ipc-decorator'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class LoroIpc extends IpcService {
  static override readonly groupName = 'loro'

  @IpcMethod()
  async isConnected() {
    return getIpcServiceDeps().loroDataPlaneRelay.isConnected()
  }
}

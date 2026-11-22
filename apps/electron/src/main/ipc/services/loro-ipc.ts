import { ProductWindowIpcService } from '../product-window-ipc-service'
import { IpcMethod } from 'electron-ipc-decorator'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class LoroIpc extends ProductWindowIpcService {
  static override readonly groupName = 'loro'

  @IpcMethod()
  async isConnected() {
    return getIpcServiceDeps().loroDataPlaneRelay.isConnected()
  }
}

import { ProductWindowIpcService } from '../product-window-ipc-service'
import { IpcMethod } from 'electron-ipc-decorator'
import { isLocalPlatform, readLocalPlatformSnapshot } from '../../platform'

export class LocalPlatformIpc extends ProductWindowIpcService {
  static override readonly groupName = 'localPlatform'

  @IpcMethod()
  async getSnapshot() {
    if (!isLocalPlatform()) return null
    return await readLocalPlatformSnapshot()
  }
}

import { IpcMethod, IpcService } from 'electron-ipc-decorator'
import { isLocalPlatform, readLocalPlatformSnapshot } from '../../platform'

export class LocalPlatformIpc extends IpcService {
  static override readonly groupName = 'localPlatform'

  @IpcMethod()
  async getSnapshot() {
    if (!isLocalPlatform()) return null
    return await readLocalPlatformSnapshot()
  }
}

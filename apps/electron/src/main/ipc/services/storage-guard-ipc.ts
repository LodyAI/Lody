import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import type {
  ElectronStorageGuardRelaunchOutcome,
  ElectronStorageGuardState
} from '@lody/shared/electron-ipc'
import { assertProductWindowSender } from '../assert-sender'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class StorageGuardIpc extends IpcService {
  static override readonly groupName = 'storageGuard'

  @IpcMethod()
  async getState(): Promise<ElectronStorageGuardState> {
    return getIpcServiceDeps().storageGuard.getState()
  }

  /** The renderer's local store failed a write; the main process decides if the disk is why. */
  @IpcMethod()
  async reportWriteFailure(): Promise<void> {
    assertProductWindowSender(getIpcContext().event)
    await getIpcServiceDeps().storageGuard.reportWriteFailure('renderer')
  }

  @IpcMethod()
  async relaunchIfSpaceFreed(): Promise<ElectronStorageGuardRelaunchOutcome> {
    assertProductWindowSender(getIpcContext().event)
    return await getIpcServiceDeps().storageGuard.relaunchIfSpaceFreed()
  }

  @IpcMethod()
  async quit(): Promise<void> {
    assertProductWindowSender(getIpcContext().event)
    getIpcServiceDeps().storageGuard.quit()
  }
}

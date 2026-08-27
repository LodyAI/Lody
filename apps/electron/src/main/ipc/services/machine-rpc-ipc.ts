import { IpcMethod, IpcService } from 'electron-ipc-decorator'
import type { LocalMachineRpcRequest } from '@lody/shared/local-machine-rpc'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class MachineRpcIpc extends IpcService {
  static override readonly groupName = 'machineRpc'

  @IpcMethod()
  async send(message: LocalMachineRpcRequest) {
    return await getIpcServiceDeps().cliService.sendLocalMachineRpc(message)
  }
}

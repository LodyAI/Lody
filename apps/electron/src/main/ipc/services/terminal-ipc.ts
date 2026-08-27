import { clipboard } from 'electron'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import {
  TerminalClientMessageSchema,
  type TerminalOpenParams
} from '@lody/shared/terminal-protocol'
import { getIpcServiceDeps } from '../ipc-service-deps'

export class TerminalIpc extends IpcService {
  static override readonly groupName = 'terminal'

  @IpcMethod()
  async list(sessionIdRaw: string) {
    if (typeof sessionIdRaw !== 'string' || !sessionIdRaw.trim()) {
      throw new Error('invalid_session_id')
    }
    const { event } = getIpcContext()
    return await getIpcServiceDeps().terminalRelay.list(sessionIdRaw, event.sender)
  }

  @IpcMethod()
  async open(payload: TerminalOpenParams) {
    const message = TerminalClientMessageSchema.parse({
      ...(payload && typeof payload === 'object' ? payload : {}),
      type: 'open'
    })
    if (message.type !== 'open') {
      throw new Error('invalid_terminal_open_request')
    }
    const { event } = getIpcContext()
    return await getIpcServiceDeps().terminalRelay.open(message, event.sender)
  }

  @IpcMethod()
  async readClipboardText() {
    return clipboard.readText()
  }

  @IpcMethod()
  async writeClipboardText(text: string) {
    clipboard.writeText(text)
  }
}

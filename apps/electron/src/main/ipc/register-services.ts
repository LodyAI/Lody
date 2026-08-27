import { ipcMain, type IpcMainEvent } from 'electron'
import { createServices, type MergeIpcService } from 'electron-ipc-decorator'
import { IPC_PUSH_CHANNELS, IPC_SEND_CHANNELS } from '@lody/shared/electron-ipc'
import { LocalLoroDataPlaneClientMessageSchema } from '@lody/shared/local-loro-data-plane'
import { TerminalClientMessageSchema } from '@lody/shared/terminal-protocol'
import { AppIpc, installNativeThemeWatch } from './services/app-ipc'
import { AuthIpc } from './services/auth-ipc'
import { CliIpc } from './services/cli-ipc'
import { ImageIpc } from './services/image-ipc'
import { LocalPlatformIpc } from './services/local-platform-ipc'
import { LocalProjectsIpc } from './services/local-projects-ipc'
import { LoroIpc } from './services/loro-ipc'
import { MachineRpcIpc } from './services/machine-rpc-ipc'
import { NotificationsIpc } from './services/notifications-ipc'
import { PublicBrowserIpc } from './services/public-browser-ipc'
import { SessionControlIpc } from './services/session-control-ipc'
import { TerminalIpc } from './services/terminal-ipc'
import { UpdaterIpc } from './services/updater-ipc'
import { setIpcServiceDeps, type IpcServiceDeps } from './ipc-service-deps'

type TerminalFireAndForgetType = 'attach' | 'input' | 'resize' | 'close' | 'close_session'

export const IPC_SERVICE_CONSTRUCTORS = [
  AppIpc,
  AuthIpc,
  CliIpc,
  ImageIpc,
  LocalPlatformIpc,
  LocalProjectsIpc,
  LoroIpc,
  MachineRpcIpc,
  NotificationsIpc,
  PublicBrowserIpc,
  SessionControlIpc,
  TerminalIpc,
  UpdaterIpc
] as const

function createRegisteredIpcServices() {
  return createServices(IPC_SERVICE_CONSTRUCTORS)
}

export type ElectronIpcServices = MergeIpcService<ReturnType<typeof createRegisteredIpcServices>>

export function registerIpcServices(deps: IpcServiceDeps) {
  setIpcServiceDeps(deps)
  installNativeThemeWatch()

  ipcMain.on(IPC_SEND_CHANNELS.cliSubscribe, (event) => {
    deps.cliService.attachCliStateSender(event.sender)
  })
  ipcMain.on(IPC_SEND_CHANNELS.loroSubscribe, (event) => {
    deps.loroDataPlaneRelay.attachSender(event.sender)
  })
  ipcMain.on(IPC_SEND_CHANNELS.loroSend, (event, payload: unknown) => {
    const parsed = LocalLoroDataPlaneClientMessageSchema.safeParse(payload)
    if (parsed.success) {
      deps.loroDataPlaneRelay.send(parsed.data, event.sender)
    }
  })

  const sendTerminalFireAndForget = (
    event: IpcMainEvent,
    type: TerminalFireAndForgetType,
    payload: unknown
  ) => {
    const parsed = TerminalClientMessageSchema.safeParse({
      ...(payload && typeof payload === 'object' ? payload : {}),
      type
    })
    if (!parsed.success) {
      event.sender.send(IPC_PUSH_CHANNELS.terminalEvent, {
        type: 'error',
        code: 'invalid_request',
        message: parsed.error.message
      })
      return
    }
    deps.terminalRelay.send(parsed.data, event.sender)
  }

  ipcMain.on(IPC_SEND_CHANNELS.terminalAttach, (event, payload: unknown) => {
    sendTerminalFireAndForget(event, 'attach', payload)
  })
  ipcMain.on(IPC_SEND_CHANNELS.terminalInput, (event, payload: unknown) => {
    sendTerminalFireAndForget(event, 'input', payload)
  })
  ipcMain.on(IPC_SEND_CHANNELS.terminalResize, (event, payload: unknown) => {
    sendTerminalFireAndForget(event, 'resize', payload)
  })
  ipcMain.on(IPC_SEND_CHANNELS.terminalClose, (event, payload: unknown) => {
    sendTerminalFireAndForget(event, 'close', payload)
  })
  ipcMain.on(IPC_SEND_CHANNELS.terminalCloseSession, (event, payload: unknown) => {
    sendTerminalFireAndForget(event, 'close_session', payload)
  })

  return createRegisteredIpcServices()
}

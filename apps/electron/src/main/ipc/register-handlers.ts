import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ElectronAuthCallbackInput,
  ElectronDevEmailPasswordSignInInput,
  SendSessionFileLocalInput,
  SendSessionFileLocalResult,
  SetGlobalShortcutInput,
  ShowSessionCompletionNotificationInput
} from '@lody/shared/electron-ipc'
import {
  CopyImageToClipboardInputSchema,
  ELECTRON_LOCAL_SESSION_CONTROL_RESPONSE_CHANNEL,
  ElectronAuthCallbackInputSchema,
  ElectronDevEmailPasswordSignInInputSchema,
  GLOBAL_SHORTCUT_DEFAULTS,
  LaunchLocalPathInputSchema,
  SaveImageFileInputSchema,
  ShowImagePreviewMenuInputSchema
} from '@lody/shared/electron-ipc'
import type {
  LocalProjectControlRequest,
  LocalSessionControlRequest,
  SessionFileSendLocalResponse
} from '@lody/shared/message'
import type { SessionId, WorkspaceId } from '@lody/shared/ids'
import { TerminalClientMessageSchema } from '@lody/shared/terminal-protocol'
import { LocalLoroDataPlaneClientMessageSchema } from '@lody/shared/local-loro-data-plane'
import type { LocalMachineRpcRequest } from '@lody/shared/local-machine-rpc'
import { SessionIdSchema } from '@lody/shared/message-schemas'
import type { LocalProjectHistoryProvider, LocalProjectId } from '@lody/shared/project'
import type { CliService } from '../services/cli-service'
import type { TerminalRelay } from '../services/terminal-relay'
import type { LoroDataPlaneRelay } from '../services/loro-data-plane-relay'
import type { AppUpdaterService } from '../services/app-updater-service'
import type { NotificationService } from '../services/notification-service'
import type { AuthService } from '../services/auth-service'
import type { GlobalShortcutsService } from '../services/global-shortcuts-service'
import type { WindowBadgeService } from '../services/window-badge-service'
import { parseWindowBadge } from '../services/window-badge-service'
import { launchLocalPath } from '../services/local-path-launcher-service'
import {
  copyImageToClipboard,
  saveImageFile,
  showImagePreviewMenu
} from '../services/image-export-service'
import { setMenuLanguage } from '../menu'
import { isLocalPlatform, readLocalPlatformSnapshot } from '../platform'
import { formatUnknownError, normalizeExternalHttpUrl } from '../utils'
import {
  findWindow,
  markRendererMounted,
  persistRendererFatalError,
  requestRendererReload
} from '../renderer-recovery'
import { getMainWindowBackgroundColor, getMainWindowTitleBarOverlay } from '../window-theme'

function isShowSessionCompletionNotificationInput(
  payload: unknown
): payload is ShowSessionCompletionNotificationInput {
  return (
    !!payload &&
    typeof payload === 'object' &&
    typeof (payload as ShowSessionCompletionNotificationInput).sessionId === 'string' &&
    typeof (payload as ShowSessionCompletionNotificationInput).title === 'string' &&
    typeof (payload as ShowSessionCompletionNotificationInput).body === 'string'
  )
}

function assertMainWindowSender(
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null
): void {
  const mainWindow = getMainWindow()
  const senderUrl = event.senderFrame?.url
  const devRendererUrl = process.env['ELECTRON_RENDERER_URL']
  let hasAllowedUrl = false
  try {
    const parsedSender = new URL(senderUrl ?? '')
    hasAllowedUrl = devRendererUrl
      ? parsedSender.origin === new URL(devRendererUrl).origin
      : parsedSender.protocol === 'file:' &&
        parsedSender.pathname.endsWith('/out/renderer/index.html')
  } catch {
    hasAllowedUrl = false
  }

  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    !hasAllowedUrl
  ) {
    throw new Error('Rejected auth IPC from an untrusted renderer')
  }
}

const SESSION_FILE_SEND_LOCAL_MAX_COUNT = 8
const SESSION_FILE_SEND_LOCAL_MAX_SIZE_BYTES = 100 * 1024 * 1024

function parseSendSessionFileLocalInput(payload: unknown): SendSessionFileLocalInput | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const record = payload as Record<string, unknown>
  const { workspaceId, sessionId, machineId, files } = record
  if (
    typeof workspaceId !== 'string' ||
    !workspaceId.trim() ||
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    typeof machineId !== 'string' ||
    !machineId.trim() ||
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > SESSION_FILE_SEND_LOCAL_MAX_COUNT
  ) {
    return null
  }
  const parsedFiles: SendSessionFileLocalInput['files'] = []
  for (const file of files) {
    if (!file || typeof file !== 'object') {
      return null
    }
    const fileRecord = file as Record<string, unknown>
    const fileName = fileRecord.fileName
    const bytes = fileRecord.bytes
    if (typeof fileName !== 'string' || !fileName.trim() || !(bytes instanceof ArrayBuffer)) {
      return null
    }
    if (bytes.byteLength <= 0 || bytes.byteLength > SESSION_FILE_SEND_LOCAL_MAX_SIZE_BYTES) {
      return null
    }
    parsedFiles.push({ fileName, bytes })
  }
  return { workspaceId, sessionId, machineId, files: parsedFiles }
}

function isLocalProjectHistoryProvider(value: unknown): value is LocalProjectHistoryProvider {
  return (
    !!value &&
    typeof value === 'object' &&
    ((value as { cliType?: unknown }).cliType === 'builtin' ||
      (value as { cliType?: unknown }).cliType === 'registry') &&
    typeof (value as { agentType?: unknown }).agentType === 'string' &&
    (value as { agentType: string }).agentType.trim().length > 0
  )
}

type RegisterIpcHandlersOptions = {
  cliService: CliService
  terminalRelay: TerminalRelay
  loroDataPlaneRelay: LoroDataPlaneRelay
  appUpdaterService: AppUpdaterService
  notificationService: NotificationService
  authService: AuthService
  windowBadgeService: WindowBadgeService
  globalShortcutsService: GlobalShortcutsService
  getMainWindow: () => BrowserWindow | null
}

function isSetGlobalShortcutInput(value: unknown): value is SetGlobalShortcutInput {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { id?: unknown; binding?: unknown }
  if (typeof candidate.id !== 'string') return false
  if (!(candidate.id in GLOBAL_SHORTCUT_DEFAULTS)) return false
  return candidate.binding === null || typeof candidate.binding === 'string'
}

type LocalProjectControlRequestWithoutMachine = LocalProjectControlRequest extends infer T
  ? T extends { machineId: unknown }
    ? Omit<T, 'machineId'>
    : never
  : never

type TerminalFireAndForgetType = 'attach' | 'input' | 'resize' | 'close' | 'close_session'

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): void {
  const autoLaunchSupported = process.platform === 'darwin' || process.platform === 'win32'

  const getAutoLaunchStatus = () => {
    if (!autoLaunchSupported) {
      return {
        supported: false,
        enabled: false
      }
    }

    try {
      const settings = app.getLoginItemSettings()
      return {
        supported: true,
        enabled: Boolean(settings.openAtLogin),
        openAtLogin: Boolean(settings.openAtLogin),
        openAsHidden: Boolean(settings.openAsHidden)
      }
    } catch (error) {
      return {
        supported: true,
        enabled: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  const sendLocalProjectControl = async (
    request: LocalProjectControlRequest | LocalProjectControlRequestWithoutMachine,
    knownMachineId?: string
  ) => {
    const unavailableResponse = {
      ok: false,
      type: request.type,
      error: 'daemon_unavailable',
      message: 'Local CLI daemon is unavailable. Run `npx lody start`.'
    } as const

    const machineId = knownMachineId ?? (await options.cliService.getLocalMachineId())
    if (!machineId) {
      return unavailableResponse
    }

    const requestWithMachineId = {
      ...request,
      machineId
    } as LocalProjectControlRequest
    const response = await options.cliService.sendLocalProjectControl(requestWithMachineId)
    if (response.ok || response.error !== 'machine_mismatch') {
      return response
    }

    const refreshedMachineId = await options.cliService.getLocalMachineId({ forceRefresh: true })
    if (!refreshedMachineId || refreshedMachineId === machineId) {
      return response
    }

    return await options.cliService.sendLocalProjectControl({
      ...request,
      machineId: refreshedMachineId
    } as LocalProjectControlRequest)
  }

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
      event.sender.send('lodyTerminal:event', {
        type: 'error',
        code: 'invalid_request',
        message: parsed.error.message
      })
      return
    }
    options.terminalRelay.send(parsed.data, event.sender)
  }

  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle(
    'lodyLocalProjects:control',
    async (_event, request: LocalProjectControlRequest) => {
      return await sendLocalProjectControl(request)
    }
  )

  ipcMain.handle('lodyCli:getOutputBacklog', () => {
    return options.cliService.getOutputBacklog()
  })

  ipcMain.on('lodyCliState:subscribe', (event) => {
    options.cliService.attachCliStateSender(event.sender)
  })

  ipcMain.handle('lodyCliState:getState', (event) => {
    options.cliService.attachCliStateSender(event.sender)
    return options.cliService.getCliState()
  })

  ipcMain.handle('lodyCliState:restart', async (event) => {
    options.cliService.attachCliStateSender(event.sender)
    return await options.cliService.restartAutoStart()
  })

  ipcMain.handle('lodyCliState:terminate', async (event) => {
    options.cliService.attachCliStateSender(event.sender)
    return await options.cliService.terminateAutoStart()
  })

  ipcMain.handle('lodyCli:getAutoStartEnabled', () => {
    return { enabled: options.cliService.getCliAutoStartEnabled() }
  })

  ipcMain.handle('lodyCli:setAutoStartEnabled', (event, enabledRaw: unknown) => {
    if (typeof enabledRaw !== 'boolean') {
      return { ok: false, enabled: options.cliService.getCliAutoStartEnabled() }
    }
    options.cliService.attachCliStateSender(event.sender)
    options.cliService.setCliAutoStartEnabled(enabledRaw)
    return { ok: true, enabled: enabledRaw }
  })

  ipcMain.handle('lodyUpdater:getState', () => {
    return options.appUpdaterService.getState()
  })

  ipcMain.handle('lodyUpdater:checkForUpdates', async () => {
    return await options.appUpdaterService.checkForUpdates()
  })

  ipcMain.handle('lodyUpdater:quitAndInstall', () => {
    return options.appUpdaterService.quitAndInstall()
  })

  ipcMain.handle('lodyWindow:getFullscreen', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
  })

  ipcMain.handle('lodySessionControl:send', async (event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'invalid_request' }
    }
    const requestId = (payload as { requestId?: unknown }).requestId
    const message = (payload as { message?: unknown }).message
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      return { ok: false, error: 'invalid_request' }
    }

    return await options.cliService.sendLocalSessionControl(message as LocalSessionControlRequest, {
      onResponse: (response) => {
        if (event.sender.isDestroyed()) return
        event.sender.send(ELECTRON_LOCAL_SESSION_CONTROL_RESPONSE_CHANNEL, {
          requestId,
          response
        })
      }
    })
  })

  ipcMain.handle('lodyMachineRpc:send', async (_event, payload: unknown) => {
    return await options.cliService.sendLocalMachineRpc(payload as LocalMachineRpcRequest)
  })

  // Protocol 2 is push-based: send is fire-and-forget, and the renderer
  // subscribes to server pushes ('lodyLoroDataPlane:event') + connection status
  // ('lodyLoroDataPlane:status') via the relay.
  ipcMain.on('lodyLoroDataPlane:subscribe', (event) => {
    options.loroDataPlaneRelay.attachSender(event.sender)
  })
  ipcMain.on('lodyLoroDataPlane:send', (event, payload: unknown) => {
    const parsed = LocalLoroDataPlaneClientMessageSchema.safeParse(payload)
    if (parsed.success) {
      options.loroDataPlaneRelay.send(parsed.data, event.sender)
    }
  })
  ipcMain.handle('lodyLoroDataPlane:isConnected', () => {
    return options.loroDataPlaneRelay.isConnected()
  })

  ipcMain.handle('lodyTerminal:list', async (event, sessionIdRaw: unknown) => {
    if (typeof sessionIdRaw !== 'string' || !sessionIdRaw.trim()) {
      throw new Error('invalid_session_id')
    }
    return await options.terminalRelay.list(sessionIdRaw, event.sender)
  })

  ipcMain.handle('lodyTerminal:open', async (event, payload: unknown) => {
    const message = TerminalClientMessageSchema.parse({
      ...(payload && typeof payload === 'object' ? payload : {}),
      type: 'open'
    })
    // Narrows the parsed discriminated union back to the 'open' member so
    // relay.open() receives the required { sessionId, cols, rows } fields.
    if (message.type !== 'open') {
      throw new Error('invalid_terminal_open_request')
    }
    return await options.terminalRelay.open(message, event.sender)
  })

  ipcMain.on('lodyTerminal:attach', (event, payload: unknown) => {
    sendTerminalFireAndForget(event, 'attach', payload)
  })

  ipcMain.on('lodyTerminal:input', (event, payload: unknown) => {
    sendTerminalFireAndForget(event, 'input', payload)
  })

  ipcMain.on('lodyTerminal:resize', (event, payload: unknown) => {
    sendTerminalFireAndForget(event, 'resize', payload)
  })

  ipcMain.on('lodyTerminal:close', (event, payload: unknown) => {
    sendTerminalFireAndForget(event, 'close', payload)
  })

  ipcMain.on('lodyTerminal:closeSession', (event, payload: unknown) => {
    sendTerminalFireAndForget(event, 'close_session', payload)
  })

  ipcMain.handle('lodyNotifications:getPermissionStatus', () => {
    return options.notificationService.getPermissionStatus()
  })

  ipcMain.handle('lodyNotifications:openSystemSettings', async () => {
    return await options.notificationService.openSystemSettings()
  })

  ipcMain.handle('lodyApp:getAutoLaunchStatus', () => {
    return getAutoLaunchStatus()
  })

  ipcMain.handle('lodyApp:setAutoLaunchEnabled', (_event, enabledRaw: unknown) => {
    if (typeof enabledRaw !== 'boolean') {
      const status = getAutoLaunchStatus()
      return {
        ok: false,
        supported: status.supported,
        enabled: status.enabled,
        error: 'invalid_enabled_flag'
      }
    }
    if (!autoLaunchSupported) {
      return {
        ok: false,
        supported: false,
        enabled: false,
        error: 'unsupported_platform'
      }
    }

    try {
      app.setLoginItemSettings({
        openAtLogin: enabledRaw,
        openAsHidden: enabledRaw
      })
      const status = getAutoLaunchStatus()
      return {
        ok: true,
        supported: status.supported,
        enabled: status.enabled
      }
    } catch (error) {
      const status = getAutoLaunchStatus()
      return {
        ok: false,
        supported: status.supported,
        enabled: status.enabled,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('lodyApp:getGlobalShortcuts', () => {
    return options.globalShortcutsService.list()
  })

  ipcMain.handle('lodyApp:setGlobalShortcut', (_event, input: unknown) => {
    if (!isSetGlobalShortcutInput(input)) {
      return { ok: false, error: 'invalid' }
    }
    return options.globalShortcutsService.setBinding(input)
  })

  // Suspend OS global shortcuts while the renderer records a shortcut, so the combo
  // reaches the renderer (to be flagged as occupied) instead of firing the global action.
  ipcMain.on('lodyApp:setGlobalShortcutsSuspended', (_event, suspended: unknown) => {
    options.globalShortcutsService.setSuspended(suspended === true)
  })

  ipcMain.handle('lodyApp:setWindowBadge', (event, badgeRaw: unknown) => {
    const badge = parseWindowBadge(badgeRaw)
    if (!badge) {
      return { ok: false, error: 'invalid_badge' }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return { ok: false, error: 'unknown_window' }
    }
    options.windowBadgeService.setBadge(win.id, badge)
    return { ok: true }
  })

  ipcMain.handle('lodyApp:openExternalUrl', async (_event, urlRaw: unknown) => {
    const externalUrl = normalizeExternalHttpUrl(urlRaw)
    if (!externalUrl) {
      return {
        opened: false,
        error: 'invalid_url'
      }
    }

    try {
      await shell.openExternal(externalUrl)
      return {
        opened: true,
        url: externalUrl
      }
    } catch (error) {
      return {
        opened: false,
        url: externalUrl,
        error: formatUnknownError(error)
      }
    }
  })

  ipcMain.handle('lodyApp:launchLocalPath', async (_event, payload: unknown) => {
    const parsed = LaunchLocalPathInputSchema.safeParse(payload)
    if (!parsed.success) {
      return {
        launched: false,
        error: 'invalid_payload'
      }
    }
    return await launchLocalPath(parsed.data)
  })

  ipcMain.handle('lodyNotifications:showSessionCompletion', (_event, payload: unknown) => {
    if (!isShowSessionCompletionNotificationInput(payload)) {
      return {
        shown: false,
        reason: 'invalid_payload'
      }
    }

    return options.notificationService.showSessionCompletion(payload)
  })

  ipcMain.handle(
    'lodySessionFiles:sendLocal',
    async (_event, payload: unknown): Promise<SendSessionFileLocalResult> => {
      const input = parseSendSessionFileLocalInput(payload)
      if (!input) {
        return { ok: false, error: 'invalid_request' }
      }

      // Materialize each file as a temp file so the local CLI can validate +
      // hash + copy it via the existing path-based session-control contract.
      // Bytes never hit disk as base64; ArrayBuffer rides structured clone.
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-file-send-'))
      const tempPaths: string[] = []
      try {
        for (const [index, file] of input.files.entries()) {
          // basename('..') is '..' (and basename('.') is '.'), which would
          // resolve to a directory and EISDIR the whole batch; strip path
          // separators / control chars and reject dot-only names.
          const base = path
            .basename(file.fileName)
            .split('')
            .map((ch) => (ch === '/' || ch === '\\' || ch.charCodeAt(0) < 32 ? '_' : ch))
            .join('')
            .trim()
          const safeName = !base || base === '.' || base === '..' ? 'file' : base.slice(0, 255)
          // Index-prefix the temp name so two files that sanitize to the same
          // name don't overwrite each other (which would silently drop a file
          // and hand the CLI a duplicate path).
          const tempPath = path.join(tempDir, `${index}-${safeName}`)
          await fs.writeFile(tempPath, Buffer.from(file.bytes))
          tempPaths.push(tempPath)
        }
        if (tempPaths.length !== input.files.length) {
          return { ok: false, error: 'temp_write_incomplete' }
        }

        const result = await options.cliService.sendLocalSessionControl({
          type: 'session/file-send-local',
          machineId: input.machineId,
          sessionId: input.sessionId as SessionId,
          workspaceId: input.workspaceId as WorkspaceId,
          paths: tempPaths
        } as LocalSessionControlRequest)

        if (!result.ok) {
          return { ok: false, error: result.error }
        }

        const response = result.responses.find(
          (item): item is SessionFileSendLocalResponse =>
            item.type === 'session/file-send-local_response'
        )
        if (!response) {
          return { ok: false, error: 'invalid_response' }
        }
        if (!response.success) {
          return { ok: false, error: response.error ?? 'local_handoff_failed' }
        }
        return {
          ok: true,
          files: response.files ?? [],
          ...(response.message ? { message: response.message } : {})
        }
      } catch (error) {
        return { ok: false, error: formatUnknownError(error) }
      } finally {
        // Best-effort cleanup; the CLI has already copied bytes into its store.
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  )

  // Image preview right-click. Three steps rather than one: the renderer holds
  // the bytes, so it only pays to copy them across after the user picks an
  // action from the native menu.
  ipcMain.handle('lodyImage:showPreviewMenu', async (event, payload: unknown) => {
    const parsed = ShowImagePreviewMenuInputSchema.safeParse(payload)
    if (!parsed.success) {
      return { action: null }
    }
    const window = BrowserWindow.fromWebContents(event.sender) ?? options.getMainWindow()
    return await showImagePreviewMenu(window, parsed.data)
  })

  ipcMain.handle('lodyImage:copyToClipboard', (_event, payload: unknown) => {
    const parsed = CopyImageToClipboardInputSchema.safeParse(payload)
    if (!parsed.success) {
      return { copied: false, error: 'invalid_payload' }
    }
    return copyImageToClipboard(parsed.data.pngBytes)
  })

  ipcMain.handle('lodyImage:saveAs', async (event, payload: unknown) => {
    const parsed = SaveImageFileInputSchema.safeParse(payload)
    if (!parsed.success) {
      return { saved: false, error: 'invalid_payload' }
    }
    const window = BrowserWindow.fromWebContents(event.sender) ?? options.getMainWindow()
    return await saveImageFile(window, parsed.data)
  })

  ipcMain.handle('lodyLocalProjects:selectDirectory', async () => {
    const mainWindow = options.getMainWindow()
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled) {
      return null
    }
    const selectedPath = result.filePaths[0]
    if (!selectedPath) {
      return null
    }

    const machineId = await options.cliService.getLocalMachineId()
    if (!machineId) {
      return { error: 'Local CLI daemon is unavailable. Run `npx lody start`.' }
    }

    return {
      rootPath: selectedPath,
      machineId
    }
  })

  ipcMain.handle(
    'lodyLocalProjects:getGitState',
    async (_event, workspaceId: string, localProjectId: string) => {
      const response = await sendLocalProjectControl({
        type: 'local-project/git-state',
        workspaceId: workspaceId as WorkspaceId,
        localProjectId: localProjectId as LocalProjectId
      })
      if (!response.ok) {
        return { error: response.message }
      }
      if (response.type !== 'local-project/git-state') {
        return { error: `Unexpected response type: ${response.type}` }
      }
      return response.result
    }
  )

  ipcMain.handle(
    'lodyLocalProjects:listFiles',
    async (
      _event,
      workspaceId: string,
      localProjectId: string,
      optionsArg?: { maxFiles?: number }
    ) => {
      const response = await sendLocalProjectControl({
        type: 'local-project/list-files',
        workspaceId: workspaceId as WorkspaceId,
        localProjectId: localProjectId as LocalProjectId,
        maxFiles: optionsArg?.maxFiles
      })
      if (!response.ok) {
        if (response.error === 'daemon_unavailable') {
          throw new Error('cli_not_running')
        }
        throw new Error(response.message ?? 'Failed to list project files')
      }
      if (response.type !== 'local-project/list-files') {
        throw new Error(`Unexpected response type: ${response.type}`)
      }
      return response.result
    }
  )

  ipcMain.handle(
    'lodyLocalProjects:listDir',
    async (
      _event,
      workspaceId: string,
      localProjectId: string,
      relativePath: string,
      optionsArg?: { limit?: number }
    ) => {
      const response = await sendLocalProjectControl({
        type: 'local-project/list-dir',
        workspaceId: workspaceId as WorkspaceId,
        localProjectId: localProjectId as LocalProjectId,
        relativePath,
        limit: optionsArg?.limit
      })
      if (!response.ok) {
        if (response.error === 'daemon_unavailable') {
          throw new Error('cli_not_running')
        }
        throw new Error(response.message ?? 'Failed to list project directory')
      }
      if (response.type !== 'local-project/list-dir') {
        throw new Error(`Unexpected response type: ${response.type}`)
      }
      return response.result
    }
  )

  ipcMain.handle(
    'lodyLocalProjects:checkoutBranch',
    async (_event, workspaceId: string, localProjectId: string, branchName: string) => {
      const response = await sendLocalProjectControl({
        type: 'local-project/checkout-branch',
        workspaceId: workspaceId as WorkspaceId,
        localProjectId: localProjectId as LocalProjectId,
        branchName
      })
      if (!response.ok) {
        return { success: false, error: response.message }
      }
      if (response.type !== 'local-project/checkout-branch') {
        return { success: false, error: `Unexpected response type: ${response.type}` }
      }
      return response.result
    }
  )

  ipcMain.handle(
    'lodyLocalProjects:syncHistory',
    async (
      _event,
      provider: LocalProjectHistoryProvider,
      workspaceId: string,
      localProjectId: string
    ) => {
      if (!isLocalProjectHistoryProvider(provider)) {
        return { error: `Invalid history provider: ${String(provider)}` }
      }
      const response = await sendLocalProjectControl({
        type: 'local-project/sync-history',
        provider,
        workspaceId: workspaceId as WorkspaceId,
        localProjectId: localProjectId as LocalProjectId
      })
      if (!response.ok) {
        return { error: response.message }
      }
      if (response.type !== 'local-project/sync-history') {
        return { error: `Unexpected response type: ${response.type}` }
      }
      return response.result
    }
  )

  ipcMain.handle(
    'lodyLocalProjects:importHistory',
    async (
      _event,
      provider: LocalProjectHistoryProvider,
      workspaceId: string,
      localProjectId: string,
      acpSessionIds: string[]
    ) => {
      if (!isLocalProjectHistoryProvider(provider)) {
        return { error: `Invalid history provider: ${String(provider)}` }
      }
      const response = await sendLocalProjectControl({
        type: 'local-project/import-history',
        provider,
        workspaceId: workspaceId as WorkspaceId,
        localProjectId: localProjectId as LocalProjectId,
        acpSessionIds
      })
      if (!response.ok) {
        return { error: response.message }
      }
      if (response.type !== 'local-project/import-history') {
        return { error: `Unexpected response type: ${response.type}` }
      }
      return response.result
    }
  )

  ipcMain.handle(
    'lodyLocalProjects:resolveHistoryConflict',
    async (
      _event,
      provider: LocalProjectHistoryProvider,
      workspaceId: string,
      localProjectId: string,
      sessionId: string,
      acpSessionId: string
    ) => {
      if (!isLocalProjectHistoryProvider(provider)) {
        return { error: `Invalid history provider: ${String(provider)}` }
      }
      const response = await sendLocalProjectControl({
        type: 'local-project/resolve-history-conflict',
        provider,
        workspaceId: workspaceId as WorkspaceId,
        localProjectId: localProjectId as LocalProjectId,
        sessionId: sessionId as SessionId,
        acpSessionId
      })
      if (!response.ok) {
        return { error: response.message }
      }
      if (response.type !== 'local-project/resolve-history-conflict') {
        return { error: `Unexpected response type: ${response.type}` }
      }
      return response.result
    }
  )

  ipcMain.handle(
    'lodyLocalProjects:readFile',
    async (
      _event,
      workspaceId: string,
      localProjectId: string,
      relativePath: string,
      optionsArg?: { maxBytes?: number }
    ) => {
      const response = await sendLocalProjectControl({
        type: 'local-project/read-file',
        workspaceId: workspaceId as WorkspaceId,
        localProjectId: localProjectId as LocalProjectId,
        relativePath,
        maxBytes: optionsArg?.maxBytes
      })
      if (!response.ok || response.type !== 'local-project/read-file') {
        return null
      }
      return response.result
    }
  )

  ipcMain.handle(
    'lodyWorktree:listFiles',
    async (_event, repoKey: string, sessionId: string, optionsArg?: { maxFiles?: number }) => {
      const response = await sendLocalProjectControl({
        type: 'worktree/list-files',
        repoFullName: repoKey,
        sessionId: SessionIdSchema.parse(sessionId),
        maxFiles: optionsArg?.maxFiles
      })
      if (!response.ok) {
        if (response.error === 'daemon_unavailable') {
          throw new Error('cli_not_running')
        }
        throw new Error(response.message ?? 'Failed to list worktree files')
      }
      if (response.type !== 'worktree/list-files') {
        throw new Error(`Unexpected response type: ${response.type}`)
      }
      return response.result
    }
  )

  ipcMain.handle(
    'lodyWorktree:readFile',
    async (
      _event,
      repoKey: string,
      sessionId: string,
      relativePath: string,
      optionsArg?: { maxBytes?: number }
    ) => {
      const response = await sendLocalProjectControl({
        type: 'worktree/read-file',
        repoFullName: repoKey,
        sessionId: SessionIdSchema.parse(sessionId),
        relativePath,
        maxBytes: optionsArg?.maxBytes
      })
      if (!response.ok || response.type !== 'worktree/read-file') {
        return null
      }
      return response.result
    }
  )

  const registerAuthHandler = <TArgs extends unknown[], TResult>(
    channel: string,
    handler: (...args: TArgs) => TResult | Promise<TResult>
  ) => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertMainWindowSender(event, options.getMainWindow)
      return await handler(...(args as TArgs))
    })
  }

  registerAuthHandler('lodyAuth:completeCallback', async (payload: unknown) => {
    const input: ElectronAuthCallbackInput = ElectronAuthCallbackInputSchema.parse(payload)
    return await options.authService.completeCallback(input)
  })

  registerAuthHandler('lodyAuth:signInWithDevEmailPassword', async (payload: unknown) => {
    const input: ElectronDevEmailPasswordSignInInput =
      ElectronDevEmailPasswordSignInInputSchema.parse(payload)
    return await options.authService.signInWithDevEmailPassword(input)
  })

  registerAuthHandler('lodyAuth:signOut', async () => {
    await options.authService.signOut()
  })

  registerAuthHandler('lodyAuth:getSession', async (optionsArg?: unknown) => {
    return await options.authService.getSession(optionsArg)
  })

  registerAuthHandler('lodyAuth:listOrganizations', async (optionsArg?: unknown) => {
    return await options.authService.listOrganizations(optionsArg)
  })

  registerAuthHandler('lodyAuth:getActiveOrganization', async (optionsArg?: unknown) => {
    return await options.authService.getActiveOrganization(optionsArg)
  })

  registerAuthHandler('lodyAuth:changeEmail', async (payload: unknown) => {
    return await options.authService.changeEmail(payload)
  })

  registerAuthHandler('lodyAuth:listAccounts', async (optionsArg?: unknown) => {
    return await options.authService.listAccounts(optionsArg)
  })

  registerAuthHandler('lodyAuth:updateUser', async (payload: unknown) => {
    return await options.authService.updateUser(payload)
  })

  registerAuthHandler('lodyAuth:changePassword', async (payload: unknown) => {
    return await options.authService.changePassword(payload)
  })

  registerAuthHandler('lodyAuth:requestPasswordReset', async (payload: unknown) => {
    return await options.authService.requestPasswordReset(payload)
  })

  registerAuthHandler('lodyAuth:convexToken', async (optionsArg?: unknown) => {
    return await options.authService.convexToken(optionsArg)
  })

  registerAuthHandler('lodyAuth:crossDomainVerifyOneTimeToken', async (payload: unknown) => {
    return await options.authService.crossDomainVerifyOneTimeToken(payload)
  })

  registerAuthHandler('lodyAuth:organization:getInvitation', async (payload: unknown) => {
    return await options.authService.organizationGetInvitation(payload)
  })

  registerAuthHandler('lodyAuth:organization:acceptInvitation', async (payload: unknown) => {
    return await options.authService.organizationAcceptInvitation(payload)
  })

  registerAuthHandler('lodyAuth:organization:listInvitations', async (payload?: unknown) => {
    return await options.authService.organizationListInvitations(payload)
  })

  registerAuthHandler('lodyAuth:organization:inviteMember', async (payload: unknown) => {
    return await options.authService.organizationInviteMember(payload)
  })

  registerAuthHandler('lodyAuth:organization:cancelInvitation', async (payload: unknown) => {
    return await options.authService.organizationCancelInvitation(payload)
  })

  registerAuthHandler('lodyAuth:organization:removeMember', async (payload: unknown) => {
    return await options.authService.organizationRemoveMember(payload)
  })

  registerAuthHandler('lodyAuth:organization:updateMemberRole', async (payload: unknown) => {
    return await options.authService.organizationUpdateMemberRole(payload)
  })

  registerAuthHandler('lodyAuth:organization:setActive', async (payload: unknown) => {
    return await options.authService.organizationSetActive(payload)
  })

  registerAuthHandler('lodyAuth:organization:update', async (payload: unknown) => {
    return await options.authService.organizationUpdate(payload)
  })

  registerAuthHandler('lodyAuth:organization:create', async (payload: unknown) => {
    return await options.authService.organizationCreate(payload)
  })

  registerAuthHandler('lodyAuth:organization:delete', async (payload: unknown) => {
    return await options.authService.organizationDelete(payload)
  })

  registerAuthHandler('lodyAuth:organization:leave', async (payload: unknown) => {
    return await options.authService.organizationLeave(payload)
  })

  ipcMain.handle('lodyPower:setPreventSleepEnabled', (_event, enabledRaw: unknown) => {
    if (typeof enabledRaw !== 'boolean') {
      return { ok: false, enabled: options.cliService.getPreventSleepEnabled() }
    }
    options.cliService.setPreventSleepEnabled(enabledRaw)
    return { ok: true, enabled: enabledRaw }
  })

  ipcMain.handle('lodyPower:getPreventSleepEnabled', () => {
    return { enabled: options.cliService.getPreventSleepEnabled() }
  })

  // Local platform only: identity and workspace are one atomic catalog
  // snapshot. Cloud builds always answer null.
  ipcMain.handle('local-platform:get-snapshot', async () => {
    if (!isLocalPlatform()) {
      return null
    }
    return await readLocalPlatformSnapshot()
  })

  ipcMain.on('lodyApp:setLanguage', (_event, locale: unknown) => {
    if (typeof locale === 'string') {
      setMenuLanguage(locale)
    }
  })

  // Keep OS-drawn window surfaces in sync with the in-app theme. The explicit
  // background color also covers pixels exposed before Chromium paints a resize.
  ipcMain.on('lodyApp:setNativeTheme', (event, source: unknown) => {
    if (source === 'dark' || source === 'light' || source === 'system') {
      nativeTheme.themeSource = source
      const resolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
      const window = findWindow(event.sender)
      window?.setBackgroundColor(getMainWindowBackgroundColor(resolvedTheme))
      // Windows draws the caption buttons as an overlay on the page; retint it
      // so the strip stays on the same canvas after a theme switch.
      if (process.platform === 'win32') {
        window?.setTitleBarOverlay(getMainWindowTitleBarOverlay(resolvedTheme))
      }
    }
  })

  ipcMain.on('lody:notify-renderer-mounted', (event) => {
    const window = findWindow(event.sender)
    if (window) markRendererMounted(window)
  })

  ipcMain.on('lody:report-renderer-fatal-error', (_event, payloadRaw: unknown) => {
    if (!payloadRaw || typeof payloadRaw !== 'object') return
    const payload = payloadRaw as Record<string, unknown>
    void persistRendererFatalError({
      scope: typeof payload.scope === 'string' ? payload.scope : 'unknown',
      message: typeof payload.message === 'string' ? payload.message : '(no message)',
      details: typeof payload.details === 'string' ? payload.details : '',
      copied: payload.copied === true
    })
  })

  ipcMain.on('lody:request-renderer-reload', (event) => {
    const window = findWindow(event.sender)
    if (window) requestRendererReload(window)
  })
}

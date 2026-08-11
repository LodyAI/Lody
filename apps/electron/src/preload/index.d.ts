import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  CheckForElectronUpdateResult,
  CopyImageToClipboardInput,
  CopyImageToClipboardResult,
  ElectronAutoLaunchStatusResult,
  ElectronAuthCallbackInput,
  ElectronAuthCallbackSession,
  ElectronDevEmailPasswordSignInInput,
  ElectronCliState,
  ElectronLocalPlatformSnapshot,
  ElectronUpdaterState,
  ElectronPublicBrowserBounds,
  ElectronPublicBrowserResult,
  ElectronPublicBrowserState,
  GetNotificationPermissionStatusResult,
  GlobalShortcutBinding,
  GlobalShortcutTriggeredPayload,
  LaunchLocalPathInput,
  LaunchLocalPathResult,
  OpenExternalUrlResult,
  OpenSystemNotificationSettingsResult,
  QuitAndInstallElectronUpdateResult,
  RestartCliResult,
  SaveImageFileInput,
  SaveImageFileResult,
  SendLocalProjectControlResult,
  SendLocalMachineRpcResult,
  SendSessionFileLocalInput,
  SendSessionFileLocalResult,
  ShowImagePreviewMenuInput,
  ShowImagePreviewMenuResult,
  SetElectronAutoLaunchResult,
  SetGlobalShortcutInput,
  SetGlobalShortcutResult,
  SendLocalSessionControlResult,
  SessionCompletionNotificationClickPayload,
  ShowSessionCompletionNotificationInput,
  ShowSessionCompletionNotificationResult,
  TerminateCliResult
} from '@lody/shared/electron-ipc'
import type {
  LocalProjectDirectoryListResult,
  LocalProjectFileListResult,
  LocalProjectFileReadResult,
  LocalProjectHistoryCatalogResult,
  LocalProjectHistoryConflictResolveResult,
  LocalProjectHistoryImportResult,
  LocalProjectControlRequest,
  LocalSessionControlRequest,
  LocalSessionControlResponse
} from '@lody/shared/message'
import type {
  LocalLoroDataPlaneClientMessage,
  LocalLoroDataPlaneServerMessage
} from '@lody/shared/local-loro-data-plane'
import type { LocalMachineRpcRequest } from '@lody/shared/local-machine-rpc'
import type { SessionId } from '@lody/shared/ids'
import type { LocalProjectGitState, LocalProjectHistoryProvider } from '@lody/shared/project'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOpenParams,
  TerminalOpenResult,
  TerminalSnapshot,
  TerminalTitleEvent
} from '@lody/shared/terminal-protocol'

type CliOutputStream = 'stdout' | 'stderr' | 'meta'

type CliOutputEvent = {
  runId: string
  stream: CliOutputStream
  chunk: string
}

type LodyRendererApi = {
  auth: {
    completeCallback: (input: ElectronAuthCallbackInput) => Promise<ElectronAuthCallbackSession>
    signInWithDevEmailPassword: (input: ElectronDevEmailPasswordSignInInput) => Promise<unknown>
    signOut: () => Promise<void>
    getSession: (options?: unknown) => Promise<unknown>
    listOrganizations: (options?: unknown) => Promise<unknown>
    getActiveOrganization: (options?: unknown) => Promise<unknown>
    changeEmail: (payload: unknown) => Promise<unknown>
    listAccounts: (options?: unknown) => Promise<unknown>
    updateUser: (payload: unknown) => Promise<unknown>
    changePassword: (payload: unknown) => Promise<unknown>
    requestPasswordReset: (payload: unknown) => Promise<unknown>
    convexToken: (options?: unknown) => Promise<unknown>
    crossDomainVerifyOneTimeToken: (payload: unknown) => Promise<unknown>
    organization: {
      getInvitation: (payload: unknown) => Promise<unknown>
      acceptInvitation: (payload: unknown) => Promise<unknown>
      listInvitations: (payload?: unknown) => Promise<unknown>
      inviteMember: (payload: unknown) => Promise<unknown>
      cancelInvitation: (payload: unknown) => Promise<unknown>
      removeMember: (payload: unknown) => Promise<unknown>
      updateMemberRole: (payload: unknown) => Promise<unknown>
      setActive: (payload: unknown) => Promise<unknown>
      update: (payload: unknown) => Promise<unknown>
      create: (payload: unknown) => Promise<unknown>
      delete: (payload: unknown) => Promise<unknown>
      leave: (payload: unknown) => Promise<unknown>
    }
  }
  updater: {
    getState: () => Promise<ElectronUpdaterState>
    checkForUpdates: () => Promise<CheckForElectronUpdateResult>
    quitAndInstall: () => Promise<QuitAndInstallElectronUpdateResult>
    onState: (handler: (state: ElectronUpdaterState) => void) => () => void
  }
  onCliOutput: (handler: (event: CliOutputEvent) => void) => () => void
  getCliOutputBacklog: () => Promise<CliOutputEvent[]>
  cliState: {
    getState: () => Promise<ElectronCliState>
    restart: () => Promise<RestartCliResult>
    terminate: () => Promise<TerminateCliResult>
    onState: (handler: (state: ElectronCliState) => void) => () => void
  }
  publicBrowser: {
    capability: 'web-contents-view-v1'
    create: (
      browserId: string,
      bounds: ElectronPublicBrowserBounds
    ) => Promise<ElectronPublicBrowserResult>
    navigate: (browserId: string, url: string) => Promise<ElectronPublicBrowserResult>
    back: (browserId: string) => Promise<ElectronPublicBrowserResult>
    forward: (browserId: string) => Promise<ElectronPublicBrowserResult>
    reload: (browserId: string) => Promise<ElectronPublicBrowserResult>
    stop: (browserId: string) => Promise<ElectronPublicBrowserResult>
    setBounds: (
      browserId: string,
      bounds: ElectronPublicBrowserBounds
    ) => Promise<ElectronPublicBrowserResult>
    setVisible: (browserId: string, visible: boolean) => Promise<ElectronPublicBrowserResult>
    destroy: (browserId: string) => Promise<ElectronPublicBrowserResult>
    onState: (handler: (state: ElectronPublicBrowserState) => void) => () => void
  }
  localPlatform: {
    getSnapshot: () => Promise<ElectronLocalPlatformSnapshot | null>
  }
  sendLocalSessionControl: (
    message: LocalSessionControlRequest,
    onResponse?: (response: LocalSessionControlResponse) => void
  ) => Promise<SendLocalSessionControlResult>
  sendLocalMachineRpc: (message: LocalMachineRpcRequest) => Promise<SendLocalMachineRpcResult>
  loroDataPlane: {
    send: (message: LocalLoroDataPlaneClientMessage) => void
    subscribe: () => void
    isConnected: () => Promise<boolean>
    onEvent: (listener: (message: LocalLoroDataPlaneServerMessage) => void) => () => void
    onStatus: (listener: (connected: boolean) => void) => () => void
  }
  terminal: {
    list: (sessionId: string) => Promise<TerminalSnapshot[]>
    open: (params: TerminalOpenParams) => Promise<TerminalOpenResult>
    attach: (terminalId: string, cols: number, rows: number) => void
    input: (terminalId: string, data: string) => void
    resize: (terminalId: string, cols: number, rows: number) => void
    close: (terminalId: string) => void
    closeSession: (sessionId: string) => void
    onData: (handler: (event: TerminalDataEvent) => void) => () => void
    onExit: (handler: (event: TerminalExitEvent) => void) => () => void
    onTitle: (handler: (event: TerminalTitleEvent) => void) => () => void
  }
  sendLocalProjectControl: (
    message: LocalProjectControlRequest
  ) => Promise<SendLocalProjectControlResult>
  sendSessionFileLocal: (input: SendSessionFileLocalInput) => Promise<SendSessionFileLocalResult>
  selectLocalProjectDirectory: () => Promise<
    { rootPath: string; machineId: string } | { error: string } | null
  >
  imagePreview: {
    showMenu: (input: ShowImagePreviewMenuInput) => Promise<ShowImagePreviewMenuResult>
    copyToClipboard: (input: CopyImageToClipboardInput) => Promise<CopyImageToClipboardResult>
    saveAs: (input: SaveImageFileInput) => Promise<SaveImageFileResult>
  }
  getLocalProjectGitState: (
    workspaceId: string,
    localProjectId: string
  ) => Promise<LocalProjectGitState | { error: string }>
  listLocalProjectFiles: (
    workspaceId: string,
    localProjectId: string,
    options?: { maxFiles?: number }
  ) => Promise<LocalProjectFileListResult>
  listLocalProjectDir: (
    workspaceId: string,
    localProjectId: string,
    relativePath: string,
    options?: { limit?: number }
  ) => Promise<LocalProjectDirectoryListResult>
  readLocalProjectFile: (
    workspaceId: string,
    localProjectId: string,
    relativePath: string,
    options?: { maxBytes?: number }
  ) => Promise<LocalProjectFileReadResult | null>
  listSessionWorktreeFiles: (
    repoKey: string,
    sessionId: string,
    options?: { maxFiles?: number }
  ) => Promise<LocalProjectFileListResult>
  readSessionWorktreeFile: (
    repoKey: string,
    sessionId: string,
    relativePath: string,
    options?: { maxBytes?: number }
  ) => Promise<LocalProjectFileReadResult | null>
  checkoutLocalProjectBranch: (
    workspaceId: string,
    localProjectId: string,
    branchName: string
  ) => Promise<{ success: true; currentBranch: string } | { success: false; error: string }>
  syncLocalProjectHistory: (
    provider: LocalProjectHistoryProvider,
    workspaceId: string,
    localProjectId: string
  ) => Promise<LocalProjectHistoryCatalogResult | { error: string }>
  importLocalProjectHistory: (
    provider: LocalProjectHistoryProvider,
    workspaceId: string,
    localProjectId: string,
    acpSessionIds: string[]
  ) => Promise<LocalProjectHistoryImportResult | { error: string }>
  resolveLocalProjectHistoryConflict: (
    provider: LocalProjectHistoryProvider,
    workspaceId: string,
    localProjectId: string,
    sessionId: SessionId,
    acpSessionId: string
  ) => Promise<LocalProjectHistoryConflictResolveResult | { error: string }>
  onDeepLink: (handler: (url: string) => void) => () => void
  onMenuAction: (handler: (action: string) => void) => () => void
  onWindowFullscreenChanged: (handler: (isFullscreen: boolean) => void) => () => void
  getWindowFullscreen: () => Promise<boolean>
  getNotificationPermissionStatus: () => Promise<GetNotificationPermissionStatusResult>
  openSystemNotificationSettings: () => Promise<OpenSystemNotificationSettingsResult>
  getAutoLaunchStatus: () => Promise<ElectronAutoLaunchStatusResult>
  setAutoLaunchEnabled: (enabled: boolean) => Promise<SetElectronAutoLaunchResult>
  globalShortcuts: {
    getAll: () => Promise<GlobalShortcutBinding[]>
    set: (input: SetGlobalShortcutInput) => Promise<SetGlobalShortcutResult>
    setSuspended: (suspended: boolean) => void
    onTriggered: (handler: (payload: GlobalShortcutTriggeredPayload) => void) => () => void
  }
  openExternalUrl: (url: string) => Promise<OpenExternalUrlResult>
  launchLocalPath: (input: LaunchLocalPathInput) => Promise<LaunchLocalPathResult>
  setWindowBadge: (badge: { unread: number; waiting: number }) => void
  showSessionCompletionNotification: (
    payload: ShowSessionCompletionNotificationInput
  ) => Promise<ShowSessionCompletionNotificationResult>
  onSessionCompletionNotificationClick: (
    handler: (payload: SessionCompletionNotificationClickPayload) => void
  ) => () => void
  setPreventSleepEnabled: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean }>
  getPreventSleepEnabled: () => Promise<{ enabled: boolean }>
  setCliAutoStartEnabled: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean }>
  getCliAutoStartEnabled: () => Promise<{ enabled: boolean }>
  setLanguage: (locale: string) => void
  setNativeTheme: (source: 'dark' | 'light' | 'system') => void
  // Optional: missing on older preload builds. Renderer code must use
  // optional chaining so a bridge mismatch never becomes the new white screen.
  notifyRendererMounted?: () => void
  reportRendererFatalError?: (payload: {
    scope: string
    message: string
    details: string
    copied?: boolean
  }) => void
  requestRendererReload?: () => void
}

type LodyPlatformInfo = {
  os: string
  homeDir: string
  machineName: string
}

type LodyNativeAppInfo = {
  version?: string
  build?: string
  native_platform?: string
  os_name?: string
  os_version?: string
  app_version?: string
  install_id?: string
}

type ElectronRequestAuthOptions = {
  provider?: string
  callbackURL?: string
  newUserCallbackURL?: string
  errorCallbackURL?: string
  disableRedirect?: boolean
  scopes?: string[]
  requestSignUp?: boolean
  additionalData?: Record<string, unknown>
}

type ElectronAuthenticateOptions = {
  token: string
}

type BetterAuthElectronBridges = {
  getUser: () => Promise<unknown>
  requestAuth: (options?: ElectronRequestAuthOptions) => Promise<void>
  authenticate: (options: ElectronAuthenticateOptions) => Promise<unknown>
  signOut: () => Promise<void>
  onAuthenticated: (callback: (user: unknown) => unknown) => () => void
  onUserUpdated: (callback: (user: unknown) => unknown) => () => void
  onAuthError: (callback: (context: unknown) => unknown) => () => void
}

declare global {
  interface Window extends BetterAuthElectronBridges {
    __LODY_ELECTRON__?: true
    __LODY_PLATFORM__?: LodyPlatformInfo
    __LODY_APP_INFO__?: LodyNativeAppInfo
    electron: ElectronAPI
    api: LodyRendererApi
  }
}

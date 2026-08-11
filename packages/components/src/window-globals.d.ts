import type { LoroRepo } from 'loro-repo';
import type { LoroDoc } from 'loro-crdt';
import type { CodeCollabDebugGlobal } from './lib/code-collab-global-debug';
import type { WorkspacePresenceDebugGlobal } from './providers/workspace-presence-transport';
import type {
  CheckForElectronUpdateResult,
  CopyImageToClipboardInput,
  CopyImageToClipboardResult,
  ElectronAutoLaunchStatusResult,
  ElectronCliState,
  ElectronLocalPlatformSnapshot,
  ElectronPublicBrowserBounds,
  ElectronPublicBrowserResult,
  ElectronPublicBrowserState,
  ElectronUpdaterState,
  GetNotificationPermissionStatusResult,
  GlobalShortcutBinding,
  GlobalShortcutTriggeredPayload,
  SetGlobalShortcutInput,
  SetGlobalShortcutResult,
  LocalProjectHistoryCatalogResult,
  LocalProjectHistoryConflictResolveResult,
  LocalProjectHistoryImportResult,
  LocalProjectHistoryProvider,
  LocalProjectGitState,
  LocalProjectControlRequest,
  LocalSessionControlRequest,
  LocalSessionControlResponse,
  LaunchLocalPathInput,
  LaunchLocalPathResult,
  LocalProjectDirectoryListResult,
  LocalProjectFileListResult,
  LocalProjectFileReadResult,
  OpenExternalUrlResult,
  OpenSystemNotificationSettingsResult,
  QuitAndInstallElectronUpdateResult,
  RestartCliResult,
  SaveImageFileInput,
  SaveImageFileResult,
  SetElectronAutoLaunchResult,
  SendLocalMachineRpcResult,
  SendLocalProjectControlResult,
  SendLocalSessionControlResult,
  SendSessionFileLocalInput,
  SendSessionFileLocalResult,
  SessionCompletionNotificationClickPayload,
  SessionId,
  ShowImagePreviewMenuInput,
  ShowImagePreviewMenuResult,
  ShowSessionCompletionNotificationInput,
  ShowSessionCompletionNotificationResult,
  TerminateCliResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOpenParams,
  TerminalOpenResult,
  TerminalSnapshot,
  TerminalTitleEvent,
} from '@lody/shared';
import type {
  LocalLoroDataPlaneClientMessage,
  LocalLoroDataPlaneServerMessage,
  LocalMachineRpcRequest,
} from '@lody/shared';
import type { LodyLiveActivityBridge } from './hooks/use-lody-live-activity';

/**
 * Boot guard installed by the inline script in a shell's index.html (currently
 * apps/mobile). It owns the boot watchdog and a last-resort fallback UI;
 * main.tsx upgrades `render` to the styled renderer and signals lifecycle via
 * markBooted()/fail().
 */
export interface LodyBootController {
  booted: boolean;
  render: ((root: HTMLElement | null, error: unknown) => void) | null;
  getFirstError: () => unknown;
  markBooted: () => void;
  fail: (error: unknown) => void;
}

declare global {
  interface Window {
    repo?: LoroRepo;
    currentSessionDoc?: LoroDoc;
    currentCodeCollab?: CodeCollabDebugGlobal;
    lodyPresence?: WorkspacePresenceDebugGlobal;
    __LODY_NATIVE__?: boolean;
    __LODY_CORDOVA_READY__?: boolean;
    __LODY_ELECTRON__?: true;
    __LODY_PLATFORM__?: { os: string; homeDir: string; machineName?: string };
    __LODY_BOOT__?: LodyBootController;
    __LODY_LIVE_ACTIVITY__?: LodyLiveActivityBridge;
    __LODY_APP_INFO__?: {
      version?: string;
      build?: string;
      native_platform?: string;
      os_name?: string;
      os_version?: string;
      app_version?: string;
      install_id?: string;
    };
    authenticate?: (options: { token: string }) => Promise<unknown>;
    api?: {
      onCliOutput?: (
        handler: (event: {
          runId: string;
          stream: 'stdout' | 'stderr' | 'meta';
          chunk: string;
        }) => void
      ) => () => void;
      getCliOutputBacklog?: () => Promise<
        { runId: string; stream: 'stdout' | 'stderr' | 'meta'; chunk: string }[]
      >;
      cliState?: {
        getState: () => Promise<ElectronCliState>;
        restart: () => Promise<RestartCliResult>;
        terminate: () => Promise<TerminateCliResult>;
        onState: (handler: (state: ElectronCliState) => void) => () => void;
      };
      updater?: {
        getState: () => Promise<ElectronUpdaterState>;
        checkForUpdates: () => Promise<CheckForElectronUpdateResult>;
        quitAndInstall: () => Promise<QuitAndInstallElectronUpdateResult>;
        onState: (handler: (state: ElectronUpdaterState) => void) => () => void;
      };
      publicBrowser?: {
        capability: 'web-contents-view-v1';
        create: (
          browserId: string,
          bounds: ElectronPublicBrowserBounds
        ) => Promise<ElectronPublicBrowserResult>;
        navigate: (browserId: string, url: string) => Promise<ElectronPublicBrowserResult>;
        back: (browserId: string) => Promise<ElectronPublicBrowserResult>;
        forward: (browserId: string) => Promise<ElectronPublicBrowserResult>;
        reload: (browserId: string) => Promise<ElectronPublicBrowserResult>;
        stop: (browserId: string) => Promise<ElectronPublicBrowserResult>;
        setBounds: (
          browserId: string,
          bounds: ElectronPublicBrowserBounds
        ) => Promise<ElectronPublicBrowserResult>;
        setVisible: (browserId: string, visible: boolean) => Promise<ElectronPublicBrowserResult>;
        destroy: (browserId: string) => Promise<ElectronPublicBrowserResult>;
        onState: (handler: (state: ElectronPublicBrowserState) => void) => () => void;
      };
      /**
       * Open-source local platform bridge (specs/platform-providers.md).
       * `getSnapshot` resolves null until the CLI has provisioned the atomic
       * local identity/workspace snapshot — and always null on cloud.
       */
      localPlatform?: {
        getSnapshot: () => Promise<ElectronLocalPlatformSnapshot | null>;
      };
      sendLocalSessionControl?: (
        message: LocalSessionControlRequest,
        onResponse?: (response: LocalSessionControlResponse) => void
      ) => Promise<SendLocalSessionControlResult>;
      sendLocalMachineRpc?: (message: LocalMachineRpcRequest) => Promise<SendLocalMachineRpcResult>;
      loroDataPlane?: {
        send: (message: LocalLoroDataPlaneClientMessage) => void;
        subscribe: () => void;
        isConnected: () => Promise<boolean>;
        onEvent: (listener: (message: LocalLoroDataPlaneServerMessage) => void) => () => void;
        onStatus: (listener: (connected: boolean) => void) => () => void;
      };
      terminal?: {
        list: (sessionId: string) => Promise<TerminalSnapshot[]>;
        open: (params: TerminalOpenParams) => Promise<TerminalOpenResult>;
        attach: (terminalId: string, cols: number, rows: number) => void;
        input: (terminalId: string, data: string) => void;
        resize: (terminalId: string, cols: number, rows: number) => void;
        close: (terminalId: string) => void;
        closeSession: (sessionId: string) => void;
        onData: (handler: (event: TerminalDataEvent) => void) => () => void;
        onExit: (handler: (event: TerminalExitEvent) => void) => () => void;
        onTitle: (handler: (event: TerminalTitleEvent) => void) => () => void;
      };
      sendLocalProjectControl?: (
        message: LocalProjectControlRequest
      ) => Promise<SendLocalProjectControlResult>;
      sendSessionFileLocal?: (
        input: SendSessionFileLocalInput
      ) => Promise<SendSessionFileLocalResult>;
      selectLocalProjectDirectory?: () => Promise<
        { rootPath: string; machineId: string } | { error: string } | null
      >;
      imagePreview?: {
        showMenu: (input: ShowImagePreviewMenuInput) => Promise<ShowImagePreviewMenuResult>;
        copyToClipboard: (input: CopyImageToClipboardInput) => Promise<CopyImageToClipboardResult>;
        saveAs: (input: SaveImageFileInput) => Promise<SaveImageFileResult>;
      };
      getLocalProjectGitState?: (
        workspaceId: string,
        localProjectId: string
      ) => Promise<LocalProjectGitState | { error: string }>;
      listLocalProjectFiles?: (
        workspaceId: string,
        localProjectId: string,
        options?: { maxFiles?: number }
      ) => Promise<LocalProjectFileListResult>;
      listLocalProjectDir?: (
        workspaceId: string,
        localProjectId: string,
        relativePath: string,
        options?: { limit?: number }
      ) => Promise<LocalProjectDirectoryListResult>;
      readLocalProjectFile?: (
        workspaceId: string,
        localProjectId: string,
        relativePath: string,
        options?: { maxBytes?: number }
      ) => Promise<LocalProjectFileReadResult | null>;
      listSessionWorktreeFiles?: (
        repoKey: string,
        sessionId: string,
        options?: { maxFiles?: number }
      ) => Promise<LocalProjectFileListResult>;
      readSessionWorktreeFile?: (
        repoKey: string,
        sessionId: string,
        relativePath: string,
        options?: { maxBytes?: number }
      ) => Promise<LocalProjectFileReadResult | null>;
      checkoutLocalProjectBranch?: (
        workspaceId: string,
        localProjectId: string,
        branchName: string
      ) => Promise<{ success: true; currentBranch: string } | { success: false; error: string }>;
      syncLocalProjectHistory?: (
        provider: LocalProjectHistoryProvider,
        workspaceId: string,
        localProjectId: string
      ) => Promise<LocalProjectHistoryCatalogResult | { error: string }>;
      importLocalProjectHistory?: (
        provider: LocalProjectHistoryProvider,
        workspaceId: string,
        localProjectId: string,
        acpSessionIds: string[]
      ) => Promise<LocalProjectHistoryImportResult | { error: string }>;
      resolveLocalProjectHistoryConflict?: (
        provider: LocalProjectHistoryProvider,
        workspaceId: string,
        localProjectId: string,
        sessionId: SessionId,
        acpSessionId: string
      ) => Promise<LocalProjectHistoryConflictResolveResult | { error: string }>;
      onDeepLink?: (handler: (url: string) => void) => () => void;
      onMenuAction?: (handler: (action: string) => void) => () => void;
      onWindowFullscreenChanged?: (handler: (isFullscreen: boolean) => void) => () => void;
      getWindowFullscreen?: () => Promise<boolean>;
      getNotificationPermissionStatus?: () => Promise<GetNotificationPermissionStatusResult>;
      openSystemNotificationSettings?: () => Promise<OpenSystemNotificationSettingsResult>;
      getAutoLaunchStatus?: () => Promise<ElectronAutoLaunchStatusResult>;
      setAutoLaunchEnabled?: (enabled: boolean) => Promise<SetElectronAutoLaunchResult>;
      globalShortcuts?: {
        getAll: () => Promise<GlobalShortcutBinding[]>;
        set: (input: SetGlobalShortcutInput) => Promise<SetGlobalShortcutResult>;
        setSuspended?: (suspended: boolean) => void;
        onTriggered?: (handler: (payload: GlobalShortcutTriggeredPayload) => void) => () => void;
      };
      openExternalUrl?: (url: string) => Promise<OpenExternalUrlResult>;
      launchLocalPath?: (input: LaunchLocalPathInput) => Promise<LaunchLocalPathResult>;
      showSessionCompletionNotification?: (
        payload: ShowSessionCompletionNotificationInput
      ) => Promise<ShowSessionCompletionNotificationResult>;
      onSessionCompletionNotificationClick?: (
        handler: (payload: SessionCompletionNotificationClickPayload) => void
      ) => () => void;
      setPreventSleepEnabled?: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean }>;
      getPreventSleepEnabled?: () => Promise<{ enabled: boolean }>;
      setCliAutoStartEnabled?: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean }>;
      getCliAutoStartEnabled?: () => Promise<{ enabled: boolean }>;
      setLanguage?: (locale: string) => void;
      setNativeTheme?: (source: 'dark' | 'light' | 'system') => void;
    };
  }
}

export type WindowGlobals = {
  repo?: LoroRepo;
  currentSessionDoc?: LoroDoc;
  currentCodeCollab?: CodeCollabDebugGlobal;
  lodyPresence?: WorkspacePresenceDebugGlobal;
  __LODY_NATIVE__?: boolean;
  __LODY_CORDOVA_READY__?: boolean;
  __LODY_LIVE_ACTIVITY__?: LodyLiveActivityBridge;
};

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { setupRenderer } from '@better-auth/electron/preload'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type {
  CheckForElectronUpdateResult,
  CopyImageToClipboardInput,
  CopyImageToClipboardResult,
  ElectronCliState,
  ElectronAuthCallbackInput,
  ElectronAuthCallbackSession,
  ElectronDevEmailPasswordSignInInput,
  ElectronLocalPlatformSnapshot,
  ElectronUpdaterState,
  ElectronPublicBrowserBounds,
  ElectronPublicBrowserResult,
  ElectronPublicBrowserState,
  LaunchLocalPathInput,
  LaunchLocalPathResult,
  OpenExternalUrlResult,
  QuitAndInstallElectronUpdateResult,
  SaveImageFileInput,
  SaveImageFileResult,
  SendLocalProjectControlResult,
  SendSessionFileLocalInput,
  SendSessionFileLocalResult,
  ShowImagePreviewMenuInput,
  ShowImagePreviewMenuResult,
  RestartCliResult,
  TerminateCliResult
} from '@lody/shared/electron-ipc'
import {
  ELECTRON_LOCAL_SESSION_CONTROL_RESPONSE_CHANNEL,
  ELECTRON_PUBLIC_BROWSER_STATE_CHANNEL,
  GLOBAL_SHORTCUT_TRIGGERED_CHANNEL,
  type ElectronLocalSessionControlResponseEvent,
  type GlobalShortcutTriggeredPayload
} from '@lody/shared/electron-ipc'
import type {
  LocalProjectControlRequest,
  LocalSessionControlRequest,
  LocalSessionControlResponse
} from '@lody/shared/message'
import { LocalSessionControlResponseSchema } from '@lody/shared/message-schemas'
import type {
  LocalLoroDataPlaneClientMessage,
  LocalLoroDataPlaneServerMessage
} from '@lody/shared/local-loro-data-plane'
import type { LocalMachineRpcRequest } from '@lody/shared/local-machine-rpc'
import type { SessionId } from '@lody/shared/ids'
import type { LocalProjectHistoryProvider } from '@lody/shared/project'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOpenParams,
  TerminalOpenResult,
  TerminalSnapshot,
  TerminalTitleEvent
} from '@lody/shared/terminal-protocol'
setupRenderer()

const deepLinkHandlers = new Set<(url: string) => void>()
const pendingDeepLinks: string[] = []
const globalShortcutTriggeredHandlers = new Set<(payload: GlobalShortcutTriggeredPayload) => void>()

ipcRenderer.on('lody:deep-link', (_event, url: string) => {
  if (deepLinkHandlers.size === 0) {
    pendingDeepLinks.push(url)
    return
  }
  for (const handler of deepLinkHandlers) {
    handler(url)
  }
})

ipcRenderer.on(
  GLOBAL_SHORTCUT_TRIGGERED_CHANNEL,
  (_event, payload: GlobalShortcutTriggeredPayload) => {
    for (const handler of globalShortcutTriggeredHandlers) {
      handler(payload)
    }
  }
)

function subscribeTerminalEvent<E extends { type: string }>(
  type: E['type'],
  handler: (event: E) => void
): () => void {
  const listener = (_event: unknown, payload: unknown) => {
    if (payload && typeof payload === 'object' && (payload as { type?: unknown }).type === type) {
      handler(payload as E)
    }
  }
  ipcRenderer.on('lodyTerminal:event', listener)
  return () => ipcRenderer.removeListener('lodyTerminal:event', listener)
}

// Custom APIs for renderer
const api = {
  auth: {
    completeCallback: async (
      input: ElectronAuthCallbackInput
    ): Promise<ElectronAuthCallbackSession> => {
      return await ipcRenderer.invoke('lodyAuth:completeCallback', input)
    },
    signInWithDevEmailPassword: async (input: ElectronDevEmailPasswordSignInInput) => {
      return await ipcRenderer.invoke('lodyAuth:signInWithDevEmailPassword', input)
    },
    signOut: async (): Promise<void> => {
      await ipcRenderer.invoke('lodyAuth:signOut')
    },
    getSession: async (options?: unknown) => {
      return await ipcRenderer.invoke('lodyAuth:getSession', options)
    },
    listOrganizations: async (options?: unknown) => {
      return await ipcRenderer.invoke('lodyAuth:listOrganizations', options)
    },
    getActiveOrganization: async (options?: unknown) => {
      return await ipcRenderer.invoke('lodyAuth:getActiveOrganization', options)
    },
    changeEmail: async (payload: unknown) => {
      return await ipcRenderer.invoke('lodyAuth:changeEmail', payload)
    },
    listAccounts: async (options?: unknown) => {
      return await ipcRenderer.invoke('lodyAuth:listAccounts', options)
    },
    updateUser: async (payload: unknown) => {
      return await ipcRenderer.invoke('lodyAuth:updateUser', payload)
    },
    changePassword: async (payload: unknown) => {
      return await ipcRenderer.invoke('lodyAuth:changePassword', payload)
    },
    requestPasswordReset: async (payload: unknown) => {
      return await ipcRenderer.invoke('lodyAuth:requestPasswordReset', payload)
    },
    convexToken: async (options?: unknown) => {
      return await ipcRenderer.invoke('lodyAuth:convexToken', options)
    },
    crossDomainVerifyOneTimeToken: async (payload: unknown) => {
      return await ipcRenderer.invoke('lodyAuth:crossDomainVerifyOneTimeToken', payload)
    },
    organization: {
      getInvitation: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:getInvitation', payload)
      },
      acceptInvitation: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:acceptInvitation', payload)
      },
      listInvitations: async (payload?: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:listInvitations', payload)
      },
      inviteMember: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:inviteMember', payload)
      },
      cancelInvitation: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:cancelInvitation', payload)
      },
      removeMember: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:removeMember', payload)
      },
      updateMemberRole: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:updateMemberRole', payload)
      },
      setActive: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:setActive', payload)
      },
      update: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:update', payload)
      },
      create: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:create', payload)
      },
      delete: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:delete', payload)
      },
      leave: async (payload: unknown) => {
        return await ipcRenderer.invoke('lodyAuth:organization:leave', payload)
      }
    }
  },
  updater: {
    getState: async (): Promise<ElectronUpdaterState> => {
      return await ipcRenderer.invoke('lodyUpdater:getState')
    },
    checkForUpdates: async (): Promise<CheckForElectronUpdateResult> => {
      return await ipcRenderer.invoke('lodyUpdater:checkForUpdates')
    },
    quitAndInstall: async (): Promise<QuitAndInstallElectronUpdateResult> => {
      return await ipcRenderer.invoke('lodyUpdater:quitAndInstall')
    },
    onState: (handler: (state: ElectronUpdaterState) => void) => {
      const listener = (_event: unknown, payload: ElectronUpdaterState) => handler(payload)
      ipcRenderer.on('lodyUpdater:state', listener)
      return () => ipcRenderer.removeListener('lodyUpdater:state', listener)
    }
  },
  onCliOutput: (handler: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload)
    ipcRenderer.on('lodyCli:output', listener)
    return () => ipcRenderer.removeListener('lodyCli:output', listener)
  },
  getCliOutputBacklog: async () => {
    return await ipcRenderer.invoke('lodyCli:getOutputBacklog')
  },
  cliState: {
    getState: async (): Promise<ElectronCliState> => {
      return await ipcRenderer.invoke('lodyCliState:getState')
    },
    restart: async (): Promise<RestartCliResult> => {
      return await ipcRenderer.invoke('lodyCliState:restart')
    },
    terminate: async (): Promise<TerminateCliResult> => {
      return await ipcRenderer.invoke('lodyCliState:terminate')
    },
    onState: (handler: (state: ElectronCliState) => void) => {
      ipcRenderer.send('lodyCliState:subscribe')
      const listener = (_event: unknown, payload: ElectronCliState) => handler(payload)
      ipcRenderer.on('lodyCliState:state', listener)
      return () => ipcRenderer.removeListener('lodyCliState:state', listener)
    }
  },
  publicBrowser: {
    capability: 'web-contents-view-v1' as const,
    create: async (browserId: string, bounds: ElectronPublicBrowserBounds) => {
      return (await ipcRenderer.invoke('lodyPublicBrowser:create', {
        browserId,
        bounds
      })) as ElectronPublicBrowserResult
    },
    navigate: async (browserId: string, url: string) => {
      return (await ipcRenderer.invoke('lodyPublicBrowser:navigate', {
        browserId,
        url
      })) as ElectronPublicBrowserResult
    },
    back: async (browserId: string) =>
      (await ipcRenderer.invoke('lodyPublicBrowser:back', {
        browserId
      })) as ElectronPublicBrowserResult,
    forward: async (browserId: string) =>
      (await ipcRenderer.invoke('lodyPublicBrowser:forward', {
        browserId
      })) as ElectronPublicBrowserResult,
    reload: async (browserId: string) =>
      (await ipcRenderer.invoke('lodyPublicBrowser:reload', {
        browserId
      })) as ElectronPublicBrowserResult,
    stop: async (browserId: string) =>
      (await ipcRenderer.invoke('lodyPublicBrowser:stop', {
        browserId
      })) as ElectronPublicBrowserResult,
    setBounds: async (browserId: string, bounds: ElectronPublicBrowserBounds) =>
      (await ipcRenderer.invoke('lodyPublicBrowser:setBounds', {
        browserId,
        bounds
      })) as ElectronPublicBrowserResult,
    setVisible: async (browserId: string, visible: boolean) =>
      (await ipcRenderer.invoke('lodyPublicBrowser:setVisible', {
        browserId,
        visible
      })) as ElectronPublicBrowserResult,
    destroy: async (browserId: string) =>
      (await ipcRenderer.invoke('lodyPublicBrowser:destroy', {
        browserId
      })) as ElectronPublicBrowserResult,
    onState: (handler: (state: ElectronPublicBrowserState) => void) => {
      const listener = (_event: unknown, state: ElectronPublicBrowserState) => handler(state)
      ipcRenderer.on(ELECTRON_PUBLIC_BROWSER_STATE_CHANNEL, listener)
      return () => ipcRenderer.removeListener(ELECTRON_PUBLIC_BROWSER_STATE_CHANNEL, listener)
    }
  },
  localPlatform: {
    getSnapshot: async (): Promise<ElectronLocalPlatformSnapshot | null> => {
      return await ipcRenderer.invoke('local-platform:get-snapshot')
    }
  },
  sendLocalSessionControl: async (
    message: LocalSessionControlRequest,
    onResponse?: (response: LocalSessionControlResponse) => void
  ) => {
    const requestId = randomUUID()
    const listener = (_event: unknown, payload: ElectronLocalSessionControlResponseEvent) => {
      if (payload?.requestId !== requestId) return
      // The preload runs under the renderer CSP. Zod's object fast path uses
      // `new Function`, so every preload-side parse must explicitly disable
      // code generation instead of weakening the app's `script-src` policy.
      const parsed = LocalSessionControlResponseSchema.safeParse(payload.response, {
        jitless: true
      })
      if (parsed.success) {
        onResponse?.(parsed.data as LocalSessionControlResponse)
      }
    }
    ipcRenderer.on(ELECTRON_LOCAL_SESSION_CONTROL_RESPONSE_CHANNEL, listener)
    try {
      return await ipcRenderer.invoke('lodySessionControl:send', { requestId, message })
    } finally {
      ipcRenderer.removeListener(ELECTRON_LOCAL_SESSION_CONTROL_RESPONSE_CHANNEL, listener)
    }
  },
  sendLocalMachineRpc: async (message: LocalMachineRpcRequest) => {
    return await ipcRenderer.invoke('lodyMachineRpc:send', message)
  },
  loroDataPlane: {
    send: (message: LocalLoroDataPlaneClientMessage): void => {
      ipcRenderer.send('lodyLoroDataPlane:send', message)
    },
    subscribe: (): void => {
      ipcRenderer.send('lodyLoroDataPlane:subscribe')
    },
    isConnected: async (): Promise<boolean> => {
      return await ipcRenderer.invoke('lodyLoroDataPlane:isConnected')
    },
    onEvent: (listener: (message: LocalLoroDataPlaneServerMessage) => void): (() => void) => {
      const handler = (_event: unknown, message: LocalLoroDataPlaneServerMessage): void =>
        listener(message)
      ipcRenderer.on('lodyLoroDataPlane:event', handler)
      return () => ipcRenderer.removeListener('lodyLoroDataPlane:event', handler)
    },
    onStatus: (listener: (connected: boolean) => void): (() => void) => {
      const handler = (_event: unknown, connected: boolean): void => listener(connected)
      ipcRenderer.on('lodyLoroDataPlane:status', handler)
      return () => ipcRenderer.removeListener('lodyLoroDataPlane:status', handler)
    }
  },
  terminal: {
    list: async (sessionId: string): Promise<TerminalSnapshot[]> => {
      return await ipcRenderer.invoke('lodyTerminal:list', sessionId)
    },
    open: async (params: TerminalOpenParams): Promise<TerminalOpenResult> => {
      return await ipcRenderer.invoke('lodyTerminal:open', params)
    },
    attach: (terminalId: string, cols: number, rows: number) => {
      ipcRenderer.send('lodyTerminal:attach', { terminalId, cols, rows })
    },
    input: (terminalId: string, data: string) => {
      ipcRenderer.send('lodyTerminal:input', { terminalId, data })
    },
    resize: (terminalId: string, cols: number, rows: number) => {
      ipcRenderer.send('lodyTerminal:resize', { terminalId, cols, rows })
    },
    close: (terminalId: string) => {
      ipcRenderer.send('lodyTerminal:close', { terminalId })
    },
    closeSession: (sessionId: string) => {
      ipcRenderer.send('lodyTerminal:closeSession', { sessionId })
    },
    onData: (handler: (event: TerminalDataEvent) => void) =>
      subscribeTerminalEvent('data', handler),
    onExit: (handler: (event: TerminalExitEvent) => void) =>
      subscribeTerminalEvent('exit', handler),
    onTitle: (handler: (event: TerminalTitleEvent) => void) =>
      subscribeTerminalEvent('title', handler)
  },
  sendLocalProjectControl: async (
    message: LocalProjectControlRequest
  ): Promise<SendLocalProjectControlResult> => {
    return await ipcRenderer.invoke('lodyLocalProjects:control', message)
  },
  sendSessionFileLocal: async (
    input: SendSessionFileLocalInput
  ): Promise<SendSessionFileLocalResult> => {
    return await ipcRenderer.invoke('lodySessionFiles:sendLocal', input)
  },
  selectLocalProjectDirectory: async () => {
    return await ipcRenderer.invoke('lodyLocalProjects:selectDirectory')
  },
  imagePreview: {
    showMenu: async (input: ShowImagePreviewMenuInput): Promise<ShowImagePreviewMenuResult> => {
      return await ipcRenderer.invoke('lodyImage:showPreviewMenu', input)
    },
    copyToClipboard: async (
      input: CopyImageToClipboardInput
    ): Promise<CopyImageToClipboardResult> => {
      return await ipcRenderer.invoke('lodyImage:copyToClipboard', input)
    },
    saveAs: async (input: SaveImageFileInput): Promise<SaveImageFileResult> => {
      return await ipcRenderer.invoke('lodyImage:saveAs', input)
    }
  },
  getLocalProjectGitState: async (workspaceId: string, localProjectId: string) => {
    return await ipcRenderer.invoke('lodyLocalProjects:getGitState', workspaceId, localProjectId)
  },
  listLocalProjectFiles: async (
    workspaceId: string,
    localProjectId: string,
    options?: { maxFiles?: number }
  ) => {
    return await ipcRenderer.invoke(
      'lodyLocalProjects:listFiles',
      workspaceId,
      localProjectId,
      options
    )
  },
  listLocalProjectDir: async (
    workspaceId: string,
    localProjectId: string,
    relativePath: string,
    options?: { limit?: number }
  ) => {
    return await ipcRenderer.invoke(
      'lodyLocalProjects:listDir',
      workspaceId,
      localProjectId,
      relativePath,
      options
    )
  },
  readLocalProjectFile: async (
    workspaceId: string,
    localProjectId: string,
    relativePath: string,
    options?: { maxBytes?: number }
  ) => {
    return await ipcRenderer.invoke(
      'lodyLocalProjects:readFile',
      workspaceId,
      localProjectId,
      relativePath,
      options
    )
  },
  listSessionWorktreeFiles: async (
    repoKey: string,
    sessionId: string,
    options?: { maxFiles?: number }
  ) => {
    return await ipcRenderer.invoke('lodyWorktree:listFiles', repoKey, sessionId, options)
  },
  readSessionWorktreeFile: async (
    repoKey: string,
    sessionId: string,
    relativePath: string,
    options?: { maxBytes?: number }
  ) => {
    return await ipcRenderer.invoke(
      'lodyWorktree:readFile',
      repoKey,
      sessionId,
      relativePath,
      options
    )
  },
  checkoutLocalProjectBranch: async (
    workspaceId: string,
    localProjectId: string,
    branchName: string
  ) => {
    return await ipcRenderer.invoke(
      'lodyLocalProjects:checkoutBranch',
      workspaceId,
      localProjectId,
      branchName
    )
  },
  syncLocalProjectHistory: async (
    provider: LocalProjectHistoryProvider,
    workspaceId: string,
    localProjectId: string
  ) => {
    return await ipcRenderer.invoke(
      'lodyLocalProjects:syncHistory',
      provider,
      workspaceId,
      localProjectId
    )
  },
  importLocalProjectHistory: async (
    provider: LocalProjectHistoryProvider,
    workspaceId: string,
    localProjectId: string,
    acpSessionIds: string[]
  ) => {
    return await ipcRenderer.invoke(
      'lodyLocalProjects:importHistory',
      provider,
      workspaceId,
      localProjectId,
      acpSessionIds
    )
  },
  resolveLocalProjectHistoryConflict: async (
    provider: LocalProjectHistoryProvider,
    workspaceId: string,
    localProjectId: string,
    sessionId: SessionId,
    acpSessionId: string
  ) => {
    return await ipcRenderer.invoke(
      'lodyLocalProjects:resolveHistoryConflict',
      provider,
      workspaceId,
      localProjectId,
      sessionId,
      acpSessionId
    )
  },
  onDeepLink: (handler: (url: string) => void) => {
    deepLinkHandlers.add(handler)
    while (pendingDeepLinks.length > 0) {
      const pendingDeepLink = pendingDeepLinks.shift()
      if (pendingDeepLink) {
        handler(pendingDeepLink)
      }
    }
    return () => {
      deepLinkHandlers.delete(handler)
    }
  },
  onMenuAction: (handler: (action: string) => void) => {
    const listener = (_event: unknown, action: string) => handler(action)
    ipcRenderer.on('lody:menu-action', listener)
    return () => ipcRenderer.removeListener('lody:menu-action', listener)
  },
  onWindowFullscreenChanged: (handler: (isFullscreen: boolean) => void) => {
    const listener = (_event: unknown, isFullscreen: boolean) => handler(isFullscreen)
    ipcRenderer.on('lody:window-fullscreen-changed', listener)
    return () => ipcRenderer.removeListener('lody:window-fullscreen-changed', listener)
  },
  getWindowFullscreen: async (): Promise<boolean> => {
    return await ipcRenderer.invoke('lodyWindow:getFullscreen')
  },
  getNotificationPermissionStatus: async () => {
    return await ipcRenderer.invoke('lodyNotifications:getPermissionStatus')
  },
  openSystemNotificationSettings: async () => {
    return await ipcRenderer.invoke('lodyNotifications:openSystemSettings')
  },
  getAutoLaunchStatus: async () => {
    return await ipcRenderer.invoke('lodyApp:getAutoLaunchStatus')
  },
  setAutoLaunchEnabled: async (enabled: boolean) => {
    return await ipcRenderer.invoke('lodyApp:setAutoLaunchEnabled', enabled)
  },
  globalShortcuts: {
    getAll: async () => {
      return await ipcRenderer.invoke('lodyApp:getGlobalShortcuts')
    },
    set: async (input: { id: string; binding: string | null }) => {
      return await ipcRenderer.invoke('lodyApp:setGlobalShortcut', input)
    },
    setSuspended: (suspended: boolean) => {
      ipcRenderer.send('lodyApp:setGlobalShortcutsSuspended', suspended)
    },
    onTriggered: (handler: (payload: GlobalShortcutTriggeredPayload) => void) => {
      globalShortcutTriggeredHandlers.add(handler)
      return () => {
        globalShortcutTriggeredHandlers.delete(handler)
      }
    }
  },
  openExternalUrl: async (url: string): Promise<OpenExternalUrlResult> => {
    return await ipcRenderer.invoke('lodyApp:openExternalUrl', url)
  },
  launchLocalPath: async (input: LaunchLocalPathInput): Promise<LaunchLocalPathResult> => {
    return await ipcRenderer.invoke('lodyApp:launchLocalPath', input)
  },
  setWindowBadge: (badge: { unread: number; waiting: number }) => {
    void ipcRenderer.invoke('lodyApp:setWindowBadge', badge)
  },
  showSessionCompletionNotification: async (payload: unknown) => {
    return await ipcRenderer.invoke('lodyNotifications:showSessionCompletion', payload)
  },
  onSessionCompletionNotificationClick: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload)
    ipcRenderer.on('lodyNotifications:sessionCompletionClick', listener)
    return () => ipcRenderer.removeListener('lodyNotifications:sessionCompletionClick', listener)
  },
  setPreventSleepEnabled: async (enabled: boolean) => {
    return await ipcRenderer.invoke('lodyPower:setPreventSleepEnabled', enabled)
  },
  getPreventSleepEnabled: async () => {
    return await ipcRenderer.invoke('lodyPower:getPreventSleepEnabled')
  },
  setCliAutoStartEnabled: async (enabled: boolean) => {
    return await ipcRenderer.invoke('lodyCli:setAutoStartEnabled', enabled)
  },
  getCliAutoStartEnabled: async () => {
    return await ipcRenderer.invoke('lodyCli:getAutoStartEnabled')
  },
  setLanguage: (locale: string) => {
    ipcRenderer.send('lodyApp:setLanguage', locale)
  },
  setNativeTheme: (source: 'dark' | 'light' | 'system') => {
    ipcRenderer.send('lodyApp:setNativeTheme', source)
  },
  notifyRendererMounted: () => {
    try {
      ipcRenderer.send('lody:notify-renderer-mounted')
    } catch (error) {
      console.warn('[preload] notifyRendererMounted send failed', error)
    }
  },
  reportRendererFatalError: (payload: {
    scope: string
    message: string
    details: string
    copied?: boolean
  }) => {
    try {
      ipcRenderer.send('lody:report-renderer-fatal-error', payload)
    } catch (error) {
      console.warn('[preload] reportRendererFatalError send failed', error)
    }
  },
  requestRendererReload: (): void => {
    try {
      ipcRenderer.send('lody:request-renderer-reload')
    } catch (error) {
      console.warn('[preload] requestRendererReload send failed', error)
    }
  }
}

const platformInfo = {
  os: process.platform,
  homeDir: os.homedir(),
  machineName: os.hostname()
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('__LODY_ELECTRON__', true)
    contextBridge.exposeInMainWorld('__LODY_PLATFORM__', platformInfo)
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.__LODY_ELECTRON__ = true
  // @ts-ignore (define in dts)
  window.__LODY_PLATFORM__ = platformInfo
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

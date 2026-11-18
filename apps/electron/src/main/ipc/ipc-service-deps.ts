import type { CloudFileIndexMainLegacy } from '../services/cloud-file-index'
import type { SessionId, ScheduleSaveInput } from '@lody/shared'
import type { NativeDocumentDomainsMainLegacy } from '../services/native-document-domains'
import type { RendererDocumentDomainMigrationMainLegacy } from '../services/renderer-document-domain-migration'
import type { NativeDocumentDomainTarget } from '@lody/shared/native-document-domain-ipc'
import type { RendererSessionBodyMigrationMainLegacy } from '../services/renderer-session-body-migration'
import type { createElectronAppIconService } from '../services/app-icon-service'
import type { BrowserWindow } from 'electron'
import type { AppUpdaterService } from '../services/app-updater-service'
import type { AuthService } from '../services/auth-service'
import type { CliService } from '../services/cli-service'
import type { GlobalShortcutsService } from '../services/global-shortcuts-service'
import type { LoroDataPlaneRelay } from '../services/loro-data-plane-relay'
import type { LocalNativeRepoLeaseServiceLegacy } from '../services/local-native-repo-lease'
import type { RendererWorkspaceFlockMigrationMainLegacy } from '../services/renderer-workspace-flock-migration'
import type { NativeWorkspaceCatalogMainLegacy } from '../services/native-workspace-catalog'
import type { NativeMachineCatalogMainLegacy } from '../services/native-machine-catalog'
import type { NativeScheduleRegistryMainLegacy } from '../services/native-schedule-registry'
import type { NativeWorkspaceMetaMainLegacy } from '../services/native-workspace-meta'
import type { NativeSessionMainLegacy } from '../services/native-session-domain'
import type { RendererWfBinding } from '@lody/shared/renderer-room-migration'
import type { RendererFlockGroup } from '@lody/shared/renderer-flock-room-group'
import type { RendererFlockRoomGroupMigrationMainLegacy } from '../services/renderer-flock-room-group-migration'
import type { NotificationService } from '../services/notification-service'
import type { PublicBrowserService } from '../services/public-browser-service'
import type { StorageGuard } from '../services/storage-guard'
import type { TerminalRelay } from '../services/terminal-relay'
import type { WindowBadgeService } from '../services/window-badge-service'

export type IpcServiceDeps = {
  prepareCloudFileIndex?: (windowId: number, workspaceId: string) => Promise<void>
  cloudFileIndex?: (
    windowId: number,
    workspaceId: string
  ) => Promise<CloudFileIndexMainLegacy | null>
  appIconService: ReturnType<typeof createElectronAppIconService>
  cliService: CliService
  appUpdaterService: AppUpdaterService
  authService: AuthService
  notificationService: NotificationService
  terminalRelay: TerminalRelay
  publicBrowserService: PublicBrowserService
  storageGuard: StorageGuard
  loroDataPlaneRelay: LoroDataPlaneRelay
  localNativeRepoLease: LocalNativeRepoLeaseServiceLegacy | null
  rendererWorkspaceFlockMigration: () => RendererWorkspaceFlockMigrationMainLegacy | null
  migrateNativeWorkspaceCatalog(binding: RendererWfBinding): Promise<void>
  nativeWorkspaceCatalog: () => NativeWorkspaceCatalogMainLegacy | null
  nativeMachineCatalog?: () => NativeMachineCatalogMainLegacy | null
  nativeScheduleRegistry?: () => NativeScheduleRegistryMainLegacy | null
  retireNativeSessionBodyMigration?: (windowId: number, registrationId: string) => void
  ensureNativePreviewComments?: (
    windowId: number,
    registrationId: string,
    sessionId: SessionId
  ) => Promise<void>
  createNativeScheduleDefinition?: (
    windowId: number,
    registrationId: string,
    input: Omit<ScheduleSaveInput, 'actorId' | 'create'>
  ) => Promise<void>
  nativeDocumentDomains?: (
    windowId: number,
    registrationId: string
  ) => Promise<NativeDocumentDomainsMainLegacy | null>
  nativeDocumentDomainMigration?: (
    windowId: number,
    registrationId: string
  ) => Promise<RendererDocumentDomainMigrationMainLegacy | null>
  migrateNativeDocumentDomain?: (
    windowId: number,
    registrationId: string,
    target: NativeDocumentDomainTarget
  ) => Promise<void>
  nativeSessionBodyMigration?: (
    windowId: number,
    registrationId: string
  ) => RendererSessionBodyMigrationMainLegacy | Promise<RendererSessionBodyMigrationMainLegacy>
  nativeWorkspaceMeta?: () => NativeWorkspaceMetaMainLegacy | null
  nativeSessionDomain?: () => NativeSessionMainLegacy | null
  rendererMachineFlockMigration?: () => Promise<RendererFlockRoomGroupMigrationMainLegacy | null>
  migrateNativeMachineCatalog?: (group: RendererFlockGroup) => Promise<void>
  rendererScheduleRegistryMigration?: () => Promise<RendererFlockRoomGroupMigrationMainLegacy | null>
  migrateNativeScheduleRegistry?: (group: RendererFlockGroup) => Promise<void>
  rendererWorkspaceMetaMigration?: () => Promise<RendererFlockRoomGroupMigrationMainLegacy | null>
  migrateNativeWorkspaceMeta?: (group: RendererFlockGroup) => Promise<void>
  windowBadgeService: WindowBadgeService
  globalShortcutsService: GlobalShortcutsService
  getMainWindow: () => BrowserWindow | null
  completeOnboarding: (window: BrowserWindow) => void
  restartOnboarding: (window: BrowserWindow) => void
  reloadMainWindowForDevbar: (window: BrowserWindow, enabled: boolean) => Promise<void>
}

let deps: IpcServiceDeps | null = null

export function setIpcServiceDeps(next: IpcServiceDeps): void {
  deps = next
}

export function getIpcServiceDeps(): IpcServiceDeps {
  if (!deps) {
    throw new Error('IPC service deps not set')
  }
  return deps
}

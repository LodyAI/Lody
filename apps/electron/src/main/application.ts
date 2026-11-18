import { assertMainNativeDocumentDomainMigrationAuthority } from './services/native-document-domain-migration-authority'
import { RendererDocumentDomainMigrationMainLegacy } from './services/renderer-document-domain-migration'
import { NativeDocumentDomainMigrationLegacy } from './services/native-document-domain-migration'
import { NativeDocumentDomainsMainLegacy } from './services/native-document-domains'
import { createMainNativeDocumentDomainOwner } from './services/native-document-domain-owner'
import { readNativeDocumentDomainRoute } from '@lody/shared/node/native-document-domains'
import type { NativeDocumentDomainTarget } from '@lody/shared/native-document-domain-ipc'
import { NativeSessionMigrationMainLegacy } from './services/native-session-migration'
import { NativeLoroDocumentVerifierLegacy } from '@lody/shared/node/native-document-verification'
import { NativeScheduleRegistryMainLegacy } from './services/native-schedule-registry'
import { NativeScheduleRegistryMigrationLegacy } from './services/native-schedule-registry-migration'
import { ScheduleRegistryIpcError } from '@lody/shared/schedule-registry-ipc'
import { onProductWindowMessage } from './ipc/product-window-ipc-service'
import { closeDesktopE2eeAccount, resumeDesktopE2eeAccount } from './services/e2ee-account-runtime'
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime'
import {
  LoginShellCacheLive,
  loginShellEnvLayer,
  recoverLoginShellCacheShutdown
} from '@lody/shared/node/login-shell-env'
import { squashProcessFailure } from '@lody/shared/node/process'
import { Layer } from 'effect'
import { bindUserShellEnvCacheLegacy } from './services/shell-env'
import { handleWindowContentReady } from './window-target'
import { installLocalFileResourceProtocol } from './services/local-file-resource-protocol'
import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import dns from 'node:dns'
import { mkdirSync, existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { writeHeapSnapshot } from 'node:v8'
import icon from '../../resources/icon.png?asset'
import macIcon from '../../build/icon-mac.padded.png?asset'
import aquaIcon from '../../resources/app-icons/aqua.png?asset'
import { createElectronAppIconService } from './services/app-icon-service'
import { handleDeepLink, initializeAuthDeepLinks } from './deep-link'
import type { DesktopLaunchEvent } from './services/desktop-launch-buffer'
import { registerLodyProtocolClient } from './protocol-client'
import { getDesktopCallbackProtocol } from './desktop-channel'
import { registerIpcServices } from './ipc/register-services'
import {
  openMainWindow,
  openOrFocusMainWindow,
  reloadMainWindowForDevbar,
  setMainWindowOnboardingReloadTarget,
  setMainWindowProductReloadTarget
} from './window'
import {
  getMainWindow,
  isAppQuitting,
  productWindows,
  setAppQuitting,
  setWindowsTrayAvailable
} from './window-state'
import {
  CliService,
  resolveBundledIndependentRepoLaunch,
  resolveBundledWorkspaceCatalogMigrationLaunch
} from './services/cli-service'
import { RendererFlockRoomGroupMigrationMainLegacy } from './services/renderer-flock-room-group-migration'
import { NativeMachineCatalogMainLegacy } from './services/native-machine-catalog'
import { NativeMachineCatalogMigrationLegacy } from './services/native-machine-catalog-migration'
import { NativeWorkspaceMetaMigrationLegacy } from './services/native-workspace-meta-migration'
import { NativeMachineCatalogVerifierLegacy } from './services/native-machine-catalog-verifier'
import { NativeWorkspaceMetaMainLegacy } from './services/native-workspace-meta'
import {
  projectWorkspaceMetaPublicSnapshot,
  WorkspaceMetaIpcError
} from '@lody/shared/native-workspace-meta-ipc'
import { NativeWorkspaceMetaOwnerLegacy } from './services/native-workspace-meta-owner'
import type { MachineMeta, WorkspaceId } from '@lody/shared'
import { RendererSessionBodyMigrationMainLegacy } from './services/renderer-session-body-migration'
import { NativeSessionMainLegacy } from './services/native-session-domain'
import { NativeSessionIpcError } from '@lody/shared/native-session-ipc'
import {
  NativeLocalSessionOwnerLegacy,
  NativeSessionSnapshotRegistry,
  acquireNativeSessionDomainGrant,
  readLocalNativeSessionRoute
} from '@lody/shared/node/native-session'
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy'
import {
  rendererFlockGroupSchema,
  rendererFlockGroupScope,
  type RendererFlockGroup
} from '@lody/shared/renderer-flock-room-group'
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility'
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths'
import { MachineCatalogIpcError } from '@lody/shared/machine-catalog-ipc'
import { readLocalPlatformSnapshot } from './platform'
import { NativeWorkspaceCatalogMigrationLegacy } from './services/native-workspace-catalog-migration'
import type { RendererWfBinding } from '@lody/shared/renderer-room-migration'
import { LocalNativeRepoLeaseServiceLegacy } from './services/local-native-repo-lease'
import { RendererWorkspaceFlockMigrationMainLegacy } from './services/renderer-workspace-flock-migration'
import { NativeWorkspaceCatalogMainLegacy } from './services/native-workspace-catalog'
import {
  readNativeWorkspaceMetaOwner,
  assertPublishedNativeWorkspaceMetaStorage,
  readNativeWorkspaceFlockOwner,
  assertPublishedNativeWorkspaceFlockStorage
} from './services/native-workspace-routing'
import { getLodyDataDir } from '@lody/shared/node/installation-profile'
import { createElectronStorageGuard } from './services/storage-guard-electron'
import { observeCliStorageWriteFailures } from './services/storage-guard-cli'
import type { DesktopExecutionHost } from './services/desktop-execution-host'
import {
  createDesktopQuitBarrier,
  drainMainProcessQuitResources,
  finishUnconfirmedDesktopQuit,
  recordUnconfirmedDesktopQuit,
  reportPreviousUnconfirmedDesktopQuit,
  waitForQuitRecovery
} from './services/desktop-shutdown'
import { cancelRequestedRelaunch, relaunchIfRequested } from './relaunch-intent'
import { applyPendingDesktopLocalReset } from './services/local-reset-service'
import { TerminalRelay } from './services/terminal-relay'
import { LoroDataPlaneRelay } from './services/loro-data-plane-relay'
import { NotificationService } from './services/notification-service'
import { AuthService } from './services/auth-service'
import { CloudFileIndexMainLegacy } from './services/cloud-file-index'
import {
  hasDesktopNativeDataPlatformLegacy,
  closeInstalledDesktopNativeDataPlatformLegacy,
  recoverInstalledDesktopNativeDataPlatformLegacy,
  resolveDesktopNativeDataPlatformLegacy
} from './services/native-data-platform'
import { listCloudFileIndexSelections } from '@lody/shared/node/native-cloud-file-index-selection'
import { authClient } from './auth'
import { AppUpdaterService } from './services/app-updater-service'
import { shouldConstructUpdaterEnabled } from './services/app-updater-sparkle-policy'
import { startDevbarDevframeService, stopDevbarDevframeService } from './services/devbar/service'
import { GlobalShortcutsService } from './services/global-shortcuts-service'
import { WindowsTrayService } from './services/windows-tray-service'
import {
  WindowBadgeService,
  bindWindowBadgeToBrowserWindows
} from './services/window-badge-service'
import { setupApplicationMenu, translateAppText } from './menu'
import { isRendererReloadShortcut } from './reload-shortcut'
import { requestRendererReload } from './renderer-recovery'
import { closeProductWindowsForQuit } from './renderer-unload'
import {
  flushElectronMainErrorReporting,
  installElectronMainErrorReporting
} from './posthog-error-reporting'
import { IPC_PUSH_CHANNELS, IPC_SEND_CHANNELS } from '@lody/shared/electron-ipc'
import { PublicBrowserService } from './services/public-browser-service'
import { desktopInstallationProfile, isLocalPlatform } from './platform'
import { mainPlatformKind } from './platform'
import { getLocalDaemonRunFilePath, readLocalDaemonRunFile } from '@lody/shared/node/local-ipc'
import { getLocalTerminalSocketPath } from '@lody/shared/node/local-terminal'
import {
  getInitialDesktopPath,
  markOnboardingCompleted,
  resetOnboardingCompleted
} from './onboarding-state'
import { handlePreparedWindowState, handleWindowWarmReady } from './window-warm-service'
import { extractDeepLinkFromArgv } from './deep-link-url'
import { shouldHideMainWindowOnAutoLaunch } from './auto-launch-policy'
import {
  getAutoLaunchInvocationStatus,
  getHideWindowOnAutoLaunchEnabled
} from './auto-launch-settings'

const LODY_PROTOCOL = desktopInstallationProfile.desktopProtocol
const PRODUCT_NAME = desktopInstallationProfile.desktopProductName
const DESKTOP_FILE_NAME = `${desktopInstallationProfile.desktopAppId}.desktop`
const DEEP_LINK_DEBUG_PREFIX = '[electron-auth-debug]'
const IS_E2E = !app.isPackaged && process.env.LODY_E2E === '1'
declare const __LODY_DESKTOP_BUILD_JSON__: string | null

type E2EBootDiagnostic = { stage: string; error?: string }
type E2EGlobal = typeof globalThis & {
  __LODY_E2E_BOOT_DIAGNOSTIC__?: E2EBootDiagnostic
  __LODY_E2E_WRITE_HEAP_SNAPSHOT__?: (path: string) => string
}

export function startApplication(executionHost?: DesktopExecutionHost): void {
  const createShellRuntime = () =>
    makeApplicationRuntime(LoginShellCacheLive.pipe(Layer.provide(loginShellEnvLayer())), {
      recover: recoverLoginShellCacheShutdown,
      project: squashProcessFailure
    })
  let applicationRuntime = createShellRuntime()
  bindUserShellEnvCacheLegacy(applicationRuntime)
  if (typeof __LODY_DESKTOP_BUILD_JSON__ === 'string') {
    console.info('[desktop-build]', __LODY_DESKTOP_BUILD_JSON__)
  }
  if (IS_E2E) {
    ;(globalThis as E2EGlobal).__LODY_E2E_WRITE_HEAP_SNAPSHOT__ = (path) => writeHeapSnapshot(path)
  }

  function recordE2EBootDiagnostic(stage: string, error?: unknown): void {
    if (!IS_E2E) return
    const diagnostic: E2EBootDiagnostic = { stage }
    if (error !== undefined) {
      diagnostic.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
    }
    const e2eGlobal = globalThis as E2EGlobal
    e2eGlobal.__LODY_E2E_BOOT_DIAGNOSTIC__ = diagnostic
  }

  function logDeepLinkDebug(message: string, meta?: Record<string, unknown>): void {
    if (meta) {
      console.info(DEEP_LINK_DEBUG_PREFIX, message, meta)
      return
    }
    console.info(DEEP_LINK_DEBUG_PREFIX, message)
  }

  if (!isLocalPlatform()) {
    installElectronMainErrorReporting()
  }

  try {
    dns.setDefaultResultOrder('ipv4first')
  } catch (error) {
    console.warn('[Auth] Failed to set DNS result order to ipv4first', error)
  }

  if (!isLocalPlatform()) {
    authClient.setupMain({
      csp: false,
      bridges: true,
      scheme: false,
      // Pin the target to the main window so Better Auth events always reach the
      // visible renderer that owns login state and CLI restart.
      getWindow: () => getMainWindow()
    })
    logDeepLinkDebug('authClient.setupMain initialized', {
      csp: false,
      bridges: true,
      scheme: false
    })
  }

  function createGlobalShortcutsService(iconPath: string): GlobalShortcutsService {
    return new GlobalShortcutsService(
      [
        {
          id: 'app.focus',
          handler: () => {
            openOrFocusMainWindow({ icon: iconPath })
          }
        }
      ],
      {
        onTriggered: (payload) => {
          const target =
            getMainWindow() ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
          target?.webContents.send(IPC_PUSH_CHANNELS.appGlobalShortcut, payload)
        }
      }
    )
  }

  registerLodyProtocolClient({
    protocol: getDesktopCallbackProtocol(desktopInstallationProfile),
    productName: PRODUCT_NAME,
    desktopFileName: DESKTOP_FILE_NAME,
    iconPath: icon,
    log: logDeepLinkDebug
  })

  recordE2EBootDiagnostic('waiting-for-app-ready')
  const appReady = app.whenReady().then(async () => {
    installLocalFileResourceProtocol()
    // Before any window can reopen the local stores: a reset armed with
    // `lody app reset-cache` is the way back for a user whose renderer is wedged,
    // so it has to run while nothing holds that storage open.
    await applyPendingDesktopLocalReset()
    await startDevbarDevframeService()
    recordE2EBootDiagnostic('initializing-services')
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(macIcon)
    const appIconService = createElectronAppIconService(macIcon, aquaIcon)
    if (process.platform === 'darwin' && app.isPackaged) {
      void Promise.resolve()
        .then(() => appIconService.getState())
        .catch((error: unknown) => {
          console.warn('[Electron] Failed to restore app icon', error)
        })
    }

    logDeepLinkDebug('app.whenReady resolved', {
      isDefaultProtocolClient: app.isDefaultProtocolClient(LODY_PROTOCOL),
      protocol: LODY_PROTOCOL
    })
    const authService = new AuthService(
      (state) => {
        // Only redacted lifecycle data goes to diagnostics, never the session.
        console.info('[Auth] login transition', {
          attemptId: state.attemptId,
          phase: state.phase,
          error: state.error
        })
        for (const window of productWindows) {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            try {
              window.webContents.send('auth.loginState', state)
            } catch {
              // A closing renderer cannot roll back the authoritative result.
              console.warn('[Auth] Login state delivery failed; snapshot remains available')
            }
          }
        }
      },
      () => {
        void cliService.restartAutoStart().catch(() => console.warn('[Auth] CLI restart failed'))
      }
    )
    const storageGuard = createElectronStorageGuard()
    const observeStorageFailure = observeCliStorageWriteFailures(storageGuard)
    const cliService = new CliService({
      executionHost,
      onRuntimeState: (runtime) => {
        void observeStorageFailure(runtime).catch((error) =>
          console.warn('[Storage guard] Could not observe CLI storage failure', error)
        )
      },
      resolveBootstrapSession: async () => {
        return await authService.getBootstrapSession()
      }
    })
    if (!isLocalPlatform()) {
      initializeAuthDeepLinks(async (token) => {
        await authService.login.complete(token)
      })
    }
    let terminalRelay = new TerminalRelay(getLocalTerminalSocketPath(mainPlatformKind))
    let loroDataPlaneRelay = new LoroDataPlaneRelay(() => {
      const run = readLocalDaemonRunFile(getLocalDaemonRunFilePath(mainPlatformKind))
      if (!run.token || !run.dataPlaneSocketPath) throw new Error('local_ipc_credentials_missing')
      return { socketPath: run.dataPlaneSocketPath, token: run.token }
    })
    loroDataPlaneRelay.setEnabled(cliService.getCliAutoStartEnabled())
    const createLocalDataLease = () =>
      isLocalPlatform()
        ? new LocalNativeRepoLeaseServiceLegacy({
            dataRoot: getLodyDataDir(mainPlatformKind),
            requested:
              process.env.LODY_NATIVE_REPO_MODE === 'independent' ||
              process.env.LODY_NATIVE_WORKSPACE_CATALOG === '1' ||
              process.env.LODY_NATIVE_MACHINE_CATALOG === '1' ||
              process.env.LODY_NATIVE_SCHEDULE_REGISTRY === '1' ||
              process.env.LODY_NATIVE_WORKSPACE_META === '1',
            launch: resolveBundledIndependentRepoLaunch
          })
        : null
    // Packaged native packages live in the embedded CLI closure, not main devDependencies.
    // The compiled artifact constant still verifies main's bundled JS against this receipt.
    const loadDesktopNativeSdkCompatibility = () =>
      loadNativeRepoSdkCompatibility(resolveBundledIndependentRepoLaunch().entry)
    let cloudNativePlatform: ReturnType<typeof resolveDesktopNativeDataPlatformLegacy> = null
    const acquireCloudFileIndex = async (windowId: number, workspaceId: string) => {
      const target = [...productWindows].find(
        (window) =>
          !window.isDestroyed() &&
          !window.webContents.isDestroyed() &&
          window.webContents.id === windowId
      )
      if (!target || isAppQuitting()) throw new Error('Cloud file-index participant retired')
      const identity = authService.getCachedSessionIdentity()
      if (!identity.userId) throw new Error('Cloud file-index authentication required')
      const dataRoot = getLodyDataDir(mainPlatformKind)
      const hasNativeOwner = listCloudFileIndexSelections(
        dataRoot,
        identity.userId,
        workspaceId
      ).some((selection) => selection.owners.length > 0)
      if (!hasDesktopNativeDataPlatformLegacy()) {
        if (!hasNativeOwner) return null
        throw new Error('Native Cloud file-index recovery required')
      }
      if (!cloudNativePlatform) {
        const deploymentUrl = import.meta.env.VITE_CONVEX_DEPLOY_URL
        const authSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL || deploymentUrl
        const proof = await loadDesktopNativeSdkCompatibility()
        if (target.isDestroyed() || target.webContents.isDestroyed() || isAppQuitting())
          throw new Error('Cloud file-index participant retired')
        if (!deploymentUrl || !authSiteUrl || !proof)
          throw new Error('Native Cloud file-index configuration unavailable')
        cloudNativePlatform = resolveDesktopNativeDataPlatformLegacy({
          platform: mainPlatformKind,
          auth: authService,
          deploymentUrl,
          authSiteUrl,
          dataRoot,
          launch: resolveBundledIndependentRepoLaunch(),
          requiredSdkArtifactId: proof.artifactId
        })
      }
      const openReader = cloudNativePlatform?.openFileIndexReader
      if (!openReader) throw new Error('Native Cloud file-index reader unavailable')
      const reader = await openReader(
        { expectedAccountId: identity.userId, workspaceId },
        new AbortController().signal
      )
      if (!reader) {
        const current = authService.getCachedSessionIdentity()
        if (current.userId !== identity.userId || current.generation !== identity.generation)
          throw new Error('Cloud file-index account changed')
        return null
      }
      return {
        workspaceId: reader.workspaceId,
        generation: reader.generation,
        source: reader.source,
        assertCurrent: () => {
          if (target.isDestroyed() || target.webContents.isDestroyed())
            throw new Error('Cloud file-index participant retired')
          const current = authService.getCachedSessionIdentity()
          if (current.userId !== identity.userId || current.generation !== identity.generation)
            throw new Error('Cloud file-index account changed')
          reader.assertCurrent()
        },
        release: () => reader.close()
      }
    }
    const createCloudFileIndexBridge = () =>
      isLocalPlatform()
        ? undefined
        : new CloudFileIndexMainLegacy({
            acquire: acquireCloudFileIndex,
            send: (id, event) => {
              const target = [...productWindows].find(
                (window) =>
                  !window.isDestroyed() &&
                  !window.webContents.isDestroyed() &&
                  window.webContents.id === id
              )
              target?.webContents.send(IPC_PUSH_CHANNELS.cloudFileIndexSnapshot, event)
            }
          })
    let cloudFileIndexBridge = createCloudFileIndexBridge()
    // Cleanup always addresses the original bridge, including after auth revocation.
    const cloudFileIndex = async () => cloudFileIndexBridge ?? null
    const prepareCloudFileIndex = async (windowId: number, workspaceId: string) => {
      if (isLocalPlatform()) return
      const reader = await acquireCloudFileIndex(windowId, workspaceId)
      // The installation retains failed/late reader cleanup; this is only a borrow.
      await reader?.release()
    }
    const closeCloudFileIndexes = async () => {
      await cloudFileIndexBridge?.close()
      if (!isLocalPlatform()) await closeInstalledDesktopNativeDataPlatformLegacy()
    }
    let localNativeRepoLease = createLocalDataLease()
    let rendererWfMigration: RendererWorkspaceFlockMigrationMainLegacy | undefined
    let nativeCatalog: NativeWorkspaceCatalogMainLegacy | undefined
    let nativeCatalogUpgrade: NativeWorkspaceCatalogMigrationLegacy | undefined
    const rendererWorkspaceFlockMigration = () => {
      if (!isLocalPlatform()) return null
      if (!rendererWfMigration) {
        const dataRoot = getLodyDataDir(mainPlatformKind)
        const directory = join(dataRoot, 'native-repo')
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        rendererWfMigration = new RendererWorkspaceFlockMigrationMainLegacy({
          databasePath: join(directory, 'renderer-wf-owners.sqlite3'),
          registeredWindowIds: () =>
            [...productWindows]
              .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
              .map((window) => window.webContents.id),
          send: (id, request) => {
            const target = [...productWindows].find(
              (window) =>
                !window.isDestroyed() &&
                !window.webContents.isDestroyed() &&
                window.webContents.id === id
            )
            if (!target) throw new Error('Renderer migration participant is unavailable')
            target.webContents.send(IPC_PUSH_CHANNELS.workspaceFlockMigration, request)
          },
          publishOwner: (id, owner) => {
            const target = [...productWindows].find(
              (window) =>
                !window.isDestroyed() &&
                !window.webContents.isDestroyed() &&
                window.webContents.id === id
            )
            if (!target) throw new Error('Native owner notification target unavailable')
            target.webContents.send(IPC_PUSH_CHANNELS.workspaceFlockOwner, owner)
          },
          readCommittedOwner: async (binding) => {
            const owner = readNativeWorkspaceFlockOwner(dataRoot, binding)
            if (owner === 'native') assertPublishedNativeWorkspaceFlockStorage(dataRoot, binding)
            return owner
          }
        })
      }
      return rendererWfMigration
    }
    const nativeWorkspaceCatalog = () => {
      if (!isLocalPlatform()) return null
      nativeCatalog ??= new NativeWorkspaceCatalogMainLegacy({
        dataRoot: getLodyDataDir(mainPlatformKind),
        lease: () => localNativeRepoLease,
        migration: rendererWorkspaceFlockMigration,
        send: (id, event) => {
          const target = [...productWindows].find(
            (window) =>
              !window.isDestroyed() &&
              !window.webContents.isDestroyed() &&
              window.webContents.id === id
          )
          if (!target) throw new Error('Catalog observer window unavailable')
          target.webContents.send(IPC_PUSH_CHANNELS.workspaceCatalog, event)
        }
      })
      return nativeCatalog
    }
    const migrateNativeWorkspaceCatalog = async (binding: RendererWfBinding) => {
      if (!isLocalPlatform() || isAppQuitting()) return
      const renderer = rendererWorkspaceFlockMigration()!
      if (
        process.env.LODY_NATIVE_WORKSPACE_CATALOG !== '1' &&
        renderer.status(binding).owner !== 'frozen' &&
        !nativeCatalogUpgrade
      )
        return
      nativeCatalogUpgrade ??= new NativeWorkspaceCatalogMigrationLegacy({
        dataRoot: getLodyDataDir(mainPlatformKind),
        renderer: () => rendererWorkspaceFlockMigration()!,
        acquirePause: () => cliService.acquireDataMigrationPause(),
        ensureData: async (current) => {
          if (!localNativeRepoLease) throw new Error('Local data host is unavailable')
          await localNativeRepoLease.client(current)
        },
        launch: resolveBundledWorkspaceCatalogMigrationLaunch
      })
      await nativeCatalogUpgrade.migrate(binding)
    }
    let rendererMfMigration: RendererFlockRoomGroupMigrationMainLegacy | undefined
    let nativeMachineCatalogBridge: NativeMachineCatalogMainLegacy | undefined
    let nativeMachineCatalogUpgrade: NativeMachineCatalogMigrationLegacy | undefined
    const rendererMachineFlockMigration = async () => {
      if (!isLocalPlatform()) return null
      const snapshot = await readLocalPlatformSnapshot()
      if (!snapshot) return null
      if (rendererMfMigration) {
        if (
          rendererMfMigration.group.accountId !== snapshot.userId ||
          rendererMfMigration.group.workspaceId !== snapshot.workspace.workspaceId
        )
          throw new Error('MF trusted identity changed; retire the previous owner')
        return rendererMfMigration
      }
      const dataRoot = getLodyDataDir(mainPlatformKind)
      const databasePath = join(dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3')
      let group: RendererFlockGroup | undefined
      if (existsSync(databasePath)) {
        const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 })
        try {
          const rows = db
            .prepare('SELECT group_json FROM renderer_flock_group_owners WHERE instr(scope,?)=1')
            .all(
              JSON.stringify([
                snapshot.userId,
                snapshot.workspace.workspaceId,
                'machine',
                'plaintext'
              ]).slice(0, -1) + ','
            ) as Array<{ group_json: string }>
          const groups = rows
            .map((row) => rendererFlockGroupSchema.parse(JSON.parse(row.group_json)))
            .filter(
              (value) =>
                value.domain === 'machine' &&
                value.accountId === snapshot.userId &&
                value.workspaceId === snapshot.workspace.workspaceId
            )
          if (groups.length > 1)
            throw new Error('Multiple MF groups require an explicit room dispatcher')
          group = groups[0]
        } finally {
          db.close()
        }
      }
      if (!group) {
        const descriptor = resolveLocalIndependentRepo({
          platform: 'local',
          dataRoot,
          accountId: snapshot.userId,
          workspaceId: snapshot.workspace.workspaceId
        })
        const routes = join(descriptor.directory, 'routes.sqlite3')
        if (existsSync(routes)) {
          const db = new Database(routes, { readonly: true, fileMustExist: true, timeout: 0 })
          try {
            const rows = db
              .prepare(
                "SELECT room_key FROM native_room_migrations WHERE binding=? AND stage!='legacy' UNION SELECT room_key FROM native_room_maintenance WHERE binding=?"
              )
              .all(
                JSON.stringify([snapshot.userId, snapshot.workspace.workspaceId]),
                JSON.stringify([snapshot.userId, snapshot.workspace.workspaceId])
              ) as Array<{ room_key: string }>
            for (const row of rows) {
              const room: unknown = JSON.parse(row.room_key)
              if (
                room &&
                typeof room === 'object' &&
                'id' in room &&
                typeof room.id === 'string' &&
                room.id.startsWith(`${snapshot.workspace.workspaceId}:mf:`)
              )
                throw new Error(
                  'MF group ownership witness is missing; explicit recovery is required'
                )
            }
          } finally {
            db.close()
          }
        }
        if (process.env.LODY_NATIVE_MACHINE_CATALOG !== '1') return null
        const machineId = cliService.readLocalDataMachineId()
        if (!machineId) throw new Error('Local machine identity is unavailable')
        group = rendererFlockGroupSchema.parse({
          accountId: snapshot.userId,
          workspaceId: snapshot.workspace.workspaceId,
          domain: 'machine',
          contentMode: 'plaintext',
          roomIds: [`${snapshot.workspace.workspaceId}:mf:${machineId}`]
        })
      }
      if (group.roomIds.length !== 1)
        throw new Error('MF first batch requires exactly one complete machine room')
      if (rendererMfMigration) return rendererMfMigration
      mkdirSync(join(dataRoot, 'native-repo'), { recursive: true, mode: 0o700 })
      rendererMfMigration = new RendererFlockRoomGroupMigrationMainLegacy({
        group,
        databasePath,
        preflight: true,
        registeredWindowIds: () =>
          [...productWindows]
            .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
            .map((window) => window.webContents.id),
        send: (id, request) => {
          const target = [...productWindows].find(
            (window) =>
              !window.isDestroyed() &&
              !window.webContents.isDestroyed() &&
              window.webContents.id === id
          )
          if (!target) throw new Error('MF migration participant unavailable')
          target.webContents.send(IPC_PUSH_CHANNELS.machineFlockMigration, request)
        },
        publishOwner: (id, owner) => {
          const target = [...productWindows].find(
            (window) =>
              !window.isDestroyed() &&
              !window.webContents.isDestroyed() &&
              window.webContents.id === id
          )
          if (!target) throw new Error('MF owner target unavailable')
          target.webContents.send(IPC_PUSH_CHANNELS.machineFlockOwner, owner)
        },
        readCommittedOwner: async (current) => {
          const values = current.roomIds.map((roomId) => {
            const binding = {
              accountId: current.accountId,
              workspaceId: current.workspaceId,
              roomId,
              contentMode: 'plaintext' as const
            }
            const owner = readNativeWorkspaceFlockOwner(dataRoot, binding)
            if (owner === 'native') assertPublishedNativeWorkspaceFlockStorage(dataRoot, binding)
            return owner
          })
          if (values.every((value) => value === 'legacy')) return 'legacy'
          if (values.every((value) => value === 'native')) return 'native'
          return 'frozen'
        }
      })
      return rendererMfMigration
    }
    let nativeMachineCatalogVerifier: NativeMachineCatalogVerifierLegacy | undefined
    const nativeMachineCatalog = () => {
      if (!isLocalPlatform()) return null
      nativeMachineCatalogBridge ??= new NativeMachineCatalogMainLegacy({
        acquire: async (windowId, registrationId, machineId) => {
          const renderer = await rendererMachineFlockMigration()
          if (!renderer) throw new MachineCatalogIpcError('access_denied')
          const group = renderer.group
          const roomId = `${group.workspaceId}:mf:${machineId}`
          const dataRoot = getLodyDataDir(mainPlatformKind)
          const binding = {
            accountId: group.accountId,
            workspaceId: group.workspaceId,
            roomId,
            contentMode: 'plaintext' as const
          }
          const check = () => {
            renderer.assertRegistration(windowId, registrationId)
            if (
              renderer !== rendererMfMigration ||
              renderer.status().owner !== 'native' ||
              !group.roomIds.includes(roomId) ||
              readNativeWorkspaceFlockOwner(dataRoot, binding) !== 'native'
            )
              throw new MachineCatalogIpcError('restart_required')
            assertPublishedNativeWorkspaceFlockStorage(dataRoot, binding)
          }
          check()
          const proof = await loadDesktopNativeSdkCompatibility()
          if (!proof || !localNativeRepoLease) throw new MachineCatalogIpcError('restart_required')
          const client = await localNativeRepoLease.client(group)
          const info = await localNativeRepoLease.leaseInfo(client)
          if (info.sdkArtifactId !== proof.artifactId)
            throw new MachineCatalogIpcError('restart_required')
          check()
          const generation = JSON.stringify([
            registrationId,
            renderer.status().revision,
            info.engineRunId,
            info.clientGeneration,
            proof.artifactId
          ])
          const assertCurrent = () => {
            check()
            if (client.connectionState !== 'connected')
              throw new MachineCatalogIpcError('restart_required')
          }
          return {
            generation,
            assertCurrent,
            options: {
              client,
              namespace: group.workspaceId,
              writer: `main-mf:${machineId}`,
              machineMetadata: async () => {
                assertCurrent()
                if (
                  !cliService.getCliAutoStartEnabled() ||
                  cliService.getCliState().runtime?.startupStage !== 'ready' ||
                  (await cliService.getLocalMachineId()) !== machineId
                )
                  throw new MachineCatalogIpcError('unavailable')
                const metadata = await trustedWorkspaceMeta()
                const snapshot = projectWorkspaceMetaPublicSnapshot(
                  await metadata.externalMetadata.read(),
                  () => false
                )
                const row = snapshot.docs.find(
                  (row) => row.docId === `machine-${machineId}` && !row.deleted
                )
                const value = row?.meta
                assertCurrent()
                metadata.assertCurrent()
                if (
                  !value ||
                  value.id !== machineId ||
                  typeof value.name !== 'string' ||
                  typeof value.cliVersion !== 'string' ||
                  typeof value.os !== 'string' ||
                  !Array.isArray(value.sessions) ||
                  !value.sessions.every((id) => typeof id === 'string')
                )
                  throw new MachineCatalogIpcError('unavailable')
                return value as MachineMeta
              },
              verifyAgentChange: async (_previous, candidate, signal) => {
                assertCurrent()
                nativeMachineCatalogVerifier ??= new NativeMachineCatalogVerifierLegacy({
                  dataRoot,
                  launch: () => {
                    const host = resolveBundledIndependentRepoLaunch()
                    return {
                      executable: host.executable,
                      entry: join(host.entry, '..', 'native-machine-catalog-verify.js')
                    }
                  }
                })
                const verified = await nativeMachineCatalogVerifier.verify({
                  binding: {
                    accountId: group.accountId,
                    workspaceId: group.workspaceId,
                    machineId
                  } as never,
                  generation,
                  candidate,
                  signal
                })
                assertCurrent()
                return verified
              },
              losslessWireI64: true,
              binding: {
                accountId: group.accountId,
                workspaceId: group.workspaceId,
                machineId
              } as never,
              authorize: () => {
                assertCurrent()
                return true
              },
              authority: {
                current: () => {
                  assertCurrent()
                  return { epoch: generation, synced: true }
                },
                subscribe: (listener) => client.onConnectionStateChange(listener)
              }
            }
          }
        },
        send: (id, event) => {
          const target = [...productWindows].find(
            (window) =>
              !window.isDestroyed() &&
              !window.webContents.isDestroyed() &&
              window.webContents.id === id
          )
          if (!target) throw new MachineCatalogIpcError('restart_required')
          target.webContents.send(IPC_PUSH_CHANNELS.machineCatalogEvent, event)
        }
      })
      return nativeMachineCatalogBridge
    }
    const migrateNativeMachineCatalog = async (group: RendererFlockGroup) => {
      if (!isLocalPlatform() || isAppQuitting()) return
      const renderer = await rendererMachineFlockMigration()
      if (!renderer || rendererFlockGroupScope(renderer.group) !== rendererFlockGroupScope(group))
        throw new Error('MF trusted migration group changed')
      if (process.env.LODY_NATIVE_MACHINE_CATALOG !== '1' && renderer.status().owner === 'legacy')
        return
      nativeMachineCatalogUpgrade ??= new NativeMachineCatalogMigrationLegacy({
        dataRoot: getLodyDataDir(mainPlatformKind),
        renderer: () => {
          if (!rendererMfMigration) throw new Error('MF migration owner unavailable')
          return rendererMfMigration
        },
        acquirePause: () => cliService.acquireDataMigrationPause(),
        ensureData: async (current) => {
          const proof = await loadDesktopNativeSdkCompatibility()
          if (!proof || !localNativeRepoLease)
            throw new Error('Verified MF SDK artifact unavailable')
          const client = await localNativeRepoLease.client(current)
          if ((await localNativeRepoLease.leaseInfo(client)).sdkArtifactId !== proof.artifactId)
            throw new Error('MF host SDK artifact mismatch')
        },
        launch: () => {
          const host = resolveBundledIndependentRepoLaunch()
          return {
            executable: host.executable,
            entry: join(host.entry, '..', 'native-machine-catalog-migrate.js')
          }
        }
      })
      await nativeMachineCatalogUpgrade.migrate(group)
    }
    let rendererSrMigration: RendererFlockRoomGroupMigrationMainLegacy | undefined
    let nativeScheduleRegistryBridge: NativeScheduleRegistryMainLegacy | undefined
    let nativeScheduleRegistryUpgrade: NativeScheduleRegistryMigrationLegacy | undefined
    const rendererScheduleRegistryMigration = async () => {
      if (!isLocalPlatform()) return null
      const snapshot = await readLocalPlatformSnapshot()
      if (!snapshot) return null
      if (rendererSrMigration) {
        if (
          rendererSrMigration.group.accountId !== snapshot.userId ||
          rendererSrMigration.group.workspaceId !== snapshot.workspace.workspaceId
        )
          throw new Error('SR trusted identity changed; retire the previous owner')
        return rendererSrMigration
      }
      const dataRoot = getLodyDataDir(mainPlatformKind)
      const databasePath = join(dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3')
      let group: RendererFlockGroup | undefined
      if (existsSync(databasePath)) {
        const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 })
        try {
          const rows = db
            .prepare('SELECT group_json FROM renderer_flock_group_owners WHERE instr(scope,?)=1')
            .all(
              JSON.stringify([
                snapshot.userId,
                snapshot.workspace.workspaceId,
                'schedule',
                'plaintext'
              ]).slice(0, -1) + ','
            ) as Array<{ group_json: string }>
          const groups = rows
            .map((row) => rendererFlockGroupSchema.parse(JSON.parse(row.group_json)))
            .filter(
              (value) =>
                value.domain === 'schedule' &&
                value.accountId === snapshot.userId &&
                value.workspaceId === snapshot.workspace.workspaceId
            )
          if (groups.length > 1)
            throw new Error('Multiple SR groups require an explicit room dispatcher')
          group = groups[0]
        } finally {
          db.close()
        }
      }
      if (!group) {
        const descriptor = resolveLocalIndependentRepo({
          platform: 'local',
          dataRoot,
          accountId: snapshot.userId,
          workspaceId: snapshot.workspace.workspaceId
        })
        const routes = join(descriptor.directory, 'routes.sqlite3')
        if (existsSync(routes)) {
          const db = new Database(routes, { readonly: true, fileMustExist: true, timeout: 0 })
          try {
            const rows = db
              .prepare(
                "SELECT room_key FROM native_room_migrations WHERE binding=? AND stage!='legacy' UNION SELECT room_key FROM native_room_maintenance WHERE binding=?"
              )
              .all(
                JSON.stringify([snapshot.userId, snapshot.workspace.workspaceId]),
                JSON.stringify([snapshot.userId, snapshot.workspace.workspaceId])
              ) as Array<{ room_key: string }>
            for (const row of rows) {
              const room: unknown = JSON.parse(row.room_key)
              if (
                room &&
                typeof room === 'object' &&
                'id' in room &&
                typeof room.id === 'string' &&
                room.id === `${snapshot.workspace.workspaceId}:sr`
              )
                throw new Error(
                  'SR group ownership witness is missing; explicit recovery is required'
                )
            }
          } finally {
            db.close()
          }
        }
        if (process.env.LODY_NATIVE_SCHEDULE_REGISTRY !== '1') return null
        group = rendererFlockGroupSchema.parse({
          accountId: snapshot.userId,
          workspaceId: snapshot.workspace.workspaceId,
          domain: 'schedule',
          contentMode: 'plaintext',
          roomIds: [`${snapshot.workspace.workspaceId}:sr`]
        })
      }
      if (group.roomIds.length !== 1)
        throw new Error('SR requires exactly one complete registry room')
      if (rendererSrMigration) return rendererSrMigration
      mkdirSync(join(dataRoot, 'native-repo'), { recursive: true, mode: 0o700 })
      rendererSrMigration = new RendererFlockRoomGroupMigrationMainLegacy({
        group,
        databasePath,
        registeredWindowIds: () =>
          [...productWindows]
            .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
            .map((window) => window.webContents.id),
        send: (id, request) => {
          const target = [...productWindows].find(
            (window) =>
              !window.isDestroyed() &&
              !window.webContents.isDestroyed() &&
              window.webContents.id === id
          )
          if (!target) throw new Error('SR migration participant unavailable')
          target.webContents.send(IPC_PUSH_CHANNELS.scheduleRegistryMigration, request)
        },
        publishOwner: (id, owner) => {
          const target = [...productWindows].find(
            (window) =>
              !window.isDestroyed() &&
              !window.webContents.isDestroyed() &&
              window.webContents.id === id
          )
          if (!target) throw new Error('SR owner target unavailable')
          target.webContents.send(IPC_PUSH_CHANNELS.scheduleRegistryOwner, owner)
        },
        readCommittedOwner: async (current) => {
          const values = current.roomIds.map((roomId) => {
            const binding = {
              accountId: current.accountId,
              workspaceId: current.workspaceId,
              roomId,
              contentMode: 'plaintext' as const
            }
            const owner = readNativeWorkspaceFlockOwner(dataRoot, binding)
            if (owner === 'native') assertPublishedNativeWorkspaceFlockStorage(dataRoot, binding)
            return owner
          })
          if (values.every((value) => value === 'legacy')) return 'legacy'
          if (values.every((value) => value === 'native')) return 'native'
          return 'frozen'
        }
      })
      return rendererSrMigration
    }
    const nativeScheduleRegistry = () => {
      if (!isLocalPlatform()) return null
      nativeScheduleRegistryBridge ??= new NativeScheduleRegistryMainLegacy({
        acquire: async (windowId, registrationId) => {
          const renderer = await rendererScheduleRegistryMigration()
          if (!renderer) throw new ScheduleRegistryIpcError('access_denied')
          const group = renderer.group
          const dataRoot = getLodyDataDir(mainPlatformKind)
          const binding = {
            accountId: group.accountId,
            workspaceId: group.workspaceId,
            roomId: `${group.workspaceId}:sr`,
            contentMode: 'plaintext' as const
          }
          const check = () => {
            renderer.assertRegistration(windowId, registrationId)
            if (
              renderer !== rendererSrMigration ||
              renderer.status().owner !== 'native' ||
              !group.roomIds.includes(binding.roomId) ||
              readNativeWorkspaceFlockOwner(dataRoot, binding) !== 'native'
            )
              throw new ScheduleRegistryIpcError('restart_required')
            assertPublishedNativeWorkspaceFlockStorage(dataRoot, binding)
          }
          check()
          const proof = await loadDesktopNativeSdkCompatibility()
          if (!proof || !localNativeRepoLease)
            throw new ScheduleRegistryIpcError('restart_required')
          const client = await localNativeRepoLease.client(group)
          const info = await localNativeRepoLease.leaseInfo(client)
          if (info.sdkArtifactId !== proof.artifactId)
            throw new ScheduleRegistryIpcError('restart_required')
          const machineId = cliService.readLocalDataMachineId()
          if (!machineId) throw new ScheduleRegistryIpcError('unavailable')
          check()
          const generation = JSON.stringify([
            registrationId,
            renderer.status().revision,
            info.engineRunId,
            info.clientGeneration,
            proof.artifactId
          ])
          const assertCurrent = () => {
            check()
            if (client.connectionState !== 'connected')
              throw new ScheduleRegistryIpcError('restart_required')
          }
          return {
            generation,
            actorId: group.accountId,
            machineId,
            client,
            assertCurrent,
            options: {
              workspaceId: group.workspaceId as never,
              namespace: group.workspaceId,
              writer: `main-sr:${group.accountId}`,
              flush: async () => assertCurrent(),
              authority: {
                current: () => {
                  assertCurrent()
                  return true
                },
                subscribe: (listener) => client.onConnectionStateChange(listener)
              }
            }
          }
        },
        send: (id, event) => {
          const target = [...productWindows].find(
            (window) =>
              !window.isDestroyed() &&
              !window.webContents.isDestroyed() &&
              window.webContents.id === id
          )
          if (!target) throw new ScheduleRegistryIpcError('restart_required')
          target.webContents.send(IPC_PUSH_CHANNELS.scheduleRegistryEvent, event)
        }
      })
      return nativeScheduleRegistryBridge
    }
    const migrateNativeScheduleRegistry = async (group: RendererFlockGroup) => {
      if (!isLocalPlatform() || isAppQuitting()) return
      const renderer = await rendererScheduleRegistryMigration()
      if (!renderer || rendererFlockGroupScope(renderer.group) !== rendererFlockGroupScope(group))
        throw new Error('SR trusted migration group changed')
      if (process.env.LODY_NATIVE_SCHEDULE_REGISTRY !== '1' && renderer.status().owner === 'legacy')
        return
      nativeScheduleRegistryUpgrade ??= new NativeScheduleRegistryMigrationLegacy({
        dataRoot: getLodyDataDir(mainPlatformKind),
        renderer: () => {
          if (!rendererSrMigration) throw new Error('SR migration owner unavailable')
          return rendererSrMigration
        },
        acquirePause: () => cliService.acquireDataMigrationPause(),
        ensureData: async (current) => {
          const proof = await loadDesktopNativeSdkCompatibility()
          if (!proof || !localNativeRepoLease)
            throw new Error('Verified SR SDK artifact unavailable')
          const client = await localNativeRepoLease.client(current)
          if ((await localNativeRepoLease.leaseInfo(client)).sdkArtifactId !== proof.artifactId)
            throw new Error('SR host SDK artifact mismatch')
        },
        launch: () => {
          const host = resolveBundledIndependentRepoLaunch()
          return {
            executable: host.executable,
            entry: join(host.entry, '..', 'native-schedule-registry-migrate.js')
          }
        }
      })
      await nativeScheduleRegistryUpgrade.migrate(group)
    }
    let rendererMetaMigration: RendererFlockRoomGroupMigrationMainLegacy | undefined
    let nativeMetaUpgrade: NativeWorkspaceMetaMigrationLegacy | undefined
    let nativeMetaOwner: NativeWorkspaceMetaOwnerLegacy | undefined
    const rendererWorkspaceMetaMigration = async () => {
      if (!isLocalPlatform()) return null
      const snapshot = await readLocalPlatformSnapshot()
      if (!snapshot) return null
      if (rendererMetaMigration) {
        if (
          rendererMetaMigration.group.accountId !== snapshot.userId ||
          rendererMetaMigration.group.workspaceId !== snapshot.workspace.workspaceId
        )
          throw new Error('Meta trusted identity changed')
        return rendererMetaMigration
      }
      const dataRoot = getLodyDataDir(mainPlatformKind)
      const binding = {
        accountId: snapshot.userId,
        workspaceId: snapshot.workspace.workspaceId,
        contentMode: 'plaintext' as const
      }
      const group = rendererFlockGroupSchema.parse({
        ...binding,
        domain: 'meta',
        roomIds: ['meta']
      })
      const databasePath = join(dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3')
      let witness = false
      if (existsSync(databasePath)) {
        const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 })
        try {
          const row = db
            .prepare('SELECT group_json FROM renderer_flock_group_owners WHERE scope=?')
            .get(rendererFlockGroupScope(group)) as { group_json: string } | undefined
          if (row) {
            if (
              rendererFlockGroupScope(
                rendererFlockGroupSchema.parse(JSON.parse(row.group_json))
              ) !== rendererFlockGroupScope(group)
            )
              throw new Error('Meta witness identity mismatch')
            witness = true
          }
        } finally {
          db.close()
        }
      }
      const owner = readNativeWorkspaceMetaOwner(dataRoot, binding)
      if (owner !== 'legacy' && !witness)
        throw new Error('Meta native owner requires its complete renderer witness')
      if (!witness && process.env.LODY_NATIVE_WORKSPACE_META !== '1') return null
      if (rendererMetaMigration) return rendererMetaMigration
      mkdirSync(join(dataRoot, 'native-repo'), { recursive: true, mode: 0o700 })
      const target = (id: number) => {
        const window = [...productWindows].find(
          (value) =>
            !value.isDestroyed() && !value.webContents.isDestroyed() && value.webContents.id === id
        )
        if (!window) throw new Error('Meta participant unavailable')
        return window
      }
      rendererMetaMigration = new RendererFlockRoomGroupMigrationMainLegacy({
        group,
        databasePath,
        registeredWindowIds: () =>
          [...productWindows]
            .filter((value) => !value.isDestroyed() && !value.webContents.isDestroyed())
            .map((value) => value.webContents.id),
        send: (id, request) =>
          target(id).webContents.send(IPC_PUSH_CHANNELS.workspaceMetaMigration, request),
        publishOwner: (id, value) =>
          target(id).webContents.send(IPC_PUSH_CHANNELS.workspaceMetaOwner, value),
        readCommittedOwner: async (current) => {
          const owner = readNativeWorkspaceMetaOwner(dataRoot, current)
          if (owner === 'native') assertPublishedNativeWorkspaceMetaStorage(dataRoot, current)
          return owner
        }
      })
      return rendererMetaMigration
    }
    const migrateNativeWorkspaceMeta = async (group: RendererFlockGroup) => {
      if (!isLocalPlatform() || isAppQuitting()) throw new Error('Meta migration unavailable')
      const renderer = await rendererWorkspaceMetaMigration()
      if (!renderer || rendererFlockGroupScope(renderer.group) !== rendererFlockGroupScope(group))
        throw new Error('Meta migration identity changed')
      if (renderer.status().owner === 'legacy') {
        // The first public Meta slice omits saved Agent/MCP launch values. Their
        // catalog owners must already have migrated, so filtering old fallback
        // metadata cannot hide a still-authoritative provider configuration.
        const workspace = rendererWorkspaceFlockMigration()
        const workspaceBinding = {
          accountId: group.accountId,
          workspaceId: group.workspaceId,
          roomId: `${group.workspaceId}:wf:workspace`,
          contentMode: 'plaintext' as const
        }
        const machine = await rendererMachineFlockMigration()
        const schedule = await rendererScheduleRegistryMigration()
        if (
          !workspace ||
          workspace.status(workspaceBinding).owner !== 'native' ||
          readNativeWorkspaceFlockOwner(getLodyDataDir(mainPlatformKind), workspaceBinding) !==
            'native' ||
          !machine ||
          machine.status().owner !== 'native' ||
          !schedule ||
          schedule.status().owner !== 'native'
        )
          throw new Error(
            'Workspace Meta requires the completed native workspace, machine and schedule catalogs'
          )
        assertPublishedNativeWorkspaceFlockStorage(
          getLodyDataDir(mainPlatformKind),
          workspaceBinding
        )
        await machine.reconcileOwner()
        await schedule.reconcileOwner()
        for (const roomId of schedule.group.roomIds) {
          const scheduleBinding = {
            accountId: group.accountId,
            workspaceId: group.workspaceId,
            roomId,
            contentMode: 'plaintext' as const
          }
          if (
            readNativeWorkspaceFlockOwner(getLodyDataDir(mainPlatformKind), scheduleBinding) !==
            'native'
          )
            throw new Error('Schedule catalog native owner changed')
          assertPublishedNativeWorkspaceFlockStorage(
            getLodyDataDir(mainPlatformKind),
            scheduleBinding
          )
        }
      }
      nativeMetaUpgrade ??= new NativeWorkspaceMetaMigrationLegacy({
        dataRoot: getLodyDataDir(mainPlatformKind),
        renderer: () => {
          if (!rendererMetaMigration) throw new Error('Meta migration owner unavailable')
          return rendererMetaMigration
        },
        acquirePause: () => cliService.acquireDataMigrationPause(),
        ensureData: async (current) => {
          const proof = await loadDesktopNativeSdkCompatibility()
          if (!proof?.flockStateEntries || !localNativeRepoLease)
            throw new Error('Verified Meta SDK unavailable')
          const client = await localNativeRepoLease.client(current)
          if ((await localNativeRepoLease.leaseInfo(client)).sdkArtifactId !== proof.artifactId)
            throw new Error('Meta SDK host mismatch')
        },
        launch: () => {
          const host = resolveBundledIndependentRepoLaunch()
          return {
            executable: host.executable,
            entry: join(host.entry, '..', 'native-workspace-meta-migrate.js')
          }
        }
      })
      await nativeMetaUpgrade.migrate(group)
    }
    const trustedWorkspaceMeta = async () => {
      if (!isLocalPlatform()) throw new Error('Local Meta unavailable')
      nativeMetaOwner ??= new NativeWorkspaceMetaOwnerLegacy({
        acquire: async () => {
          const renderer = await rendererWorkspaceMetaMigration()
          if (!renderer) throw new Error('Meta owner unavailable')
          const group = renderer.group
          const revision = renderer.status().revision
          const check = () => {
            if (
              renderer !== rendererMetaMigration ||
              renderer.status().owner !== 'native' ||
              renderer.status().revision !== revision ||
              readNativeWorkspaceMetaOwner(getLodyDataDir(mainPlatformKind), group) !== 'native'
            )
              throw new Error('Meta generation changed')
            assertPublishedNativeWorkspaceMetaStorage(getLodyDataDir(mainPlatformKind), group)
          }
          check()
          const proof = await loadDesktopNativeSdkCompatibility()
          if (!proof?.flockStateEntries || !localNativeRepoLease)
            throw new Error('Verified Meta SDK unavailable')
          const client = await localNativeRepoLease.client(group)
          const info = await localNativeRepoLease.leaseInfo(client)
          if (info.sdkArtifactId !== proof.artifactId)
            throw new Error('Meta engine artifact mismatch')
          check()
          return {
            binding: { accountId: group.accountId, workspaceId: group.workspaceId as WorkspaceId },
            generation: JSON.stringify([
              revision,
              info.engineRunId,
              info.clientGeneration,
              proof.artifactId
            ]),
            client,
            sdkCompatibility: proof,
            sdkArtifactId: info.sdkArtifactId,
            assertCurrent: check
          }
        }
      })
      return nativeMetaOwner.get()
    }
    let nativeWorkspaceMetaBridge: NativeWorkspaceMetaMainLegacy | undefined
    let nativeSessionBridge: NativeSessionMainLegacy | undefined
    let nativeSessionOwner: NativeLocalSessionOwnerLegacy | undefined
    let nativeSessionOwnerStarting: Promise<NativeLocalSessionOwnerLegacy> | undefined
    let nativeSessionSnapshots = new NativeSessionSnapshotRegistry()
    const assertMetaFrame = async (windowId: number, registrationId: string) => {
      const renderer = await rendererWorkspaceMetaMigration()
      if (!renderer) throw new NativeSessionIpcError('access_denied')
      const revision = renderer.status().revision
      const check = () => {
        renderer.assertRegistration(windowId, registrationId)
        if (
          renderer !== rendererMetaMigration ||
          renderer.status().owner !== 'native' ||
          renderer.status().revision !== revision ||
          readNativeWorkspaceMetaOwner(getLodyDataDir(mainPlatformKind), renderer.group) !==
            'native'
        )
          throw new NativeSessionIpcError('restart_required')
        assertPublishedNativeWorkspaceMetaStorage(getLodyDataDir(mainPlatformKind), renderer.group)
      }
      check()
      return { renderer, check, revision }
    }
    let sessionBodyMigration: RendererSessionBodyMigrationMainLegacy | undefined
    const nativeSessionBodyMigration = async (windowId: number, registrationId: string) => {
      const frame = await assertMetaFrame(windowId, registrationId)
      if (!sessionBodyMigration) {
        const dataRoot = getLodyDataDir(mainPlatformKind)
        const group = frame.renderer.group
        const admit = (id: number, registration: string) => {
          if (
            rendererMetaMigration !== frame.renderer ||
            frame.renderer.status().owner !== 'native' ||
            frame.renderer.status().revision !== frame.revision
          )
            throw new Error('Session migration Meta owner changed')
          frame.renderer.assertRegistration(id, registration)
          if (readNativeWorkspaceMetaOwner(dataRoot, group) !== 'native')
            throw new Error('Session metadata route changed')
          assertPublishedNativeWorkspaceMetaStorage(dataRoot, group)
        }
        sessionBodyMigration = new RendererSessionBodyMigrationMainLegacy({
          binding: {
            accountId: group.accountId,
            workspaceId: group.workspaceId,
            contentMode: 'plaintext'
          },
          databasePath: join(dataRoot, 'native-repo', 'renderer-session-body-owners.sqlite3'),
          admit,
          registeredWindowIds: () =>
            [...productWindows]
              .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
              .map((window) => window.webContents.id),
          readCommittedOwner: (sessionId) =>
            readLocalNativeSessionRoute(
              {
                accountId: group.accountId,
                workspaceId: group.workspaceId as WorkspaceId,
                dataRoot
              },
              `session-${sessionId}`
            ),
          send: (id, request) => {
            const target = [...productWindows].find(
              (window) =>
                !window.isDestroyed() &&
                !window.webContents.isDestroyed() &&
                window.webContents.id === id
            )
            if (!target) throw new Error('Session migration participant retired')
            target.webContents.send(IPC_PUSH_CHANNELS.sessionBodyMigrationRequest, request)
          }
        })
      }
      return sessionBodyMigration
    }
    let nativeSessionMigrationCoordinator: NativeSessionMigrationMainLegacy | undefined
    const sessionMigrationVerifiers = new Set<NativeLoroDocumentVerifierLegacy>()
    const sessionMigrationCoordinator = () => {
      nativeSessionMigrationCoordinator ??= new NativeSessionMigrationMainLegacy({
        resolve: async (windowId, registrationId) => {
          const frame = await assertMetaFrame(windowId, registrationId)
          const metadata = await trustedWorkspaceMeta()
          const owner = await getNativeSessionOwner(frame.renderer.group)
          const windows = await nativeSessionBodyMigration(windowId, registrationId)
          const machineId = cliService.readLocalDataMachineId()
          if (!machineId) throw new NativeSessionIpcError('unavailable')
          const assertCurrent = () => {
            frame.check()
            metadata.assertCurrent()
          }
          assertCurrent()
          return {
            accountId: frame.renderer.group.accountId,
            workspaceId: frame.renderer.group.workspaceId as WorkspaceId,
            machineId,
            dataRoot: getLodyDataDir(mainPlatformKind),
            metadata,
            owner,
            windows,
            assertCurrent,
            control: (request) => cliService.controlNativeSessionBodyMigration(request)
          }
        },
        verifyState: async (scope, input) => {
          scope.assertCurrent()
          const compatibility = await loadDesktopNativeSdkCompatibility()
          if (!compatibility) throw new NativeSessionIpcError('unavailable')
          const selected = resolveLocalIndependentRepo({ platform: 'local', ...scope })
          const verifier = new NativeLoroDocumentVerifierLegacy({
            directory: join(selected.directory, 'session-staging'),
            compatibility,
            launch: resolveBundledIndependentRepoLaunch(),
            assertCurrent: scope.assertCurrent
          })
          sessionMigrationVerifiers.add(verifier)
          try {
            await verifier.verify(input)
          } finally {
            await verifier.close()
            sessionMigrationVerifiers.delete(verifier)
          }
        }
      })
      return nativeSessionMigrationCoordinator
    }
    const nativeWorkspaceMeta = () => {
      if (!isLocalPlatform() || isAppQuitting()) return null
      nativeWorkspaceMetaBridge ??= new NativeWorkspaceMetaMainLegacy({
        acquire: async (windowId, registrationId) => {
          const frame = await assertMetaFrame(windowId, registrationId)
          const metadata = await trustedWorkspaceMeta()
          const machineId = cliService.readLocalDataMachineId()
          if (!machineId) throw new WorkspaceMetaIpcError('unavailable')
          const assertCurrent = () => {
            frame.check()
            metadata.assertCurrent()
          }
          assertCurrent()
          return {
            binding: metadata.binding,
            generation: metadata.generation,
            actorId: metadata.binding.accountId,
            machineId,
            metadata,
            ...(process.env.LODY_NATIVE_SESSION_BODY === '1'
              ? {
                  createSession: (
                    command: Parameters<NativeSessionMigrationMainLegacy['createSession']>[2],
                    authorize: Parameters<NativeSessionMigrationMainLegacy['createSession']>[3]
                  ) =>
                    sessionMigrationCoordinator().createSession(
                      windowId,
                      registrationId,
                      command,
                      authorize
                    )
                }
              : {}),
            // All product Flock catalogs have their own typed native ports.
            allowsFlock: () => false,
            assertCurrent
          }
        },
        send: (windowId, event) => {
          const target = [...productWindows].find(
            (window) => window.webContents.id === windowId && !window.isDestroyed()
          )
          if (!target) throw new WorkspaceMetaIpcError('restart_required')
          target.webContents.send(IPC_PUSH_CHANNELS.workspaceMetaEvent, event)
        }
      })
      return nativeWorkspaceMetaBridge
    }
    const getNativeSessionOwner = async (group: RendererFlockGroup) => {
      if (nativeSessionOwner) return nativeSessionOwner
      if (!nativeSessionOwnerStarting)
        nativeSessionOwnerStarting = (async () => {
          const proof = await loadDesktopNativeSdkCompatibility()
          if (!proof?.setValue) throw new NativeSessionIpcError('unavailable')
          const selected = resolveLocalIndependentRepo({
            platform: 'local',
            dataRoot: getLodyDataDir(mainPlatformKind),
            accountId: group.accountId,
            workspaceId: group.workspaceId
          })
          const host = new IndependentNativeRepoHostLegacy({
            dataDir: selected.dataDir,
            binding: selected.binding,
            ...resolveBundledIndependentRepoLaunch(),
            requiredSdkArtifactId: proof.artifactId
          })
          nativeSessionOwner = new NativeLocalSessionOwnerLegacy({
            accountId: group.accountId,
            workspaceId: group.workspaceId as WorkspaceId,
            dataRoot: getLodyDataDir(mainPlatformKind),
            compatibility: proof,
            host,
            writer: `main-session:${process.pid}`,
            closeTimeoutMs: 5000,
            editingLeaseMs: 30000,
            now: Date.now,
            onBackgroundFailure: () =>
              console.warn('[Native Session] Background operation remains unconfirmed')
          })
          return nativeSessionOwner
        })().finally(() => {
          nativeSessionOwnerStarting = undefined
        })
      return nativeSessionOwnerStarting
    }
    let documentMigrationWindows: RendererDocumentDomainMigrationMainLegacy | undefined
    let documentMigrationDriver: NativeDocumentDomainMigrationLegacy | undefined
    let documentBridge: NativeDocumentDomainsMainLegacy | undefined
    const documentOwners = new Map<
      string,
      { generation: string; owner: ReturnType<typeof createMainNativeDocumentDomainOwner> }
    >()
    const documentScope = async (windowId: number, registrationId: string) => {
      const frame = await assertMetaFrame(windowId, registrationId)
      const metadata = await trustedWorkspaceMeta()
      const dataRoot = getLodyDataDir(mainPlatformKind),
        group = frame.renderer.group
      const selected = resolveLocalIndependentRepo({ platform: 'local', dataRoot, ...group })
      const check = () => {
        frame.check()
        metadata.assertCurrent()
      }
      const route = (target: NativeDocumentDomainTarget) => {
        check()
        return readNativeDocumentDomainRoute(
          {
            accountId: group.accountId,
            workspaceId: group.workspaceId as WorkspaceId,
            journalPath: join(selected.directory, 'document-routes.sqlite3'),
            dataDir: selected.dataDir
          },
          target.domain,
          target.id
        )
      }
      const authorize = async (target: NativeDocumentDomainTarget) => {
        metadata.assertCurrent()
        if (
          !(await metadata
            .document(
              `${target.domain === 'preview_comments' ? 'preview-comment-' : 'schedule-'}${target.id}`
            )
            .read())
        )
          throw new Error('Document metadata unavailable')
        if (
          target.domain === 'preview_comments' &&
          !(await metadata.document(`session-${target.id}`).read())
        )
          throw new Error('Preview parent unavailable')
        metadata.assertCurrent()
      }
      const getClient = async () => {
        metadata.assertCurrent()
        if (!localNativeRepoLease) throw new Error('Native host unavailable')
        const client = await localNativeRepoLease.client(group),
          info = await localNativeRepoLease.leaseInfo(client)
        metadata.assertCurrent()
        return {
          client,
          generation: JSON.stringify([info.engineRunId, info.clientGeneration, info.sdkArtifactId]),
          sdkArtifactId: info.sdkArtifactId ?? ''
        }
      }
      return { frame, metadata, dataRoot, group, selected, check, route, authorize, getClient }
    }
    const nativeDocumentDomainMigration = async (windowId: number, registrationId: string) => {
      const scope = await documentScope(windowId, registrationId)
      if (!documentMigrationWindows)
        documentMigrationWindows = new RendererDocumentDomainMigrationMainLegacy({
          binding: {
            accountId: scope.group.accountId,
            workspaceId: scope.group.workspaceId,
            contentMode: 'plaintext'
          },
          metadataGeneration: scope.metadata.generation,
          creationEnabled: process.env.LODY_NATIVE_DOCUMENT_DOMAINS === '1',
          databasePath: join(
            scope.dataRoot,
            'native-repo',
            'renderer-document-domain-owners.sqlite3'
          ),
          admit: (id, registration) => scope.frame.renderer.assertRegistration(id, registration),
          registeredWindowIds: () =>
            [...productWindows]
              .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
              .map((window) => window.webContents.id),
          readCommittedOwner: (target) => {
            scope.metadata.assertCurrent()
            return readNativeDocumentDomainRoute(
              {
                accountId: scope.group.accountId,
                workspaceId: scope.group.workspaceId as WorkspaceId,
                journalPath: join(scope.selected.directory, 'document-routes.sqlite3'),
                dataDir: scope.selected.dataDir
              },
              target.domain,
              target.id
            )
          },
          assertMetadataCurrent: () => scope.metadata.assertCurrent(),
          authorize: (target) =>
            assertMainNativeDocumentDomainMigrationAuthority({
              metadata: scope.metadata,
              scope: target,
              actorId: scope.group.accountId,
              machineId: cliService.readLocalDataMachineId() ?? undefined,
              creationEnabled: process.env.LODY_NATIVE_DOCUMENT_DOMAINS === '1'
            }),
          send: (id, request) => {
            const target = [...productWindows].find(
              (window) =>
                !window.isDestroyed() &&
                !window.webContents.isDestroyed() &&
                window.webContents.id === id
            )
            if (!target) throw new Error('Document migration participant retired')
            target.webContents.send(IPC_PUSH_CHANNELS.documentDomainMigrationRequest, request)
          }
        })
      return documentMigrationWindows
    }
    const getNativeDocumentMigrationDriver = async (windowId: number, registrationId: string) => {
      const scope = await documentScope(windowId, registrationId)
      const renderer = await nativeDocumentDomainMigration(windowId, registrationId)
      if (!documentMigrationDriver) {
        const compatibility = await loadDesktopNativeSdkCompatibility()
        if (!compatibility) throw new Error('Native SDK unavailable')
        const machineId = cliService.readLocalDataMachineId()
        if (!machineId) throw new Error('Machine identity unavailable')
        const creationEnabled = process.env.LODY_NATIVE_DOCUMENT_DOMAINS === '1'
        let creation: ConstructorParameters<
          typeof NativeDocumentDomainMigrationLegacy
        >[0]['creation']
        if (creationEnabled) {
          const check = () => {
            scope.metadata.assertCurrent()
            const sr = {
              accountId: scope.group.accountId,
              workspaceId: scope.group.workspaceId,
              roomId: `${scope.group.workspaceId}:sr`,
              contentMode: 'plaintext' as const
            }
            if (readNativeWorkspaceFlockOwner(scope.dataRoot, sr) !== 'native')
              throw new Error('Native SR required')
            assertPublishedNativeWorkspaceFlockStorage(scope.dataRoot, sr)
          }
          check()
          const owner = createMainNativeDocumentDomainOwner({
            accountId: scope.group.accountId,
            workspaceId: scope.group.workspaceId as WorkspaceId,
            dataRoot: scope.dataRoot,
            metadata: scope.metadata,
            compatibility,
            assertCurrent: check,
            getClient: scope.getClient
          })
          documentOwners.set('__migration__', { generation: scope.metadata.generation, owner })
          creation = {
            metadata: scope.metadata,
            actorId: scope.group.accountId,
            machineId,
            registry: owner.definitionRegistry,
            authorize: (target, snapshot) => {
              check()
              if (target.domain === 'preview_comments') {
                const parent = snapshot.docs.find(
                  (row) => row.docId === `session-${target.id}` && !row.deleted
                )
                if (
                  !parent ||
                  parent.meta.userId !== scope.group.accountId ||
                  parent.meta.machineId !== machineId
                )
                  throw new Error('Preview parent authority denied')
              }
            }
          }
        }
        documentMigrationDriver = new NativeDocumentDomainMigrationLegacy({
          creation,
          binding: renderer.binding,
          dataRoot: scope.dataRoot,
          compatibility,
          launch: resolveBundledIndependentRepoLaunch(),
          renderer,
          getClient: scope.getClient,
          control: (request) => cliService.controlNativeDocumentDomainMigration(request),
          authorize: scope.authorize,
          assertCurrent: () => scope.metadata.assertCurrent()
        })
      }
      scope.check()
      return documentMigrationDriver
    }
    const migrateNativeDocumentDomain = async (
      windowId: number,
      registrationId: string,
      target: NativeDocumentDomainTarget
    ) => {
      const driver = await getNativeDocumentMigrationDriver(windowId, registrationId)
      await driver.migrate(target)
    }
    const ensureNativePreviewComments = async (
      windowId: number,
      registrationId: string,
      sessionId: import('@lody/shared').SessionId
    ) => {
      if (process.env.LODY_NATIVE_DOCUMENT_DOMAINS !== '1')
        throw new Error('Native document creation disabled')
      const driver = await getNativeDocumentMigrationDriver(windowId, registrationId)
      await driver.ensurePreview(sessionId)
    }
    const createNativeScheduleDefinition = async (
      windowId: number,
      registrationId: string,
      input: Omit<import('@lody/shared').ScheduleSaveInput, 'actorId' | 'create'>
    ) => {
      if (process.env.LODY_NATIVE_DOCUMENT_DOMAINS !== '1')
        throw new Error('Native document creation disabled')
      const driver = await getNativeDocumentMigrationDriver(windowId, registrationId)
      await driver.createSchedule(input)
    }
    const nativeDocumentDomains = async (windowId: number, registrationId: string) => {
      await assertMetaFrame(windowId, registrationId)
      documentBridge ??= new NativeDocumentDomainsMainLegacy({
        route: async (id, registration, target) => {
          const scope = await documentScope(id, registration)
          return scope.route(target)
        },
        acquire: async (id, registration, target) => {
          const scope = await documentScope(id, registration),
            key = JSON.stringify([id, registration])
          const machineId = cliService.readLocalDataMachineId()
          if (!machineId) throw new Error('Machine identity unavailable')
          let entry = documentOwners.get(key)
          if (entry && entry.generation !== scope.metadata.generation) {
            await entry.owner.close()
            documentOwners.delete(key)
            entry = undefined
          }
          if (!entry) {
            const compatibility = await loadDesktopNativeSdkCompatibility()
            if (!compatibility) throw new Error('Native SDK unavailable')
            const check = () => {
              scope.check()
              const sr = {
                accountId: scope.group.accountId,
                workspaceId: scope.group.workspaceId,
                roomId: `${scope.group.workspaceId}:sr`,
                contentMode: 'plaintext' as const
              }
              if (readNativeWorkspaceFlockOwner(scope.dataRoot, sr) !== 'native')
                throw new Error('Native SR unavailable')
              assertPublishedNativeWorkspaceFlockStorage(scope.dataRoot, sr)
            }
            check()
            entry = {
              generation: scope.metadata.generation,
              owner: createMainNativeDocumentDomainOwner({
                accountId: scope.group.accountId,
                workspaceId: scope.group.workspaceId as WorkspaceId,
                dataRoot: scope.dataRoot,
                metadata: scope.metadata,
                compatibility,
                assertCurrent: check,
                getClient: scope.getClient
              })
            }
            documentOwners.set(key, entry)
          }
          const grant = await entry.owner.acquire(target)
          scope.check()
          return {
            ...grant,
            generation: JSON.stringify([registration, scope.metadata.generation]),
            actorId: scope.group.accountId,
            machineId,
            assertCurrent: scope.check
          }
        },
        send: (id, event) => {
          const target = [...productWindows].find(
            (window) =>
              !window.isDestroyed() &&
              !window.webContents.isDestroyed() &&
              window.webContents.id === id
          )
          if (!target) throw new Error('Document participant retired')
          target.webContents.send(IPC_PUSH_CHANNELS.documentDomainsEvent, event)
        }
      })
      return documentBridge
    }
    const closeNativeDocumentDomains = async () => {
      const results = await Promise.allSettled([
        documentBridge?.close(),
        documentMigrationDriver?.close(),
        Promise.resolve().then(() => documentMigrationWindows?.close()),
        ...[...documentOwners.values()].map((entry) => entry.owner.close())
      ])
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (errors.length) throw new AggregateError(errors, 'Document cleanup unconfirmed')
      documentOwners.clear()
    }
    const nativeSessionDomain = () => {
      if (!isLocalPlatform()) return null
      const snapshots = nativeSessionSnapshots
      nativeSessionBridge ??= new NativeSessionMainLegacy({
        retireSnapshots: (windowId, registrationId) =>
          registrationId
            ? snapshots.retireRegistration(registrationId)
            : snapshots.retireWindow(windowId),
        closeSnapshots: () => snapshots.close(),
        route: async (windowId, registrationId, sessionId) => {
          let phase: 'authority' | 'read-route' | 'ensure-body' | 'read-committed' = 'authority'
          try {
            const frame = await assertMetaFrame(windowId, registrationId)
            phase = 'read-route'
            let owner = readLocalNativeSessionRoute(
              {
                accountId: frame.renderer.group.accountId,
                workspaceId: frame.renderer.group.workspaceId as WorkspaceId,
                dataRoot: getLodyDataDir(mainPlatformKind)
              },
              `session-${sessionId}`
            )
            frame.check()
            if (owner !== 'legacy' || process.env.LODY_NATIVE_SESSION_BODY === '1') {
              phase = 'ensure-body'
              await sessionMigrationCoordinator().ensureMigrated(
                windowId,
                registrationId,
                sessionId
              )
              frame.check()
              phase = 'read-committed'
              owner = readLocalNativeSessionRoute(
                {
                  accountId: frame.renderer.group.accountId,
                  workspaceId: frame.renderer.group.workspaceId as WorkspaceId,
                  dataRoot: getLodyDataDir(mainPlatformKind)
                },
                `session-${sessionId}`
              )
            }
            return { owner }
          } catch (error) {
            // Fixed local diagnostics only; never log IDs, metadata, text or raw causes.
            const reasons: Record<string, string> = {
              'Existing Loro Session metadata unavailable': 'metadata_unavailable',
              'Exact CLI Session migration authority unavailable': 'cli_authority_unavailable',
              'Session migration coordinator retired': 'coordinator_retired'
            }
            const reason =
              error instanceof Error && Object.hasOwn(reasons, error.message)
                ? reasons[error.message]
                : undefined
            const sqlite =
              error && typeof error === 'object' && 'errcode' in error
                ? error.errcode === 5
                  ? 'busy'
                  : error.errcode === 6
                    ? 'locked'
                    : 'none'
                : 'none'
            console.warn('Native Session main route failed', {
              phase,
              reason: reason ?? 'other',
              sqlite
            })
            throw error
          }
        },
        acquire: async (windowId, registrationId, sessionId) => {
          const frame = await assertMetaFrame(windowId, registrationId)
          const metadata = await trustedWorkspaceMeta()
          frame.check()
          const owner = await getNativeSessionOwner(frame.renderer.group)
          frame.check()
          const check = () => {
            frame.check()
            metadata.assertCurrent()
            if (
              readLocalNativeSessionRoute(
                {
                  accountId: frame.renderer.group.accountId,
                  workspaceId: frame.renderer.group.workspaceId as WorkspaceId,
                  dataRoot: getLodyDataDir(mainPlatformKind)
                },
                `session-${sessionId}`
              ) !== 'native'
            )
              throw new NativeSessionIpcError('restart_required')
          }
          check()
          return acquireNativeSessionDomainGrant({
            factory: owner.factory,
            metadata,
            sessionId,
            scopeGeneration: JSON.stringify([registrationId, frame.revision, metadata.generation]),
            principalId: frame.renderer.group.accountId,
            snapshots,
            snapshotRealm: JSON.stringify([
              registrationId,
              frame.revision,
              frame.renderer.group.workspaceId
            ]),
            snapshotScope: { windowId, registrationId },
            assertCurrent: check
          })
        },
        send: (id, event) => {
          const target = [...productWindows].find(
            (value) =>
              !value.isDestroyed() &&
              !value.webContents.isDestroyed() &&
              value.webContents.id === id
          )
          if (!target) throw new NativeSessionIpcError('restart_required')
          target.webContents.send(IPC_PUSH_CHANNELS.nativeSessionEvent, event)
        }
      })
      return nativeSessionBridge
    }
    const closeNativeSessions = async () => {
      const failures: unknown[] = []
      try {
        await nativeSessionBridge?.close()
      } catch (error) {
        failures.push(error)
      }
      try {
        await nativeSessionMigrationCoordinator?.close()
      } catch (error) {
        failures.push(error)
      }
      const verifierResults = await Promise.allSettled(
        [...sessionMigrationVerifiers].map(async (verifier) => {
          await verifier.close()
          sessionMigrationVerifiers.delete(verifier)
        })
      )
      failures.push(
        ...verifierResults.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        )
      )
      await nativeSessionOwnerStarting?.catch(() => {})
      try {
        await nativeSessionOwner?.close()
      } catch (error) {
        failures.push(error)
      }
      nativeSessionSnapshots.close()
      if (failures.length) throw new AggregateError(failures, 'Session cleanup remains unconfirmed')
    }
    const closeRendererMigrations = async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => rendererWfMigration?.close()),
        Promise.resolve().then(() => rendererMfMigration?.close()),
        Promise.resolve().then(() => rendererSrMigration?.close()),
        Promise.resolve().then(() => rendererMetaMigration?.close())
      ])
      const failures = results.flatMap((value) =>
        value.status === 'rejected' ? [value.reason] : []
      )
      if (failures.length)
        throw new AggregateError(failures, 'Renderer migration owner release failed')
    }
    const closeNativeData = async () => {
      const [
        catalog,
        data,
        upgrade,
        machine,
        machineUpgrade,
        schedule,
        scheduleUpgrade,
        meta,
        metaUpgrade,
        sessions,
        publicMeta,
        providerVerification,
        bodyMigration,
        documentDomains,
        cloudFileIndexes
      ] = await Promise.allSettled([
        nativeCatalog?.close(),
        localNativeRepoLease?.close(),
        nativeCatalogUpgrade?.close(),
        nativeMachineCatalogBridge?.close(),
        nativeMachineCatalogUpgrade?.close(),
        nativeScheduleRegistryBridge?.close(),
        nativeScheduleRegistryUpgrade?.close(),
        nativeMetaOwner?.close(),
        nativeMetaUpgrade?.close(),
        closeNativeSessions(),
        nativeWorkspaceMetaBridge?.close(),
        nativeMachineCatalogVerifier?.close(),
        sessionBodyMigration?.close(),
        closeNativeDocumentDomains(),
        closeCloudFileIndexes()
      ])
      const errors: unknown[] = data.status === 'rejected' ? [data.reason] : []
      if (upgrade.status === 'rejected') errors.push(upgrade.reason)
      if (machineUpgrade.status === 'rejected') errors.push(machineUpgrade.reason)
      if (scheduleUpgrade.status === 'rejected') errors.push(scheduleUpgrade.reason)
      if (metaUpgrade.status === 'rejected') errors.push(metaUpgrade.reason)
      if (publicMeta.status === 'rejected') errors.push(publicMeta.reason)
      if (bodyMigration.status === 'rejected') errors.push(bodyMigration.reason)
      if (documentDomains.status === 'rejected') errors.push(documentDomains.reason)
      if (cloudFileIndexes.status === 'rejected') errors.push(cloudFileIndexes.reason)
      if (providerVerification.status === 'rejected') {
        try {
          await nativeMachineCatalogVerifier?.retryCleanup()
          await nativeMachineCatalogVerifier?.close()
        } catch (retry) {
          errors.push(providerVerification.reason, retry)
        }
      }
      if (sessions.status === 'rejected') {
        try {
          await closeNativeSessions()
        } catch (retry) {
          errors.push(sessions.reason, retry)
        }
      }
      if (meta.status === 'rejected') {
        try {
          await nativeMetaOwner?.close()
        } catch (retry) {
          errors.push(meta.reason, retry)
        }
      }
      if (schedule.status === 'rejected') {
        try {
          await nativeScheduleRegistryBridge?.close()
        } catch (retry) {
          errors.push(schedule.reason, retry)
        }
      }
      if (machine.status === 'rejected') {
        try {
          await nativeMachineCatalogBridge?.close()
        } catch (retry) {
          errors.push(machine.reason, retry)
        }
      }
      if (catalog.status === 'rejected') {
        // Closing the borrowed SDK connection can supply the release proof which
        // a failed unsubscribe could not obtain. Retry that exact retained owner.
        try {
          await nativeCatalog?.close()
        } catch (retry) {
          errors.push(catalog.reason, retry)
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'Desktop native catalog/data cleanup failed')
    }
    const bindMigrationRetirement = (window: BrowserWindow) => {
      const contents = window.webContents
      const id = contents.id
      const retire = () => {
        void cloudFileIndexBridge
          ?.retire(id)
          .catch(() => console.error('[Cloud file index] Window release unconfirmed'))
        for (const migration of [
          rendererWfMigration,
          rendererMfMigration,
          rendererSrMigration,
          rendererMetaMigration
        ]) {
          try {
            migration?.windowClosed(id)
          } catch {
            console.error('[Native data] Renderer retirement persistence failed')
          }
        }
        sessionBodyMigration?.windowClosed(id)
        documentMigrationWindows?.windowClosed(id)
        for (const key of documentOwners.keys()) {
          if (key === '__migration__') continue
          const [ownerWindowId, registrationId] = JSON.parse(key) as [number, string]
          if (ownerWindowId === id) {
            const entry = documentOwners.get(key)
            void (async () => {
              await documentBridge?.retire(id, registrationId)
              await entry?.owner.close()
              if (documentOwners.get(key) === entry) documentOwners.delete(key)
            })().catch(() => console.error('[Native documents] Window release unconfirmed'))
          }
        }
        void nativeWorkspaceMetaBridge
          ?.retire(id)
          .catch(() => console.error('[Native Meta] Window release remains unconfirmed'))
        void nativeSessionBridge
          ?.retire(id)
          .catch(() => console.error('[Native Session] Window release remains unconfirmed'))
        void nativeScheduleRegistryBridge
          ?.retire(id)
          .catch(() => console.error('[SR registry] Window release remains unconfirmed'))
        void nativeMachineCatalogBridge
          ?.retire(id)
          .catch(() => console.error('[MF catalog] Window release remains unconfirmed'))
        void nativeCatalog?.retire(id).catch(() => {
          console.error('[Native catalog] Window release remains unconfirmed')
        })
      }
      window.once('closed', retire)
      contents.on('render-process-gone', retire)
      contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) retire()
      })
    }
    for (const window of productWindows) bindMigrationRetirement(window)
    app.on('browser-window-created', (_event, window) => bindMigrationRetirement(window))

    const appUpdaterService = new AppUpdaterService({
      enabled: shouldConstructUpdaterEnabled({
        localPlatform: isLocalPlatform(),
        forceEnable: process.env.LODY_ELECTRON_ENABLE_UPDATER === '1'
      })
    })
    const notificationService = new NotificationService(() => getMainWindow())
    const windowsTrayService = new WindowsTrayService({
      iconPath: icon,
      productName: PRODUCT_NAME,
      openOrFocusMainWindow: () => openOrFocusMainWindow({ icon })
    })
    const windowBadgeService = new WindowBadgeService()
    const publicBrowserService = new PublicBrowserService(() => getMainWindow())
    bindWindowBadgeToBrowserWindows(windowBadgeService)

    if (!isLocalPlatform() && !safeStorage.isEncryptionAvailable()) {
      const isLinux = process.platform === 'linux'
      const hint = isLinux
        ? 'gnome-libsecret was already configured automatically. ' +
          'Ensure gnome-keyring-daemon is running, or try launching with ' +
          '--password-store=kwallet5 or --password-store=basic'
        : 'Check that your OS keychain is configured and accessible.'
      console.warn(
        `[Auth] safeStorage encryption is not available. Authentication may fail. ${hint}`
      )
    }

    electronApp.setAppUserModelId(desktopInstallationProfile.desktopAppId)
    const globalShortcutsService = createGlobalShortcutsService(icon)
    globalShortcutsService.registerAll()
    app.once('will-quit', () => globalShortcutsService.dispose())
    app.on('browser-window-created', (_, window) => {
      // Keep Electron's native Cmd/Ctrl zoom shortcuts available. The toolkit
      // blocks Minus and shifted Equal by default when zoom is not enabled.
      optimizer.watchWindowShortcuts(window, { zoom: true })
      // electron-toolkit deliberately blocks the production reload shortcut.
      // Restore the normal desktop-app behavior requested by the user while
      // routing both reload shortcuts through the renderer reload path.
      window.webContents.on('before-input-event', (event, input) => {
        if (isRendererReloadShortcut(input, process.platform)) {
          event.preventDefault()
          requestRendererReload(window, { ignoreCache: input.shift })
        }
      })
    })

    const completeOnboarding = (window: BrowserWindow): void => {
      markOnboardingCompleted()
      setMainWindowProductReloadTarget(window)
    }
    const restartOnboarding = (window: BrowserWindow): void => {
      resetOnboardingCompleted()
      setMainWindowOnboardingReloadTarget(window)
      requestRendererReload(window)
    }
    const ipcDeps = {
      appIconService,
      cliService,
      appUpdaterService,
      authService,
      cloudFileIndex,
      prepareCloudFileIndex,
      notificationService,
      terminalRelay,
      publicBrowserService,
      storageGuard,
      loroDataPlaneRelay,
      localNativeRepoLease,
      rendererWorkspaceFlockMigration,
      nativeWorkspaceCatalog,
      rendererMachineFlockMigration,
      nativeMachineCatalog,
      migrateNativeMachineCatalog,
      rendererWorkspaceMetaMigration,
      migrateNativeWorkspaceMeta,
      rendererScheduleRegistryMigration,
      nativeScheduleRegistry,
      nativeSessionDomain,
      nativeDocumentDomains,
      nativeDocumentDomainMigration,
      migrateNativeDocumentDomain,
      ensureNativePreviewComments,
      createNativeScheduleDefinition,
      nativeWorkspaceMeta,
      nativeSessionBodyMigration,
      retireNativeSessionBodyMigration: (windowId, registrationId) => {
        sessionBodyMigration?.retire(windowId, registrationId)
        documentMigrationWindows?.retire(windowId, registrationId)
        const key = JSON.stringify([windowId, registrationId]),
          entry = documentOwners.get(key)
        void (async () => {
          await documentBridge?.retire(windowId, registrationId)
          await entry?.owner.close()
          if (documentOwners.get(key) === entry) documentOwners.delete(key)
        })().catch(() => console.error('[Native documents] Registration release unconfirmed'))
      },
      migrateNativeScheduleRegistry,
      migrateNativeWorkspaceCatalog,
      windowBadgeService,
      globalShortcutsService,
      getMainWindow,
      completeOnboarding,
      restartOnboarding,
      reloadMainWindowForDevbar
    }
    registerIpcServices(ipcDeps)

    setupApplicationMenu({
      appUpdaterService,
      getMainWindow,
      openOrFocusMainWindow: () => openOrFocusMainWindow({ icon })
    })
    const initialPath = getInitialDesktopPath()
    const loginItemSettings = getAutoLaunchInvocationStatus()
    const hideWindowOnAutoLaunch = shouldHideMainWindowOnAutoLaunch({
      preferenceEnabled: getHideWindowOnAutoLaunchEnabled(),
      launchedAtLogin: loginItemSettings.launchedAtLogin,
      initialPath,
      hasInitialDeepLink: Boolean(extractDeepLinkFromArgv(process.argv))
    })
    recordE2EBootDiagnostic('opening-main-window')
    openMainWindow({ icon, initialPath, hideWindowOnAutoLaunch })
    recordE2EBootDiagnostic('main-window-opened')
    // Startup notification delivery never gates rendering or a subsequent quit.
    void reportPreviousUnconfirmedDesktopQuit(app.getPath('userData'), () => {
      if (isAppQuitting()) return Promise.resolve({ shown: false })
      return notificationService.showQuitWarning({
        title: translateAppText('desktop.quitUnconfirmed.title'),
        body: translateAppText('desktop.quitUnconfirmed.detail')
      })
    }).catch(() => console.warn('[Electron] Previous quit warning remains pending'))
    // Warmup is off by default and only enabled from Developer mode. When it is
    // enabled, session-windows primes the spare after an auxiliary request so
    // ordinary single-window sessions never pay an idle renderer cost.
    onProductWindowMessage(IPC_SEND_CHANNELS.appWindowReady, (event) =>
      handleWindowWarmReady(event.sender.id)
    )
    onProductWindowMessage(IPC_SEND_CHANNELS.appPreparedWindowState, (event, state) => {
      if (event.senderFrame === event.sender.mainFrame)
        handlePreparedWindowState(event.sender.id, state)
    })
    onProductWindowMessage(IPC_SEND_CHANNELS.appWindowContentReady, (event, target) => {
      if (event.senderFrame === event.sender.mainFrame)
        handleWindowContentReady(event.sender.id, target)
    })
    console.info('[Electron] Initial desktop surface selected', {
      initialPath,
      hideWindowOnAutoLaunch
    })
    setWindowsTrayAvailable(windowsTrayService.start())
    cliService.autoStart(getMainWindow()?.webContents ?? undefined)
    appUpdaterService.start()

    let quitRecoveryOnly = false
    app.on('activate', () => {
      if (quitRecoveryOnly) return
      const windows = BrowserWindow.getAllWindows()
      if (windows.length === 0) {
        openMainWindow({ icon })
        return
      }
      openOrFocusMainWindow({ icon })
    })

    const unconfirmedQuitResources = new Set<string>()
    const beforeQuit = createDesktopQuitBarrier({
      // Every renderer approves unload (closing its window) before anything is
      // torn down, so a Stay answer leaves relays and the CLI running.
      prepare: () => closeProductWindowsForQuit(() => unconfirmedQuitResources.add('renderer')),
      stop: async () => {
        setAppQuitting(true)
        setWindowsTrayAvailable(false)
        windowsTrayService.stop()
        windowBadgeService.reset()
        terminalRelay.destroy()
        loroDataPlaneRelay.destroy()
        appUpdaterService.stop()
        publicBrowserService.destroyAll()
        const [cliResult, shellResult, dataResult, migrationResult] = await Promise.allSettled([
          cliService.shutdownForQuit(),
          applicationRuntime.closeLegacy(),
          closeNativeData(),
          closeRendererMigrations(),
          drainMainProcessQuitResources(
            [
              { name: 'e2ee', close: () => closeDesktopE2eeAccount({ quit: true }) },
              { name: 'error-reporting', close: flushElectronMainErrorReporting },
              { name: 'devbar', close: stopDevbarDevframeService }
            ],
            15_000,
            (resource, state) => console.info('[Electron] Quit resource', { resource, state })
          ).then((unconfirmed) => {
            for (const resource of unconfirmed) unconfirmedQuitResources.add(resource)
          })
        ])
        const failures = [cliResult, shellResult, dataResult, migrationResult].flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        )
        if (failures.length > 0)
          throw new AggregateError(failures, 'Desktop resource cleanup failed')
      },
      quit: () => {
        if (unconfirmedQuitResources.size === 0) {
          app.quit()
          return
        }
        // Only main-owned work may end at process termination. The CLI and shell
        // process owners above must first confirm release; never orphan them.
        cancelRequestedRelaunch()
        // A second menu/dock Quit while marker I/O is pending must not replace
        // the nonzero terminal exit.
        app.on('before-quit', (event) => event.preventDefault())
        console.error('[Electron] Quit persistence unconfirmed', {
          resources: [...unconfirmedQuitResources]
        })
        // No shutdown UI, including update installation and OS shutdown/logout.
        void finishUnconfirmedDesktopQuit({
          record: () => recordUnconfirmedDesktopQuit(app.getPath('userData')),
          exit: (code) => app.exit(code)
        })
      },
      recover: async () => {
        // One bounded owner retry before rebuilding services, never a second live CLI.
        const retried = await waitForQuitRecovery(
          Promise.allSettled([
            cliService.shutdownForQuit(),
            applicationRuntime.closeLegacy(),
            closeNativeData(),
            closeRendererMigrations(),
            closeDesktopE2eeAccount({ quit: true })
          ])
        )
        if (!retried || retried.some((result) => result.status === 'rejected')) return false
        if (!applicationRuntime.isReleased()) return false
        if (!isLocalPlatform()) await recoverInstalledDesktopNativeDataPlatformLegacy()
        applicationRuntime = createShellRuntime()
        cloudNativePlatform = null
        cloudFileIndexBridge = createCloudFileIndexBridge()
        localNativeRepoLease = createLocalDataLease()
        nativeCatalog = undefined
        nativeMetaUpgrade = undefined
        nativeMetaOwner = undefined
        sessionBodyMigration = undefined
        nativeMachineCatalogVerifier = undefined
        nativeWorkspaceMetaBridge = undefined
        nativeSessionBridge = undefined
        nativeSessionOwner = undefined
        nativeSessionMigrationCoordinator = undefined
        documentMigrationWindows = undefined
        documentMigrationDriver = undefined
        documentBridge = undefined
        nativeSessionSnapshots = new NativeSessionSnapshotRegistry()
        rendererMetaMigration = undefined
        nativeScheduleRegistryBridge = undefined
        nativeScheduleRegistryUpgrade = undefined
        rendererSrMigration?.close()
        rendererSrMigration = undefined
        nativeMachineCatalogBridge = undefined
        nativeMachineCatalogUpgrade = undefined
        rendererMfMigration?.close()
        rendererMfMigration = undefined
        nativeCatalogUpgrade = undefined
        rendererWfMigration?.close()
        rendererWfMigration = undefined
        ipcDeps.localNativeRepoLease = localNativeRepoLease
        bindUserShellEnvCacheLegacy(applicationRuntime)
        terminalRelay = new TerminalRelay(getLocalTerminalSocketPath(mainPlatformKind))
        loroDataPlaneRelay = new LoroDataPlaneRelay(() => {
          const run = readLocalDaemonRunFile(getLocalDaemonRunFilePath(mainPlatformKind))
          if (!run.token || !run.dataPlaneSocketPath)
            throw new Error('local_ipc_credentials_missing')
          return { socketPath: run.dataPlaneSocketPath, token: run.token }
        })
        loroDataPlaneRelay.setEnabled(cliService.getCliAutoStartEnabled())
        ipcDeps.terminalRelay = terminalRelay
        ipcDeps.loroDataPlaneRelay = loroDataPlaneRelay
        quitRecoveryOnly = false
        setAppQuitting(false)
        setWindowsTrayAvailable(windowsTrayService.start())
        appUpdaterService.start()
        resumeDesktopE2eeAccount()
        cliService.autoStart(undefined)
        openOrFocusMainWindow({ icon })
        return true
      },
      reportFailure: (error, recovered) => {
        // A timeout does not prove exit. Keep ownership until quit succeeds.
        console.error('[Electron] Quit blocked by owned resources', error)
        if (recovered) return
        quitRecoveryOnly = true
        // Both actions re-enter the ownership barrier; neither force-exits a live owner.
        dialog.showMessageBoxSync({
          type: 'error',
          title: PRODUCT_NAME,
          message: translateAppText('Lody could not fully quit. Please restart Lody.'),
          buttons: [translateAppText('desktop.unloadConfirm.quit'), translateAppText('Retry quit')],
          defaultId: 1,
          cancelId: 1
        })
        queueMicrotask(() => app.quit())
      },
      cancelled: () => {
        unconfirmedQuitResources.clear()
        resumeDesktopE2eeAccount()
        cancelRequestedRelaunch()
      }
    })
    app.on('will-quit', relaunchIfRequested)
    app.on('before-quit', (event) => {
      void beforeQuit(event)
    })

    process.on('exit', () => {
      setWindowsTrayAvailable(false)
      windowsTrayService.stop()
      terminalRelay.destroy()
      loroDataPlaneRelay.destroy()
      cliService.killAllProcesses()
      appUpdaterService.stop()
      publicBrowserService.destroyAll()
    })
  })
  void appReady.catch(async (error: unknown) => {
    recordE2EBootDiagnostic('failed', error)
    console.error('[Electron] Fatal error while creating the main window', error)
    try {
      await applicationRuntime.closeLegacy()
    } catch (cleanupError) {
      console.error('[Electron] Startup resource cleanup failed', cleanupError)
    }
    if (!IS_E2E) app.exit(1)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

// The entry retains launch events while it acquires ownership and loads this module.
export function handleDesktopLaunch(event: DesktopLaunchEvent): void {
  if (event.url) handleDeepLink(event.url)
  if (event.activate) {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) openOrFocusMainWindow({ icon })
  }
}

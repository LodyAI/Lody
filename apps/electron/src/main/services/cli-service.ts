import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { totalmem } from 'node:os'
import { basename, join, resolve as resolvePath } from 'node:path'
import { app, powerSaveBlocker, type WebContents } from 'electron'
import { Effect } from 'effect'
import { isLocalSessionControlRequest } from '@lody/shared/node/local-session-control'
import { isLocalProjectControlRequest } from '@lody/shared/node/local-project-control'
import {
  CLI_EXIT_CODE_AUTH_FAILURE,
  CLI_EXIT_CODE_RETRYABLE_STARTUP,
  CLI_EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH,
  LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION,
  LODY_SUPERVISOR_CONTRACT_ENV,
  LODY_SUPERVISOR_INSTANCE_ID_ENV,
  LODY_SUPERVISOR_PID_ENV,
  LODY_SUPERVISOR_TOKEN_ENV
} from '@lody/shared/node/local-cli-supervisor'
import {
  acquireLocalCliHostLease,
  getLocalCliHostEndpoint,
  inspectLocalCliHost,
  type LocalCliHostLease
} from '@lody/shared/node/local-cli-host-lease'
import {
  LocalMachineRpcRequestSchema,
  type LocalMachineRpcRequest
} from '@lody/shared/local-machine-rpc'
import {
  getLocalDaemonRunFilePath,
  makeLocalControlClientAuto,
  makeLocalProbeClientAuto
} from '@lody/shared/node/local-ipc'
import { getLodyDataDir } from '@lody/shared/node/installation-profile'
import { ACP_CAPABILITIES_REFRESH_CLIENT_BACKSTOP_MS } from '@lody/shared/acp-startup-budget'
import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalSessionControlRequest,
  LocalSessionControlResponse
} from '@lody/shared/message'
import type {
  ElectronCliState,
  RestartCliResult,
  SendLocalMachineRpcResult,
  SendLocalProjectControlResult,
  SendLocalSessionControlResult,
  TerminateCliResult
} from '@lody/shared/electron-ipc'
import {
  appendOutputTail,
  calculateWorkerMaxOldSpaceMiB,
  CliSupervisor,
  formatCommandForDisplay,
  isV8OutOfMemoryExit,
  type LaunchHandle,
  type PreparedLaunch
} from '@lody/cli-supervisor'
import type { BootstrapSession } from './auth-service'
import { isLocalPlatform, mainPlatformKind } from '../platform'
import { getUserShellEnvCached, shouldUseWindowsShell } from './shell-env'
import { applyProxyEnvFallback, resolveSystemProxyEnv } from './system-proxy-env'
import type { CliOutputEvent, CliRunResult } from '../types'

const CLI_OUTPUT_BUFFER_MAX_EVENTS = 2000
// How long to wait for the embedded CLI to exit on SIGTERM during app quit before
// force-killing it. Kept short so Command+Q feels responsive; with the CLI's own
// fast socket teardown a clean exit normally lands well under this.
const CLI_QUIT_GRACE_MS = 3000
const CLI_ELECTRON_BOOTSTRAP_ENV = 'LODY_ELECTRON_BOOTSTRAP'
const CLI_ELECTRON_SESSION_TOKEN_ENV = 'LODY_ELECTRON_SESSION_TOKEN'
// See apps/cli/src/commands/start.ts:ELECTRON_SESSION_USER_ID_ENV for rationale.
const CLI_ELECTRON_SESSION_USER_ID_ENV = 'LODY_ELECTRON_SESSION_USER_ID'
const LOCAL_SESSION_CONTROL_TIMEOUT_MS = 10_000
// The machine owns this deadline and answers with its own failure reason. This
// is only a backstop for a daemon that died without replying, so it is derived
// from the machine's worst case rather than set to a second, smaller number:
// a 120s socket timeout here expired requests the CLI was still working on
// (a cold `npx` init alone may run 300s) and reported them as our timeout.
const LOCAL_SESSION_CONTROL_ACP_REFRESH_TIMEOUT_MS = ACP_CAPABILITIES_REFRESH_CLIENT_BACKSTOP_MS
// Downloading + unpacking a registry agent binary can take minutes on a slow
// link, so the local-control request must outlive the default before falling
// back to Streams RPC.
const LOCAL_SESSION_CONTROL_BINARY_INSTALL_TIMEOUT_MS = 300_000
// Local file handoff hashes + copies up to 8 files (≤100 MB each) into the blob
// store before responding; give it well beyond the default 10s.
const LOCAL_SESSION_CONTROL_FILE_SEND_LOCAL_TIMEOUT_MS = 120_000
const LOCAL_PROJECT_CONTROL_TIMEOUT_MS = 20_000
const LOCAL_PROJECT_CONTROL_LIST_FILES_TIMEOUT_MS = 120_000
const LOCAL_PROBE_TIMEOUT_MS = 3000
const LODY_DATA_DIR = getLodyDataDir(mainPlatformKind)
const LOCAL_DAEMON_RUN_FILE = getLocalDaemonRunFilePath(mainPlatformKind)
const LOCAL_CLI_HOST_ENDPOINT = getLocalCliHostEndpoint(mainPlatformKind)
const CLI_CREDENTIALS_PATH = join(LODY_DATA_DIR, 'credentials.json')
const ELECTRON_SETTINGS_PATH = join(LODY_DATA_DIR, 'electron-settings.json')
const BUNDLED_CLI_ENTRY_FILE = 'index.js'

type CliRunOptions = {
  envOverrides?: NodeJS.ProcessEnv
  maxOldSpaceMiB?: number
  signal?: AbortSignal
  supervisorControl?: {
    instanceId: string
    token: string
  }
  onSpawn?: (child: ChildProcess) => void
  onClose?: (payload: {
    child: ChildProcess
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }) => void
}

type MachineIdLookupOptions = {
  forceRefresh?: boolean
}

type CliServiceOptions = {
  resolveBootstrapSession?: () => Promise<BootstrapSession | null>
}

function resolveLocalProjectControlTimeoutMs(type: LocalProjectControlRequest['type']): number {
  if (
    type === 'local-project/list-files' ||
    type === 'local-project/list-skills' ||
    type === 'local-project/list-global-skills' ||
    type === 'worktree/list-files' ||
    type === 'local-project/sync-history' ||
    type === 'local-project/import-history' ||
    type === 'local-project/resolve-history-conflict'
  ) {
    return LOCAL_PROJECT_CONTROL_LIST_FILES_TIMEOUT_MS
  }
  return LOCAL_PROJECT_CONTROL_TIMEOUT_MS
}

function resolveLocalSessionControlTimeoutMs(type: LocalSessionControlRequest['type']): number {
  if (type === 'machine/acp-capabilities-refresh') {
    return LOCAL_SESSION_CONTROL_ACP_REFRESH_TIMEOUT_MS
  }
  if (type === 'machine/acp-authenticate') {
    return LOCAL_SESSION_CONTROL_BINARY_INSTALL_TIMEOUT_MS
  }
  if (type === 'machine/acp-binary-install') {
    return LOCAL_SESSION_CONTROL_BINARY_INSTALL_TIMEOUT_MS
  }
  if (type === 'session/file-send-local') {
    return LOCAL_SESSION_CONTROL_FILE_SEND_LOCAL_TIMEOUT_MS
  }
  return LOCAL_SESSION_CONTROL_TIMEOUT_MS
}

function resolveBundledCliEntry(): string | null {
  const packagedEntry = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'resources',
    'cli',
    BUNDLED_CLI_ENTRY_FILE
  )
  if (fs.existsSync(packagedEntry)) {
    return packagedEntry
  }

  const repoRoot = resolveRepoRoot()
  if (repoRoot) {
    const repoEmbeddedEntry = join(
      repoRoot,
      'apps',
      'electron',
      'resources',
      'cli',
      BUNDLED_CLI_ENTRY_FILE
    )
    if (fs.existsSync(repoEmbeddedEntry)) {
      return repoEmbeddedEntry
    }

    const repoDistEntry = join(repoRoot, 'apps', 'cli', 'dist', BUNDLED_CLI_ENTRY_FILE)
    if (fs.existsSync(repoDistEntry)) {
      return repoDistEntry
    }
  }

  const devEntry = join(app.getAppPath(), 'resources', 'cli', BUNDLED_CLI_ENTRY_FILE)
  if (fs.existsSync(devEntry)) {
    return devEntry
  }

  return null
}

function resolveBundledCliRuntime(): string {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return process.execPath
  }

  const executableName = basename(process.execPath)
  const helperExecutable = `${executableName} Helper`
  // Use Electron's signed helper for the packaged CLI so macOS does not create
  // a transient Dock tile for the foreground Lody.app executable.
  const helperPath = resolvePath(
    process.resourcesPath,
    '..',
    'Frameworks',
    `${helperExecutable}.app`,
    'Contents',
    'MacOS',
    helperExecutable
  )

  if (fs.existsSync(helperPath)) {
    return helperPath
  }

  console.warn(
    `[embedded-cli] macOS helper executable not found, falling back to ${process.execPath}`
  )
  return process.execPath
}

function resolveRepoRoot(): string | null {
  let candidate = app.getAppPath()
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(join(candidate, 'pnpm-workspace.yaml'))) {
      return candidate
    }

    const parent = resolvePath(candidate, '..')
    if (parent === candidate) {
      break
    }
    candidate = parent
  }

  return null
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw new DOMException('CLI launch preparation was canceled', 'AbortError')
}

function assignEnvIfPresent(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  const trimmed = value?.trim()
  if (trimmed) {
    env[key] = trimmed
  }
}

function buildCliRuntimeEnvOverrides(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // The public source is shared by local and cloud composition roots. Make
    // the selected platform explicit because the standalone source defaults
    // to local when no selector is present.
    LODY_PLATFORM: mainPlatformKind
  }

  if (isLocalPlatform()) {
    env.LODY_DATA_DIR = LODY_DATA_DIR
    return env
  }

  assignEnvIfPresent(env, 'LODY_AUTH_URL', import.meta.env.VITE_CONVEX_DEPLOY_URL)
  assignEnvIfPresent(env, 'LODY_AUTH_SITE_URL', import.meta.env.VITE_CONVEX_SITE_URL)
  assignEnvIfPresent(env, 'LODY_SERVER_URL', import.meta.env.VITE_SERVER_URL)
  assignEnvIfPresent(env, 'SITE_URL', import.meta.env.VITE_SITE_URL)

  return env
}

function buildSystemProxyProbeUrls(): string[] {
  const urls = new Set<string>(['https://registry.npmjs.org'])
  if (!isLocalPlatform()) {
    const serverUrl = import.meta.env.VITE_SERVER_URL?.trim()
    if (serverUrl) {
      urls.add(serverUrl)
    }
  }
  return [...urls]
}

function readElectronSettings(): Record<string, unknown> {
  try {
    if (!fs.existsSync(ELECTRON_SETTINGS_PATH)) {
      return {}
    }
    const raw = fs.readFileSync(ELECTRON_SETTINGS_PATH, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeElectronSettings(settings: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(LODY_DATA_DIR)) {
      fs.mkdirSync(LODY_DATA_DIR, { recursive: true })
    }
    fs.writeFileSync(ELECTRON_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8')
  } catch {
    // best effort
  }
}

function readMachineIdFromCliCredentials(): string | null {
  try {
    if (!fs.existsSync(CLI_CREDENTIALS_PATH)) {
      return null
    }

    const raw = fs.readFileSync(CLI_CREDENTIALS_PATH, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const machine = (parsed as { machine?: unknown }).machine
    if (!machine || typeof machine !== 'object') {
      return null
    }

    const machineId = (machine as { machineId?: unknown }).machineId
    if (typeof machineId !== 'string' || !machineId.trim()) {
      return null
    }

    return machineId
  } catch {
    return null
  }
}

export class CliService {
  private readonly trackedCliChildren = new Set<ChildProcess>()
  private autoStartSender: WebContents | undefined
  private readonly cliOutputBuffer: CliOutputEvent[] = []
  private readonly cliStateSenders = new Set<WebContents>()
  private cliState: ElectronCliState = {
    phase: 'stopped',
    desiredState: 'stopped',
    localAgentEnabled: true,
    updatedAtMs: Date.now(),
    preventSleepEnabled: true
  }
  private cachedMachineId: string | null = null
  // Reused across requests: the clients cache the resolved socket path, so
  // constructing one per call would re-read + re-parse the daemon run file on
  // every request (the renderer data-plane poll issues these continuously).
  private readonly localProbeClient = makeLocalProbeClientAuto({
    runFilePath: LOCAL_DAEMON_RUN_FILE
  })
  private readonly localControlClient = makeLocalControlClientAuto({
    runFilePath: LOCAL_DAEMON_RUN_FILE
  })
  private readonly resolveBootstrapSession: (() => Promise<BootstrapSession | null>) | undefined
  private preventSleepEnabled = true
  // When false, the desktop shell never auto-launches the embedded CLI: it runs
  // purely as a control UI for agents on other machines. Persisted so the choice
  // survives restarts. Defaults to true to preserve the "runs the CLI" behavior.
  private cliAutoStartEnabled = true
  private powerSaveBlockerId: number | null = null
  private supervisor: CliSupervisor | null = null
  private readonly supervisorInstanceId = randomUUID()
  private readonly supervisorToken = `${randomUUID()}${randomUUID()}`
  private hostLease: LocalCliHostLease | null = null

  constructor(options: CliServiceOptions = {}) {
    this.resolveBootstrapSession = options.resolveBootstrapSession
    const settings = readElectronSettings()
    if (typeof settings.preventSleepEnabled === 'boolean') {
      this.preventSleepEnabled = settings.preventSleepEnabled
    }
    if (typeof settings.cliAutoStartEnabled === 'boolean') {
      this.cliAutoStartEnabled = settings.cliAutoStartEnabled
    }
    this.cliState.localAgentEnabled = this.cliAutoStartEnabled
    this.cliState.preventSleepEnabled = this.preventSleepEnabled
    this.updatePowerSaveBlocker()
  }

  private ensureSupervisor(): CliSupervisor {
    if (this.supervisor) return this.supervisor

    this.supervisor = new CliSupervisor({
      prepareLaunch: async (signal) => await this.buildLaunchPreparation(signal),
      fetchRuntimeState: async ({ timeoutMs }) => {
        try {
          return await Effect.runPromise(this.localProbeClient.state({ timeoutMs }))
        } catch {
          return null
        }
      },
      decideExit: (result) => {
        if (result.code === CLI_EXIT_CODE_AUTH_FAILURE) {
          return {
            action: 'fatal' as const,
            message: 'CLI authentication failed; sign in again to restart the local agent'
          }
        }
        if (result.code === CLI_EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH) {
          return {
            action: 'fatal' as const,
            message: 'Embedded CLI rejected the supervisor contract; update the desktop app'
          }
        }
        if (isV8OutOfMemoryExit(result)) {
          return {
            action: 'retry' as const,
            countFailure: true,
            failureClass: 'v8_oom' as const,
            message: 'Electron-managed CLI exhausted its V8 heap'
          }
        }
        return {
          action: 'retry' as const,
          countFailure: result.code !== CLI_EXIT_CODE_RETRYABLE_STARTUP,
          message:
            result.code === 0
              ? 'Electron-managed CLI exited unexpectedly'
              : `Electron-managed CLI exited with code ${result.code ?? 'signal'}`
        }
      },
      existingRuntimePolicy: 'attach',
      ownership: {
        acquire: async (signal) => {
          const result = await acquireLocalCliHostLease({
            instanceId: this.supervisorInstanceId,
            mode: 'electron',
            signal,
            endpoint: LOCAL_CLI_HOST_ENDPOINT
          })
          if (result.status === 'occupied') {
            return {
              status: 'occupied' as const,
              owner: result.record ?? undefined,
              description: result.record
                ? `Local CLI host is owned by ${result.record.mode} process ${result.record.pid}`
                : 'Another local CLI host owns the runtime'
            }
          }
          this.hostLease = result.lease
          return { status: 'acquired' as const }
        },
        inspect: async () => await inspectLocalCliHost(LOCAL_CLI_HOST_ENDPOINT),
        release: async () => {
          const lease = this.hostLease
          this.hostLease = null
          await lease?.close()
        }
      },
      onStateChange: (state) => {
        const runtime = state.runtime
        if (runtime?.machineId) {
          this.cachedMachineId = runtime.machineId
        }
        this.publishCliState()
        this.updatePowerSaveBlocker()
      }
    })

    return this.supervisor
  }

  private async buildLaunchPreparation(signal: AbortSignal): Promise<PreparedLaunch> {
    const sender = this.autoStartSender
    this.sendCliMeta(sender, '[electron] Preparing CLI autostart\n')
    throwIfAborted(signal)

    let bootstrapSession: BootstrapSession | null
    try {
      bootstrapSession = await this.resolveBootstrapSessionForAutoStart()
      throwIfAborted(signal)
    } catch (error) {
      this.sendCliMeta(
        sender,
        `[electron] Failed to prepare CLI autostart: ${formatUnknownError(error)}\n`
      )
      throw error
    }

    const finalArgs = ['start']
    const envOverrides: NodeJS.ProcessEnv = {
      ...buildCliRuntimeEnvOverrides(),
      [CLI_ELECTRON_BOOTSTRAP_ENV]: '1',
      [LODY_SUPERVISOR_CONTRACT_ENV]: LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION,
      [LODY_SUPERVISOR_PID_ENV]: String(process.pid),
      [LODY_SUPERVISOR_INSTANCE_ID_ENV]: this.supervisorInstanceId,
      [LODY_SUPERVISOR_TOKEN_ENV]: this.supervisorToken
    }
    if (bootstrapSession?.token) {
      envOverrides[CLI_ELECTRON_SESSION_TOKEN_ENV] = bootstrapSession.token
    }
    if (bootstrapSession?.userId) {
      envOverrides[CLI_ELECTRON_SESSION_USER_ID_ENV] = bootstrapSession.userId
    }

    const prepared = await this.prepareBundledCli(finalArgs, sender, {
      envOverrides,
      maxOldSpaceMiB: calculateWorkerMaxOldSpaceMiB(totalmem()),
      signal,
      supervisorControl: {
        instanceId: this.supervisorInstanceId,
        token: this.supervisorToken
      }
    })
    throwIfAborted(signal)
    return prepared
  }

  setPreventSleepEnabled(enabled: boolean): void {
    this.preventSleepEnabled = enabled
    this.updatePowerSaveBlocker()
    const settings = readElectronSettings()
    settings.preventSleepEnabled = enabled
    writeElectronSettings(settings)
    this.publishCliState()
  }

  getPreventSleepEnabled(): boolean {
    return this.preventSleepEnabled
  }

  getCliAutoStartEnabled(): boolean {
    return this.cliAutoStartEnabled
  }

  setCliAutoStartEnabled(enabled: boolean): void {
    this.cliAutoStartEnabled = enabled
    const settings = readElectronSettings()
    settings.cliAutoStartEnabled = enabled
    writeElectronSettings(settings)
    this.publishCliState()

    if (enabled) {
      // Re-enabling brings the embedded CLI back up immediately (and on the next
      // launch), so the user doesn't have to restart the app to get a local agent.
      this.startSupervisorIfNeeded()
    } else {
      // Control-only mode: stop the embedded CLI now and keep it stopped on the
      // next launch. The desktop app keeps working as a UI for remote agents.
      void this.terminateAutoStart()
    }
  }

  getCliState(): ElectronCliState {
    return this.cliState
  }

  attachCliStateSender(sender: WebContents | undefined): void {
    if (!sender || sender.isDestroyed()) return

    if (!this.cliStateSenders.has(sender)) {
      this.cliStateSenders.add(sender)
      sender.once('destroyed', () => {
        this.cliStateSenders.delete(sender)
      })
    }

    sender.send('cli.state', this.cliState)
  }

  async restartAutoStart(): Promise<RestartCliResult> {
    if (!this.cliAutoStartEnabled) {
      return { ok: false }
    }
    const supervisor = this.ensureSupervisor()
    try {
      await supervisor.restart()
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async terminateAutoStart(): Promise<TerminateCliResult> {
    const supervisor = this.supervisor
    this.clearMachineIdCache()

    if (!supervisor) {
      this.publishCliState()
      return { ok: true }
    }

    try {
      this.sendCliMeta(this.autoStartSender, '[electron] CLI terminate requested\n')
      await supervisor.stop()
      // Manual termination keeps observing an external CLI only while local
      // agents remain enabled. Disabling the setting is an explicit
      // control-only mode and must not retain a background probe loop.
      if (this.cliAutoStartEnabled) {
        supervisor.startProbing()
      }
      this.updatePowerSaveBlocker()
      this.publishCliState()
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  getOutputBacklog(): CliOutputEvent[] {
    return this.cliOutputBuffer
  }

  private clearMachineIdCache(): void {
    this.cachedMachineId = null
  }

  async getLocalMachineId(options?: MachineIdLookupOptions): Promise<string | null> {
    if (!this.cliAutoStartEnabled) {
      return null
    }
    if (!options?.forceRefresh && this.cachedMachineId) {
      return this.cachedMachineId
    }

    try {
      const health = await Effect.runPromise(
        this.localProbeClient.health({ timeoutMs: LOCAL_PROBE_TIMEOUT_MS })
      )
      this.cachedMachineId = health.machineId
      return health.machineId
    } catch {
      const fallbackMachineId = readMachineIdFromCliCredentials()
      if (fallbackMachineId) {
        this.cachedMachineId = fallbackMachineId
      }
      return fallbackMachineId
    }
  }

  async sendLocalSessionControl(
    message: LocalSessionControlRequest,
    options: {
      onResponse?: (response: LocalSessionControlResponse) => void
    } = {}
  ): Promise<SendLocalSessionControlResult> {
    if (!isLocalSessionControlRequest(message)) {
      return { ok: false, error: 'invalid_request' }
    }

    const timeoutMs = resolveLocalSessionControlTimeoutMs(message.type)

    try {
      return await Effect.runPromise(
        this.localControlClient
          .sessionControl(message, { timeoutMs, onResponse: options.onResponse })
          .pipe(
            Effect.map(
              (responses): SendLocalSessionControlResult => ({
                ok: true,
                responses
              })
            ),
            Effect.catchTag('IpcTimeoutError', () =>
              Effect.succeed({ ok: false as const, error: 'request_timeout' })
            ),
            Effect.catchTag('IpcProtocolError', (error) =>
              Effect.succeed({
                ok: false as const,
                error: error.errorCode ?? 'invalid_response'
              })
            )
          )
      )
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async sendLocalMachineRpc(message: LocalMachineRpcRequest): Promise<SendLocalMachineRpcResult> {
    if (!LocalMachineRpcRequestSchema.safeParse(message).success) {
      return { ok: false, error: 'invalid_request' }
    }

    try {
      const result = await Effect.runPromise(
        this.localControlClient
          .machineRpc(message, { timeoutMs: message.timeoutMs ?? 30_000 })
          .pipe(
            Effect.catchTag('IpcTimeoutError', () =>
              Effect.succeed({ ok: false as const, error: 'request_timeout' })
            ),
            Effect.catchTag('IpcProtocolError', (error) =>
              Effect.succeed({ ok: false as const, error: error.message })
            )
          )
      )

      if (!result.ok && result.error === 'machine_mismatch') {
        this.clearMachineIdCache()
      }

      return result
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async sendLocalProjectControl(
    message: LocalProjectControlRequest
  ): Promise<SendLocalProjectControlResult> {
    const requestType = message.type
    if (!isLocalProjectControlRequest(message)) {
      return {
        ok: false,
        type: requestType,
        error: 'invalid_request',
        message: 'Invalid local project control request payload'
      }
    }

    const timeoutMs = resolveLocalProjectControlTimeoutMs(message.type)

    try {
      const payload = await Effect.runPromise(
        this.localControlClient.projectControl(message, { timeoutMs }).pipe(
          Effect.catchTag('IpcTimeoutError', () =>
            Effect.succeed({
              ok: false,
              type: message.type,
              error: 'daemon_unavailable',
              message: `Local project control request timed out after ${timeoutMs}ms`
            } satisfies LocalProjectControlResponse)
          ),
          Effect.catchTag('IpcProtocolError', (error) =>
            Effect.succeed({
              ok: false,
              type: message.type,
              error: 'invalid_response',
              message: error.message
            } satisfies LocalProjectControlResponse)
          )
        )
      )

      if (!payload.ok && payload.error === 'machine_mismatch') {
        this.clearMachineIdCache()
      }

      return payload as LocalProjectControlResponse
    } catch (error) {
      return {
        ok: false,
        type: message.type,
        error: 'daemon_unavailable',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  killAllProcesses(): void {
    if (this.supervisor) {
      void this.supervisor.stop()
      this.supervisor = null
    }
    this.clearMachineIdCache()
    for (const child of this.trackedCliChildren) {
      try {
        child.kill()
      } catch {
        // best effort
      }
    }
    this.trackedCliChildren.clear()
    this.updatePowerSaveBlocker()
    this.publishCliState()
  }

  /**
   * Gracefully terminate the embedded CLI for app quit, then guarantee it is dead.
   *
   * `killAllProcesses()` only sends SIGTERM and never waits, so on Command+Q the
   * app would exit while the CLI was still shutting down — orphaning it holding the
   * local probe/session-control ports and the terminal socket, which then breaks
   * the next launch. Here we send SIGTERM, wait up to `graceMs` for a clean exit,
   * then SIGKILL anything still alive so nothing is left holding resources.
   */
  async shutdownForQuit(graceMs = CLI_QUIT_GRACE_MS): Promise<void> {
    if (this.supervisor) {
      // Stop polling/retry first so the supervisor does not relaunch the child
      // after we signal it. (This also sends SIGTERM to its active child.)
      try {
        await this.supervisor.stop({ terminationGraceMs: graceMs })
      } catch (error) {
        console.error('[Electron] Supervisor shutdown barrier failed', error)
      }
      this.supervisor = null
    }
    this.clearMachineIdCache()

    const children = Array.from(this.trackedCliChildren)
    for (const child of children) {
      try {
        child.kill('SIGTERM')
      } catch {
        // best effort
      }
    }

    await Promise.race([
      Promise.all(children.map((child) => this.waitForChildExit(child))),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs))
    ])

    for (const child of this.trackedCliChildren) {
      try {
        child.kill('SIGKILL')
      } catch {
        // best effort
      }
    }
    await Promise.race([
      Promise.all(Array.from(this.trackedCliChildren, (child) => this.waitForChildExit(child))),
      new Promise<void>((resolve) => setTimeout(resolve, 5000))
    ])
    const survivors = Array.from(this.trackedCliChildren).filter(
      (child) => child.exitCode === null && child.signalCode === null
    )
    this.updatePowerSaveBlocker()
    this.publishCliState()
    if (survivors.length > 0) {
      const error = new Error(
        `Embedded CLI did not confirm exit after SIGKILL (${survivors.map((child) => child.pid ?? 'unknown').join(', ')})`
      )
      console.error('[Electron]', error.message)
      throw error
    }
  }

  private waitForChildExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      child.once('close', () => resolve())
    })
  }

  autoStart(sender: WebContents | undefined): void {
    this.autoStartSender = sender
    this.attachCliStateSender(sender)

    // Control-only mode deliberately ignores even an externally started CLI.
    // The renderer switches to its cloud transport, so retaining a supervisor
    // probe here only creates a false reconnecting state and background work.
    if (!this.cliAutoStartEnabled) {
      return
    }

    this.startSupervisorIfNeeded()
  }

  private startSupervisorIfNeeded(): void {
    const supervisor = this.ensureSupervisor()
    void supervisor.start()
  }

  async run(
    args: string[],
    sender: WebContents | undefined,
    options?: CliRunOptions
  ): Promise<CliRunResult> {
    const prepared = await this.prepareBundledCli(args, sender, options)
    throwIfAborted(options?.signal)
    return await prepared.spawn().result
  }

  private sendCliOutput(sender: WebContents | undefined, event: CliOutputEvent): void {
    this.cliOutputBuffer.push(event)
    if (this.cliOutputBuffer.length > CLI_OUTPUT_BUFFER_MAX_EVENTS) {
      this.cliOutputBuffer.splice(0, this.cliOutputBuffer.length - CLI_OUTPUT_BUFFER_MAX_EVENTS)
    }

    if (!sender || sender.isDestroyed()) return
    sender.send('cli.output', event)
  }

  private sendCliMeta(sender: WebContents | undefined, chunk: string): void {
    this.sendCliOutput(sender, { runId: randomUUID(), stream: 'meta', chunk })
  }

  private spawnCli(
    command: string,
    args: string[],
    spawnOptions: SpawnOptions,
    sender: WebContents | undefined,
    options?: CliRunOptions
  ): LaunchHandle {
    throwIfAborted(options?.signal)
    const runId = randomUUID()
    this.sendCliOutput(sender, {
      runId,
      stream: 'meta',
      chunk: `$ ${formatCommandForDisplay(command, args)}\n`
    })

    const child = spawn(command, args, {
      ...spawnOptions,
      shell: shouldUseWindowsShell(command)
    })
    this.trackedCliChildren.add(child)
    options?.onSpawn?.(child)

    const result = new Promise<CliRunResult>((resolvePromise, reject) => {
      let stdout = ''
      let stderr = ''
      let processError: Error | null = null

      child.stdout?.on('data', (chunk) => {
        const text = String(chunk)
        stdout = appendOutputTail(stdout, text)
        this.sendCliOutput(sender, { runId, stream: 'stdout', chunk: text })
      })

      child.stderr?.on('data', (chunk) => {
        const text = String(chunk)
        stderr = appendOutputTail(stderr, text)
        this.sendCliOutput(sender, { runId, stream: 'stderr', chunk: text })
      })

      child.once('error', (error) => {
        processError = error
      })
      child.once('close', (code, signal) => {
        this.trackedCliChildren.delete(child)
        this.sendCliOutput(sender, {
          runId,
          stream: 'meta',
          chunk: `\n[cli exited: ${code ?? 'null'}]\n`
        })
        options?.onClose?.({
          child,
          code,
          signal: signal ?? null,
          stdout,
          stderr
        })
        if (processError) {
          reject(processError)
        } else {
          const exitResult: CliRunResult = {
            code,
            signal: signal ?? null,
            stdout,
            stderr
          }
          exitResult.terminationKind = isV8OutOfMemoryExit(exitResult)
            ? 'v8_oom'
            : signal
              ? 'signal'
              : 'exit'
          resolvePromise(exitResult)
        }
      })
    })

    return {
      child,
      result,
      ...(options?.supervisorControl
        ? {
            requestShutdown: async () => {
              if (!child.connected) {
                throw new Error('CLI supervisor IPC channel is not connected')
              }
              await new Promise<void>((resolve, reject) => {
                child.send(
                  {
                    type: 'lody/supervisor-shutdown',
                    instanceId: options.supervisorControl?.instanceId,
                    token: options.supervisorControl?.token
                  },
                  (error) => (error ? reject(error) : resolve())
                )
              })
            }
          }
        : {})
    }
  }

  private async prepareBundledCli(
    args: string[],
    sender: WebContents | undefined,
    options?: CliRunOptions
  ): Promise<PreparedLaunch> {
    throwIfAborted(options?.signal)
    const entry = resolveBundledCliEntry()
    if (!entry) {
      throw new Error(
        `Bundled CLI not found (${BUNDLED_CLI_ENTRY_FILE}). Build the CLI with \`pnpm --dir apps/cli run build\`, then sync it with \`pnpm --dir apps/electron run sync:cli\`.`
      )
    }

    const shellEnv = await getUserShellEnvCached()
    throwIfAborted(options?.signal)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(shellEnv ?? {}),
      ...(options?.envOverrides ?? {}),
      ELECTRON_RUN_AS_NODE: '1'
    }
    delete env.LODY_DAEMON_SUPERVISED
    applyProxyEnvFallback(env, await resolveSystemProxyEnv(buildSystemProxyProbeUrls()))
    throwIfAborted(options?.signal)

    return {
      spawn: () =>
        this.spawnCli(
          resolveBundledCliRuntime(),
          [
            ...(options?.maxOldSpaceMiB ? [`--max-old-space-size=${options.maxOldSpaceMiB}`] : []),
            entry,
            ...args
          ],
          {
            env,
            windowsHide: true,
            ...(options?.supervisorControl ? { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] } : {})
          },
          sender,
          options
        )
    }
  }

  private updatePowerSaveBlocker(): void {
    const shouldBlock = this.preventSleepEnabled

    if (shouldBlock) {
      if (
        this.powerSaveBlockerId === null ||
        !powerSaveBlocker.isStarted(this.powerSaveBlockerId)
      ) {
        this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      }
    } else {
      if (this.powerSaveBlockerId !== null && powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
        powerSaveBlocker.stop(this.powerSaveBlockerId)
      }
      this.powerSaveBlockerId = null
    }
  }

  private buildCliState(): ElectronCliState {
    if (!this.supervisor) {
      return {
        phase: 'stopped',
        desiredState: 'stopped',
        localAgentEnabled: this.cliAutoStartEnabled,
        updatedAtMs: this.cliState.updatedAtMs,
        preventSleepEnabled: this.preventSleepEnabled
      }
    }

    const supervisorState = this.supervisor.getState()
    return {
      phase: supervisorState.phase,
      desiredState: supervisorState.desiredState,
      localAgentEnabled: this.cliAutoStartEnabled,
      updatedAtMs: this.cliState.updatedAtMs,
      preventSleepEnabled: this.preventSleepEnabled,
      startupStage: supervisorState.runtime?.startupStage,
      connectivity: supervisorState.runtime?.connectivity,
      runtime: supervisorState.runtime,
      runtimeOwnership: supervisorState.runtimeOwnership,
      message: supervisorState.message,
      retryAttempt: supervisorState.retryAttempt,
      retryInMs: supervisorState.retryInMs,
      lastExitCode: supervisorState.lastExitCode,
      lastExitAtMs: supervisorState.lastExitAtMs
    }
  }

  private publishCliState(): void {
    const nextState = this.buildCliState()
    const previous = JSON.stringify(this.cliState)
    const next = JSON.stringify(nextState)
    if (previous === next) return

    nextState.updatedAtMs = Date.now()
    this.cliState = nextState
    for (const sender of this.cliStateSenders) {
      if (sender.isDestroyed()) {
        this.cliStateSenders.delete(sender)
        continue
      }
      sender.send('cli.state', nextState)
    }
  }

  private async resolveBootstrapSessionForAutoStart(): Promise<BootstrapSession | null> {
    if (isLocalPlatform()) {
      // Local platform: the CLI needs no credentials, so don't touch the auth
      // service (its client is inert without cloud env).
      return null
    }
    if (!this.resolveBootstrapSession) {
      return null
    }
    return await this.resolveBootstrapSession()
  }
}

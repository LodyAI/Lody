import { randomUUID } from 'node:crypto'
import { type BrowserWindow, shell } from 'electron'
import type {
  ArrivalProbe,
  ElectronSorbetOAuthState,
  ImportSourceDescription,
  ImportSourceId,
  ImportSourceResult,
  SorbetConnectApiKeyInput,
  SorbetConnectCustomProviderInput,
  SorbetConnectionSource,
  SorbetConnectResult,
  SorbetImportRequest,
  SorbetStartOAuthInput
} from '@lody/shared/electron-ipc'
import type { LaunchHandle } from '@lody/cli-supervisor'
import { signalChildTreeNowLegacy } from '@lody/shared/node/process'
import type { CliService } from './cli-service'

const EXTERNAL_ENV_SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'CEREBRAS_API_KEY'
] as const

function scrubInheritedProviderEnv(): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {}
  for (const key of EXTERNAL_ENV_SECRET_KEYS) {
    scrubbed[key] = ''
  }
  return scrubbed
}

function parseLastJsonLine<T>(stdout: string): T {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) {
    throw new Error('Sorbet helper returned empty output')
  }
  return JSON.parse(last) as T
}

type OAuthStreamMessage =
  | {
      event: 'authorization'
      url: string
      userCode?: string
    }
  | {
      event: 'authenticated'
      providerId: string
      providerName: string
      modelSelector: string
      modelName: string
      source: SorbetConnectionSource
    }
  | {
      event: 'error'
      error: string
    }

export class OnboardingSorbetService {
  private authSnapshot: ElectronSorbetOAuthState = {
    revision: 0,
    attemptId: null,
    providerId: null,
    providerName: null,
    phase: 'idle',
    authorizationUrl: null,
    userCode: null,
    modelSelector: null,
    modelName: null,
    source: null,
    error: null
  }
  private activeOAuth: {
    attemptId: string
    handle: LaunchHandle | null
    cancelled: boolean
  } | null = null
  private cachedArrivalProbe: Promise<ArrivalProbe> | null = null

  constructor(
    private readonly options: {
      cliService: CliService
      publishAuthState: (state: ElectronSorbetOAuthState) => void
      focusMainWindow: () => BrowserWindow | null
    }
  ) {}

  getAuthState(): ElectronSorbetOAuthState {
    return this.authSnapshot
  }

  private updateAuthState(patch: Partial<ElectronSorbetOAuthState>): void {
    this.authSnapshot = {
      ...this.authSnapshot,
      ...patch,
      revision: this.authSnapshot.revision + 1
    }
    this.options.publishAuthState(this.authSnapshot)
  }

  private async runHelper<T>(
    action: string,
    payload?: Record<string, unknown>,
    options?: { includeShellEnv?: boolean }
  ): Promise<T> {
    const includeShellEnv = options?.includeShellEnv === true
    const result = await this.options.cliService.run(['__internal', 'sorbet-onboarding', action], {
      includeShellEnv,
      envOverrides: includeShellEnv ? undefined : scrubInheritedProviderEnv(),
      stdinInput: payload ? JSON.stringify(payload) : '',
      suppressOutputLog: true
    })
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `Sorbet helper (${action}) exited with ${result.code}`
      )
    }
    return parseLastJsonLine<T>(result.stdout)
  }

  async probeArrival(options?: { forceRefresh?: boolean }): Promise<ArrivalProbe> {
    if (!options?.forceRefresh && this.cachedArrivalProbe) {
      return await this.cachedArrivalProbe
    }
    const pending = this.runHelper<ArrivalProbe>('probe', undefined, {
      includeShellEnv: false
    }).catch((error) => {
      if (this.cachedArrivalProbe === pending) {
        this.cachedArrivalProbe = null
      }
      throw error
    })
    this.cachedArrivalProbe = pending
    return await pending
  }

  invalidateArrivalProbe(): void {
    this.cachedArrivalProbe = null
  }

  async listConnectionSources(): Promise<Record<string, SorbetConnectionSource>> {
    return await this.runHelper<Record<string, SorbetConnectionSource>>('sources', undefined, {
      includeShellEnv: false
    })
  }

  describeImport(source: ImportSourceId): ImportSourceDescription {
    return {
      source,
      systemPromptKind:
        source === 'claude-code' && process.platform === 'darwin' ? 'macos-keychain' : 'none'
    }
  }

  async runImport(request: SorbetImportRequest): Promise<ImportSourceResult> {
    const result = await this.runHelper<ImportSourceResult>('import', request, {
      includeShellEnv: request.source === 'env'
    })
    if (result.status === 'imported') {
      this.invalidateArrivalProbe()
    }
    return result
  }

  async connectApiKey(input: SorbetConnectApiKeyInput): Promise<SorbetConnectResult> {
    const result = await this.runHelper<SorbetConnectResult>('connect-api-key', input, {
      includeShellEnv: false
    })
    if (result.ok) {
      this.invalidateArrivalProbe()
    }
    return result
  }

  async connectCustomProvider(
    input: SorbetConnectCustomProviderInput
  ): Promise<SorbetConnectResult> {
    const result = await this.runHelper<SorbetConnectResult>('connect-custom-provider', input, {
      includeShellEnv: false
    })
    if (result.ok) {
      this.invalidateArrivalProbe()
    }
    return result
  }

  async disconnectProvider(providerId: string): Promise<void> {
    await this.runHelper('disconnect', { providerId }, { includeShellEnv: false })
    this.invalidateArrivalProbe()
  }

  async startOAuth(input: SorbetStartOAuthInput): Promise<ElectronSorbetOAuthState> {
    this.cancelOAuth({ silent: true })
    const attemptId = randomUUID()
    const attempt = {
      attemptId,
      handle: null as LaunchHandle | null,
      cancelled: false
    }
    this.activeOAuth = attempt
    this.updateAuthState({
      attemptId,
      providerId: input.providerId,
      providerName: input.providerName ?? input.providerId,
      phase: 'starting',
      authorizationUrl: null,
      userCode: null,
      modelSelector: null,
      modelName: null,
      source: null,
      error: null
    })

    let lineBuffer = ''
    let openedBrowser = false

    const handleLine = (line: string): void => {
      if (this.activeOAuth !== attempt || attempt.cancelled) return
      let parsed: OAuthStreamMessage
      try {
        parsed = JSON.parse(line) as OAuthStreamMessage
      } catch {
        return
      }
      if (parsed.event === 'authorization') {
        this.updateAuthState({
          phase: 'waiting',
          authorizationUrl: parsed.url,
          userCode: parsed.userCode ?? null
        })
        if (!openedBrowser) {
          openedBrowser = true
          void shell.openExternal(parsed.url, { activate: true }).catch(() => {
            if (this.activeOAuth === attempt && !attempt.cancelled) {
              this.updateAuthState({ error: 'browser_open_failed' })
            }
          })
        }
        return
      }
      if (parsed.event === 'authenticated') {
        this.invalidateArrivalProbe()
        const window = this.options.focusMainWindow()
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore()
          window.focus()
        }
        this.updateAuthState({
          phase: 'authenticated',
          providerId: parsed.providerId,
          providerName: parsed.providerName,
          modelSelector: parsed.modelSelector || null,
          modelName: parsed.modelName || null,
          source: parsed.source,
          error: null
        })
        return
      }
      if (parsed.event === 'error') {
        this.updateAuthState({
          phase: 'error',
          error: parsed.error
        })
      }
    }

    void (async () => {
      try {
        const handle = await this.options.cliService.spawnBundled(
          ['__internal', 'sorbet-onboarding', 'oauth-login'],
          {
            includeShellEnv: false,
            envOverrides: scrubInheritedProviderEnv(),
            stdinInput: JSON.stringify({ providerId: input.providerId }),
            suppressOutputLog: true,
            onStdoutChunk: (chunk) => {
              lineBuffer += chunk
              let newlineIdx = lineBuffer.indexOf('\n')
              while (newlineIdx >= 0) {
                const line = lineBuffer.slice(0, newlineIdx).trim()
                lineBuffer = lineBuffer.slice(newlineIdx + 1)
                if (line) handleLine(line)
                newlineIdx = lineBuffer.indexOf('\n')
              }
            }
          }
        )
        if (this.activeOAuth !== attempt || attempt.cancelled) {
          signalChildTreeNowLegacy(
            handle.child,
            process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM',
            { processGroup: false }
          )
          return
        }
        attempt.handle = handle
        const result = await handle.result
        if (lineBuffer.trim()) {
          handleLine(lineBuffer.trim())
          lineBuffer = ''
        }
        if (this.activeOAuth !== attempt || attempt.cancelled) return
        if (
          this.authSnapshot.phase !== 'authenticated' &&
          this.authSnapshot.phase !== 'error' &&
          result.code !== 0
        ) {
          this.updateAuthState({
            phase: 'error',
            error: result.stderr.trim() || 'oauth_failed'
          })
        }
      } catch (error) {
        if (this.activeOAuth !== attempt || attempt.cancelled) return
        this.updateAuthState({
          phase: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })()

    return this.authSnapshot
  }

  cancelOAuth(options?: { silent?: boolean }): ElectronSorbetOAuthState {
    const current = this.activeOAuth
    this.activeOAuth = null
    if (current) {
      current.cancelled = true
      if (current.handle?.child) {
        signalChildTreeNowLegacy(
          current.handle.child,
          process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM',
          { processGroup: false }
        )
      }
    }
    if (!options?.silent) {
      this.updateAuthState({
        attemptId: null,
        phase: 'idle',
        authorizationUrl: null,
        userCode: null,
        error: null
      })
    }
    return this.authSnapshot
  }
}

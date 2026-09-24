import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ElectronAuthCallbackSession, ElectronLoginState } from '@lody/shared/electron-ipc'

export type DesktopLoginError = NonNullable<ElectronLoginState['error']>

// Thrown by dependencies when a failure has a more specific user action than
// the phase default. `detail` must not contain credentials.
export class DesktopLoginFailure extends Error {
  readonly code: DesktopLoginError
  constructor(code: DesktopLoginError, detail: string) {
    super(detail)
    this.name = 'DesktopLoginFailure'
    this.code = code
  }
}

export type DesktopLoginFailureReport = {
  attemptId: string | null
  phase: 'waiting' | 'exchanging'
  error: DesktopLoginError
  detail: string | null
  cause: unknown
}

const MAX_DETAIL_LENGTH = 400

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readErrorCode(error: unknown, depth = 0): string | null {
  if (typeof error !== 'object' || error === null || depth > 3) return null
  const record = error as { code?: unknown; cause?: unknown }
  return readString(record.code) ?? readErrorCode(record.cause, depth + 1)
}

// Summarizes an exchange/browser failure for the user and diagnostics: HTTP
// status and Better Auth error code for server rejections, error name/message/
// system code for local failures. Request bodies and headers are never read.
export function describeDesktopLoginFailure(
  error: unknown,
  fallback: DesktopLoginError
): { error: DesktopLoginError; detail: string | null } {
  if (error instanceof DesktopLoginFailure) {
    return { error: error.code, detail: error.message.slice(0, MAX_DETAIL_LENGTH) || null }
  }
  if (typeof error !== 'object' || error === null) {
    return { error: fallback, detail: error === undefined ? null : String(error) }
  }
  const record = error as { status?: unknown; error?: unknown; name?: unknown; message?: unknown }
  let detail: string
  let code = fallback
  if (typeof record.status === 'number') {
    // BetterFetchError: `error` is the parsed JSON body or the response text.
    const body = typeof record.error === 'object' && record.error !== null ? record.error : {}
    const serverCode = readString((body as { code?: unknown }).code)
    const serverMessage =
      readString((body as { message?: unknown }).message) ??
      readString(record.error) ??
      readString(record.message)
    detail = [`HTTP ${record.status}`, serverCode, serverMessage].filter(Boolean).join(' ')
    // 4xx means the server read and refused this one-time code; retrying it is
    // pointless, but a fresh browser attempt is not.
    if (fallback === 'exchange_failed' && record.status >= 400 && record.status < 500) {
      code = 'exchange_rejected'
    }
  } else {
    const name = readString(record.name) ?? 'Error'
    const systemCode = readErrorCode(error)
    detail = [`${name}: ${readString(record.message) ?? 'unknown error'}`, systemCode]
      .filter(Boolean)
      .join(' ')
  }
  return { error: code, detail: detail.slice(0, MAX_DETAIL_LENGTH) }
}

type Dependencies = {
  channel?: 'stable' | 'nightly'
  openBrowser: (query: Record<string, string>) => Promise<void>
  exchange: (
    body: { token: string; state: string; code_verifier: string },
    signal: AbortSignal
  ) => Promise<ElectronAuthCallbackSession>
  publish: (state: ElectronLoginState) => void
  authenticated: (session: ElectronAuthCallbackSession) => void
  reportFailure?: (report: DesktopLoginFailureReport) => void
}

// The main process owns the attempt independently of any renderer's lifetime.
// Credentials never enter diagnostics. Only one attempt may exchange at a time.
export class DesktopLogin {
  private snapshot: ElectronLoginState = {
    revision: 0,
    attemptId: null,
    phase: 'idle',
    session: null,
    error: null,
    errorDetail: null
  }
  private attempt: { state: string; verifier: string; controller: AbortController } | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private completion: Promise<void> | null = null
  private readonly dependencies: Dependencies

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies
  }

  getState(): ElectronLoginState {
    return this.snapshot
  }

  private update(value: Partial<ElectronLoginState>): void {
    this.snapshot = { ...this.snapshot, ...value, revision: this.snapshot.revision + 1 }
    this.dependencies.publish(this.snapshot)
  }

  private fail(
    phase: DesktopLoginFailureReport['phase'],
    cause: unknown,
    fallback: DesktopLoginError
  ): void {
    const { error, detail } = describeDesktopLoginFailure(cause, fallback)
    this.update({ phase: 'error', error, errorDetail: detail })
    try {
      this.dependencies.reportFailure?.({
        attemptId: this.snapshot.attemptId,
        phase,
        error,
        detail,
        cause
      })
    } catch {
      /* diagnostics never change the login result */
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  async start(): Promise<void> {
    // Do not race a fresh exchange against an older request's cookie writes.
    if (this.snapshot.phase === 'exchanging') return
    this.clearTimer()
    this.attempt?.controller.abort()
    const attempt = {
      state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
      controller: new AbortController()
    }
    this.attempt = attempt
    this.update({ attemptId: randomUUID(), phase: 'waiting', error: null, errorDetail: null })
    this.timer = setTimeout(() => {
      if (this.attempt !== attempt) return
      attempt.verifier = ''
      this.update({ phase: 'error', error: 'authorization_expired', errorDetail: null })
    }, 300_000)
    try {
      await this.dependencies.openBrowser({
        client_id: 'electron',
        ...(this.dependencies.channel === 'nightly' ? { desktop_channel: 'nightly' } : {}),
        state: attempt.state,
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        code_challenge_method: 'S256'
      })
    } catch (error) {
      if (this.attempt !== attempt || this.snapshot.phase !== 'waiting') return
      this.clearTimer()
      attempt.verifier = ''
      this.fail('waiting', error, 'browser_open_failed')
    }
  }

  async complete(token: string): Promise<void> {
    let payload: { identifier?: unknown; state?: unknown }
    try {
      if (token.length > 16_384) return
      payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
      if (
        !payload ||
        typeof payload.identifier !== 'string' ||
        !payload.identifier ||
        typeof payload.state !== 'string'
      )
        return
    } catch {
      return
    }
    const attempt = this.attempt
    if (!attempt) {
      // A restarted process cannot redeem an earlier process's PKCE request.
      if (!this.snapshot.session)
        this.update({ phase: 'error', error: 'restart_required', errorDetail: null })
      return
    }
    // Late, foreign, cancelled and already consumed callbacks never touch identity.
    if (payload.state !== attempt.state) return
    if (this.snapshot.phase === 'exchanging') {
      await this.completion
      return
    }
    if (this.snapshot.phase !== 'waiting') return
    this.clearTimer()
    const verifier = attempt.verifier
    const identifier = payload.identifier
    attempt.verifier = ''
    this.update({ phase: 'exchanging', error: null, errorDetail: null })
    const operation = Promise.resolve().then(() =>
      this.dependencies.exchange(
        {
          token: identifier,
          state: attempt.state,
          code_verifier: verifier
        },
        attempt.controller.signal
      )
    )
    let timedOut = false
    const timeout = new Promise<never>((_resolve, reject) => {
      this.timer = setTimeout(() => {
        timedOut = true
        attempt.controller.abort()
        reject(new Error('exchange_timeout'))
      }, 25_000)
    })
    const completion = (async () => {
      try {
        const session = await Promise.race([operation, timeout])
        if (this.attempt !== attempt) return
        this.update({ phase: 'authenticated', session, error: null, errorDetail: null })
        // Post-login services (such as CLI restart) cannot undo authentication.
        try {
          this.dependencies.authenticated(session)
        } catch {
          /* best effort */
        }
      } catch (error) {
        if (this.attempt !== attempt) return
        if (timedOut) {
          this.fail(
            'exchanging',
            new DesktopLoginFailure('exchange_timeout', ''),
            'exchange_timeout'
          )
        } else {
          this.fail('exchanging', error, 'exchange_failed')
        }
      } finally {
        if (this.attempt === attempt) this.clearTimer()
      }
    })()
    this.completion = completion
    await completion
    if (this.completion === completion) this.completion = null
  }

  cancel(): void {
    this.clearTimer()
    this.attempt?.controller.abort()
    this.attempt = null
    this.update({ attemptId: null, phase: 'idle', session: null, error: null, errorDetail: null })
  }
}

export function readDesktopLoginCallback(url: string, protocol = 'lody'): string | null {
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol !== `${protocol}:` ||
      parsed.hostname !== 'auth' ||
      parsed.pathname !== '/callback' ||
      parsed.search
    )
      return null
    return new URLSearchParams(parsed.hash.slice(1)).get('token')
  } catch {
    return null
  }
}

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ElectronAuthCallbackSession, ElectronLoginState } from '@lody/shared/electron-ipc'

type Dependencies = {
  openBrowser: (query: Record<string, string>) => Promise<void>
  exchange: (
    body: { token: string; state: string; code_verifier: string },
    signal: AbortSignal
  ) => Promise<ElectronAuthCallbackSession>
  publish: (state: ElectronLoginState) => void
  authenticated: (session: ElectronAuthCallbackSession) => void
}

// The main process owns the attempt independently of any renderer's lifetime.
// Credentials never enter diagnostics. Only one attempt may exchange at a time.
export class DesktopLogin {
  private snapshot: ElectronLoginState = {
    revision: 0,
    attemptId: null,
    phase: 'idle',
    session: null,
    error: null
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
    this.update({ attemptId: randomUUID(), phase: 'waiting', error: null })
    this.timer = setTimeout(() => {
      if (this.attempt !== attempt) return
      attempt.verifier = ''
      this.update({ phase: 'error', error: 'authorization_expired' })
    }, 300_000)
    try {
      await this.dependencies.openBrowser({
        client_id: 'electron',
        state: attempt.state,
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        code_challenge_method: 'S256'
      })
    } catch {
      if (this.attempt !== attempt || this.snapshot.phase !== 'waiting') return
      this.clearTimer()
      attempt.verifier = ''
      this.update({ phase: 'error', error: 'browser_open_failed' })
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
      if (!this.snapshot.session) this.update({ phase: 'error', error: 'restart_required' })
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
    this.update({ phase: 'exchanging', error: null })
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
        this.update({ phase: 'authenticated', session, error: null })
        // Post-login services (such as CLI restart) cannot undo authentication.
        try {
          this.dependencies.authenticated(session)
        } catch {
          /* best effort */
        }
      } catch {
        if (this.attempt !== attempt) return
        this.update({ phase: 'error', error: timedOut ? 'exchange_timeout' : 'exchange_failed' })
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
    this.update({ attemptId: null, phase: 'idle', session: null, error: null })
  }
}

export function readDesktopLoginCallback(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'lody:' ||
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

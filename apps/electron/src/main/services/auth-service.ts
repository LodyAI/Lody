import { app } from 'electron'
import { authClient } from '../auth'
import {
  ElectronAuthCallbackSessionSchema,
  isDevEmailPasswordLoginEnabled,
  type ElectronAuthCallbackInput,
  type ElectronAuthCallbackSession,
  type ElectronDevEmailPasswordSignInInput
} from '@lody/shared/electron-ipc'

const AUTH_CALLBACK_TIMEOUT_MS = 25_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readSessionFromResponse(response: unknown): {
  token: string | null
  userId: string | null
} {
  if (!isRecord(response)) {
    return { token: null, userId: null }
  }

  let token: string | null = null
  let userId: string | null = null

  if ('data' in response) {
    const nested = readSessionFromResponse(response.data)
    token = nested.token
    userId = nested.userId
  }

  if (!token) {
    token = readNonEmptyString(response.token)
  }

  if (!token) {
    const session = asRecord(response.session)
    if (session) {
      token = readNonEmptyString(session.token)
    }
  }

  if (!userId) {
    const user = asRecord(response.user)
    if (user) {
      userId = readNonEmptyString(user.id)
    }
  }

  return { token, userId }
}

function readSessionTokenFromResponse(response: unknown): string | null {
  return readSessionFromResponse(response).token
}

function hasResolvedSession(response: unknown): boolean {
  const { token, userId } = readSessionFromResponse(response)
  return Boolean(token || userId)
}

function readErrorCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null
  }

  const code = error.code
  if (typeof code === 'string') {
    return code
  }

  const cause = error.cause
  if (!cause) {
    return null
  }
  return readErrorCode(cause)
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = readErrorCode(error)
  if (!code) {
    return false
  }

  return (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN'
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function readRequiredString(input: Record<string, unknown>, key: string, context: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context}: "${key}" must be a non-empty string`)
  }
  return value
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  return value
}

function readOptionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key]
  if (typeof value !== 'boolean') {
    return undefined
  }
  return value
}

function parseInviteRole(value: unknown): 'member' | 'admin' | 'owner' {
  if (value === 'member' || value === 'admin' || value === 'owner') {
    return value
  }
  throw new Error('organization.inviteMember: "role" must be one of member/admin/owner')
}

function parseObjectInput(input: unknown, context: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(`${context}: payload must be an object`)
  }
  return input
}

type SessionQueryOptions = {
  fetchOptions?: {
    headers?: {
      Authorization?: string
    }
  }
}

function parseSessionQueryOptions(input: unknown): SessionQueryOptions | undefined {
  if (input === undefined) {
    return undefined
  }
  if (!isRecord(input)) {
    throw new Error('getSession: options must be an object')
  }

  const result: SessionQueryOptions = {}
  const fetchOptions = input.fetchOptions
  if (!isRecord(fetchOptions)) {
    return result
  }

  const headers = fetchOptions.headers
  if (!isRecord(headers)) {
    result.fetchOptions = {}
    return result
  }

  const authorization = headers.Authorization
  if (typeof authorization === 'string' && authorization.length > 0) {
    result.fetchOptions = {
      headers: {
        Authorization: authorization
      }
    }
    return result
  }

  result.fetchOptions = {}
  return result
}

type AuthorizedRequestOptions = {
  fetchOptions?: {
    headers?: {
      Authorization?: string
      authorization?: string
    }
  }
}

function readBearerTokenFromInput(input: unknown): string | null {
  if (!isRecord(input)) {
    return null
  }

  const fetchOptions = asRecord(input.fetchOptions)
  const headers = asRecord(fetchOptions?.headers)
  const authorization =
    readNonEmptyString(headers?.Authorization) ?? readNonEmptyString(headers?.authorization)
  if (!authorization) {
    return null
  }

  const bearerPrefix = 'Bearer '
  if (!authorization.startsWith(bearerPrefix)) {
    return null
  }

  const token = authorization.slice(bearerPrefix.length).trim()
  return token.length > 0 ? token : null
}

function getElectronAuthCookieHeader(): string | null {
  const getCookie = (authClient as { getCookie?: () => string }).getCookie
  if (typeof getCookie !== 'function') {
    return null
  }

  const cookie = getCookie()
  return typeof cookie === 'string' && cookie.trim().length > 0 ? cookie : null
}

function readSessionTokenFromCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) {
    return null
  }

  const cookies = cookieHeader
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  for (const cookie of cookies) {
    const equalsIndex = cookie.indexOf('=')
    if (equalsIndex <= 0) {
      continue
    }

    const name = cookie.slice(0, equalsIndex).trim()
    if (!name.endsWith('session_token')) {
      continue
    }

    const rawValue = cookie.slice(equalsIndex + 1).trim()
    if (rawValue.length === 0) {
      continue
    }

    try {
      return decodeURIComponent(rawValue)
    } catch {
      return rawValue
    }
  }

  return null
}

function withAuthorization<T extends Record<string, unknown>>(
  input: T,
  sessionToken: string | null
): T & AuthorizedRequestOptions {
  if (!sessionToken) {
    return input as T & AuthorizedRequestOptions
  }

  const fetchOptions = asRecord(input.fetchOptions)
  const headers = asRecord(fetchOptions?.headers)

  return {
    ...input,
    fetchOptions: {
      ...(fetchOptions ?? {}),
      headers: {
        ...(headers ?? {}),
        Authorization: `Bearer ${sessionToken}`
      }
    }
  }
}

function hasResponseError(response: unknown): boolean {
  return isRecord(response) && 'error' in response && response.error != null
}

// Bound on how long a session query may wait on the network before the cached
// fallback kicks in. Must stay well under the renderer's own 10s auth-query
// timeout so an offline/hung network serves the cached session instead of
// surfacing ElectronAuthQueryTimeoutError to every consumer.
const AUTH_SESSION_NETWORK_TIMEOUT_MS = 5_000

async function withSessionNetworkTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(`getSession network call timed out after ${AUTH_SESSION_NETWORK_TIMEOUT_MS}ms`)
      )
    }, AUTH_SESSION_NETWORK_TIMEOUT_MS)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

function readResponseErrorStatus(response: unknown): number | null {
  if (!isRecord(response)) {
    return null
  }
  const error = asRecord(response.error)
  if (!error) {
    return null
  }
  return typeof error.status === 'number' ? error.status : null
}

// A definitive "you are not signed in" answer from the auth server: no
// resolved session and either a clean empty body or an auth-shaped rejection.
// 5xx/status-0 error bodies are NOT definitive — the server (or the path to
// it) is broken, which must not be conflated with being logged out.
function isDefinitiveUnauthenticatedResponse(response: unknown): boolean {
  if (hasResolvedSession(response)) {
    return false
  }
  const status = readResponseErrorStatus(response)
  if (status === null) {
    return !hasResponseError(response)
  }
  return status === 401 || status === 403 || status === 404
}

function unwrapResponseData<T>(response: unknown): T | null {
  if (!isRecord(response)) {
    return null
  }

  if ('data' in response) {
    return (response.data as T | null | undefined) ?? null
  }

  return response as T
}

function readOrganizationId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null
  }

  const id = value.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function withSessionTokenInResponse(response: unknown, sessionToken: string | null): unknown {
  if (!sessionToken || readSessionTokenFromResponse(response)) {
    return response
  }
  if (!isRecord(response)) {
    return response
  }

  if (isRecord(response.data)) {
    const session = isRecord(response.data.session) ? response.data.session : {}
    return {
      ...response,
      data: {
        ...response.data,
        session: {
          ...session,
          token: sessionToken
        }
      }
    }
  }

  const session = isRecord(response.session) ? response.session : {}
  return {
    ...response,
    session: {
      ...session,
      token: sessionToken
    }
  }
}

export type BootstrapSession = {
  token: string
  /**
   * The user id behind the session token. Null when only the cookie fallback
   * yielded a token (no JSON body to read the user from). Used by the CLI to
   * detect when its existing credentials.json belongs to a different user
   * than the desktop app session and re-bootstrap accordingly.
   */
  userId: string | null
}

export class AuthService {
  // The desktop renderer holds the working Better Auth session token in its own
  // localStorage (lody_auth_token) and passes it as a bearer on every auth IPC.
  // The main process has no other handle on it: under @better-auth/electron the
  // raw getSession + auth cookie come back without a token. So we cache the most
  // recent token that successfully resolved a session here, and let CLI
  // bootstrap reuse it — otherwise an already-logged-in desktop can never hand
  // the CLI a session token and the daemon loops on "Electron session is not
  // ready yet".
  private lastKnownSessionToken: string | null = null
  private authOperation: Promise<void> = Promise.resolve()
  private authGeneration = 0
  private activeAuthAbortController: AbortController | null = null

  // Offline identity authority (specs/local-first-two-plane.md): the last
  // session response that actually resolved a user this run. Served when the
  // network is unreachable/hung so local-first functionality never blocks on a
  // cloud auth round-trip. Authentication generation changes and definitive
  // unauthenticated responses clear it; transport failures never sign the user
  // out by themselves.
  private lastResolvedSessionResponse: unknown = null

  private rememberSessionToken(token: string | null | undefined): void {
    if (typeof token === 'string' && token.length > 0) {
      this.lastKnownSessionToken = token
    }
  }

  private async enqueueAuthOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.authOperation.then(operation, operation)
    this.authOperation = result.then(
      () => undefined,
      () => undefined
    )
    return await result
  }

  async completeCallback(input: ElectronAuthCallbackInput): Promise<ElectronAuthCallbackSession> {
    const generation = ++this.authGeneration
    this.lastResolvedSessionResponse = null
    this.activeAuthAbortController?.abort()
    return await this.enqueueAuthOperation(async () => {
      if (generation !== this.authGeneration) {
        throw new Error('Authentication callback was superseded')
      }
      const abortController = new AbortController()
      this.activeAuthAbortController = abortController
      const timeoutId = setTimeout(() => abortController.abort(), AUTH_CALLBACK_TIMEOUT_MS)
      let response: Awaited<ReturnType<typeof authClient.authenticate>>
      try {
        response = await authClient.authenticate({
          ...input,
          fetchOptions: { signal: abortController.signal }
        })
      } finally {
        clearTimeout(timeoutId)
        if (this.activeAuthAbortController === abortController) {
          this.activeAuthAbortController = null
        }
      }
      const data = isRecord(response) && isRecord(response.data) ? response.data : response
      const record = asRecord(data)
      const { token } = readSessionFromResponse(response)
      const user = asRecord(record?.user)

      if (!token || !user || !readNonEmptyString(user.id)) {
        throw new Error('Authentication callback did not return a complete session')
      }
      if (generation !== this.authGeneration) {
        throw new Error('Authentication callback was superseded')
      }

      const session = ElectronAuthCallbackSessionSchema.parse({
        session: {
          ...(asRecord(record?.session) ?? {}),
          token
        },
        user
      })
      this.rememberSessionToken(session.session.token)
      this.lastResolvedSessionResponse = session
      return session
    })
  }

  async signInWithDevEmailPassword(input: ElectronDevEmailPasswordSignInInput): Promise<unknown> {
    if (
      !isDevEmailPasswordLoginEnabled({
        isPackaged: app.isPackaged
      })
    ) {
      throw new Error('Dev email/password login is disabled')
    }

    const generation = ++this.authGeneration
    this.lastResolvedSessionResponse = null
    this.activeAuthAbortController?.abort()
    return await this.enqueueAuthOperation(async () => {
      if (generation !== this.authGeneration) {
        throw new Error('Dev email/password login was superseded')
      }

      // Password login stays in Electron's own Better Auth client so its session
      // cookie is stored in the Desktop profile, never borrowed from the browser.
      // Do not log this input: it contains the user's password.
      return await authClient.signIn.email(input)
    })
  }

  async signOut(): Promise<void> {
    this.authGeneration += 1
    this.lastResolvedSessionResponse = null
    this.activeAuthAbortController?.abort()
    await this.enqueueAuthOperation(async () => {
      try {
        await authClient.signOut()
      } finally {
        this.lastKnownSessionToken = null
        this.lastResolvedSessionResponse = null
      }
    })
  }

  async getSessionToken(options?: unknown): Promise<string | null> {
    const explicitBearerToken = readBearerTokenFromInput(options)
    if (explicitBearerToken) {
      // A renderer-supplied bearer (localStorage `lody_auth_token`) can be stale
      // even when the durable session is fine. Returning it unconditionally let a
      // stale token shadow a valid session, so org/convex/email calls would 401
      // while getSession() stayed green. Mirror getSession()'s validate-and-fallback
      // here: resolve the session for this bearer and trust only the token it
      // actually yields, so both entry points agree on the same session.
      const verified = await this.getSession(options)
      const verifiedToken = readSessionTokenFromResponse(verified)
      if (verifiedToken) {
        return verifiedToken
      }
    }

    const session = await this.getBootstrapSession()
    return session?.token ?? null
  }

  async getBootstrapSession(): Promise<BootstrapSession | null> {
    const generation = this.authGeneration
    try {
      // Through this.getSession() (not the raw client) so CLI bootstrap gets
      // the same bounded network timeout + cached-session fallback: an offline
      // desktop that already resolved a session this run can still hand the
      // CLI its token instead of hanging on a dead network.
      const response = await this.getSession()
      const { token, userId } = readSessionFromResponse(response)
      if (token) {
        if (generation !== this.authGeneration) return null
        this.rememberSessionToken(token)
        return { token, userId }
      }
    } catch (error) {
      console.warn('[Auth] Failed to resolve session for CLI bootstrap', error)
    }

    const cookieToken = readSessionTokenFromCookieHeader(getElectronAuthCookieHeader())
    if (cookieToken) {
      if (generation !== this.authGeneration) return null
      this.rememberSessionToken(cookieToken)
      return { token: cookieToken, userId: null }
    }

    // Last resort: reuse the session token the renderer most recently
    // authenticated with. Re-validate it through getSession first; only hand it
    // to the CLI if it still resolves a live session, otherwise drop it so we
    // never bootstrap with a stale (e.g. logged-out) token.
    const cachedToken = this.lastKnownSessionToken
    if (cachedToken) {
      try {
        const verified = await this.getSession({
          fetchOptions: { headers: { Authorization: `Bearer ${cachedToken}` } }
        })
        if (hasResolvedSession(verified)) {
          if (generation !== this.authGeneration) return null
          const { token, userId } = readSessionFromResponse(verified)
          // getSession may not echo the token back even for a valid session, so
          // fall back to the cached bearer — it IS the session token.
          return { token: token ?? cachedToken, userId }
        }
      } catch (error) {
        console.warn('[Auth] Failed to verify cached session token for CLI bootstrap', error)
      }
      if (generation === this.authGeneration) this.lastKnownSessionToken = null
    }

    return null
  }

  /** Main-only lease for local E2EE identity selection, not Org authorization. */
  async getDeviceIdentityAccount() {
    const generation = this.authGeneration
    const response = await this.getSession()
    const { userId } = readSessionFromResponse(response)
    if (!userId || generation !== this.authGeneration) throw new Error('e2ee-account-required')
    return {
      userId,
      assertCurrent: () => {
        if (generation !== this.authGeneration) throw new Error('e2ee-account-changed')
      }
    }
  }

  async getSession(options?: unknown) {
    const generation = this.authGeneration
    const parsedOptions = parseSessionQueryOptions(options)
    let response: unknown
    try {
      response = parsedOptions
        ? await withSessionNetworkTimeout(authClient.getSession(parsedOptions))
        : await withSessionNetworkTimeout(authClient.getSession())
    } catch (error) {
      // Transport-level failure (offline, hung network, DNS): serve the last
      // resolved session instead of surfacing a timeout to every consumer.
      // Definitive "no session" answers flow through below and clear the
      // cache, so sign-out semantics are unchanged.
      const cached = this.lastResolvedSessionResponse
      if (generation === this.authGeneration && cached !== null) {
        console.warn('[Auth] getSession network failure; serving last resolved session', error)
        return cached
      }
      throw error
    }
    const cookieToken = readSessionTokenFromCookieHeader(getElectronAuthCookieHeader())
    const existingAuthorization = parsedOptions?.fetchOptions?.headers?.Authorization
    if (hasResolvedSession(response)) {
      // Remember whatever token resolved this session (response > cookie >
      // the bearer the caller supplied) so CLI bootstrap can reuse it.
      const resolved = withSessionTokenInResponse(
        response,
        !existingAuthorization || existingAuthorization === `Bearer ${cookieToken}`
          ? cookieToken
          : null
      )
      if (generation === this.authGeneration) {
        this.rememberSessionToken(
          readSessionTokenFromResponse(response) ?? cookieToken ?? readBearerTokenFromInput(options)
        )
        this.lastResolvedSessionResponse = resolved
      }
      return resolved
    }

    if (!cookieToken || existingAuthorization === `Bearer ${cookieToken}`) {
      if (generation === this.authGeneration && isDefinitiveUnauthenticatedResponse(response)) {
        this.lastResolvedSessionResponse = null
      }
      return response
    }

    try {
      const fallbackResponse = await withSessionNetworkTimeout(
        authClient.getSession({
          fetchOptions: {
            headers: {
              Authorization: `Bearer ${cookieToken}`
            }
          }
        })
      )
      if (hasResolvedSession(fallbackResponse)) {
        const resolved = withSessionTokenInResponse(fallbackResponse, cookieToken)
        if (generation === this.authGeneration) {
          this.rememberSessionToken(cookieToken)
          this.lastResolvedSessionResponse = resolved
        }
        return resolved
      }
    } catch (error) {
      console.warn('[Auth] Failed to resolve session through cookie bearer fallback', error)
    }

    if (generation === this.authGeneration && isDefinitiveUnauthenticatedResponse(response)) {
      this.lastResolvedSessionResponse = null
    }
    return response
  }

  async listOrganizations(options?: unknown) {
    const sessionToken = await this.getSessionToken(options)
    return await authClient.organization.list(withAuthorization({}, sessionToken))
  }

  async getActiveOrganization(
    options?: unknown,
    query?: { organizationId?: string; organizationSlug?: string }
  ) {
    if (query) {
      const token = await this.getSessionToken(options)
      return await authClient.organization.getFullOrganization(withAuthorization({ query }, token))
    }
    const sessionToken = await this.getSessionToken(options)
    const activeOrganizationResponse = await authClient.organization.getFullOrganization(
      withAuthorization({}, sessionToken)
    )
    if (hasResponseError(activeOrganizationResponse)) {
      return activeOrganizationResponse
    }

    const activeOrganization = unwrapResponseData<Record<string, unknown>>(
      activeOrganizationResponse
    )
    if (activeOrganization) {
      return activeOrganizationResponse
    }

    const organizationsResponse = await authClient.organization.list(
      withAuthorization({}, sessionToken)
    )
    if (hasResponseError(organizationsResponse)) {
      return organizationsResponse
    }

    const organizations = unwrapResponseData<unknown[]>(organizationsResponse)
    const firstOrganizationId = Array.isArray(organizations)
      ? readOrganizationId(organizations[0])
      : null
    if (!firstOrganizationId) {
      return activeOrganizationResponse
    }

    const setActiveResponse = await authClient.organization.setActive(
      withAuthorization(
        {
          organizationId: firstOrganizationId
        },
        sessionToken
      )
    )
    if (hasResponseError(setActiveResponse)) {
      return setActiveResponse
    }

    return await authClient.organization.getFullOrganization(withAuthorization({}, sessionToken))
  }

  async changeEmail(input: unknown) {
    const parsed = parseObjectInput(input, 'changeEmail')
    const newEmail = readRequiredString(parsed, 'newEmail', 'changeEmail')
    const callbackURL = readOptionalString(parsed, 'callbackURL')
    const sessionToken = await this.getSessionToken(input)

    return await authClient.changeEmail({
      newEmail,
      callbackURL,
      ...withAuthorization({}, sessionToken)
    })
  }

  async listAccounts(input?: unknown): Promise<unknown> {
    const sessionToken = await this.getSessionToken(input)
    return await authClient.listAccounts(withAuthorization({}, sessionToken))
  }

  async updateUser(input: unknown): Promise<unknown> {
    const parsed = parseObjectInput(input, 'updateUser')
    const name = readOptionalString(parsed, 'name')
    const image = readOptionalString(parsed, 'image')
    if (!name && !image) {
      throw new Error('updateUser: payload must include "name" or "image"')
    }
    const sessionToken = await this.getSessionToken(input)

    return await authClient.updateUser({
      ...(name ? { name } : {}),
      ...(image ? { image } : {}),
      ...withAuthorization({}, sessionToken)
    })
  }

  async changePassword(input: unknown): Promise<unknown> {
    const parsed = parseObjectInput(input, 'changePassword')
    const currentPassword = readRequiredString(parsed, 'currentPassword', 'changePassword')
    const newPassword = readRequiredString(parsed, 'newPassword', 'changePassword')
    const revokeOtherSessions = readOptionalBoolean(parsed, 'revokeOtherSessions')
    const sessionToken = await this.getSessionToken(input)

    return await authClient.changePassword({
      currentPassword,
      newPassword,
      ...(revokeOtherSessions === undefined ? {} : { revokeOtherSessions }),
      ...withAuthorization({}, sessionToken)
    })
  }

  async requestPasswordReset(input: unknown): Promise<unknown> {
    const parsed = parseObjectInput(input, 'requestPasswordReset')
    const email = readRequiredString(parsed, 'email', 'requestPasswordReset')
    const redirectTo = readOptionalString(parsed, 'redirectTo')

    return await authClient.requestPasswordReset({
      email,
      ...(redirectTo ? { redirectTo } : {})
    })
  }

  async convexToken(options?: unknown) {
    const sessionToken = await this.getSessionToken(options)
    return await authClient.convex.token(withAuthorization({}, sessionToken))
  }

  async crossDomainVerifyOneTimeToken(input: unknown) {
    const parsed = parseObjectInput(input, 'crossDomainVerifyOneTimeToken')
    const token = readRequiredString(parsed, 'token', 'crossDomainVerifyOneTimeToken')
    const maxAttempts = 3

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await authClient.crossDomain.oneTimeToken.verify({ token })
        const sessionToken = readSessionTokenFromResponse(response)
        if (sessionToken) {
          console.info('[Auth] One-time token verified, hydrating session with bearer token')
          await authClient.getSession({
            fetchOptions: {
              headers: {
                Authorization: `Bearer ${sessionToken}`
              }
            }
          })
        } else {
          console.warn('[Auth] One-time token verify succeeded but no session token was returned')
        }
        return response
      } catch (error) {
        const retryable = attempt < maxAttempts && isRetryableNetworkError(error)
        if (!retryable) {
          throw error
        }

        const delayMs = 300 * 2 ** (attempt - 1)
        console.warn(
          `[Auth] crossDomain verify failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`,
          error
        )
        await sleep(delayMs)
      }
    }

    throw new Error('crossDomainVerifyOneTimeToken exhausted retries')
  }

  async organizationGetInvitation(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.getInvitation')
    const query = parseObjectInput(parsed.query, 'organization.getInvitation.query')
    const id = readRequiredString(query, 'id', 'organization.getInvitation')
    const sessionToken = await this.getSessionToken(input)
    return await authClient.organization.getInvitation({
      query: {
        id
      },
      ...withAuthorization({}, sessionToken)
    })
  }

  async organizationAcceptInvitation(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.acceptInvitation')
    const invitationId = readRequiredString(parsed, 'invitationId', 'organization.acceptInvitation')
    const sessionToken = await this.getSessionToken(input)
    return await authClient.organization.acceptInvitation(
      withAuthorization(
        {
          invitationId
        },
        sessionToken
      )
    )
  }

  async organizationListInvitations(input?: unknown) {
    const sessionToken = await this.getSessionToken(input)
    if (input === undefined) {
      return await authClient.organization.listInvitations(withAuthorization({}, sessionToken))
    }

    const parsed = parseObjectInput(input, 'organization.listInvitations')
    const queryValue = parsed.query
    if (!isRecord(queryValue)) {
      return await authClient.organization.listInvitations(withAuthorization({}, sessionToken))
    }
    const organizationId = readOptionalString(queryValue, 'organizationId')
    if (!organizationId) {
      return await authClient.organization.listInvitations(withAuthorization({}, sessionToken))
    }
    return await authClient.organization.listInvitations({
      query: {
        organizationId
      },
      ...withAuthorization({}, sessionToken)
    })
  }

  async organizationInviteMember(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.inviteMember')
    const email = readRequiredString(parsed, 'email', 'organization.inviteMember')
    const role = parseInviteRole(parsed.role)
    const organizationId = readRequiredString(parsed, 'organizationId', 'organization.inviteMember')
    const resend = readOptionalBoolean(parsed, 'resend')
    const sessionToken = await this.getSessionToken(input)
    return await authClient.organization.inviteMember(
      withAuthorization(
        {
          email,
          role,
          organizationId,
          resend
        },
        sessionToken
      )
    )
  }

  async organizationCancelInvitation(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.cancelInvitation')
    const invitationId = readRequiredString(parsed, 'invitationId', 'organization.cancelInvitation')
    const sessionToken = await this.getSessionToken(input)
    return await authClient.organization.cancelInvitation(
      withAuthorization(
        {
          invitationId
        },
        sessionToken
      )
    )
  }

  async organizationRemoveMember(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.removeMember')
    const memberIdOrEmail = readRequiredString(
      parsed,
      'memberIdOrEmail',
      'organization.removeMember'
    )
    const organizationId = readRequiredString(parsed, 'organizationId', 'organization.removeMember')
    const sessionToken = await this.getSessionToken(input)
    return await authClient.organization.removeMember(
      withAuthorization(
        {
          memberIdOrEmail,
          organizationId
        },
        sessionToken
      )
    )
  }

  async organizationUpdateMemberRole(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.updateMemberRole')
    const memberId = readRequiredString(parsed, 'memberId', 'organization.updateMemberRole')
    const role = readRequiredString(parsed, 'role', 'organization.updateMemberRole')
    const organizationId = readRequiredString(
      parsed,
      'organizationId',
      'organization.updateMemberRole'
    )
    const sessionToken = await this.getSessionToken(input)
    return await authClient.organization.updateMemberRole(
      withAuthorization(
        {
          memberId,
          role,
          organizationId
        },
        sessionToken
      )
    )
  }

  async organizationSetActive(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.setActive')
    const organizationId = readRequiredString(parsed, 'organizationId', 'organization.setActive')
    const sessionToken = await this.getSessionToken(input)
    return await authClient.organization.setActive(
      withAuthorization(
        {
          organizationId
        },
        sessionToken
      )
    )
  }

  async organizationUpdate(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.update')
    const organizationId = readOptionalString(parsed, 'organizationId')
    const dataInput = parseObjectInput(parsed.data, 'organization.update.data')
    const data: Record<string, unknown> = {}

    const name = readOptionalString(dataInput, 'name')
    if (name) {
      data.name = name
    }

    const slug = readOptionalString(dataInput, 'slug')
    if (slug) {
      data.slug = slug
    }

    const logo = readOptionalString(dataInput, 'logo')
    if (logo) {
      data.logo = logo
    }

    if (isRecord(dataInput.metadata)) {
      data.metadata = dataInput.metadata
    }

    if (Object.keys(data).length === 0) {
      throw new Error('organization.update: "data" must include at least one supported field')
    }

    const sessionToken = await this.getSessionToken(input)
    const payload = organizationId ? { organizationId, data } : { data }
    return await authClient.organization.update(withAuthorization(payload, sessionToken))
  }

  async organizationCreate(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.create')
    const name = readRequiredString(parsed, 'name', 'organization.create')
    const slug = readRequiredString(parsed, 'slug', 'organization.create')
    const sessionToken = await this.getSessionToken(input)
    return await authClient.organization.create(
      withAuthorization(
        {
          name,
          slug
        },
        sessionToken
      )
    )
  }

  async organizationDelete(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.delete')
    const organizationId = readRequiredString(parsed, 'organizationId', 'organization.delete')
    const sessionToken = await this.getSessionToken(input)
    return await authClient.organization.delete(
      withAuthorization(
        {
          organizationId
        },
        sessionToken
      )
    )
  }

  async organizationLeave(input: unknown) {
    const parsed = parseObjectInput(input, 'organization.leave')
    const organizationId = readRequiredString(parsed, 'organizationId', 'organization.leave')
    const sessionToken = await this.getSessionToken(input)
    return await authClient.organization.leave(
      withAuthorization(
        {
          organizationId
        },
        sessionToken
      )
    )
  }
}

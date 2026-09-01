import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { electronProxyClient } from '@better-auth/electron/proxy'
import {
  ElectronDevEmailPasswordSignInInputSchema,
  isDevEmailPasswordLoginEnabled
} from '@lody/shared/electron-ipc'
import {
  clearLocalAuthState,
  createLodyAuthClient,
  type LodyAuthClient
} from '@lody/components/lib/auth'
import { getAppWindowLocation } from '@lody/components/lib/app-location'
import { readStoredAuthToken } from '@lody/components/lib/auth-bootstrap'
import { capturePostHogSingleton } from '@lody/components/lib/mobile-resume-analytics'
import { persistNativeAuthSessionResult as persistAuthSessionResult } from '@lody/components/lib/native-auth-session-sync'
import { getIpcServices } from '@lody/components/lib/electron-ipc-client'
import { createAuthCallbackTransaction } from './auth-callback-transaction'
import { createAuthQueryGeneration } from './auth-query-generation'

const ELECTRON_PROTOCOL_SCHEME = 'lody'
const SAFE_TELEMETRY_STRING_PATTERN = /^[A-Za-z0-9_.: -]+$/
const ELECTRON_ACCOUNT_AUTH_METHODS = [
  'listAccounts',
  'updateUser',
  'changePassword',
  'requestPasswordReset'
] as const satisfies readonly (keyof LodyAuthClient)[]

type QuerySnapshot<TData> = {
  data: TData | undefined
  isPending: boolean
  isRefetching: boolean
  error: unknown
}

type QueryResult<TData> = QuerySnapshot<TData> & {
  refetch: () => Promise<void>
}

const ELECTRON_AUTH_QUERY_TIMEOUT_MS = 10_000

class ElectronAuthQueryTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} timed out after ${ELECTRON_AUTH_QUERY_TIMEOUT_MS}ms`)
    this.name = 'ElectronAuthQueryTimeoutError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getAppVersion(): string {
  const appInfo = typeof window === 'undefined' ? undefined : window['__LODY_APP_INFO__']
  const appInfoVersion = appInfo?.app_version ?? appInfo?.version
  if (typeof appInfoVersion === 'string' && appInfoVersion.length > 0) {
    return appInfoVersion
  }
  if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0) {
    return __APP_VERSION__
  }
  return 'unknown'
}

function normalizeTelemetryString(value: unknown, fallback = 'unknown'): string {
  if (typeof value !== 'string') {
    return fallback
  }

  const normalized = value.trim()
  if (!normalized) {
    return fallback
  }
  const truncated = normalized.slice(0, 80)
  return SAFE_TELEMETRY_STRING_PATTERN.test(truncated) ? truncated : fallback
}

function classifyCallbackURL(value: unknown): 'none' | 'electron_oauth' | 'relative' | 'absolute' {
  if (typeof value !== 'string' || value.length === 0) {
    return 'none'
  }
  if (value.includes('electron_oauth=1')) {
    return 'electron_oauth'
  }
  if (value.startsWith('/')) {
    return 'relative'
  }
  return 'absolute'
}

function getElectronAuthTelemetryBase() {
  const platform = typeof window !== 'undefined' ? window['__LODY_PLATFORM__'] : undefined

  return {
    login_surface: 'electron_renderer',
    launch_mode: 'electron',
    electron_platform: platform?.os ?? 'unknown',
    app_version: getAppVersion()
  }
}

function captureElectronRequestAuthStarted(
  options: Parameters<ReturnType<typeof getRequestAuthBridge>>[0],
  usesLoginPageFlow: boolean
): void {
  const provider = normalizeTelemetryString(options?.provider, 'none')
  capturePostHogSingleton('auth/electron_request_auth_started', {
    ...getElectronAuthTelemetryBase(),
    provider,
    uses_login_page_flow: usesLoginPageFlow,
    provider_forwarded_to_main: !usesLoginPageFlow && provider !== 'none',
    callback_url_kind: classifyCallbackURL(options?.callbackURL),
    has_callback_url: typeof options?.callbackURL === 'string' && options.callbackURL.length > 0
  })
}

async function withAuthQueryTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ElectronAuthQueryTimeoutError(label))
    }, ELECTRON_AUTH_QUERY_TIMEOUT_MS)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

function getAuthApi() {
  if (!getIpcServices()) {
    throw new Error('Electron auth bridge is not available')
  }
  const auth = getIpcServices()!.auth
  return {
    completeCallback: auth.completeCallback.bind(auth),
    signInWithDevEmailPassword: auth.signInWithDevEmailPassword.bind(auth),
    signOut: auth.signOut.bind(auth),
    getSession: auth.getSession.bind(auth),
    listOrganizations: auth.listOrganizations.bind(auth),
    getActiveOrganization: auth.getActiveOrganization.bind(auth),
    changeEmail: auth.changeEmail.bind(auth),
    listAccounts: auth.listAccounts.bind(auth),
    updateUser: auth.updateUser.bind(auth),
    changePassword: auth.changePassword.bind(auth),
    requestPasswordReset: auth.requestPasswordReset.bind(auth),
    convexToken: auth.convexToken.bind(auth),
    crossDomainVerifyOneTimeToken: auth.crossDomainVerifyOneTimeToken.bind(auth),
    organization: {
      getInvitation: auth.getInvitation.bind(auth),
      acceptInvitation: auth.acceptInvitation.bind(auth),
      listInvitations: auth.listInvitations.bind(auth),
      inviteMember: auth.inviteMember.bind(auth),
      cancelInvitation: auth.cancelInvitation.bind(auth),
      removeMember: auth.removeMember.bind(auth),
      updateMemberRole: auth.updateMemberRole.bind(auth),
      setActive: auth.setActive.bind(auth),
      update: auth.updateOrganization.bind(auth),
      create: auth.createOrganization.bind(auth),
      delete: auth.deleteOrganization.bind(auth),
      leave: auth.leaveOrganization.bind(auth)
    }
  }
}

function getRequestAuthBridge() {
  if (typeof window.requestAuth !== 'function') {
    throw new Error('window.requestAuth bridge is not available')
  }
  return window.requestAuth
}

function hasResponseError(response: unknown): boolean {
  return isRecord(response) && 'error' in response && response.error != null
}

function unwrapData(response: unknown): unknown {
  if (!isRecord(response) || !('data' in response)) {
    return response
  }
  return response.data
}

function unwrapError(response: unknown): unknown {
  if (!isRecord(response) || !('error' in response)) {
    return null
  }
  return response.error ?? null
}

function withStoredSessionAuthorization(input?: unknown): unknown {
  let token: string | null = null
  try {
    token = readStoredAuthToken()
  } catch {
    token = null
  }

  if (!token) {
    return input
  }

  const authorization = `Bearer ${token}`
  if (input === undefined) {
    return {
      fetchOptions: {
        headers: {
          Authorization: authorization
        }
      }
    }
  }

  if (!isRecord(input)) {
    return input
  }

  const fetchOptions = isRecord(input.fetchOptions) ? input.fetchOptions : {}
  const headers = isRecord(fetchOptions.headers) ? fetchOptions.headers : {}
  if (typeof headers.Authorization === 'string' && headers.Authorization.length > 0) {
    return input
  }

  return {
    ...input,
    fetchOptions: {
      ...fetchOptions,
      headers: {
        ...headers,
        Authorization: authorization
      }
    }
  }
}

function withSessionAuthorization(token: string): unknown {
  return {
    fetchOptions: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  }
}

function readCallbackSessionToken(session: unknown): string {
  const sessionRecord = isRecord(session)
    ? isRecord(session.session)
      ? session.session
      : null
    : null
  const token = sessionRecord?.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Authentication callback session token is missing')
  }
  return token
}

function assertSuccessfulAuthResponse(response: unknown, label: string): void {
  if (hasResponseError(response)) {
    throw new Error(`${label} failed during authentication`)
  }
}

function createQueryStore<TData>(
  label: string,
  fetcher: () => Promise<unknown>,
  onCommit?: (response: unknown) => void
) {
  let snapshot: QuerySnapshot<TData> = {
    data: undefined,
    isPending: true,
    isRefetching: false,
    error: null
  }
  let hasLoaded = false
  let inFlight: Promise<void> | null = null
  let pendingRefetch = false
  let held = false
  const generation = createAuthQueryGeneration()
  const listeners = new Set<() => void>()

  const notify = () => {
    listeners.forEach((listener) => listener())
  }

  const setSnapshot = (next: QuerySnapshot<TData>) => {
    snapshot = next
    notify()
  }

  const run = async (isRefetch: boolean) => {
    if (held) {
      return
    }
    if (inFlight) {
      if (isRefetch) {
        pendingRefetch = true
      }
      await inFlight
      return
    }

    const previous = snapshot
    const requestGeneration = generation.capture()
    setSnapshot({
      data: previous.data,
      isPending: !hasLoaded && !isRefetch,
      isRefetching: hasLoaded || isRefetch,
      error: null
    })

    const currentRun = (async () => {
      try {
        const response = await withAuthQueryTimeout(label, fetcher())
        generation.commitIfCurrent(requestGeneration, () => {
          onCommit?.(response)
          const data = unwrapData(response) as TData | undefined
          const error = unwrapError(response)
          hasLoaded = true
          setSnapshot({
            data,
            isPending: false,
            isRefetching: false,
            error
          })
        })
      } catch (error) {
        generation.commitIfCurrent(requestGeneration, () => {
          console.warn(`[Auth] ${label} failed`, error)
          hasLoaded = true
          setSnapshot({
            data: previous.data,
            isPending: false,
            isRefetching: false,
            error
          })
        })
      }
    })()

    inFlight = currentRun
    await currentRun

    if (inFlight === currentRun) {
      inFlight = null
    }

    if (requestGeneration !== generation.capture()) {
      return
    }

    if (pendingRefetch) {
      pendingRefetch = false
      await run(true)
    }
  }

  const ensureLoaded = () => {
    if (hasLoaded || inFlight) {
      return
    }
    void run(false)
  }

  const refetch = async () => {
    await run(true)
  }

  const reset = (data?: TData) => {
    generation.advance()
    held = false
    hasLoaded = true
    inFlight = null
    pendingRefetch = false
    setSnapshot({
      data,
      isPending: false,
      isRefetching: false,
      error: null
    })
  }

  const beginPending = () => {
    generation.advance()
    held = true
    hasLoaded = false
    inFlight = null
    pendingRefetch = false
    setSnapshot({
      data: undefined,
      isPending: true,
      isRefetching: false,
      error: null
    })
  }

  const commitResponse = (response: unknown) => {
    generation.advance()
    held = false
    hasLoaded = true
    inFlight = null
    pendingRefetch = false
    onCommit?.(response)
    setSnapshot({
      data: unwrapData(response) as TData | undefined,
      isPending: false,
      isRefetching: false,
      error: unwrapError(response)
    })
  }

  const useQuery = (): QueryResult<TData> => {
    const state = useSyncExternalStore(
      (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      () => snapshot,
      () => snapshot
    )

    useEffect(() => {
      ensureLoaded()
    }, [])

    const refetchFn = useCallback(async () => {
      await refetch()
    }, [])

    return {
      ...state,
      refetch: refetchFn
    }
  }

  return {
    useQuery,
    refetch,
    reset,
    beginPending,
    commitResponse
  }
}

const sessionStore = createQueryStore(
  'getSession',
  async () => {
    return await getAuthApi().getSession(withStoredSessionAuthorization())
  },
  persistAuthSessionResult
)

const organizationsStore = createQueryStore('listOrganizations', async () => {
  return await getAuthApi().listOrganizations(withStoredSessionAuthorization())
})

const activeOrganizationStore = createQueryStore('getActiveOrganization', async () => {
  return await getAuthApi().getActiveOrganization(withStoredSessionAuthorization())
})

const refetchSessionState = async () => {
  await sessionStore.refetch()
}

const refetchOrganizationState = async () => {
  await organizationsStore.refetch()
  await activeOrganizationStore.refetch()
}

const refetchAllAuthState = async () => {
  await refetchSessionState()
  await refetchOrganizationState()
}

const authCallbackTransaction = createAuthCallbackTransaction(
  {
    begin: () => {
      sessionStore.beginPending()
      organizationsStore.beginPending()
      activeOrganizationStore.beginPending()
    },
    exchange: async (token: string) => {
      return await getAuthApi().completeCallback({ token })
    },
    persist: persistAuthSessionResult,
    loadOrganizations: async (session) => {
      const response = await withAuthQueryTimeout(
        'listOrganizations',
        getAuthApi().listOrganizations(withSessionAuthorization(readCallbackSessionToken(session)))
      )
      assertSuccessfulAuthResponse(response, 'listOrganizations')
      return response
    },
    loadActiveOrganization: async (session) => {
      const response = await withAuthQueryTimeout(
        'getActiveOrganization',
        getAuthApi().getActiveOrganization(
          withSessionAuthorization(readCallbackSessionToken(session))
        )
      )
      assertSuccessfulAuthResponse(response, 'getActiveOrganization')
      return response
    },
    commitOrganizations: (organizations, activeOrganization) => {
      organizationsStore.commitResponse(organizations)
      activeOrganizationStore.commitResponse(activeOrganization)
    },
    commitSession: (session) => sessionStore.commitResponse(session),
    rollback: () => {
      sessionStore.reset()
      organizationsStore.reset()
      activeOrganizationStore.reset()
    },
    onFailure: () => {
      clearLocalAuthState()
      void getAuthApi()
        .signOut()
        .catch((error) => console.warn('[Auth] Failed to roll back authentication', error))
    },
    restartCli: () => {
      void getIpcServices()
        ?.cli.restart()
        .catch((error) => {
          console.warn('[Auth] Failed to restart CLI after authentication', error)
        })
    }
  },
  30_000
)

export async function completeElectronAuthCallback(token: string): Promise<void> {
  await authCallbackTransaction.complete(token)
}

export function isElectronAuthCallbackActive(): boolean {
  return authCallbackTransaction.isActive()
}

let authListenersInitialized = false

function ensureAuthListeners() {
  if (authListenersInitialized) {
    return
  }
  if (typeof window.onUserUpdated !== 'function') {
    return
  }

  window.onUserUpdated(() => {
    void refetchAllAuthState()
  })

  if (typeof window.onAuthError === 'function') {
    window.onAuthError(() => {
      void refetchSessionState()
    })
  }

  authListenersInitialized = true
}

function buildRequestAuthOptions(
  input: unknown
): Parameters<ReturnType<typeof getRequestAuthBridge>>[0] {
  if (!isRecord(input)) {
    return undefined
  }

  const result: NonNullable<Parameters<ReturnType<typeof getRequestAuthBridge>>[0]> = {}

  if (typeof input.provider === 'string') {
    result.provider = input.provider
  }
  if (typeof input.callbackURL === 'string') {
    result.callbackURL = input.callbackURL
  }
  if (typeof input.newUserCallbackURL === 'string') {
    result.newUserCallbackURL = input.newUserCallbackURL
  }
  if (typeof input.errorCallbackURL === 'string') {
    result.errorCallbackURL = input.errorCallbackURL
  }
  if (typeof input.disableRedirect === 'boolean') {
    result.disableRedirect = input.disableRedirect
  }
  if (typeof input.requestSignUp === 'boolean') {
    result.requestSignUp = input.requestSignUp
  }
  if (Array.isArray(input.scopes) && input.scopes.every((scope) => typeof scope === 'string')) {
    result.scopes = input.scopes
  }
  if (isRecord(input.additionalData)) {
    result.additionalData = input.additionalData
  }

  return result
}

function shouldUseLoginPageAuthFlow(
  options: Parameters<ReturnType<typeof getRequestAuthBridge>>[0]
): boolean {
  if (!options) {
    return false
  }

  if (typeof options.callbackURL === 'string' && options.callbackURL.includes('electron_oauth=1')) {
    return true
  }

  if (
    typeof window !== 'undefined' &&
    window.__LODY_ELECTRON__ === true &&
    getAppWindowLocation().pathname === '/login'
  ) {
    return true
  }

  return false
}

function refetchAfterMutation(response: unknown) {
  if (hasResponseError(response)) {
    return
  }
  void refetchOrganizationState()
  void refetchSessionState()
}

function createElectronAuthClientAdapter() {
  ensureAuthListeners()

  return {
    useSession: () => sessionStore.useQuery(),
    getSession: async (options?: unknown) => {
      const generation = authCallbackTransaction.getGeneration()
      const response = await getAuthApi().getSession(withStoredSessionAuthorization(options))
      if (authCallbackTransaction.isCurrent(generation)) {
        persistAuthSessionResult(response)
      }
      return response
    },
    signIn: {
      social: async (options?: unknown) => {
        const requestAuth = getRequestAuthBridge()
        const requestAuthOptions = buildRequestAuthOptions(options)
        const usesLoginPageFlow = shouldUseLoginPageAuthFlow(requestAuthOptions)
        captureElectronRequestAuthStarted(requestAuthOptions, usesLoginPageFlow)
        if (usesLoginPageFlow) {
          const { provider: _provider, ...restOptions } = requestAuthOptions ?? {}
          const normalizedOptions = Object.keys(restOptions).length > 0 ? restOptions : undefined
          await requestAuth(normalizedOptions)
          return
        }
        await requestAuth(requestAuthOptions)
      },
      email: async (input: unknown) => {
        if (
          !isDevEmailPasswordLoginEnabled({
            isPackaged: !import.meta.env.DEV
          })
        ) {
          throw new Error('Dev email/password login is disabled')
        }
        const parsedInput = ElectronDevEmailPasswordSignInInputSchema.safeParse(input)
        if (!parsedInput.success) {
          return { error: { message: 'Invalid email/password login input' } }
        }
        return await getAuthApi().signInWithDevEmailPassword(parsedInput.data)
      }
    },
    signOut: async () => {
      authCallbackTransaction.cancel()
      try {
        await getAuthApi().signOut()
      } finally {
        try {
          await getIpcServices()?.cli.terminate()
        } catch (error) {
          console.warn('[Auth] Failed to terminate CLI after sign-out', error)
        }
      }
    },
    changeEmail: async (payload: unknown) => {
      const response = await getAuthApi().changeEmail(withStoredSessionAuthorization(payload))
      if (!hasResponseError(response)) {
        void refetchSessionState()
      }
      return response
    },
    listAccounts: async (options?: unknown) => {
      return await getAuthApi().listAccounts(withStoredSessionAuthorization(options))
    },
    updateUser: async (payload: unknown) => {
      const response = await getAuthApi().updateUser(withStoredSessionAuthorization(payload))
      if (!hasResponseError(response)) {
        void refetchSessionState()
      }
      return response
    },
    changePassword: async (payload: unknown) => {
      return await getAuthApi().changePassword(withStoredSessionAuthorization(payload))
    },
    requestPasswordReset: async (payload: unknown) => {
      return await getAuthApi().requestPasswordReset(payload)
    },
    convex: {
      token: async () => {
        return await getAuthApi().convexToken(withStoredSessionAuthorization())
      }
    },
    crossDomain: {
      oneTimeToken: {
        verify: async (payload: unknown) => {
          const response = await getAuthApi().crossDomainVerifyOneTimeToken(payload)
          if (!hasResponseError(response)) {
            await refetchSessionState()
          }
          return response
        }
      }
    },
    updateSession: async () => {
      await refetchAllAuthState()
    },
    useListOrganizations: () => organizationsStore.useQuery(),
    useActiveOrganization: () => activeOrganizationStore.useQuery(),
    organization: {
      getInvitation: async (payload: unknown) => {
        return await getAuthApi().organization.getInvitation(
          withStoredSessionAuthorization(payload)
        )
      },
      acceptInvitation: async (payload: unknown) => {
        const response = await getAuthApi().organization.acceptInvitation(
          withStoredSessionAuthorization(payload)
        )
        refetchAfterMutation(response)
        return response
      },
      listInvitations: async (payload?: unknown) => {
        return await getAuthApi().organization.listInvitations(
          withStoredSessionAuthorization(payload)
        )
      },
      inviteMember: async (payload: unknown) => {
        const response = await getAuthApi().organization.inviteMember(
          withStoredSessionAuthorization(payload)
        )
        refetchAfterMutation(response)
        return response
      },
      cancelInvitation: async (payload: unknown) => {
        const response = await getAuthApi().organization.cancelInvitation(
          withStoredSessionAuthorization(payload)
        )
        refetchAfterMutation(response)
        return response
      },
      removeMember: async (payload: unknown) => {
        const response = await getAuthApi().organization.removeMember(
          withStoredSessionAuthorization(payload)
        )
        refetchAfterMutation(response)
        return response
      },
      updateMemberRole: async (payload: unknown) => {
        const response = await getAuthApi().organization.updateMemberRole(
          withStoredSessionAuthorization(payload)
        )
        refetchAfterMutation(response)
        return response
      },
      setActive: async (payload: unknown) => {
        const response = await getAuthApi().organization.setActive(
          withStoredSessionAuthorization(payload)
        )
        refetchAfterMutation(response)
        return response
      },
      update: async (payload: unknown) => {
        const response = await getAuthApi().organization.update(
          withStoredSessionAuthorization(payload)
        )
        refetchAfterMutation(response)
        return response
      },
      create: async (payload: unknown) => {
        const response = await getAuthApi().organization.create(
          withStoredSessionAuthorization(payload)
        )
        refetchAfterMutation(response)
        return response
      },
      delete: async (payload: unknown) => {
        const response = await getAuthApi().organization.delete(
          withStoredSessionAuthorization(payload)
        )
        refetchAfterMutation(response)
        return response
      },
      leave: async (payload: unknown) => {
        const response = await getAuthApi().organization.leave(
          withStoredSessionAuthorization(payload)
        )
        refetchAfterMutation(response)
        return response
      }
    }
  }
}

function hasElectronAuthBridge() {
  if (typeof window === 'undefined') {
    return false
  }

  return (
    typeof window.requestAuth === 'function' &&
    typeof window.onUserUpdated === 'function' &&
    Boolean(getIpcServices())
  )
}

function createBrowserAuthClient() {
  return createLodyAuthClient({
    additionalPlugins: [
      electronProxyClient({
        protocol: {
          scheme: ELECTRON_PROTOCOL_SCHEME
        }
      })
    ]
  })
}

function createAuthClientForRuntime() {
  if (hasElectronAuthBridge()) {
    const client = createElectronAuthClientAdapter()
    for (const method of ELECTRON_ACCOUNT_AUTH_METHODS) {
      if (typeof client[method] !== 'function') {
        throw new Error(`Electron auth adapter is missing ${method}`)
      }
    }
    return client as unknown as LodyAuthClient
  }
  return createBrowserAuthClient()
}

export const authClient = createAuthClientForRuntime()

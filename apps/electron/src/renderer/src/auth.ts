import { electronProxyClient } from '@better-auth/electron/proxy'
import {
  ElectronDevEmailPasswordSignInInputSchema,
  isDevEmailPasswordLoginEnabled,
  type ElectronLoginState
} from '@lody/shared/electron-ipc'
import {
  clearLocalAuthState,
  createLodyAuthClient,
  type LodyAuthClient
} from '@lody/components/lib/auth'
import type { AuthSessionAtom, AuthSessionSnapshot } from '@lody/components/lib/auth-session-store'
import { jotaiStore } from '@lody/components/lib'
import {
  electronDeepLinkSignInInProgressAtom,
  electronLoginErrorAtom,
  electronLoginErrorDetailAtom,
  electronLoginPhaseAtom
} from '@lody/components/atoms/index'
import { readStoredAuthToken } from '@lody/components/lib/auth-bootstrap'
import { persistNativeAuthSessionResult as persistAuthSessionResult } from '@lody/components/lib/native-auth-session-sync'
import { getIpcServices, onIpcEvent } from '@lody/components/lib/electron-ipc-client'
import { createAuthQueryStore } from './auth-query-generation'

const ELECTRON_PROTOCOL_SCHEME = 'lody'
const ELECTRON_ACCOUNT_AUTH_METHODS = [
  'listAccounts',
  'updateUser',
  'changePassword',
  'requestPasswordReset'
] as const satisfies readonly (keyof LodyAuthClient)[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getAuthApi() {
  if (!getIpcServices()) {
    throw new Error('Electron auth bridge is not available')
  }
  const auth = getIpcServices()!.auth
  return {
    startLogin: auth.startLogin.bind(auth),
    getLoginState: auth.getLoginState.bind(auth),
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

function hasResponseError(response: unknown): boolean {
  return isRecord(response) && 'error' in response && response.error != null
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

const sessionStore = createAuthQueryStore<
  NonNullable<AuthSessionSnapshot['data']>,
  NonNullable<AuthSessionSnapshot['error']>
>(
  'getSession',
  async () => {
    return await getAuthApi().getSession(withStoredSessionAuthorization())
  },
  { onCommit: persistAuthSessionResult }
)

const organizationsStore = createAuthQueryStore('listOrganizations', async () => {
  return await getAuthApi().listOrganizations(withStoredSessionAuthorization())
})

const activeOrganizationStore = createAuthQueryStore('getActiveOrganization', async () => {
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

let loginRevision = -1
let loginPhase: ElectronLoginState['phase'] = 'idle'

function applyLoginState(state: ElectronLoginState): void {
  if (state.revision <= loginRevision) return
  loginRevision = state.revision
  loginPhase = state.phase
  jotaiStore.set(electronLoginPhaseAtom, state.phase)
  jotaiStore.set(electronLoginErrorAtom, state.error)
  jotaiStore.set(electronLoginErrorDetailAtom, state.errorDetail)
  // The initial idle snapshot must not erase a persisted login from a previous run.
  if (state.revision === 0) return
  if (state.phase === 'waiting' || state.phase === 'exchanging') {
    jotaiStore.set(electronDeepLinkSignInInProgressAtom, true)
    sessionStore.beginPending()
    organizationsStore.beginPending()
    activeOrganizationStore.beginPending()
    return
  }
  if (state.session) {
    organizationsStore.reset()
    activeOrganizationStore.reset()
    sessionStore.commitResponse(state.session)
    // Organization failure is independently retryable; it never rolls back identity.
    void refetchOrganizationState()
  } else if (state.phase === 'idle') {
    sessionStore.reset()
    organizationsStore.reset()
    activeOrganizationStore.reset()
    clearLocalAuthState()
  } else {
    sessionStore.releasePending()
    organizationsStore.releasePending()
    activeOrganizationStore.releasePending()
    // An exchange may have reached the server before a transport timeout. Resolve
    // the durable session once; never redeem its one-time code again.
    void refetchSessionState()
  }
  jotaiStore.set(electronDeepLinkSignInInProgressAtom, false)
}

let authListenersInitialized = false

function ensureAuthListeners() {
  if (authListenersInitialized) {
    return
  }
  if (typeof window.onUserUpdated !== 'function') {
    return
  }

  onIpcEvent('auth.loginState', applyLoginState)
  void getAuthApi()
    .getLoginState()
    .then(applyLoginState)
    .catch((error: unknown) => {
      jotaiStore.set(electronLoginErrorAtom, 'exchange_failed')
      jotaiStore.set(
        electronLoginErrorDetailAtom,
        `getLoginState: ${error instanceof Error ? error.message : String(error)}`
      )
    })

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

function refetchAfterMutation(response: unknown) {
  if (hasResponseError(response)) {
    return
  }
  void refetchOrganizationState()
  void refetchSessionState()
}

function createElectronAuthClientAdapter() {
  ensureAuthListeners()

  const store = {
    atoms: {
      session: sessionStore.atom
    },
    notify: (signal: string) => {
      if (signal === '$sessionSignal') {
        void refetchSessionState()
      } else if (signal === '$listOrg') {
        void organizationsStore.refetch()
      } else if (signal === '$activeOrgSignal') {
        void activeOrganizationStore.refetch()
      }
    }
  } satisfies {
    atoms: { session: AuthSessionAtom }
    notify: (signal: string) => void
  }

  return {
    $store: store,
    useSession: () => sessionStore.useQuery(),
    getSession: async (options?: unknown) => {
      const generation = loginRevision
      const response = await getAuthApi().getSession(withStoredSessionAuthorization(options))
      if (generation === loginRevision && loginPhase !== 'waiting' && loginPhase !== 'exchanging') {
        persistAuthSessionResult(response)
      }
      return response
    },
    signIn: {
      social: async (_options?: unknown) => {
        await getAuthApi().startLogin()
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
    if (!client.$store?.atoms?.session) {
      throw new Error('Electron auth adapter is missing $store.atoms.session')
    }
    return client as unknown as LodyAuthClient
  }
  return createBrowserAuthClient()
}

export const authClient = createAuthClientForRuntime()

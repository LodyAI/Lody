import type { DevframeAuthHandler } from 'devframe/node/auth'

export type DevbarControlInput = {
  enabled: boolean
  agentAccess: boolean
}

export function initialDevbarControl(envValue: string | undefined): DevbarControlInput {
  const enabled = envValue === 'true'
  return { enabled, agentAccess: enabled }
}

export function parseDevbarControlInput(value: unknown): DevbarControlInput {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Devbar control input must be an object')
  }
  const candidate = value as Partial<DevbarControlInput>
  if (typeof candidate.enabled !== 'boolean' || typeof candidate.agentAccess !== 'boolean') {
    throw new TypeError('Devbar control flags must be booleans')
  }
  if (!candidate.enabled && candidate.agentAccess) {
    throw new TypeError('Devbar agent access requires the Devbar to be enabled')
  }
  return { enabled: candidate.enabled, agentAccess: candidate.agentAccess }
}

export function devbarRendererEntry(enabled: boolean, auxiliary: boolean): string {
  return enabled && !auxiliary ? 'devbar.html' : 'index.html'
}

// Both opaque values the packaged renderer can present depending on the
// request kind: `null` (sandboxed/file fetch contexts) and `file://` (the
// Electron file scheme Chromium reports on upgrades). Only local content can
// produce either; the session layer still requires the per-process token.
const OPAQUE_LOCAL_ORIGINS = new Set(['null', 'file://'])

export function isAllowedDevbarRequestOrigin(
  requestOrigin: string | undefined,
  hubOrigin: string,
  rendererOrigin?: string
): boolean {
  return (
    requestOrigin === undefined ||
    OPAQUE_LOCAL_ORIGINS.has(requestOrigin) ||
    requestOrigin === hubOrigin ||
    requestOrigin === rendererOrigin
  )
}

const DEVBAR_AUTH_QUERY_PARAM = 'devframe_auth_token'

/**
 * Loopback auth gate for the Devbar Hub. Remote web content always presents
 * some Origin — either its real one (rejected by the HTTP origin check) or
 * `null` from a sandboxed frame. Opaque origins therefore must carry the
 * per-process token the renderer learns over IPC, which a sandboxed frame
 * cannot observe. The Hub's own origin, the dev renderer origin, and
 * non-browser callers without an Origin header stay inside the single-user
 * boundary.
 */
export function createDevbarAuth(
  token: string,
  trustedOrigins: () => { hub?: string; renderer?: string }
): DevframeAuthHandler {
  return {
    rpcFunctions: [],
    authorize: (methodName, session) =>
      methodName.startsWith('anonymous:') || session.meta.isTrusted === true,
    onConnect: (connection, session) => {
      let requestToken: string | undefined
      let requestOrigin: string | undefined
      try {
        requestToken =
          new URL(connection.request?.url ?? '', 'http://localhost').searchParams.get(
            DEVBAR_AUTH_QUERY_PARAM
          ) ?? undefined
      } catch {
        // A malformed request URL simply carries no token.
      }
      try {
        requestOrigin = connection.request?.headers?.get?.('origin') ?? undefined
      } catch {
        // Header lookup is optional on non-HTTP transports.
      }
      if (requestToken === token) {
        session.meta.clientAuthToken = requestToken
        session.meta.isTrusted = true
        return
      }
      const { hub, renderer } = trustedOrigins()
      if (requestOrigin === undefined || requestOrigin === hub || requestOrigin === renderer) {
        session.meta.isTrusted = true
      }
    },
    printBanner: () => {}
  }
}

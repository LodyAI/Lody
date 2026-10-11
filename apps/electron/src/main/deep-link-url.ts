import { desktopInstallationProfile } from './platform'
import { parseSessionLink, LODY_PROTOCOLS } from '@lody/shared/session-link'
import { getDesktopCallbackProtocol } from './desktop-channel'

const DEEP_LINK_PROTOCOL = desktopInstallationProfile.desktopProtocol
const PROTOCOL_PATTERN = DEEP_LINK_PROTOCOL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const DEEP_LINK_PREFIX = `${DEEP_LINK_PROTOCOL}://`
const WINDOWS_CALLBACK_MARKER = `\\${DEEP_LINK_PROTOCOL}\\callback`

function stripWrappingQuotes(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return ''
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export function parseDeepLinkArg(arg: string): string | null {
  const normalized = stripWrappingQuotes(arg)
  if (!normalized) {
    return null
  }
  // Resource URLs are channel-neutral; callback URLs still belong to the profile.
  if (parseSessionLink(normalized) && !normalized.startsWith('session://')) return normalized
  // Every advertised common-scheme route must reach routing (or a visible error),
  // even when it belongs to another installation.
  if (normalized.startsWith(`${LODY_PROTOCOLS.resource}://`)) return normalized
  if (normalized.startsWith(`${getDesktopCallbackProtocol(desktopInstallationProfile)}://`))
    return normalized

  const directPattern = new RegExp(`${PROTOCOL_PATTERN}:\\/\\/.+`, 'i')
  const directMatch = normalized.match(directPattern)
  if (directMatch && directMatch[0]) {
    return directMatch[0].replace(new RegExp(`^${PROTOCOL_PATTERN}:\\/\\/`, 'i'), DEEP_LINK_PREFIX)
  }

  const windowsStyleArg = normalized.replace(/\//g, '\\')
  const markerIndex = windowsStyleArg.toLowerCase().indexOf(WINDOWS_CALLBACK_MARKER)
  if (markerIndex < 0) {
    return null
  }

  const callbackPath = windowsStyleArg
    .slice(markerIndex + `\\${DEEP_LINK_PROTOCOL}\\`.length)
    .replace(/\\/g, '/')
  if (!callbackPath.toLowerCase().startsWith('callback')) {
    return null
  }

  return `${DEEP_LINK_PREFIX}${callbackPath}`
}

export function resolveDesktopDeepLink(
  url: string
): { kind: 'local'; url: string } | { kind: 'forward'; url: string } | { kind: 'unsupported' } {
  if (parseSessionLink(url)) return { kind: 'local', url }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { kind: 'unsupported' }
  }
  if (parsed.username || parsed.password || parsed.port) return { kind: 'unsupported' }
  const own = getDesktopCallbackProtocol(desktopInstallationProfile)
  const scheme = parsed.protocol.slice(0, -1)
  if (scheme !== LODY_PROTOCOLS.resource && scheme !== own) return { kind: 'unsupported' }
  const route = `${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}`
  const auth = route === 'auth/callback'
  const cloud =
    auth || ['invite/open', 'github-install', 'checkout-return', 'machine/connect'].includes(route)
  if (!cloud && route !== 'chat/new') return { kind: 'unsupported' }
  // Old common-scheme cloud callbacks belong to Stable, not the resource default.
  // OSS cannot process cloud routes even through its own private scheme.
  if (
    cloud &&
    own !== LODY_PROTOCOLS.stable &&
    (scheme === LODY_PROTOCOLS.resource || own === LODY_PROTOCOLS.local)
  ) {
    parsed.protocol = `${LODY_PROTOCOLS.stable}:`
    return { kind: 'forward', url: parsed.href }
  }
  // Existing renderer route readers use the common scheme. Auth stays in main.
  if (!auth) parsed.protocol = `${LODY_PROTOCOLS.resource}:`
  return { kind: 'local', url: parsed.href }
}

export function extractDeepLinkFromArgv(argv: readonly string[]): string | null {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const arg = argv[index]
    if (!arg) {
      continue
    }
    const parsed = parseDeepLinkArg(arg)
    if (parsed) {
      return parsed
    }
  }
  return null
}

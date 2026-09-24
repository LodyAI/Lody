import { desktopInstallationProfile } from './platform'

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

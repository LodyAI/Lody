import { LODY_PROTOCOLS, SESSION_LINK_SCHEMES, parseSessionLink } from '@lody/shared/session-link'

/**
 * A channel-neutral destination that every supported installation can resolve.
 * Auth and other cloud routes stay with their owning channel, so they are never
 * handed to whichever desktop happens to own the process-exclusion lease.
 */
const PORTABLE_ROUTES = new Set(['chat/new', 'provider/import'])
const INSTALLED_SCHEMES = new Set(SESSION_LINK_SCHEMES.map((scheme) => `${scheme}:`))

export const DESKTOP_HANDOFF_TYPE = 'lody/deep-link'
export const MAX_DESKTOP_HANDOFF_BYTES = 8 * 1024

/** Rewrites a portable destination to the common resource scheme. */
export function toPortableDesktopDeepLink(raw: string): string | null {
  if (raw.length > MAX_DESKTOP_HANDOFF_BYTES) return null

  if (parseSessionLink(raw)) {
    // Legacy session:// stays in-app reading compatibility, not a cross-process address.
    if (raw.startsWith('session://')) return null
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return null
    }
    parsed.protocol = `${LODY_PROTOCOLS.resource}:`
    return parsed.href
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.username || parsed.password || parsed.port || parsed.hash) return null
  if (!INSTALLED_SCHEMES.has(parsed.protocol)) return null
  const route = `${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}`
  if (!PORTABLE_ROUTES.has(route)) return null
  parsed.protocol = `${LODY_PROTOCOLS.resource}:`
  return parsed.href
}

export function formatDesktopHandoffLine(url: string): string | null {
  const portable = toPortableDesktopDeepLink(url)
  if (!portable) return null
  return `${JSON.stringify({ type: DESKTOP_HANDOFF_TYPE, url: portable })}\n`
}

export function parseDesktopHandoffLine(line: string): string | null {
  if (Buffer.byteLength(line, 'utf8') > MAX_DESKTOP_HANDOFF_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.type !== DESKTOP_HANDOFF_TYPE ||
    typeof record.url !== 'string' ||
    Object.keys(record).some((key) => key !== 'type' && key !== 'url')
  ) {
    return null
  }
  return toPortableDesktopDeepLink(record.url)
}

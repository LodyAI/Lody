import {
  LODY_PROTOCOLS,
  SESSION_LINK_SCHEMES
} from '../../../packages/shared/src/session-link-schemes.mjs'

/** Keep shared resource URLs separate from channel-specific callback dispatch. */
export function withDesktopResourceProtocols(protocols) {
  const entries = protocols == null ? [] : Array.isArray(protocols) ? protocols : [protocols]
  const schemes = new Set(entries.flatMap((entry) => entry.schemes ?? []))
  if (![...schemes].some((scheme) => SESSION_LINK_SCHEMES.includes(scheme))) return entries
  const callback = schemes.has(LODY_PROTOCOLS.nightly)
    ? LODY_PROTOCOLS.nightly
    : schemes.has(LODY_PROTOCOLS.local)
      ? LODY_PROTOCOLS.local
      : LODY_PROTOCOLS.stable
  const missing = [LODY_PROTOCOLS.resource, callback].filter((scheme) => !schemes.has(scheme))
  return missing.length ? [...entries, { name: 'Lody links', schemes: missing }] : entries
}

import { session } from 'electron'
import {
  DEFAULT_NO_PROXY,
  PROXY_ENV_KEYS,
  hasProxyEnvValue,
  withLoopbackNoProxy
} from '@lody/shared/proxy-env'

export const DEFAULT_SYSTEM_PROXY_PROBE_URLS = ['https://registry.npmjs.org'] as const

export function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return hasProxyEnvValue(env)
}

/**
 * Fill proxy variables from the system configuration when the inherited
 * environment has none, then guarantee loopback bypasses the proxy either way.
 *
 * The loopback guarantee is NOT part of the fallback: an environment that
 * already carries a proxy skipped the fallback entirely and so never had its
 * `NO_PROXY` normalized, which is how a shell exporting `no_proxy=…` next to
 * an empty `NO_PROXY=` reached the bundled CLI and its agent children. Clients
 * that read the uppercase spelling first then proxied Lody's own loopback
 * services. See `@lody/shared/proxy-env`.
 */
export function applyProxyEnvFallback(env: NodeJS.ProcessEnv, proxyEnv: NodeJS.ProcessEnv): void {
  if (!hasProxyEnv(env) && hasProxyEnv(proxyEnv)) {
    for (const key of PROXY_ENV_KEYS) {
      const value = proxyEnv[key]
      if (typeof value === 'string' && value.trim().length > 0 && env[key] === undefined) {
        env[key] = value
      }
    }
  }

  const normalized = withLoopbackNoProxy(env)
  if (normalized !== env) {
    env.NO_PROXY = normalized.NO_PROXY
    env.no_proxy = normalized.no_proxy
  }
}

/** How long one system proxy lookup may take. A stalled PAC script or WPAD discovery
 * can otherwise hold `resolveProxy` for minutes; the lookup then counts as direct. */
export const SYSTEM_PROXY_LOOKUP_TIMEOUT_MS = 3_000

/** One bounded lookup: a late answer is ignored and never rejects. */
function lookupWithin(lookup: Promise<string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), timeoutMs)
    lookup.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve('')
      }
    )
  })
}

export async function resolveSystemProxyEnv(
  probeUrls: readonly string[] = DEFAULT_SYSTEM_PROXY_PROBE_URLS,
  options: {
    readonly timeoutMs?: number
    readonly resolveProxy?: (url: string) => Promise<string>
  } = {}
): Promise<NodeJS.ProcessEnv> {
  if (process.env.LODY_ELECTRON_DISABLE_SYSTEM_PROXY_ENV === '1') {
    return {}
  }
  const resolveProxy =
    options.resolveProxy ?? ((url: string) => session.defaultSession.resolveProxy(url))

  for (const probeUrl of probeUrls) {
    let lookup: Promise<string>
    try {
      lookup = resolveProxy(probeUrl)
    } catch {
      continue
    }
    const resolved = await lookupWithin(lookup, options.timeoutMs ?? SYSTEM_PROXY_LOOKUP_TIMEOUT_MS)
    const proxyUrl = parseResolvedProxyRules(resolved)
    if (proxyUrl) {
      return {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        NO_PROXY: DEFAULT_NO_PROXY
      }
    }
  }

  return {}
}

export function parseResolvedProxyRules(rules: string): string | undefined {
  for (const part of rules.split(';')) {
    const trimmed = part.trim()
    if (!trimmed || trimmed.toUpperCase() === 'DIRECT') {
      continue
    }

    const [kindRaw, ...rest] = trimmed.split(/\s+/u)
    const kind = kindRaw?.toUpperCase()
    const hostPort = rest.join('')
    if (!kind || !hostPort) {
      continue
    }

    if (kind === 'PROXY') {
      return toProxyUrl('http', hostPort)
    }
    if (kind === 'HTTPS') {
      return toProxyUrl('https', hostPort)
    }
  }

  return undefined
}

function toProxyUrl(protocol: 'http' | 'https', hostPort: string): string | undefined {
  try {
    const url = new URL(`${protocol}://${hostPort}`)
    if (!url.hostname) {
      return undefined
    }
    return `${url.protocol}//${url.host}`
  } catch {
    return undefined
  }
}

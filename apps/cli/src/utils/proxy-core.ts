import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import type { Agent } from 'http';
import { redactProxyUrl } from './log-sanitize';

export interface ProxyAgentResolution {
  agent?: Agent;
  /**
   * Raw proxy URL, including credentials when configured. This is for transport
   * construction only. Never write this value to logs.
   */
  proxyUrl?: string;
  proxyUrlRedacted?: string;
}

const SCHEME_PREFIX_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const warnedProxyUrls = new Set<string>();

const getProxyForUrlWithWsFallback = (targetUrl: string): string => {
  try {
    const url = new URL(targetUrl);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      const proto = url.protocol.slice(0, -1);
      const hasExplicitWsProxy = Boolean(
        process.env[`npm_config_${proto}_proxy`] ||
        process.env[`NPM_CONFIG_${proto.toUpperCase()}_PROXY`] ||
        process.env[`${proto}_proxy`] ||
        process.env[`${proto.toUpperCase()}_PROXY`]
      );

      if (hasExplicitWsProxy) {
        return getProxyForUrl(targetUrl);
      }

      // proxy-from-env keys off the URL protocol, so `wss://` looks for `WSS_PROXY` rather than
      // `HTTPS_PROXY`. Most environments only set HTTP(S)_PROXY, so we map ws(s) -> http(s).
      const mapped = new URL(url.toString());
      mapped.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
      return getProxyForUrl(mapped.toString());
    }
  } catch {
    // Ignore parse errors and treat as no proxy.
  }

  return getProxyForUrl(targetUrl);
};

export function resolveProxyAgentCore(
  targetUrl: string,
  onWarn?: (message: string) => void
): ProxyAgentResolution {
  const resolved = resolveProxyUrlCore(targetUrl, onWarn);
  if (!resolved.proxyUrl) {
    return {};
  }

  return {
    agent: new HttpsProxyAgent(resolved.proxyUrl),
    proxyUrl: resolved.proxyUrl,
    proxyUrlRedacted: resolved.proxyUrlRedacted,
  };
}

export function resolveProxyUrlCore(
  targetUrl: string,
  onWarn?: (message: string) => void
): Omit<ProxyAgentResolution, 'agent'> {
  const rawProxyUrl = getProxyForUrlWithWsFallback(targetUrl);
  if (!rawProxyUrl) {
    return {};
  }

  const proxyUrl = normalizeProxyUrl(rawProxyUrl);
  if (!proxyUrl) {
    warnUnsupportedProxyUrl(rawProxyUrl, onWarn);
    return {};
  }

  return {
    proxyUrl,
    proxyUrlRedacted: redactProxyUrl(proxyUrl),
  };
}

/**
 * Normalize a proxy URL from the environment into something undici's `ProxyAgent`
 * and `https-proxy-agent` can consume. Both only accept `http:`/`https:` proxies;
 * anything else (e.g. `socks5://`) makes their constructors throw
 * `UND_ERR_INVALID_ARG` ("Invalid URL protocol"), which otherwise crashes every
 * fetch routed through the shared dispatcher.
 *
 * - A scheme-less value (`proxy.corp:8080`) is treated as an HTTP proxy, matching
 *   the convention used by curl and most HTTP clients.
 * - An unsupported or unparseable scheme returns `undefined`, so the caller falls
 *   back to a direct connection instead of crashing.
 */
function normalizeProxyUrl(rawProxyUrl: string): string | undefined {
  const trimmed = rawProxyUrl.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = SCHEME_PREFIX_RE.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }

  return candidate;
}

function warnUnsupportedProxyUrl(
  rawProxyUrl: string,
  onWarn: (message: string) => void = (message) => console.error(message)
): void {
  const redacted = redactProxyUrl(rawProxyUrl);
  if (warnedProxyUrls.has(redacted)) {
    return;
  }
  warnedProxyUrls.add(redacted);
  onWarn(
    `[proxy] ignoring unsupported proxy URL ${redacted}: only http:// and https:// proxies are ` +
      `supported (e.g. socks proxies are not); using a direct connection instead`
  );
}

/**
 * Proxy environment normalization shared by the CLI (agent child processes)
 * and the Electron main process (bundled CLI + managed runtimes).
 *
 * Lody talks to several of its own services over loopback — most importantly
 * the shared MCP HTTP host on `http://127.0.0.1:<port>/mcp`. An agent runtime
 * that inherits a corporate/VPN proxy must NOT send those requests to the
 * proxy: the proxy either refuses to connect to the client's own loopback or
 * dials its own, and the client reports a truncated connection rather than a
 * useful status code.
 *
 * The default bypass lists are not enough on their own, because clients
 * disagree about what an EMPTY variable means. Rust's `reqwest` reads the
 * uppercase `NO_PROXY` first and treats a present-but-empty value as "bypass
 * nothing", so a shell that exports `no_proxy=localhost,127.0.0.1,::1` and
 * `NO_PROXY=` proxies loopback anyway — the exact shape observed on Grok
 * sessions whose MCP initialize died as `hyper::Error(IncompleteMessage)`.
 *
 * So we write BOTH spellings to the same union, which removes the
 * disagreement regardless of which one a given client prefers.
 *
 * This happens even when the environment carries no proxy variable: the
 * agent can apply a proxy Lody never sees — its own settings file (Claude's
 * `settings.json` `env`) or the OS proxy its HTTP client reads directly. A
 * proxy that cannot reach the client's loopback answers in the host's place
 * (observed as an empty `HTTP 503`), and the agent reports the built-in MCP
 * as failed to start.
 * Without a proxy the bypass list is inert, so adding loopback costs nothing.
 */

export const PROXY_ENV_KEYS = [
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'npm_config_proxy',
  'npm_config_http_proxy',
  'npm_config_https_proxy',
] as const;

/** Hosts every Lody-internal loopback endpoint is reachable on. */
export const LOOPBACK_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

export const DEFAULT_NO_PROXY = LOOPBACK_NO_PROXY_HOSTS.join(',');

const isSet = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

/** True when any proxy variable holds a non-empty value. An empty string is
 * not a proxy — treating it as one would skip filling a real system proxy. */
export function hasProxyEnvValue(env: Record<string, string | undefined>): boolean {
  return PROXY_ENV_KEYS.some((key) => isSet(env[key]));
}

/**
 * Union of the two `NO_PROXY` spellings plus the loopback hosts, in a form
 * both spellings can be set to. A `*` wildcard collapses to `*`.
 */
export function mergeLoopbackNoProxy(upper: string | undefined, lower: string | undefined): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  // Union rather than "first non-empty wins": the two spellings may carry
  // different lists, and dropping either would remove a bypass the user
  // deliberately configured.
  for (const raw of [upper, lower]) {
    for (const part of (raw ?? '').split(',')) {
      const entry = part.trim();
      if (entry.length === 0) {
        continue;
      }
      if (entry === '*') {
        return '*';
      }
      const key = entry.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push(entry);
    }
  }
  for (const host of LOOPBACK_NO_PROXY_HOSTS) {
    if (!seen.has(host)) {
      seen.add(host);
      entries.push(host);
    }
  }
  return entries.join(',');
}

/**
 * Returns an environment in which loopback is guaranteed to bypass any proxy
 * the child applies, or the input unchanged when both spellings already agree
 * on the right value.
 */
export function withLoopbackNoProxy<T extends Record<string, string | undefined>>(env: T): T {
  const merged = mergeLoopbackNoProxy(env.NO_PROXY, env.no_proxy);
  if (env.NO_PROXY === merged && env.no_proxy === merged) {
    return env;
  }
  return { ...env, NO_PROXY: merged, no_proxy: merged };
}

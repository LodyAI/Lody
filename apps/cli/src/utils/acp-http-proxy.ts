import http from 'node:http';
import https from 'node:https';
import { hasProxyEnvValue } from '@lody/shared/proxy-env';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  Agent,
  Pool,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { resolveProxyUrlCore } from './proxy-core';
import { fetchWithUndiciDispatcher } from './undici-fetch-compat';

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONCURRENT_STREAMS = 100;
const MAX_CACHED_PROXY_AGENTS = 32;
const DISABLED_TRANSPORT_VALUES = new Set(['0', 'false', 'no', 'off', 'disable', 'disabled']);
const NODE_DEFAULT_TRANSPORT_VALUES = new Set(['default', 'node', 'native']);
const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

type GlobalAgentWithAddRequest = http.Agent & {
  addRequest: (req: http.ClientRequest, options: http.RequestOptions, ...rest: unknown[]) => void;
};

let activeDispatcher: Agent | null = null;
let previousGlobalDispatcher: Dispatcher | null = null;
let installedFetchWrapper: typeof globalThis.fetch | null = null;
let originalGlobalFetch: typeof globalThis.fetch | null = null;
let originalHttpAddRequest: GlobalAgentWithAddRequest['addRequest'] | null = null;
let originalHttpsAddRequest: GlobalAgentWithAddRequest['addRequest'] | null = null;
const cachedProxyAgents = new Map<string, HttpsProxyAgent<string>>();

export interface AcpAdapterHttpProxyOptions {
  env?: NodeJS.ProcessEnv;
  onWarn?: (message: string) => void;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTransportDisabled(env: NodeJS.ProcessEnv): boolean {
  const mode = normalizeEnvValue(env.LODY_HTTP_TRANSPORT);
  return (
    mode !== undefined &&
    (NODE_DEFAULT_TRANSPORT_VALUES.has(mode) || DISABLED_TRANSPORT_VALUES.has(mode))
  );
}

function getCachedProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  const existing = cachedProxyAgents.get(proxyUrl);
  if (existing) {
    cachedProxyAgents.delete(proxyUrl);
    cachedProxyAgents.set(proxyUrl, existing);
    return existing;
  }
  const created = new HttpsProxyAgent(proxyUrl);
  cachedProxyAgents.set(proxyUrl, created);
  if (cachedProxyAgents.size > MAX_CACHED_PROXY_AGENTS) {
    const oldest = cachedProxyAgents.keys().next().value;
    if (oldest !== undefined) {
      const removed = cachedProxyAgents.get(oldest);
      cachedProxyAgents.delete(oldest);
      removed?.destroy();
    }
  }
  return created;
}

function buildNodeHttpTargetUrl(
  defaultProtocol: 'http:' | 'https:',
  options: http.RequestOptions,
  req: http.ClientRequest
): string | undefined {
  if (options.socketPath) return undefined;
  const protocol =
    options.protocol === 'http:' || options.protocol === 'https:'
      ? options.protocol
      : defaultProtocol;
  const rawHost = options.hostname || options.host;
  if (!rawHost) return undefined;
  const hostHasPort = rawHost.startsWith('[') ? /\]:\d+$/.test(rawHost) : /:\d+$/.test(rawHost);
  const formattedHost =
    rawHost.includes(':') && !rawHost.startsWith('[') && !hostHasPort ? `[${rawHost}]` : rawHost;
  const portSuffix =
    !hostHasPort && options.port !== undefined && String(options.port).length > 0
      ? `:${options.port}`
      : '';
  const path = typeof req.path === 'string' && req.path.startsWith('/') ? req.path : '/';
  return `${protocol}//${formattedHost}${portSuffix}${path}`;
}

function patchGlobalAgent(
  agent: GlobalAgentWithAddRequest,
  defaultProtocol: 'http:' | 'https:',
  saveOriginal: (fn: GlobalAgentWithAddRequest['addRequest']) => void,
  onWarn: (message: string) => void
): void {
  const original = agent.addRequest.bind(agent);
  saveOriginal(original);
  agent.addRequest = function patchedAddRequest(
    req: http.ClientRequest,
    options: http.RequestOptions,
    ...rest: unknown[]
  ) {
    const targetUrl = buildNodeHttpTargetUrl(defaultProtocol, options, req);
    const resolved = targetUrl ? resolveProxyUrlCore(targetUrl, onWarn) : {};
    if (resolved.proxyUrl) {
      const proxyAgent = getCachedProxyAgent(
        resolved.proxyUrl
      ) as unknown as GlobalAgentWithAddRequest;
      return proxyAgent.addRequest(req, options, ...rest);
    }
    return original(req, options, ...rest);
  };
}

/**
 * Installs env-proxy routing (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`)
 * for standalone ACP adapter child processes without altering `User-Agent` or
 * importing CLI file/console loggers (which would pollute ACP `stdout`).
 */
export function installAcpAdapterHttpProxySupport(options: AcpAdapterHttpProxyOptions = {}): void {
  const env = options.env ?? process.env;
  if (isTransportDisabled(env) || !hasProxyEnvValue(env)) {
    return;
  }

  const onWarn = options.onWarn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const allowH2Normalized = normalizeEnvValue(env.LODY_HTTP2);
  const allowH2 = allowH2Normalized !== undefined && ENABLED_VALUES.has(allowH2Normalized);
  const connectTimeoutMs = parsePositiveIntegerEnv(
    env.LODY_HTTP_CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS
  );
  const maxConcurrentStreams = parsePositiveIntegerEnv(
    env.LODY_HTTP2_MAX_CONCURRENT_STREAMS,
    DEFAULT_MAX_CONCURRENT_STREAMS
  );

  if (!activeDispatcher) {
    activeDispatcher = new Agent({
      factory: (origin) => {
        const originUrl = origin.toString();
        const resolved = resolveProxyUrlCore(originUrl, onWarn);
        if (resolved.proxyUrl) {
          return new ProxyAgent({
            uri: resolved.proxyUrl,
            proxyTunnel: true,
            allowH2,
            maxConcurrentStreams,
            requestTls: { timeout: connectTimeoutMs },
            proxyTls: { timeout: connectTimeoutMs, autoSelectFamily: true },
          });
        }
        return new Pool(origin, {
          allowH2,
          maxConcurrentStreams,
          connect: { timeout: connectTimeoutMs, autoSelectFamily: true },
        });
      },
    });
  }

  previousGlobalDispatcher ??= getGlobalDispatcher();
  setGlobalDispatcher(activeDispatcher);

  if (!installedFetchWrapper) {
    originalGlobalFetch = globalThis.fetch;
    installedFetchWrapper = (input, init) => {
      const dispatcher = activeDispatcher;
      if (!dispatcher) {
        return (originalGlobalFetch ?? fetch)(input, init);
      }
      return fetchWithUndiciDispatcher(input, init, dispatcher);
    };
    globalThis.fetch = installedFetchWrapper;
  }

  if (!originalHttpAddRequest) {
    patchGlobalAgent(
      http.globalAgent as unknown as GlobalAgentWithAddRequest,
      'http:',
      (fn) => {
        originalHttpAddRequest = fn;
      },
      onWarn
    );
  }
  if (!originalHttpsAddRequest) {
    patchGlobalAgent(
      https.globalAgent as unknown as GlobalAgentWithAddRequest,
      'https:',
      (fn) => {
        originalHttpsAddRequest = fn;
      },
      onWarn
    );
  }
}

export async function resetAcpAdapterHttpProxySupportForTests(): Promise<void> {
  if (originalHttpAddRequest) {
    (http.globalAgent as unknown as GlobalAgentWithAddRequest).addRequest = originalHttpAddRequest;
    originalHttpAddRequest = null;
  }
  if (originalHttpsAddRequest) {
    (https.globalAgent as unknown as GlobalAgentWithAddRequest).addRequest =
      originalHttpsAddRequest;
    originalHttpsAddRequest = null;
  }
  if (installedFetchWrapper && globalThis.fetch === installedFetchWrapper && originalGlobalFetch) {
    globalThis.fetch = originalGlobalFetch;
  }
  installedFetchWrapper = null;
  originalGlobalFetch = null;
  for (const agent of cachedProxyAgents.values()) {
    agent.destroy();
  }
  cachedProxyAgents.clear();
  const previous = activeDispatcher;
  activeDispatcher = null;
  if (previousGlobalDispatcher) {
    setGlobalDispatcher(previousGlobalDispatcher);
    previousGlobalDispatcher = null;
  }
  await previous?.close();
}

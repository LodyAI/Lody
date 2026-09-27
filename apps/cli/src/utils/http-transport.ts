import { channel } from 'node:diagnostics_channel';
import {
  Agent,
  Pool,
  ProxyAgent,
  fetch as undiciFetch,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { sanitizeUrlForLogging } from './log-sanitize';
import { getLogger, type Logger } from './logger';
import { resolveProxyUrl } from './proxy';

export type CliFetch = typeof globalThis.fetch;

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONCURRENT_STREAMS = 100;
const DISABLED_TRANSPORT_VALUES = new Set(['0', 'false', 'no', 'off', 'disable', 'disabled']);
const NODE_DEFAULT_TRANSPORT_VALUES = new Set(['default', 'node', 'native']);
const ENABLED_DIAGNOSTIC_VALUES = new Set(['1', 'true', 'yes', 'on']);
const HTTP_PROXY_ENV_KEYS = [
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

export interface CliHttpTransportConfig {
  enabled: boolean;
  allowH2: boolean;
  connectTimeoutMs: number;
  maxConcurrentStreams: number;
  diagnosticsEnabled: boolean;
  proxyEnvPresent: boolean;
}

export interface CliHttpTransport {
  dispatcher: Dispatcher;
  fetch: CliFetch;
  diagnostics: () => CliHttpTransportConfig;
  close: () => Promise<void>;
}

export interface CliHttpTransportOptions {
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}

let singletonTransport: CliHttpTransport | null = null;
let singletonConfigKey: string | null = null;
let undiciDiagnosticsInstalled = false;

export function resolveCliHttpTransportConfig(
  env: NodeJS.ProcessEnv = process.env
): CliHttpTransportConfig {
  const transportMode = normalizeEnvValue(env.LODY_HTTP_TRANSPORT);
  const transportDisabled =
    transportMode !== undefined &&
    (NODE_DEFAULT_TRANSPORT_VALUES.has(transportMode) ||
      DISABLED_TRANSPORT_VALUES.has(transportMode));
  const allowH2 = isEnabledEnvValue(env.LODY_HTTP2);
  const connectTimeoutMs = parsePositiveIntegerEnv(
    env.LODY_HTTP_CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS
  );
  const maxConcurrentStreams = parsePositiveIntegerEnv(
    env.LODY_HTTP2_MAX_CONCURRENT_STREAMS,
    DEFAULT_MAX_CONCURRENT_STREAMS
  );
  const diagnosticsEnabled = isEnabledEnvValue(env.LODY_HTTP_TRANSPORT_DIAGNOSTICS);

  return {
    enabled: !transportDisabled,
    allowH2,
    connectTimeoutMs,
    maxConcurrentStreams,
    diagnosticsEnabled,
    proxyEnvPresent: hasProxyEnv(env),
  };
}

export function createCliHttpTransport(
  config: CliHttpTransportConfig,
  logger: Logger
): CliHttpTransport {
  const dispatcher = new Agent({
    factory: (origin) => {
      const originUrl = origin.toString();
      const resolvedProxy = resolveProxyUrl(originUrl);

      if (resolvedProxy.proxyUrl) {
        logger.debug(
          `[http-transport] using proxy for origin=${sanitizeUrlForLogging(originUrl)} proxy=${
            resolvedProxy.proxyUrlRedacted ?? 'configured'
          } allowH2=${config.allowH2}`
        );
        return new ProxyAgent({
          uri: resolvedProxy.proxyUrl,
          proxyTunnel: true,
          allowH2: config.allowH2,
          maxConcurrentStreams: config.maxConcurrentStreams,
          requestTls: {
            timeout: config.connectTimeoutMs,
          },
          proxyTls: {
            timeout: config.connectTimeoutMs,
            autoSelectFamily: true,
          },
        });
      }

      logger.debug(
        `[http-transport] using direct dispatcher for origin=${sanitizeUrlForLogging(
          originUrl
        )} allowH2=${config.allowH2}`
      );
      return new Pool(origin, {
        allowH2: config.allowH2,
        maxConcurrentStreams: config.maxConcurrentStreams,
        connect: {
          timeout: config.connectTimeoutMs,
          // Try both address families even if the embedding runtime disables it.
          autoSelectFamily: true,
        },
      });
    },
  });

  const fetchImpl: CliFetch = async (input, init) => {
    const nextInit = {
      ...(init ?? {}),
      dispatcher,
    } as NonNullable<Parameters<typeof undiciFetch>[1]>;
    const response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], nextInit);
    return response as unknown as Response;
  };

  return {
    dispatcher,
    fetch: fetchImpl,
    diagnostics: () => ({ ...config }),
    close: async () => {
      await dispatcher.close();
    },
  };
}

export function installCliHttpGlobalDispatcher(
  options: CliHttpTransportOptions = {}
): CliHttpTransport | null {
  const logger = options.logger ?? getLogger('http-transport');
  const transport = getOrCreateCliHttpTransport(options);
  const config = resolveCliHttpTransportConfig(options.env);

  if (!transport) {
    logger.debug('[http-transport] using Node default global dispatcher');
    return null;
  }

  setGlobalDispatcher(transport.dispatcher);

  if (config.diagnosticsEnabled) {
    installUndiciDiagnostics(logger);
  }

  logger.debug(
    `[http-transport] installed Undici global dispatcher allowH2=${config.allowH2} proxyEnv=${config.proxyEnvPresent} diagnostics=${config.diagnosticsEnabled}`
  );
  return transport;
}

export function getCliHttpFetch(options: CliHttpTransportOptions = {}): CliFetch {
  const transport = getOrCreateCliHttpTransport(options);
  return transport?.fetch ?? globalThis.fetch.bind(globalThis);
}

export async function resetCliHttpTransportForTests(): Promise<void> {
  const previous = singletonTransport;
  singletonTransport = null;
  singletonConfigKey = null;
  await previous?.close();
}

function getOrCreateCliHttpTransport(options: CliHttpTransportOptions): CliHttpTransport | null {
  const logger = options.logger ?? getLogger('http-transport');
  const config = resolveCliHttpTransportConfig(options.env);

  if (!config.enabled) {
    return null;
  }

  const configKey = getConfigKey(config);
  if (singletonTransport && singletonConfigKey === configKey) {
    return singletonTransport;
  }

  const previous = singletonTransport;
  singletonTransport = createCliHttpTransport(config, logger);
  singletonConfigKey = configKey;
  void previous?.close().catch((error: unknown) => {
    logger.debug(
      `[http-transport] failed to close replaced dispatcher: ${formatUnknownError(error)}`
    );
  });
  return singletonTransport;
}

function installUndiciDiagnostics(logger: Logger): void {
  if (undiciDiagnosticsInstalled) {
    return;
  }
  undiciDiagnosticsInstalled = true;

  channel('undici:client:connected').subscribe((message: unknown) => {
    const record = asRecord(message);
    const socket = asRecord(record?.socket);
    const connectParams = asRecord(record?.connectParams);
    const alpn = readString(socket, 'alpnProtocol') ?? 'unknown';
    const origin =
      readString(connectParams, 'origin') ??
      readString(connectParams, 'host') ??
      readString(connectParams, 'hostname') ??
      'unknown';
    logger.debug(
      `[http-transport] undici connected origin=${sanitizeUrlForLogging(origin)} alpn=${alpn}`
    );
  });

  channel('undici:proxy:connected').subscribe((message: unknown) => {
    const record = asRecord(message);
    const proxy = readString(record, 'proxy') ?? readString(record, 'origin') ?? 'configured';
    logger.debug(`[http-transport] undici proxy connected proxy=${sanitizeUrlForLogging(proxy)}`);
  });
}

function getConfigKey(config: CliHttpTransportConfig): string {
  return [
    config.enabled,
    config.allowH2,
    config.connectTimeoutMs,
    config.maxConcurrentStreams,
    config.diagnosticsEnabled,
    config.proxyEnvPresent,
  ].join(':');
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return HTTP_PROXY_ENV_KEYS.some((key) => {
    const value = env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function isEnabledEnvValue(value: string | undefined): boolean {
  const normalized = normalizeEnvValue(value);
  return normalized !== undefined && ENABLED_DIAGNOSTIC_VALUES.has(normalized);
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { z } from 'zod';

/** Public profile references contain no credential or filesystem location. */
export const CodexAuthProfileSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('chatgpt'), profileId: z.uuid() }).strict(),
  z
    .object({
      mode: z.literal('api-key'),
      profileId: z.uuid(),
      baseUrl: z
        .string()
        .max(2048)
        .transform((value, context) => {
          try {
            return normalizeCodexEndpoint(value);
          } catch {
            context.addIssue({ code: 'custom', message: 'Invalid Codex Base URL' });
            return z.NEVER;
          }
        }),
    })
    .strict(),
]);

export type CodexAuthProfile = z.infer<typeof CodexAuthProfileSchema>;

// NUL is never a valid executable path on supported hosts. Older daemons retain
// this override and fail before native login or model startup can use global auth.
export const CODEX_PROFILE_LEGACY_LAUNCH_GUARD = '\0lody-codex-profile-v1';

export function encodeCodexProfileConfig<
  T extends {
    codexAuth?: CodexAuthProfile;
    runtimeOverrides?: { codexPath?: string };
  },
>(config: T): T {
  return config.codexAuth
    ? { ...config, runtimeOverrides: { codexPath: CODEX_PROFILE_LEGACY_LAUNCH_GUARD } }
    : config;
}

export function normalizeCodexEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new Error('Enter a valid Codex Base URL');
  }
  const loopback =
    endpoint.hostname === 'localhost' ||
    endpoint.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))
  ) {
    throw new Error(
      'Codex Base URL requires HTTPS, except for loopback HTTP, without credentials or query parameters'
    );
  }
  return endpoint.toString().replace(/\/+$/, '');
}

const PROTECTED_ENV = new Set([
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'MODEL_PROVIDER',
  'DEFAULT_AUTH_REQUEST',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'CODEX_HOME',
  'CODEX_PATH',
  'CODEX_CONFIG',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CLIENT_ID',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_AUTH_CLIENT_ID',
  'LODY_CODEX_API_KEY',
]);

export function assertManagedCodexProfileConfig(config: {
  cliType: string;
  agentType: string;
  codexAuth?: CodexAuthProfile;
  customAcp?: unknown;
  runtimeOverrides?: unknown;
  env?: Record<string, string | undefined>;
}): void {
  if (!config.codexAuth) return;
  CodexAuthProfileSchema.parse(config.codexAuth);
  if (
    config.cliType !== 'builtin' ||
    config.agentType !== 'codex' ||
    config.customAcp ||
    config.runtimeOverrides
  ) {
    throw new Error('Codex account profiles require the managed Codex runtime');
  }
  if (
    Object.keys(config.env ?? {}).some(
      (key) =>
        PROTECTED_ENV.has(key.toUpperCase()) || /^(CODEX_|OPENAI_|LODY_CODEX_|DYLD_)/i.test(key)
    )
  ) {
    throw new Error('Additional environment variables cannot override a Codex account connection');
  }
}

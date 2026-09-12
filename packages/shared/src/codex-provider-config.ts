export const CODEX_API_KEY_ENV = 'CODEX_API_KEY';
export const CODEX_CONFIG_ENV = 'CODEX_CONFIG';
export const LODY_CODEX_API_KEY_ENV = 'LODY_CODEX_CUSTOM_ENDPOINT_API_KEY';
export const LODY_CODEX_PROVIDER_STATE_ENV = 'LODY_CODEX_CUSTOM_ENDPOINT_STATE';
export const LODY_CODEX_MODEL_PROVIDER_ID = 'lody-custom-endpoint';

export type CodexAuthenticationMode = 'chatgpt' | 'api-key';
export type LodyCodexCustomProvider = {
  baseUrl: string;
  credentialRevision?: string;
};
export type CodexCredentialBoundConfig = {
  cliType: string;
  agentType: string;
  customAcp?: unknown;
  runtimeOverrides?: unknown;
  env: Record<string, string>;
};

type AgentConfigEnvironment = {
  env: Record<string, string | undefined> | undefined;
};

export function isReservedCodexCredentialEnvKey(key: string): boolean {
  // Windows treats environment variable names case-insensitively at process launch.
  return key.toUpperCase() === LODY_CODEX_API_KEY_ENV;
}

export function agentConfigContainsCodexCredential(config: AgentConfigEnvironment): boolean {
  return Boolean(config.env && Object.keys(config.env).some(isReservedCodexCredentialEnvKey));
}

export function assertAgentConfigDoesNotContainCodexCredential(
  config: AgentConfigEnvironment
): void {
  if (agentConfigContainsCodexCredential(config)) {
    throw new Error(`${LODY_CODEX_API_KEY_ENV} is reserved for machine-local credential injection`);
  }
}
type ProviderState = {
  v: 1;
  previousModelProvider: { present: false } | { present: true; value: unknown };
  credentialRevision?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseState(value: string | undefined): ProviderState | null {
  const state = parseRecord(value);
  const previous = asRecord(state?.previousModelProvider);
  if (typeof previous?.present !== 'boolean') return null;
  if (
    state?.credentialRevision !== undefined &&
    (typeof state.credentialRevision !== 'string' ||
      !state.credentialRevision.trim() ||
      state.credentialRevision.length > 1024)
  ) {
    return null;
  }
  const previousModelProvider = previous.present
    ? ({ present: true, value: previous.value } as const)
    : ({ present: false } as const);
  if (state?.v !== 1) return null;
  return {
    v: 1,
    previousModelProvider,
    ...(state.credentialRevision ? { credentialRevision: state.credentialRevision } : {}),
  };
}

function deleteReservedCodexCredentialEnvKeys(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (isReservedCodexCredentialEnvKey(key)) delete env[key];
  }
}

export function isAllowedCredentialEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const octets = hostname.split('.').map(Number);
  return (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 127
  );
}

export function getLodyCodexCustomProvider(
  env: Record<string, string | undefined> | undefined
): LodyCodexCustomProvider | null {
  const config = parseRecord(env?.[CODEX_CONFIG_ENV]);
  const state = parseState(env?.[LODY_CODEX_PROVIDER_STATE_ENV]);
  if (!state) return null;
  if (config?.model_provider !== LODY_CODEX_MODEL_PROVIDER_ID) return null;
  const provider = asRecord(asRecord(config.model_providers)?.[LODY_CODEX_MODEL_PROVIDER_ID]);
  if (
    !provider ||
    typeof provider.base_url !== 'string' ||
    provider.env_key !== LODY_CODEX_API_KEY_ENV ||
    provider.requires_openai_auth !== false ||
    provider.wire_api !== 'responses'
  ) {
    return null;
  }
  return {
    baseUrl: provider.base_url,
    ...(state.credentialRevision ? { credentialRevision: state.credentialRevision } : {}),
  };
}

/** Bind a non-secret credential generation to the config selected by Flock publication. */
export function withLodyCodexCredentialRevision(
  env: Record<string, string>,
  credentialRevision: string
): Record<string, string> {
  const normalizedRevision = credentialRevision.trim();
  const state = parseState(env[LODY_CODEX_PROVIDER_STATE_ENV]);
  if (!getLodyCodexCustomProvider(env) || !state) {
    throw new Error('Cannot bind a credential revision to an unmanaged Codex provider');
  }
  if (!normalizedRevision || normalizedRevision.length > 1024) {
    throw new Error('Codex credential revision must contain 1 to 1024 characters');
  }
  return {
    ...env,
    [LODY_CODEX_PROVIDER_STATE_ENV]: JSON.stringify({
      ...state,
      credentialRevision: normalizedRevision,
    } satisfies ProviderState),
  };
}

export function getLodyCodexCredentialBinding(config: CodexCredentialBoundConfig): string | null {
  if (!getLodyCodexCustomProvider(config.env)) return null;
  return JSON.stringify({
    cliType: config.cliType,
    agentType: config.agentType,
    customAcp: config.customAcp ?? null,
    runtimeOverrides: config.runtimeOverrides ?? null,
    env: Object.fromEntries(
      Object.entries(config.env)
        .filter(([key]) => !isReservedCodexCredentialEnvKey(key))
        .sort(([left], [right]) => left.localeCompare(right))
    ),
  });
}

export function buildLodyCodexCustomProviderEnv(
  env: Record<string, string>,
  input: Pick<LodyCodexCustomProvider, 'baseUrl'>
): Record<string, string> {
  const baseUrl = input.baseUrl.trim();
  if (!isAllowedCredentialEndpoint(baseUrl)) {
    throw new Error('Codex credential endpoints must use HTTPS, except for loopback HTTP');
  }
  const next = { ...env };
  const rawConfig = next[CODEX_CONFIG_ENV];
  const config = rawConfig?.trim() ? parseRecord(rawConfig) : {};
  if (!config) throw new Error('CODEX_CONFIG must contain a JSON object');
  const providers = { ...(asRecord(config.model_providers) ?? {}) };
  const existingState = parseState(next[LODY_CODEX_PROVIDER_STATE_ENV]);
  if (next[LODY_CODEX_PROVIDER_STATE_ENV]?.trim() && !existingState) {
    throw new Error(`${LODY_CODEX_PROVIDER_STATE_ENV} is already defined`);
  }
  if (!existingState && LODY_CODEX_MODEL_PROVIDER_ID in providers) {
    throw new Error(`CODEX_CONFIG already defines ${LODY_CODEX_MODEL_PROVIDER_ID}`);
  }
  const previousModelProvider =
    existingState?.previousModelProvider ??
    (Object.prototype.hasOwnProperty.call(config, 'model_provider')
      ? { present: true as const, value: config.model_provider }
      : { present: false as const });
  const state: ProviderState = {
    v: 1,
    previousModelProvider,
    ...(existingState?.credentialRevision
      ? { credentialRevision: existingState.credentialRevision }
      : {}),
  };
  providers[LODY_CODEX_MODEL_PROVIDER_ID] = {
    name: 'Custom OpenAI-compatible endpoint',
    base_url: baseUrl,
    env_key: LODY_CODEX_API_KEY_ENV,
    wire_api: 'responses',
    requires_openai_auth: false,
  };
  deleteReservedCodexCredentialEnvKeys(next);
  next[LODY_CODEX_PROVIDER_STATE_ENV] = JSON.stringify(state);
  next[CODEX_CONFIG_ENV] = JSON.stringify({
    ...config,
    model_provider: LODY_CODEX_MODEL_PROVIDER_ID,
    model_providers: providers,
  });
  return next;
}

export function removeLodyCodexCustomProviderEnv(
  env: Record<string, string>
): Record<string, string> {
  if (!getLodyCodexCustomProvider(env)) return { ...env };
  const next = { ...env };
  const config = parseRecord(next[CODEX_CONFIG_ENV]);
  const state = parseState(next[LODY_CODEX_PROVIDER_STATE_ENV]);
  if (!config || !state) return next;
  const providers = { ...(asRecord(config.model_providers) ?? {}) };
  delete providers[LODY_CODEX_MODEL_PROVIDER_ID];
  if (state.previousModelProvider.present) {
    config.model_provider = state.previousModelProvider.value;
  } else {
    delete config.model_provider;
  }
  if (Object.keys(providers).length > 0) config.model_providers = providers;
  else delete config.model_providers;
  deleteReservedCodexCredentialEnvKeys(next);
  delete next[LODY_CODEX_PROVIDER_STATE_ENV];
  if (Object.keys(config).length > 0) next[CODEX_CONFIG_ENV] = JSON.stringify(config);
  else delete next[CODEX_CONFIG_ENV];
  return next;
}

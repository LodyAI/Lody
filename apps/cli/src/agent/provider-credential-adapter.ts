import {
  getLodyCodexCredentialBindingDigest,
  getLodyCodexCustomProvider,
  isAllowedCredentialEndpoint,
  LODY_CODEX_API_KEY_ENV,
  type AgentConfigMeta,
} from '@lody/shared';

export type ProviderCredentialConfig = Pick<
  AgentConfigMeta,
  'id' | 'cliType' | 'agentType' | 'customAcp' | 'runtimeOverrides' | 'env'
>;

export type ProviderCredentialAdapter = {
  readonly kind: string;
  getBindingDigest: (config: ProviderCredentialConfig) => string | null;
  normalizeSecret: (config: ProviderCredentialConfig, secret: string) => string;
  injectSecret: <T extends ProviderCredentialConfig>(config: T, secret: string) => T;
};

const codexCustomEndpointCredentialAdapter: ProviderCredentialAdapter = {
  kind: 'codex-custom-endpoint',
  getBindingDigest: getLodyCodexCredentialBindingDigest,
  normalizeSecret: (config, secret) => {
    const provider = getLodyCodexCustomProvider(config.env);
    const normalizedSecret = secret.trim();
    if (!provider || !isAllowedCredentialEndpoint(provider.baseUrl) || !normalizedSecret) {
      throw new Error('Invalid Codex custom endpoint credential');
    }
    return normalizedSecret;
  },
  injectSecret: <T extends ProviderCredentialConfig>(config: T, secret: string): T =>
    ({
      ...config,
      env: { ...config.env, [LODY_CODEX_API_KEY_ENV]: secret },
    }) as T,
};

const providerCredentialAdapters: readonly ProviderCredentialAdapter[] = [
  codexCustomEndpointCredentialAdapter,
];

export type ResolvedProviderCredentialAdapter = {
  adapter: ProviderCredentialAdapter;
  bindingDigest: string;
};

export function resolveProviderCredentialAdapter(
  config: ProviderCredentialConfig
): ResolvedProviderCredentialAdapter | null {
  let resolved: ResolvedProviderCredentialAdapter | null = null;
  for (const adapter of providerCredentialAdapters) {
    const bindingDigest = adapter.getBindingDigest(config);
    if (!bindingDigest) continue;
    if (resolved) {
      throw new Error(
        `Multiple provider credential adapters match config ${config.id}: ${resolved.adapter.kind}, ${adapter.kind}`
      );
    }
    resolved = { adapter, bindingDigest };
  }
  return resolved;
}

export function getProviderCredentialBindingDigest(
  config: ProviderCredentialConfig
): string | null {
  return resolveProviderCredentialAdapter(config)?.bindingDigest ?? null;
}

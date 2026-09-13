export const BUILTIN_MCP_PROVIDER_IDS = [
  'linear',
  'notion',
  'cloudflare',
  'posthog',
  'feishu',
] as const;

export type BuiltinMcpProviderId = (typeof BUILTIN_MCP_PROVIDER_IDS)[number];
export type BuiltinMcpAccessProfile = 'readonly' | 'read_write' | 'provider_selected';
export type BuiltinMcpAuthKind = 'mcp_oauth' | 'provider_secret_url';

export type BuiltinMcpProviderDefinition = {
  id: BuiltinMcpProviderId;
  displayName: string;
  docsUrl: string;
  setupUrl?: string;
  endpoint?: string;
  oauthResource?: string;
  oauthAllowedOrigins?: readonly string[];
  oauthIssuer?: string;
  authKind: BuiltinMcpAuthKind;
  defaultAccessProfile: BuiltinMcpAccessProfile;
  accessProfiles: readonly BuiltinMcpAccessProfile[];
  presetVersion: number;
};

export const BUILTIN_MCP_PROVIDERS: readonly BuiltinMcpProviderDefinition[] = [
  {
    id: 'linear',
    displayName: 'Linear',
    docsUrl: 'https://linear.app/docs/mcp',
    endpoint: 'https://mcp.linear.app/mcp/readonly',
    oauthAllowedOrigins: ['https://mcp.linear.app'],
    oauthIssuer: 'https://mcp.linear.app',
    authKind: 'mcp_oauth',
    defaultAccessProfile: 'readonly',
    accessProfiles: ['readonly', 'read_write'],
    presetVersion: 1,
  },
  {
    id: 'notion',
    displayName: 'Notion',
    docsUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
    endpoint: 'https://mcp.notion.com/mcp',
    oauthAllowedOrigins: ['https://mcp.notion.com'],
    oauthIssuer: 'https://mcp.notion.com',
    authKind: 'mcp_oauth',
    defaultAccessProfile: 'provider_selected',
    accessProfiles: ['provider_selected'],
    presetVersion: 1,
  },
  {
    id: 'cloudflare',
    displayName: 'Cloudflare',
    docsUrl: 'https://github.com/cloudflare/mcp',
    endpoint: 'https://mcp.cloudflare.com/mcp',
    oauthAllowedOrigins: ['https://mcp.cloudflare.com'],
    oauthIssuer: 'https://mcp.cloudflare.com',
    authKind: 'mcp_oauth',
    defaultAccessProfile: 'provider_selected',
    accessProfiles: ['provider_selected'],
    presetVersion: 1,
  },
  {
    id: 'posthog',
    displayName: 'PostHog',
    docsUrl: 'https://posthog.com/docs/model-context-protocol',
    endpoint: 'https://mcp.posthog.com/mcp?mode=cli&readonly=true',
    oauthResource: 'https://mcp.posthog.com/mcp',
    oauthAllowedOrigins: ['https://mcp.posthog.com', 'https://oauth.posthog.com'],
    oauthIssuer: 'https://oauth.posthog.com',
    authKind: 'mcp_oauth',
    defaultAccessProfile: 'readonly',
    accessProfiles: ['readonly', 'read_write'],
    presetVersion: 1,
  },
  {
    id: 'feishu',
    displayName: 'Feishu',
    docsUrl:
      'https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_introduction?lang=zh-CN',
    setupUrl: 'https://open.feishu.cn/page/mcp',
    authKind: 'provider_secret_url',
    defaultAccessProfile: 'provider_selected',
    accessProfiles: ['provider_selected'],
    presetVersion: 1,
  },
] as const;

const PROVIDER_BY_ID = new Map(
  BUILTIN_MCP_PROVIDERS.map((provider) => [provider.id, provider] as const)
);

export const isBuiltinMcpProviderId = (value: unknown): value is BuiltinMcpProviderId =>
  typeof value === 'string' && PROVIDER_BY_ID.has(value as BuiltinMcpProviderId);

export const getBuiltinMcpProvider = (
  providerId: BuiltinMcpProviderId
): BuiltinMcpProviderDefinition => {
  const provider = PROVIDER_BY_ID.get(providerId);
  if (!provider) {
    throw new Error(`Unknown built-in MCP provider: ${providerId}`);
  }
  return provider;
};

export const isBuiltinMcpAccessProfile = (value: unknown): value is BuiltinMcpAccessProfile =>
  value === 'readonly' || value === 'read_write' || value === 'provider_selected';

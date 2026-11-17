// Generated from Web agent-config-dialog.tsx, SHA256 af948c090c5e6b506438747c3b01bba32b2e417c151f7606e7fa4ccfe7be1af4.
export type ProviderPresetDefinition = {
  id: string;
  name: string;
  brandId: string;
  cliType: string;
  agentType: string;
  tokenEnvKey: string;
  modes: {
    id: string;
    name: string;
    env: Record<string, string>;
    tokenPrefix?: string;
    customEndpoint: boolean;
    endpoints: { id: string; name: string; url: string }[];
    endpoint?: string;
  }[];
};
export const providerPresets: ProviderPresetDefinition[] = [
  {
    id: 'deepseek-over-claude-code',
    name: 'DeepSeek over Claude Code',
    brandId: 'deepseek',
    cliType: 'builtin',
    agentType: 'claude',
    tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    modes: [
      {
        id: 'default',
        name: 'Default',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
          CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-pro',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
          CLAUDE_CODE_EFFORT_LEVEL: 'max',
        },
        customEndpoint: false,
        endpoints: [],
        endpoint: 'https://api.deepseek.com/anthropic',
      },
    ],
  },
  {
    id: 'deepseek-reasonix',
    name: 'DeepSeek Reasonix',
    brandId: 'deepseek',
    cliType: 'registry',
    agentType: 'reasonix',
    tokenEnvKey: 'DEEPSEEK_API_KEY',
    modes: [
      {
        id: 'default',
        name: 'Default',
        env: {},
        customEndpoint: false,
        endpoints: [],
      },
    ],
  },
  {
    id: 'mimo-over-claude-code',
    name: 'MiMo over Claude Code',
    brandId: 'mimo',
    cliType: 'builtin',
    agentType: 'claude',
    tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    modes: [
      {
        id: 'pay-as-you-go',
        name: 'Pay-as-you-go API',
        env: {
          ANTHROPIC_MODEL: 'mimo-v2.5-pro',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
          ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic',
        },
        tokenPrefix: 'sk-',
        customEndpoint: false,
        endpoints: [],
        endpoint: 'https://api.xiaomimimo.com/anthropic',
      },
      {
        id: 'token-plan',
        name: 'Token Plan',
        env: {
          ANTHROPIC_MODEL: 'mimo-v2.5-pro',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
        },
        tokenPrefix: 'tp-',
        customEndpoint: true,
        endpoints: [
          {
            id: 'cn',
            name: 'China Cluster',
            url: 'https://token-plan-cn.xiaomimimo.com/anthropic',
          },
          {
            id: 'sgp',
            name: 'Singapore Cluster',
            url: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
          },
          {
            id: 'ams',
            name: 'Europe Cluster',
            url: 'https://token-plan-ams.xiaomimimo.com/anthropic',
          },
        ],
        endpoint: 'https://token-plan-cn.xiaomimimo.com/anthropic',
      },
    ],
  },
  {
    id: 'minimax-over-claude-code',
    name: 'MiniMax over Claude Code',
    brandId: 'minimax',
    cliType: 'builtin',
    agentType: 'claude',
    tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    modes: [
      {
        id: 'default',
        name: 'Default',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
          API_TIMEOUT_MS: '3000000',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ANTHROPIC_MODEL: 'MiniMax-M3',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
        },
        customEndpoint: false,
        endpoints: [],
        endpoint: 'https://api.minimaxi.com/anthropic',
      },
    ],
  },
  {
    id: 'glm-over-claude-code',
    name: 'GLM over Claude Code',
    brandId: 'glm',
    cliType: 'builtin',
    agentType: 'claude',
    tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
    modes: [
      {
        id: 'bigmodel',
        name: 'bigmodel.cn (Zhipu)',
        env: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          API_TIMEOUT_MS: '3000000',
          ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        },
        customEndpoint: false,
        endpoints: [],
        endpoint: 'https://open.bigmodel.cn/api/anthropic',
      },
      {
        id: 'zai',
        name: 'z.ai',
        env: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          API_TIMEOUT_MS: '3000000',
          ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        },
        customEndpoint: false,
        endpoints: [],
        endpoint: 'https://api.z.ai/api/anthropic',
      },
    ],
  },
];

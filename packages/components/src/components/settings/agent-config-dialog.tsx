import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import {
  computeTitleGenerationDefaults,
  DEEPSEEK_HARNESS_API_KEY_ENV,
  DEEPSEEK_HARNESS_BASE_URL_ENV,
  formatCustomAcpCommandLine,
  getAcpCapabilityCacheEntryAuthority,
  getAcpCapabilityCacheKey,
  getStaticBuiltinAcpCapabilities,
  getBuiltinTitleGenerationDefaults,
  getRegistryAcpLaunchKind,
  machineSupportsProviderSetupProtocol,
  isManagedBuiltinAgentType,
  isAcpCapabilityCacheEntryCurrent,
  parseCustomAcpCommandLine,
  serializeCustomAcpLaunchSpec,
  machineSupportsAcpProtocolAuthentication,
  supportsBuiltinAuthentication,
  usesAcpProtocolAuthentication,
  usesAcpProvidedSessionTitle,
  REGISTRY_ACP_AGENTS,
  type AgentBrandId,
  type AgentConfigCliType,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentType,
  type ManagedBuiltinAgentType,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
  type MachineAcpBinaryProgressMessage,
  type MachineAcpBinaryStatusResponse,
  type MachineAcpCapabilitiesRefreshResponse,
  type MachineId,
  type MachineViewMeta,
  type TitleGenerationConfig,
} from '@lody/shared';
import {
  buildAllConfigOptionSelectors,
  isConfigOptionValueValid,
  type AcpConfigOptionSelector,
  type AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FlaskConical,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react';
import { AgentIcon } from '@/components/icons/agent-icon';
import { cn } from '@/lib/utils';
import { useKeyboardAwareScrollIntoView } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { useMachineAcpBinaryProgress } from '@/hooks/use-machine-acp-binary-progress';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { EnvVarsTextarea, envVarsToText } from './env-vars-textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { AcpAuthenticationPanel } from './acp-authentication-panel';

type Translate = ReturnType<typeof useTranslation>['t'];

// =============================================================================
// Preset definitions
// =============================================================================

export const DEEPSEEK_CLAUDE_PRESET_ID = 'deepseek-over-claude-code';
export const DEEPSEEK_REASONIX_PRESET_ID = 'deepseek-reasonix';
const DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com';
const LEGACY_DSH_MODELS_ENV = 'ACP_EXTENSION_DSH_MODELS';
type DeepSeekEndpointMode = 'official' | 'custom';
export const MIMO_CLAUDE_PRESET_ID = 'mimo-over-claude-code';
export const MINIMAX_CLAUDE_PRESET_ID = 'minimax-over-claude-code';
export const GLM_CLAUDE_PRESET_ID = 'glm-over-claude-code';
export const MIMO_PAY_AS_YOU_GO_CREDENTIAL_MODE_ID = 'pay-as-you-go';
export const MIMO_TOKEN_PLAN_CREDENTIAL_MODE_ID = 'token-plan';
const MIMO_TOKEN_PLAN_CUSTOM_BASE_URL_OPTION_ID = 'custom';
export const GLM_BIGMODEL_CREDENTIAL_MODE_ID = 'bigmodel';
export const GLM_ZAI_CREDENTIAL_MODE_ID = 'zai';

type PresetId =
  | typeof DEEPSEEK_CLAUDE_PRESET_ID
  | typeof DEEPSEEK_REASONIX_PRESET_ID
  | typeof MIMO_CLAUDE_PRESET_ID
  | typeof MINIMAX_CLAUDE_PRESET_ID
  | typeof GLM_CLAUDE_PRESET_ID;

type PresetBaseUrlOption = {
  id: string;
  labelKey: string;
  labelDefault: string;
  value: string;
};

type PresetCredentialMode = {
  id: string;
  labelKey: string;
  labelDefault: string;
  descriptionKey: string;
  descriptionDefault: string;
  tokenPrefix?: string;
  tokenLabelKey?: string;
  tokenLabelDefault?: string;
  tokenPlaceholderKey?: string;
  tokenPlaceholderDefault?: string;
  tokenHelpKey?: string;
  tokenHelpDefault?: string;
  tokenEnvKey?: string;
  fixedEnv?: Record<string, string>;
  baseUrlEnvKey?: string;
  baseUrlLabelKey?: string;
  baseUrlLabelDefault?: string;
  baseUrlHelpKey?: string;
  baseUrlHelpDefault?: string;
  baseUrlPlaceholderKey?: string;
  baseUrlPlaceholderDefault?: string;
  baseUrlOptions?: PresetBaseUrlOption[];
  defaultBaseUrlOptionId?: string;
  customBaseUrlOptionId?: string;
};

type PresetDefinition = {
  id: PresetId;
  /** Provider brand persisted onto the created agent config so its icon shows everywhere. */
  brandId: AgentBrandId;
  label: string;
  labelKey: string;
  descriptionKey: string;
  descriptionDefault: string;
  /** Underlying ACP runtime kind. */
  cliType: AgentConfigCliType;
  /** Underlying runtime agent. */
  agentType: string;
  /** Short badge shown in the left rail (e.g. "Preset"). */
  badge: string;
  /** Token field shown on the right side. */
  tokenLabelKey: string;
  tokenLabelDefault: string;
  tokenPlaceholderKey: string;
  tokenPlaceholderDefault: string;
  tokenHelpKey: string;
  tokenHelpDefault: string;
  helpUrl?: string;
  helpLinkLabelKey?: string;
  helpLinkLabelDefault?: string;
  /** Env var that stores the user-supplied token. */
  tokenEnvKey: string;
  /** Fixed env vars (other than the token) this preset injects on submit. */
  fixedEnv: Record<string, string>;
  credentialModes?: PresetCredentialMode[];
  /** Label/hint for the credential-mode chooser; defaults to MiMo-flavored copy. */
  credentialModeGroupLabelKey?: string;
  credentialModeGroupLabelDefault?: string;
  credentialModeGroupHintKey?: string;
  credentialModeGroupHintDefault?: string;
};

const DEEPSEEK_CLAUDE_PRESET: PresetDefinition = {
  id: DEEPSEEK_CLAUDE_PRESET_ID,
  brandId: 'deepseek',
  label: 'DeepSeek over Claude Code',
  labelKey: 'settings.agent.dialog.preset.deepseekClaude.label',
  descriptionKey: 'settings.agent.dialog.preset.deepseekClaude.description',
  descriptionDefault: 'Route Claude Code through DeepSeek — just paste your API token.',
  cliType: 'builtin',
  agentType: 'claude',
  badge: 'Preset',
  tokenLabelKey: 'settings.agent.dialog.preset.deepseekClaude.tokenLabel',
  tokenLabelDefault: 'DeepSeek API token',
  tokenPlaceholderKey: 'settings.agent.dialog.preset.deepseekClaude.tokenPlaceholder',
  tokenPlaceholderDefault: 'sk-XXXXXXXXXXXX',
  tokenHelpKey: 'settings.agent.dialog.preset.deepseekClaude.tokenHelp',
  tokenHelpDefault: 'Create or copy one at platform.deepseek.com.',
  tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
  fixedEnv: {
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
};

const DEEPSEEK_REASONIX_PRESET: PresetDefinition = {
  id: DEEPSEEK_REASONIX_PRESET_ID,
  brandId: 'deepseek',
  label: 'DeepSeek Reasonix',
  labelKey: 'settings.agent.dialog.preset.deepseekReasonix.label',
  descriptionKey: 'settings.agent.dialog.preset.deepseekReasonix.description',
  descriptionDefault: 'Run DeepSeek Reasonix through ACP — just paste your API token.',
  cliType: 'registry',
  agentType: 'reasonix',
  badge: 'Preset',
  tokenLabelKey: 'settings.agent.dialog.preset.deepseekReasonix.tokenLabel',
  tokenLabelDefault: 'DeepSeek API token',
  tokenPlaceholderKey: 'settings.agent.dialog.preset.deepseekReasonix.tokenPlaceholder',
  tokenPlaceholderDefault: 'sk-XXXXXXXXXXXX',
  tokenHelpKey: 'settings.agent.dialog.preset.deepseekReasonix.tokenHelp',
  tokenHelpDefault: 'Create or copy one at platform.deepseek.com.',
  tokenEnvKey: 'DEEPSEEK_API_KEY',
  fixedEnv: {},
};

const MIMO_TOKEN_PLAN_BASE_URL_OPTIONS: PresetBaseUrlOption[] = [
  {
    id: 'cn',
    labelKey: 'settings.agent.dialog.preset.mimoClaude.baseUrl.cn',
    labelDefault: 'China Cluster',
    value: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  },
  {
    id: 'sgp',
    labelKey: 'settings.agent.dialog.preset.mimoClaude.baseUrl.sgp',
    labelDefault: 'Singapore Cluster',
    value: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
  },
  {
    id: 'ams',
    labelKey: 'settings.agent.dialog.preset.mimoClaude.baseUrl.ams',
    labelDefault: 'Europe Cluster',
    value: 'https://token-plan-ams.xiaomimimo.com/anthropic',
  },
  {
    id: MIMO_TOKEN_PLAN_CUSTOM_BASE_URL_OPTION_ID,
    labelKey: 'settings.agent.dialog.preset.mimoClaude.baseUrl.custom',
    labelDefault: 'Custom',
    value: '',
  },
];

const MIMO_CLAUDE_PRESET: PresetDefinition = {
  id: MIMO_CLAUDE_PRESET_ID,
  brandId: 'mimo',
  label: 'MiMo over Claude Code',
  labelKey: 'settings.agent.dialog.preset.mimoClaude.label',
  descriptionKey: 'settings.agent.dialog.preset.mimoClaude.description',
  descriptionDefault: 'Route Claude Code through Xiaomi MiMo — just paste your token.',
  cliType: 'builtin',
  agentType: 'claude',
  badge: 'Preset',
  tokenLabelKey: 'settings.agent.dialog.preset.mimoClaude.tokenLabel',
  tokenLabelDefault: 'MiMo Anthropic-compatible token',
  tokenPlaceholderKey: 'settings.agent.dialog.preset.mimoClaude.tokenPlaceholder',
  tokenPlaceholderDefault: 'Paste your Anthropic-compatible Token',
  tokenHelpKey: 'settings.agent.dialog.preset.mimoClaude.tokenHelp',
  tokenHelpDefault: 'Paste the Anthropic-compatible Token from Xiaomi MiMo.',
  helpUrl: 'https://platform.xiaomimimo.com/docs/en-US/integration/claudecode',
  helpLinkLabelKey: 'settings.agent.dialog.preset.mimoClaude.helpLink',
  helpLinkLabelDefault: 'Open MiMo Claude Code setup guide',
  tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
  fixedEnv: {
    ANTHROPIC_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  },
  credentialModes: [
    {
      id: MIMO_PAY_AS_YOU_GO_CREDENTIAL_MODE_ID,
      labelKey: 'settings.agent.dialog.preset.mimoClaude.mode.payg.label',
      labelDefault: 'Pay-as-you-go API',
      descriptionKey: 'settings.agent.dialog.preset.mimoClaude.mode.payg.description',
      descriptionDefault: 'Use an sk- API Key. Base URL is configured automatically.',
      tokenPrefix: 'sk-',
      tokenLabelKey: 'settings.agent.dialog.preset.mimoClaude.mode.payg.tokenLabel',
      tokenLabelDefault: 'MiMo API Key',
      tokenPlaceholderKey: 'settings.agent.dialog.preset.mimoClaude.mode.payg.tokenPlaceholder',
      tokenPlaceholderDefault: 'sk-xxxxx',
      tokenHelpKey: 'settings.agent.dialog.preset.mimoClaude.mode.payg.tokenHelp',
      tokenHelpDefault: 'Paste the sk- API Key from MiMo API Keys.',
      fixedEnv: {
        ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic',
      },
    },
    {
      id: MIMO_TOKEN_PLAN_CREDENTIAL_MODE_ID,
      labelKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.label',
      labelDefault: 'Token Plan',
      descriptionKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.description',
      descriptionDefault: 'Use a tp- API Key and the Anthropic Base URL from Subscription.',
      tokenPrefix: 'tp-',
      tokenLabelKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.tokenLabel',
      tokenLabelDefault: 'MiMo Token Plan API Key',
      tokenPlaceholderKey:
        'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.tokenPlaceholder',
      tokenPlaceholderDefault: 'tp-xxxxx',
      tokenHelpKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.tokenHelp',
      tokenHelpDefault: 'Paste the tp- API Key from the MiMo Subscription page.',
      baseUrlEnvKey: 'ANTHROPIC_BASE_URL',
      baseUrlLabelKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.baseUrlLabel',
      baseUrlLabelDefault: 'Token Plan Anthropic Base URL',
      baseUrlHelpKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.baseUrlHelp',
      baseUrlHelpDefault:
        'Choose the cluster shown on Subscription, or choose Custom and paste the Anthropic-compatible Base URL.',
      baseUrlPlaceholderKey:
        'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.baseUrlPlaceholder',
      baseUrlPlaceholderDefault: 'https://token-plan-xxx.xiaomimimo.com/anthropic',
      baseUrlOptions: MIMO_TOKEN_PLAN_BASE_URL_OPTIONS,
      defaultBaseUrlOptionId: 'cn',
      customBaseUrlOptionId: MIMO_TOKEN_PLAN_CUSTOM_BASE_URL_OPTION_ID,
    },
  ],
};

const MINIMAX_CLAUDE_PRESET: PresetDefinition = {
  id: MINIMAX_CLAUDE_PRESET_ID,
  brandId: 'minimax',
  label: 'MiniMax over Claude Code',
  labelKey: 'settings.agent.dialog.preset.minimaxClaude.label',
  descriptionKey: 'settings.agent.dialog.preset.minimaxClaude.description',
  descriptionDefault: 'Route Claude Code through MiniMax — just paste your API key.',
  cliType: 'builtin',
  agentType: 'claude',
  badge: 'Preset',
  tokenLabelKey: 'settings.agent.dialog.preset.minimaxClaude.tokenLabel',
  tokenLabelDefault: 'MiniMax API key',
  tokenPlaceholderKey: 'settings.agent.dialog.preset.minimaxClaude.tokenPlaceholder',
  tokenPlaceholderDefault: 'Paste your MiniMax API key',
  tokenHelpKey: 'settings.agent.dialog.preset.minimaxClaude.tokenHelp',
  tokenHelpDefault: 'Create or copy one at platform.minimaxi.com.',
  tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
  fixedEnv: {
    ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
    API_TIMEOUT_MS: '3000000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
  },
};

// Shared across both GLM endpoints; only ANTHROPIC_BASE_URL differs per mode.
const GLM_SHARED_ENV: Record<string, string> = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  API_TIMEOUT_MS: '3000000',
};

const GLM_CLAUDE_PRESET: PresetDefinition = {
  id: GLM_CLAUDE_PRESET_ID,
  brandId: 'glm',
  label: 'GLM over Claude Code',
  labelKey: 'settings.agent.dialog.preset.glmClaude.label',
  descriptionKey: 'settings.agent.dialog.preset.glmClaude.description',
  descriptionDefault:
    'Route Claude Code through Zhipu GLM — pick an endpoint and paste your API key.',
  cliType: 'builtin',
  agentType: 'claude',
  badge: 'Preset',
  tokenLabelKey: 'settings.agent.dialog.preset.glmClaude.tokenLabel',
  tokenLabelDefault: 'GLM API key',
  tokenPlaceholderKey: 'settings.agent.dialog.preset.glmClaude.tokenPlaceholder',
  tokenPlaceholderDefault: 'Paste your GLM API key',
  tokenHelpKey: 'settings.agent.dialog.preset.glmClaude.tokenHelp',
  tokenHelpDefault: "Create or copy one from the selected endpoint's console.",
  tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
  fixedEnv: GLM_SHARED_ENV,
  credentialModeGroupLabelKey: 'settings.agent.dialog.preset.glmClaude.endpointLabel',
  credentialModeGroupLabelDefault: 'Endpoint',
  credentialModeGroupHintKey: 'settings.agent.dialog.preset.glmClaude.endpointHint',
  credentialModeGroupHintDefault: 'Choose the GLM endpoint that matches your API key.',
  credentialModes: [
    {
      id: GLM_BIGMODEL_CREDENTIAL_MODE_ID,
      labelKey: 'settings.agent.dialog.preset.glmClaude.mode.bigmodel.label',
      labelDefault: 'bigmodel.cn (Zhipu)',
      descriptionKey: 'settings.agent.dialog.preset.glmClaude.mode.bigmodel.description',
      descriptionDefault: 'Zhipu BigModel open platform (China).',
      tokenLabelKey: 'settings.agent.dialog.preset.glmClaude.mode.bigmodel.tokenLabel',
      tokenLabelDefault: 'Zhipu API key',
      tokenHelpKey: 'settings.agent.dialog.preset.glmClaude.mode.bigmodel.tokenHelp',
      tokenHelpDefault: 'Create or copy one at open.bigmodel.cn.',
      fixedEnv: {
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      },
    },
    {
      id: GLM_ZAI_CREDENTIAL_MODE_ID,
      labelKey: 'settings.agent.dialog.preset.glmClaude.mode.zai.label',
      labelDefault: 'z.ai',
      descriptionKey: 'settings.agent.dialog.preset.glmClaude.mode.zai.description',
      descriptionDefault: 'Z.ai international endpoint.',
      tokenLabelKey: 'settings.agent.dialog.preset.glmClaude.mode.zai.tokenLabel',
      tokenLabelDefault: 'z.ai API key',
      tokenHelpKey: 'settings.agent.dialog.preset.glmClaude.mode.zai.tokenHelp',
      tokenHelpDefault: 'Create or copy one at z.ai.',
      fixedEnv: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      },
    },
  ],
};

const PRESETS: PresetDefinition[] = [
  DEEPSEEK_CLAUDE_PRESET,
  DEEPSEEK_REASONIX_PRESET,
  MIMO_CLAUDE_PRESET,
  MINIMAX_CLAUDE_PRESET,
  GLM_CLAUDE_PRESET,
];
const PRESETS_BY_ID: Record<string, PresetDefinition> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p])
);

// =============================================================================
// Agent type options (left rail)
// =============================================================================

type AgentTypeOption = {
  kind: 'builtin' | 'preset' | 'registry' | 'custom';
  value: string;
  label: string;
  description?: string;
  labelKey?: string;
  descriptionKey?: string;
  descriptionDefault?: string;
  cliType: AgentConfigCliType;
  agentType: string;
  presetId?: PresetId;
  experimental?: boolean;
  searchKeys: string;
};

const BUILTIN_OPTIONS: AgentTypeOption[] = [
  {
    kind: 'builtin',
    value: 'builtin:kimi',
    label: 'Kimi Code',
    descriptionKey: 'settings.agent.dialog.option.kimi.description',
    descriptionDefault: 'Moonshot AI Kimi Code runtime',
    cliType: 'builtin',
    agentType: 'kimi',
    searchKeys: 'kimi moonshot',
  },
  {
    kind: 'builtin',
    value: 'builtin:grok',
    label: 'Grok',
    descriptionDefault: 'xAI Grok coding agent runtime',
    cliType: 'builtin',
    agentType: 'grok',
    searchKeys: 'grok xai',
  },
  {
    kind: 'builtin',
    value: 'builtin:claude',
    label: 'Claude',
    descriptionKey: 'settings.agent.dialog.option.claude.description',
    descriptionDefault: 'Anthropic Claude Code runtime',
    cliType: 'builtin',
    agentType: 'claude',
    searchKeys: 'claude anthropic',
  },
  {
    kind: 'builtin',
    value: 'builtin:codex',
    label: 'Codex',
    descriptionKey: 'settings.agent.dialog.option.codex.description',
    descriptionDefault: 'OpenAI Codex runtime',
    cliType: 'builtin',
    agentType: 'codex',
    searchKeys: 'codex openai',
  },
  {
    kind: 'builtin',
    value: 'builtin:deepseek',
    label: 'DeepSeek Harness',
    descriptionKey: 'settings.agent.dialog.option.deepseek.description',
    descriptionDefault: 'DeepSeek coding agent over ACP (developer preview)',
    cliType: 'builtin',
    agentType: 'deepseek',
    experimental: true,
    searchKeys: 'deepseek harness dsh acp',
  },
];

const PRESET_OPTIONS: AgentTypeOption[] = PRESETS.map((p) => ({
  kind: 'preset' as const,
  value: `preset:${p.id}`,
  label: p.label,
  labelKey: p.labelKey,
  descriptionKey: p.descriptionKey,
  descriptionDefault: p.descriptionDefault,
  cliType: p.cliType,
  agentType: p.agentType,
  presetId: p.id,
  searchKeys: `${p.label} ${p.id} ${p.descriptionDefault} ${p.tokenLabelDefault}`,
}));

const REGISTRY_OPTIONS: AgentTypeOption[] = REGISTRY_ACP_AGENTS.map((a) => ({
  kind: 'registry' as const,
  value: `registry:${a.id}`,
  label: a.name,
  description: a.description ?? undefined,
  cliType: 'registry' as AgentConfigCliType,
  agentType: a.id,
  experimental: true,
  searchKeys: `${a.name} ${a.id} ${a.description ?? ''}`.toLowerCase(),
}));

// Custom agents still need a stable provider slug for session launch metadata;
// capability cache isolation itself is handled by the agent config id.
const CUSTOM_OPTION: AgentTypeOption = {
  kind: 'custom',
  value: 'custom',
  label: 'Custom command',
  labelKey: 'settings.agent.dialog.option.custom.label',
  descriptionKey: 'settings.agent.dialog.option.custom.description',
  descriptionDefault: 'Run any ACP-compatible agent with your own command',
  cliType: 'custom',
  agentType: '',
  searchKeys: 'custom command local executable acp',
};

const ALL_OPTIONS: AgentTypeOption[] = [
  ...BUILTIN_OPTIONS,
  ...PRESET_OPTIONS,
  CUSTOM_OPTION,
  ...REGISTRY_OPTIONS,
];

// =============================================================================
// Form data
// =============================================================================

export type AgentConfigFormData = {
  name: string;
  cliType: AgentConfigCliType;
  agentType: string;
  /** Raw command line the user typed for custom providers; parsed on submit. */
  customCommandLine?: string;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  prompt: string;
  env: Record<string, string>;
  titleGeneration?: TitleGenerationConfig;
  presetId?: PresetId;
  presetToken?: string;
  presetCredentialModeId?: string;
  presetBaseUrlOptionId?: string;
  presetBaseUrl?: string;
  /** Dialog-only DeepSeek Harness endpoint tab; never persisted on AgentConfigMeta. */
  deepseekEndpointMode?: DeepSeekEndpointMode;
  /** Draft custom DEEPSEEK_BASE_URL while the official tab is selected. */
  deepseekCustomBaseUrl?: string;
};

export type AgentConfigSubmitPayload = {
  id: AgentConfigId;
  name: string;
  cliType: AgentConfigCliType;
  agentType: AgentType;
  /** Parsed launch spec for `cliType: 'custom'` configs. */
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  prompt: string;
  env: Record<string, string>;
  titleGeneration?: TitleGenerationConfig;
  description: string | undefined;
  /** Provider brand for preset-created configs; drives the agent's icon. */
  brandId?: AgentBrandId;
  /** Persist as a durable target-machine setup instead of publishing immediately. */
  backgroundSetup?: true;
};

export type AgentConfigDialogMode =
  | { kind: 'create'; initialForm?: Partial<AgentConfigFormData> }
  | { kind: 'edit'; config: AgentConfigMeta };

type RefreshArgs = {
  machineId: MachineId;
  configId: AgentConfigId;
};

/** Whether a registry agent's platform binary is present on the target machine. */
export type AgentBinaryInstallStatus =
  | 'not-applicable'
  | 'unsupported-platform'
  | 'incompatible-host'
  | 'not-installed'
  | 'installed';

type AgentBinaryRuntimeStatus =
  | AgentBinaryInstallStatus
  | MachineAcpBinaryProgressMessage['status'];

export type BinaryActionArgs = {
  machineId: MachineId;
  agentType: string;
};

export type AgentConfigDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Render above an already-open dialog, such as the desktop settings modal. */
  nestedInDialog?: boolean;
  mode: AgentConfigDialogMode;
  machine: MachineViewMeta;
  onSubmit: (payload: AgentConfigSubmitPayload) => Promise<void>;
  onRefreshCapabilities: (args: RefreshArgs) => Promise<MachineAcpCapabilitiesRefreshResponse>;
  /** Check a registry binary or managed builtin runtime on the target machine. */
  onCheckBinaryStatus?: (
    args: BinaryActionArgs
  ) => Promise<
    Pick<MachineAcpBinaryStatusResponse, 'status' | 'command' | 'version' | 'current' | 'required'>
  >;
  /** Download + unpack the agent's platform binary. Rejects on failure. */
  onInstallBinary?: (args: BinaryActionArgs) => Promise<void>;
  /** Raise the selected managed runtime above onboarding's background queue. */
  onManagedRuntimeSelected?: (agentType: ManagedBuiltinAgentType) => void;
};

const DEFAULT_FORM: AgentConfigFormData = {
  name: '',
  cliType: 'builtin',
  agentType: 'kimi',
  prompt: '',
  env: {},
};

function getPresetCredentialMode(
  preset: PresetDefinition,
  credentialModeId?: string
): PresetCredentialMode | undefined {
  const modes = preset.credentialModes ?? [];
  if (modes.length === 0) return undefined;
  return modes.find((mode) => mode.id === credentialModeId) ?? modes[0];
}

function getBaseUrlOption(
  mode: PresetCredentialMode | undefined,
  optionId?: string
): PresetBaseUrlOption | undefined {
  const options = mode?.baseUrlOptions ?? [];
  if (options.length === 0) return undefined;
  const defaultOption =
    options.find((option) => option.id === mode?.defaultBaseUrlOptionId) ?? options[0];
  return options.find((option) => option.id === optionId) ?? defaultOption;
}

function getDefaultBaseUrlOptionId(mode: PresetCredentialMode | undefined): string | undefined {
  return getBaseUrlOption(mode)?.id;
}

/**
 * Build the create-mode initial form for a preset chosen from outside the dialog
 * (e.g. the onboarding agent showcase). Mirrors {@link selectOption}'s preset
 * branch so the dialog opens straight on the preset's token form, with the
 * default credential mode / base URL seeded. Returns an empty patch for an
 * unknown id.
 */
export function buildPresetCreateForm(presetId: string): Partial<AgentConfigFormData> {
  const preset = PRESETS_BY_ID[presetId];
  if (!preset) return {};
  const credentialMode = getPresetCredentialMode(preset, undefined);
  return {
    name: preset.label,
    cliType: preset.cliType,
    agentType: preset.agentType,
    presetId: preset.id,
    presetCredentialModeId: credentialMode?.id,
    presetBaseUrlOptionId: getDefaultBaseUrlOptionId(credentialMode),
  };
}

function resolveCredentialModeBaseUrl(
  mode: PresetCredentialMode | undefined,
  optionId?: string,
  customBaseUrl?: string
): string {
  if (!mode?.baseUrlEnvKey) return '';
  const option = getBaseUrlOption(mode, optionId);
  if (!option) return '';
  if (option.id === mode.customBaseUrlOptionId) return customBaseUrl?.trim() ?? '';
  return option.value;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isDeepSeekBuiltinForm(form: Pick<AgentConfigFormData, 'cliType' | 'agentType'>): boolean {
  return form.cliType === 'builtin' && form.agentType === 'deepseek';
}

function getDeepSeekEndpointMode(form: AgentConfigFormData): DeepSeekEndpointMode {
  return form.deepseekEndpointMode === 'custom' ? 'custom' : 'official';
}

/**
 * Official DeepSeek API, including trailing slashes and a bare `/v1` path.
 * Other hosts, ports, query strings, or extra path segments are custom.
 */
function isDeepSeekOfficialBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    if (url.hostname.toLowerCase() !== 'api.deepseek.com') return false;
    if (url.port !== '' && url.port !== '443') return false;
    if (url.search !== '' || url.hash !== '') return false;
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    return path === '' || path === '/v1';
  } catch {
    return false;
  }
}

function resolveDeepSeekEndpointForm(
  env: Record<string, string>,
  explicit?: Pick<AgentConfigFormData, 'deepseekEndpointMode' | 'deepseekCustomBaseUrl'>
): Pick<AgentConfigFormData, 'deepseekEndpointMode' | 'deepseekCustomBaseUrl'> {
  if (
    explicit?.deepseekEndpointMode === 'official' ||
    explicit?.deepseekEndpointMode === 'custom'
  ) {
    return {
      deepseekEndpointMode: explicit.deepseekEndpointMode,
      deepseekCustomBaseUrl: explicit.deepseekCustomBaseUrl ?? '',
    };
  }
  const stored = env[DEEPSEEK_HARNESS_BASE_URL_ENV];
  if (!stored?.trim() || isDeepSeekOfficialBaseUrl(stored)) {
    return { deepseekEndpointMode: 'official', deepseekCustomBaseUrl: '' };
  }
  return { deepseekEndpointMode: 'custom', deepseekCustomBaseUrl: stored };
}

function omitDeepSeekProtectedEnv(env: Record<string, string>): Record<string, string> {
  const additionalEnv = { ...env };
  delete additionalEnv[DEEPSEEK_HARNESS_API_KEY_ENV];
  delete additionalEnv[DEEPSEEK_HARNESS_BASE_URL_ENV];
  delete additionalEnv[LEGACY_DSH_MODELS_ENV];
  return additionalEnv;
}

function hydrateDeepSeekEndpointForm(form: AgentConfigFormData): AgentConfigFormData {
  if (!isDeepSeekBuiltinForm(form)) return form;
  const env = { ...form.env };
  const resolved = resolveDeepSeekEndpointForm(env, form);
  delete env[DEEPSEEK_HARNESS_BASE_URL_ENV];
  delete env[LEGACY_DSH_MODELS_ENV];
  return {
    ...form,
    env,
    deepseekEndpointMode: resolved.deepseekEndpointMode,
    deepseekCustomBaseUrl: resolved.deepseekCustomBaseUrl,
  };
}

function buildDeepSeekSubmitEnv(formData: AgentConfigFormData): Record<string, string> {
  const env = omitDeepSeekProtectedEnv(formData.env);
  const apiKey = formData.env[DEEPSEEK_HARNESS_API_KEY_ENV]?.trim();
  if (apiKey) {
    env[DEEPSEEK_HARNESS_API_KEY_ENV] = apiKey;
  } else {
    delete env[DEEPSEEK_HARNESS_API_KEY_ENV];
  }
  env[DEEPSEEK_HARNESS_BASE_URL_ENV] =
    getDeepSeekEndpointMode(formData) === 'custom'
      ? (formData.deepseekCustomBaseUrl ?? '').trim()
      : DEEPSEEK_OFFICIAL_BASE_URL;
  return env;
}

function getPresetTokenEnvKey(
  preset: PresetDefinition,
  mode: PresetCredentialMode | undefined
): string {
  return mode?.tokenEnvKey ?? preset.tokenEnvKey;
}

function buildPresetEnv(
  preset: PresetDefinition,
  mode: PresetCredentialMode | undefined,
  formData: AgentConfigFormData
): Record<string, string> {
  const env = {
    ...formData.env,
    ...preset.fixedEnv,
    ...(mode?.fixedEnv ?? {}),
  };
  if (mode?.baseUrlEnvKey) {
    env[mode.baseUrlEnvKey] = resolveCredentialModeBaseUrl(
      mode,
      formData.presetBaseUrlOptionId,
      formData.presetBaseUrl
    );
  }
  env[getPresetTokenEnvKey(preset, mode)] = (formData.presetToken ?? '').trim();
  return env;
}

// Presets skip the capability-probe + title-generation form path that built-in
// agents use, so `formData.titleGeneration` is never populated through the UI.
// Without this, saving a preset agent persists `titleGeneration: undefined`
// and chatting with it later fails the "title generation not configured" gate
// in chat-landing. Use the same static built-in defaults the CLI applies in
// `createAgentConfig` so preset agents work immediately on the first turn,
// before the CLI's capability-probe backfill has a chance to run.
function buildPresetTitleGeneration(
  cliType: AgentConfigCliType,
  agentType: AgentType,
  existing: TitleGenerationConfig | undefined
): TitleGenerationConfig | undefined {
  const existingValues = existing?.configOptionValues;
  if (existingValues && Object.keys(existingValues).length > 0) {
    return existing;
  }
  if (cliType !== 'builtin') return existing;
  const defaults = getBuiltinTitleGenerationDefaults(agentType);
  if (!defaults || Object.keys(defaults).length === 0) return existing;
  return { ...existing, configOptionValues: defaults };
}

function buildPresetInjectedEnvPreview(
  preset: PresetDefinition,
  mode: PresetCredentialMode | undefined,
  formData: AgentConfigFormData
): Record<string, string> {
  const env = {
    ...preset.fixedEnv,
    ...(mode?.fixedEnv ?? {}),
  };
  if (mode?.baseUrlEnvKey) {
    env[mode.baseUrlEnvKey] = resolveCredentialModeBaseUrl(
      mode,
      formData.presetBaseUrlOptionId,
      formData.presetBaseUrl
    );
  }
  return env;
}

// For an existing custom config, returns the command "key" to pre-seed as
// already-tested IFF the machine still has current cached capabilities whose
// source version matches the saved command (same derivation the CLI uses in
// getAcpCapabilitySourceVersion). Returns null otherwise, forcing a re-test.
function resolveInitialTestedCustomKey(
  mode: AgentConfigDialogMode,
  machine: MachineViewMeta
): string | null {
  if (mode.kind !== 'edit') return null;
  const config = mode.config;
  if (config.cliType !== 'custom' || !config.customAcp) return null;
  const entry = machine.acpCapabilities?.[getAcpCapabilityCacheKey(config.id)];
  if (!isAcpCapabilityCacheEntryCurrent(entry)) return null;
  if (entry.sourceVersion !== `custom:${serializeCustomAcpLaunchSpec(config.customAcp)}`) {
    return null;
  }
  return formatCustomAcpCommandLine(config.customAcp);
}

// =============================================================================
// Main dialog
// =============================================================================

export function AgentConfigDialog(props: AgentConfigDialogProps) {
  const {
    open,
    onOpenChange,
    nestedInDialog = false,
    mode,
    machine,
    onSubmit,
    onRefreshCapabilities,
    onCheckBinaryStatus,
    onInstallBinary,
    onManagedRuntimeSelected,
  } = props;
  const { t } = useTranslation();
  const draftConfigIdRef = useRef<AgentConfigId | null>(null);
  const agentConfigId =
    mode.kind === 'edit'
      ? mode.config.id
      : (draftConfigIdRef.current ??= uuidv4() as AgentConfigId);

  const initialForm = useMemo<AgentConfigFormData>(() => {
    if (mode.kind === 'edit') {
      return hydrateDeepSeekEndpointForm({
        name: mode.config.name,
        cliType: mode.config.cliType,
        agentType: mode.config.agentType,
        customCommandLine: mode.config.customAcp
          ? formatCustomAcpCommandLine(mode.config.customAcp)
          : undefined,
        runtimeOverrides: mode.config.runtimeOverrides,
        prompt: mode.config.prompt ?? '',
        env: mode.config.env || {},
        titleGeneration: mode.config.titleGeneration,
      });
    }
    return hydrateDeepSeekEndpointForm({ ...DEFAULT_FORM, ...mode.initialForm });
  }, [mode]);

  const [formData, setFormData] = useState<AgentConfigFormData>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [manuallyTested, setManuallyTested] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [probeTick, setProbeTick] = useState(0);
  // Creation of a built-in provider is gated on a live probe for the exact
  // target machine + auth-affecting form revision. Cached capabilities make the
  // form renderable, but they do not prove that credentials still exist.
  const [builtinVerificationRevision, setBuiltinVerificationRevision] = useState(0);
  const [verifiedBuiltinContext, setVerifiedBuiltinContext] = useState<string | null>(null);
  const [pendingCreateBuiltinContext, setPendingCreateBuiltinContext] = useState<string | null>(
    null
  );
  // Custom providers probe manually only (the command doesn't exist until the
  // user types it), so readiness is tracked per the exact command that was
  // last tested. Editing the command clears readiness until it is re-tested,
  // because a config-id cache row can still be stale after an unsaved command edit.
  const [testedCustomKey, setTestedCustomKey] = useState<string | null>(null);
  // Bind the resolved status to the agent it was computed for. A bare status
  // state would, on switching from a non-binary (or already-installed) provider
  // to a different binary-only agent, briefly read as ready before the per-agent
  // check runs — letting the capability probe (and its implicit ensureBinary
  // download) fire and bypass the explicit Download confirmation. Deriving the
  // status only when `agentType` matches forces 'unknown' (not ready) across the
  // switch until the new agent is actually checked.
  const [binaryState, setBinaryState] = useState<{
    agentType: string;
    status: AgentBinaryRuntimeStatus;
    downloadedBytes?: number;
    totalBytes?: number;
    percent?: number;
    version?: string;
    command?: string;
    current?: string;
    required?: string;
    error?: string;
  } | null>(null);
  const workspaceRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const liveBinaryState = useMachineAcpBinaryProgress(
    workspaceRuntime,
    machine.id,
    formData.agentType
  );
  const effectiveBinaryState = liveBinaryState ?? binaryState;
  const [installingBinary, setInstallingBinary] = useState(false);
  const [binaryError, setBinaryError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // For narrow viewports we run a 2-step flow: pick a type, then configure.
  // Edit mode skips the picker because the type is locked.
  const [mobileView, setMobileView] = useState<'picker' | 'form'>(
    mode.kind === 'edit' ? 'form' : 'picker'
  );
  const isNarrowLayout = useNarrowDialogLayout();
  const titleDefaultsAppliedRef = useRef(false);
  const formScrollRef = useRef<HTMLDivElement>(null);
  const machineRef = useRef(machine);
  machineRef.current = machine;
  useKeyboardAwareScrollIntoView(formScrollRef);

  useEffect(() => {
    if (open) {
      setFormData(initialForm);
      setManuallyTested(false);
      setAuthRequired(false);
      setProbeError(null);
      setProbeTick(0);
      setBuiltinVerificationRevision((revision) => revision + 1);
      setVerifiedBuiltinContext(null);
      setPendingCreateBuiltinContext(null);
      setBinaryState(null);
      setInstallingBinary(false);
      setBinaryError(null);
      setQuery('');
      setMobileView(mode.kind === 'edit' ? 'form' : 'picker');
      titleDefaultsAppliedRef.current = false;
      // For an existing custom config whose cached capabilities still match the
      // saved command, pre-seed the tested key so a minor edit (e.g. the name)
      // doesn't force a re-test. Any other case starts un-tested.
      setTestedCustomKey(resolveInitialTestedCustomKey(mode, machineRef.current));
    }
  }, [open, initialForm, mode]);

  const activePreset = formData.presetId ? PRESETS_BY_ID[formData.presetId] : undefined;
  const isPreset = !!activePreset;
  const acpProvidesSessionTitle = usesAcpProvidedSessionTitle(formData.cliType, formData.agentType);
  const activeCredentialMode = activePreset
    ? getPresetCredentialMode(activePreset, formData.presetCredentialModeId)
    : undefined;
  // Prefer the active preset's brand; on edit (where the preset isn't
  // re-detected) preserve the brand already persisted on the config so an
  // unrelated edit doesn't strip it. MiMo's custom token-plan base URL can't
  // be recovered from env, so the persisted value is the source of truth.
  const resolvedBrandId =
    activePreset?.brandId ?? (mode.kind === 'edit' ? mode.config.brandId : undefined);

  const isCustom = formData.cliType === 'custom';
  const isDeepSeekBuiltin = isDeepSeekBuiltinForm(formData);
  const deepseekEndpointMode = getDeepSeekEndpointMode(formData);
  const isManagedBuiltin =
    formData.cliType === 'builtin' && isManagedBuiltinAgentType(formData.agentType);
  const builtinVerificationContext = `${machine.id}:${builtinVerificationRevision}`;
  const requiresBuiltinCreationVerification =
    mode.kind === 'create' && !isPreset && (isManagedBuiltin || isDeepSeekBuiltin);
  const builtinCreationVerified =
    !requiresBuiltinCreationVerification || verifiedBuiltinContext === builtinVerificationContext;
  const builtinCreationPending =
    requiresBuiltinCreationVerification &&
    !builtinCreationVerified &&
    pendingCreateBuiltinContext === builtinVerificationContext;
  // Editing an existing provider offers "Sign in again" whenever the provider
  // has a login of its own to run — this dialog is where re-authentication
  // lives, but preset / env-credential providers (DeepSeek, MiniMax, MiMo, GLM,
  // or a hand-rolled endpoint override) authenticate purely through env vars,
  // so a sign-in would do nothing for them. Creating one only surfaces the
  // panel when a live probe reported missing credentials, because that panel is
  // the single way to unblock the creation-time verification gate.
  // Registry and custom providers authenticate through the standard ACP
  // exchange, but only the agent knows whether it has anything to sign into —
  // so their panel appears once a live probe reported that auth is required.
  // The exchange runs entirely on the daemon, so a machine that predates it
  // answers "Authentication is not supported"; do not offer a button that can
  // only fail.
  const usesProtocolAuthentication =
    usesAcpProtocolAuthentication(formData.cliType) &&
    machineSupportsAcpProtocolAuthentication(machine);
  const showAuthenticationPanel =
    mode.kind === 'edit'
      ? supportsBuiltinAuthentication({
          cliType: formData.cliType,
          agentType: formData.agentType,
          brandId: resolvedBrandId,
          env: formData.env,
        }) ||
        (authRequired && usesProtocolAuthentication)
      : authRequired && (isManagedBuiltin || usesProtocolAuthentication);
  const builtinRuntimeOverrideKey =
    formData.cliType !== 'builtin'
      ? null
      : formData.agentType === 'codex'
        ? 'codexPath'
        : formData.agentType === 'claude'
          ? 'claudeCodeExecutable'
          : formData.agentType === 'kimi'
            ? 'kimiPath'
            : formData.agentType === 'grok'
              ? 'grokPath'
              : null;
  const builtinRuntimeOverrideValue = builtinRuntimeOverrideKey
    ? (formData.runtimeOverrides?.[builtinRuntimeOverrideKey] ?? '')
    : '';
  const hasBuiltinRuntimeOverride = builtinRuntimeOverrideValue.trim().length > 0;
  const parsedCustomAcp = useMemo(
    () => (isCustom ? parseCustomAcpCommandLine(formData.customCommandLine ?? '') : null),
    [isCustom, formData.customCommandLine]
  );
  // Canonical form of the parsed command; probe effect keys on this so edits
  // that don't change the parsed argv (extra whitespace) don't re-probe.
  const customAcpKey = parsedCustomAcp ? formatCustomAcpCommandLine(parsedCustomAcp) : '';

  const cacheKey = getAcpCapabilityCacheKey(agentConfigId);
  const cachedCapabilityAuthority = getAcpCapabilityCacheEntryAuthority(
    machine.acpCapabilities?.[cacheKey],
    formData.runtimeOverrides
  );
  const hasCachedCaps =
    formData.cliType === 'builtin' && formData.agentType === 'kimi'
      ? cachedCapabilityAuthority === 'authoritative'
      : cachedCapabilityAuthority !== 'unavailable';
  const hasStaticBuiltinCaps =
    (getStaticBuiltinAcpCapabilities(
      formData.cliType,
      formData.agentType,
      formData.runtimeOverrides
    )?.configOptions.length ?? 0) > 0;
  // Registry binary-only agents must be present before this dialog probes a live
  // agent. Built-in Codex/Claude download their managed runtime during refresh, so
  // the dialog should surface progress without blocking the initial selection.
  const binaryRequired = useMemo(() => {
    if (isPreset) return false;
    if (formData.cliType === 'builtin') {
      return false;
    }
    if (formData.cliType !== 'registry') return false;
    const agent = REGISTRY_ACP_AGENTS.find((a) => a.id === formData.agentType);
    return agent ? getRegistryAcpLaunchKind(agent.distribution) === 'binary' : false;
  }, [isPreset, formData.cliType, formData.agentType]);
  const binaryStatus: 'unknown' | AgentBinaryRuntimeStatus =
    effectiveBinaryState && effectiveBinaryState.agentType === formData.agentType
      ? effectiveBinaryState.status
      : 'unknown';
  const usesDefaultManagedRuntime =
    formData.cliType === 'builtin' &&
    isManagedBuiltinAgentType(formData.agentType) &&
    !hasBuiltinRuntimeOverride;
  // Deferring hands the target daemon a durable `providerSetup` row, so it is
  // only safe once that daemon advertises the protocol. Derived here rather
  // than passed in: every host already gives us the target machine, and a
  // per-caller flag can disagree with the machine it travels with.
  const backgroundManagedBuiltinSetup =
    machineSupportsProviderSetupProtocol(machine) &&
    requiresBuiltinCreationVerification &&
    usesDefaultManagedRuntime;
  const lastPersistedPayloadKeyRef = useRef<string | null>(null);
  const buildSubmitPayload = useCallback((): AgentConfigSubmitPayload => {
    let env = { ...formData.env };
    if (activePreset) {
      env = buildPresetEnv(activePreset, activeCredentialMode, formData);
    } else if (isDeepSeekBuiltinForm(formData)) {
      env = buildDeepSeekSubmitEnv(formData);
    }
    const agentType = formData.agentType as AgentType;
    const titleGeneration = acpProvidesSessionTitle
      ? undefined
      : isPreset
        ? buildPresetTitleGeneration(formData.cliType, agentType, formData.titleGeneration)
        : formData.titleGeneration;
    return {
      id: agentConfigId,
      name: formData.name.trim(),
      cliType: formData.cliType,
      agentType,
      customAcp: isCustom ? (parsedCustomAcp ?? undefined) : undefined,
      runtimeOverrides: formData.runtimeOverrides,
      prompt: formData.prompt,
      env,
      titleGeneration,
      description: undefined,
      brandId: resolvedBrandId,
      ...(backgroundManagedBuiltinSetup ? { backgroundSetup: true } : {}),
    };
  }, [
    activeCredentialMode,
    activePreset,
    acpProvidesSessionTitle,
    agentConfigId,
    backgroundManagedBuiltinSetup,
    formData,
    isCustom,
    isPreset,
    parsedCustomAcp,
    resolvedBrandId,
  ]);
  const persistConfigBeforeMachineLaunch = useCallback(async (): Promise<void> => {
    const payload = buildSubmitPayload();
    const payloadKey = JSON.stringify(payload);
    if (lastPersistedPayloadKeyRef.current === payloadKey) return;
    await onSubmit(payload);
    lastPersistedPayloadKeyRef.current = payloadKey;
  }, [buildSubmitPayload, onSubmit]);

  useEffect(() => {
    if (
      !open ||
      mode.kind !== 'create' ||
      !usesDefaultManagedRuntime ||
      !isManagedBuiltinAgentType(formData.agentType)
    ) {
      return;
    }
    onManagedRuntimeSelected?.(formData.agentType);
  }, [formData.agentType, mode.kind, onManagedRuntimeSelected, open, usesDefaultManagedRuntime]);
  const binaryReady =
    !binaryRequired || binaryStatus === 'installed' || binaryStatus === 'not-applicable';
  const binaryStatusBlocksReady =
    (binaryRequired && !binaryReady) ||
    (usesDefaultManagedRuntime &&
      binaryStatus !== 'unknown' &&
      binaryStatus !== 'installed' &&
      binaryStatus !== 'not-applicable');
  // Custom: ready only when the exact current command has been tested this
  // session (cache can't be trusted alone — its key doesn't move with the
  // command). Builtin/registry: ready on cache hit, static builtin defaults, or
  // a manual probe, unless a live runtime check just proved the managed binary
  // is missing/outdated.
  const customReady = !!parsedCustomAcp && testedCustomKey === customAcpKey;
  const rawCapabilitiesReady = isCustom
    ? customReady
    : manuallyTested ||
      hasCachedCaps ||
      (hasStaticBuiltinCaps && !(formData.cliType === 'builtin' && formData.agentType === 'kimi'));
  const capabilitiesReady = rawCapabilitiesReady && !binaryStatusBlocksReady;
  // Static builtin capabilities make the form usable before a runtime probe,
  // but they do not prove that the provider has local credentials. Keep a
  // visible Test action until a real probe (or authoritative cache entry) has
  // checked sign-in, so missing credentials can be resolved inside this dialog.
  const builtinNeedsCredentialCheck =
    isManagedBuiltin &&
    (requiresBuiltinCreationVerification
      ? !builtinCreationVerified
      : !manuallyTested && !hasCachedCaps);
  const binaryProgressActive =
    binaryStatus === 'checking' ||
    binaryStatus === 'downloading' ||
    binaryStatus === 'verifying' ||
    binaryStatus === 'extracting' ||
    binaryStatus === 'publishing';
  const showBinaryPanel =
    (binaryRequired && !binaryReady) ||
    (usesDefaultManagedRuntime &&
      binaryStatus !== 'unknown' &&
      binaryStatus !== 'installed' &&
      binaryStatus !== 'not-applicable');
  const incompatibleHostMessage =
    binaryStatus === 'incompatible-host'
      ? t(
          'settings.agent.dialog.nodeVersionRequired',
          'Kimi Code requires Node ≥{{required}}; this machine is using {{current}}.',
          {
            required: effectiveBinaryState?.required ?? t('common.unknown', 'unknown'),
            current: effectiveBinaryState?.current ?? t('common.unknown', 'unknown'),
          }
        )
      : null;

  // Probe gates on the runtime being usable, so check registry binaries and
  // managed builtins first. Kimi also reports the current/required Node version here.
  useEffect(() => {
    if (!open) return undefined;
    const agentType = formData.agentType;
    const shouldCheckRuntimeStatus = binaryRequired || usesDefaultManagedRuntime;
    if (!shouldCheckRuntimeStatus || !onCheckBinaryStatus) {
      setBinaryState({ agentType, status: 'not-applicable' });
      return undefined;
    }
    let cancelled = false;
    setBinaryState({ agentType, status: 'checking' });
    setBinaryError(null);
    void (async () => {
      try {
        const result = await onCheckBinaryStatus({ machineId: machine.id, agentType });
        if (!cancelled) {
          setBinaryState({
            agentType,
            status: result.status,
            command: result.command,
            version: result.version,
            current: result.current,
            required: result.required,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setBinaryState({ agentType, status: 'not-installed' });
          setBinaryError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    binaryRequired,
    usesDefaultManagedRuntime,
    machine.id,
    formData.agentType,
    onCheckBinaryStatus,
  ]);

  const handleInstallBinary = async () => {
    if (!onInstallBinary) return;
    const agentType = formData.agentType;
    setInstallingBinary(true);
    setBinaryError(null);
    try {
      await onInstallBinary({ machineId: machine.id, agentType });
      // Flipping to 'installed' unblocks the capability probe effect below.
      setBinaryState({ agentType, status: 'installed' });
    } catch (error) {
      setBinaryState({ agentType, status: 'not-installed' });
      setBinaryError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingBinary(false);
    }
  };

  const selectedTitleModelId =
    typeof formData.titleGeneration?.configOptionValues?.model === 'string'
      ? formData.titleGeneration.configOptionValues.model
      : null;
  const titleSelectors = useMemo<AcpConfigOptionSelector[]>(() => {
    if (!capabilitiesReady || acpProvidesSessionTitle) return [];
    return buildAllConfigOptionSelectors({
      configId: agentConfigId,
      cliType: formData.cliType,
      agentType: formData.agentType,
      selectedModelId: selectedTitleModelId,
      runtimeOverrides: formData.runtimeOverrides,
      machine,
    });
  }, [
    machine,
    agentConfigId,
    formData.cliType,
    formData.agentType,
    formData.runtimeOverrides,
    capabilitiesReady,
    acpProvidesSessionTitle,
    selectedTitleModelId,
  ]);

  // Capability refresh is a real runtime probe. The dialog never starts it just
  // to render static builtin defaults; probeTick is bumped by Create or explicit
  // Test / Refresh actions.
  useEffect(() => {
    if (!open) return undefined;
    if (isPreset) return undefined;
    if (isCustom) return undefined;
    if (probeTick === 0) return undefined;
    // Don't launch a binary-distribution agent to probe it until it's installed.
    if (binaryRequired && !binaryReady) return undefined;
    if (!formData.agentType.trim()) return undefined;
    let cancelled = false;
    setProbing(true);
    setProbeError(null);
    void (async () => {
      try {
        await persistConfigBeforeMachineLaunch();
        if (cancelled) return;
        const response = await onRefreshCapabilities({
          machineId: machine.id,
          configId: agentConfigId,
        });
        if (cancelled) return;
        if (response.authRequired) {
          setAuthRequired(true);
          setManuallyTested(false);
          setVerifiedBuiltinContext(null);
          return;
        }
        if (!response.success) {
          setAuthRequired(false);
          setManuallyTested(false);
          setVerifiedBuiltinContext(null);
          setProbeError(
            response.error ??
              t('settings.agent.dialog.probeFailed', 'Provider verification failed.')
          );
          return;
        }
        setAuthRequired(false);
        setManuallyTested(true);
        if (requiresBuiltinCreationVerification) {
          setVerifiedBuiltinContext(builtinVerificationContext);
        }
      } catch (error) {
        if (cancelled) return;
        setManuallyTested(false);
        setVerifiedBuiltinContext(null);
        setProbeError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setProbing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    machine.id,
    agentConfigId,
    formData.cliType,
    formData.agentType,
    formData.runtimeOverrides,
    onRefreshCapabilities,
    probeTick,
    isPreset,
    isCustom,
    binaryRequired,
    binaryReady,
    requiresBuiltinCreationVerification,
    builtinVerificationContext,
    persistConfigBeforeMachineLaunch,
    t,
  ]);

  // Manual capability probe for custom providers, triggered by the "Test"
  // button. Records the exact command tested so readiness tracks edits.
  const runCustomProbe = async () => {
    if (!parsedCustomAcp || probing) return;
    const probedKey = customAcpKey;
    setProbing(true);
    setProbeError(null);
    try {
      await persistConfigBeforeMachineLaunch();
      const response = await onRefreshCapabilities({
        machineId: machine.id,
        configId: agentConfigId,
      });
      if (response.authRequired) {
        setAuthRequired(true);
        setManuallyTested(false);
        return;
      }
      if (!response.success) {
        throw new Error(
          response.error ?? t('settings.agent.dialog.probeFailed', 'Provider verification failed.')
        );
      }
      setAuthRequired(false);
      setTestedCustomKey(probedKey);
    } catch (error) {
      setProbeError(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    if (isPreset) return;
    if (titleSelectors.length === 0 || titleDefaultsAppliedRef.current) return;
    titleDefaultsAppliedRef.current = true;
    const summaries = titleSelectors.map((sel) => ({
      id: sel.configId,
      name: sel.label,
      description: sel.description,
      category: sel.category,
      type: sel.type,
      currentValue: sel.currentValue,
      options: sel.options.map((o) => ({ value: o.value, name: o.label ?? o.value })),
    }));
    const defaults = computeTitleGenerationDefaults(
      formData.cliType,
      formData.agentType,
      summaries
    );
    if (Object.keys(defaults).length === 0) return;
    const existing = formData.titleGeneration?.configOptionValues ?? {};
    const merged = { ...defaults, ...existing };
    if (Object.keys(existing).length === Object.keys(merged).length) return;
    setFormData((prev) => ({
      ...prev,
      titleGeneration: { ...prev.titleGeneration, configOptionValues: merged },
    }));
  }, [
    isPreset,
    titleSelectors,
    formData.cliType,
    formData.agentType,
    formData.titleGeneration?.configOptionValues,
  ]);

  useEffect(() => {
    if (isPreset || titleSelectors.length === 0) return;
    const values = formData.titleGeneration?.configOptionValues;
    if (!values) return;
    const hasInvalidValue = titleSelectors.some((selector) => {
      const value = values[selector.configId];
      return (
        value !== undefined &&
        !isConfigOptionValueValid(selector, value) &&
        value !== selector.currentValue
      );
    });
    if (!hasInvalidValue) return;

    setFormData((prev) => {
      const currentValues = prev.titleGeneration?.configOptionValues ?? {};
      let nextValues = currentValues;
      for (const selector of titleSelectors) {
        const value = currentValues[selector.configId];
        if (
          value !== undefined &&
          !isConfigOptionValueValid(selector, value) &&
          value !== selector.currentValue
        ) {
          if (nextValues === currentValues) nextValues = { ...currentValues };
          nextValues[selector.configId] = selector.currentValue;
        }
      }
      if (nextValues === currentValues) return prev;
      return {
        ...prev,
        titleGeneration: { ...prev.titleGeneration, configOptionValues: nextValues },
      };
    });
  }, [isPreset, titleSelectors, formData.titleGeneration?.configOptionValues]);

  const additionalEnv = isDeepSeekBuiltin ? omitDeepSeekProtectedEnv(formData.env) : formData.env;
  const envCount = Object.keys(additionalEnv).length;

  const invalidateBuiltinVerification = () => {
    setManuallyTested(false);
    setAuthRequired(false);
    setProbeError(null);
    setProbeTick(0);
    setBuiltinVerificationRevision((revision) => revision + 1);
    setVerifiedBuiltinContext(null);
    setPendingCreateBuiltinContext(null);
  };

  const updateEnvironment = (env: Record<string, string>) => {
    invalidateBuiltinVerification();
    setFormData((prev) => ({ ...prev, env }));
  };

  const updateDeepSeekApiKey = (value: string) => {
    const env = omitDeepSeekProtectedEnv(formData.env);
    const apiKey = value.trim();
    if (apiKey) {
      env[DEEPSEEK_HARNESS_API_KEY_ENV] = apiKey;
    }
    updateEnvironment(env);
  };

  const updateDeepSeekEndpointMode = (endpointMode: DeepSeekEndpointMode) => {
    invalidateBuiltinVerification();
    setFormData((prev) => ({ ...prev, deepseekEndpointMode: endpointMode }));
  };

  const updateDeepSeekCustomBaseUrl = (value: string) => {
    invalidateBuiltinVerification();
    setFormData((prev) => ({ ...prev, deepseekCustomBaseUrl: value }));
  };

  const selectOption = (opt: AgentTypeOption) => {
    titleDefaultsAppliedRef.current = false;
    setManuallyTested(false);
    setAuthRequired(false);
    setProbeError(null);
    setProbeTick(0);
    setBuiltinVerificationRevision((revision) => revision + 1);
    setVerifiedBuiltinContext(null);
    setPendingCreateBuiltinContext(null);
    setMobileView('form');
    setFormData((prev) => {
      const autoName =
        prev.name.trim() === '' || isAutoGeneratedName(prev.name) ? opt.label : prev.name;
      if (opt.kind === 'preset') {
        const preset = opt.presetId ? PRESETS_BY_ID[opt.presetId] : undefined;
        const isSamePreset = prev.presetId === opt.presetId;
        const credentialMode = preset
          ? getPresetCredentialMode(preset, isSamePreset ? prev.presetCredentialModeId : undefined)
          : undefined;
        return {
          ...prev,
          name: autoName,
          cliType: opt.cliType,
          agentType: opt.agentType,
          presetId: opt.presetId,
          presetToken: isSamePreset ? prev.presetToken : undefined,
          presetCredentialModeId: credentialMode?.id,
          presetBaseUrlOptionId: getDefaultBaseUrlOptionId(credentialMode),
          presetBaseUrl: isSamePreset ? prev.presetBaseUrl : undefined,
          runtimeOverrides: undefined,
          titleGeneration: undefined,
        };
      }
      if (opt.kind === 'custom') {
        return {
          ...prev,
          name: autoName,
          cliType: opt.cliType,
          // Keep the slug stable while the user stays on the custom option so
          // edits to the command keep probing under the same capability key.
          agentType:
            prev.cliType === 'custom' && prev.agentType ? prev.agentType : `custom-${uuidv4()}`,
          presetId: undefined,
          presetToken: undefined,
          presetCredentialModeId: undefined,
          presetBaseUrlOptionId: undefined,
          presetBaseUrl: undefined,
          runtimeOverrides: undefined,
          titleGeneration: undefined,
        };
      }
      return {
        ...prev,
        name: autoName,
        cliType: opt.cliType,
        agentType: opt.agentType,
        customCommandLine: undefined,
        presetId: undefined,
        presetToken: undefined,
        presetCredentialModeId: undefined,
        presetBaseUrlOptionId: undefined,
        presetBaseUrl: undefined,
        runtimeOverrides: undefined,
        titleGeneration: undefined,
      };
    });
  };

  const updatePresetToken = (value: string) => {
    setFormData((prev) => {
      const preset = prev.presetId ? PRESETS_BY_ID[prev.presetId] : undefined;
      const trimmed = value.trim();
      const detectedMode = preset?.credentialModes?.find(
        (candidateMode) =>
          candidateMode.tokenPrefix && trimmed.startsWith(candidateMode.tokenPrefix)
      );
      if (!detectedMode || detectedMode.id === prev.presetCredentialModeId) {
        return { ...prev, presetToken: value };
      }
      return {
        ...prev,
        presetToken: value,
        presetCredentialModeId: detectedMode.id,
        presetBaseUrlOptionId: getDefaultBaseUrlOptionId(detectedMode),
        presetBaseUrl: undefined,
      };
    });
  };

  const updatePresetCredentialMode = (credentialModeId: string) => {
    if (!activePreset) return;
    const credentialMode = getPresetCredentialMode(activePreset, credentialModeId);
    setFormData((prev) => ({
      ...prev,
      presetCredentialModeId: credentialMode?.id,
      presetBaseUrlOptionId: getDefaultBaseUrlOptionId(credentialMode),
      presetBaseUrl:
        credentialMode?.id === prev.presetCredentialModeId ? prev.presetBaseUrl : undefined,
    }));
  };

  const updateBuiltinRuntimeOverride = (value: string) => {
    if (!builtinRuntimeOverrideKey) return;
    setManuallyTested(false);
    setAuthRequired(false);
    setProbeError(null);
    setProbeTick(0);
    setBuiltinVerificationRevision((revision) => revision + 1);
    setVerifiedBuiltinContext(null);
    setPendingCreateBuiltinContext(null);
    setFormData((prev) => {
      const nextOverrides = { ...(prev.runtimeOverrides ?? {}) };
      if (value.trim()) {
        nextOverrides[builtinRuntimeOverrideKey] = value;
      } else {
        delete nextOverrides[builtinRuntimeOverrideKey];
      }
      return {
        ...prev,
        runtimeOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
      };
    });
  };

  const disableReason: string | null = (() => {
    if (!formData.name.trim()) return t('agents.disableReason.missingName', 'Please enter a name');
    if (!formData.agentType.trim())
      return t('agents.disableReason.missingAgentType', 'Please select an agent type');
    if (incompatibleHostMessage) return incompatibleHostMessage;
    if (binaryRequired && !binaryReady) {
      if (binaryStatus === 'unsupported-platform') {
        return t(
          'settings.agent.dialog.binaryUnsupported',
          "This agent isn't available for this machine's platform."
        );
      }
      if (binaryStatus === 'error') {
        return (
          effectiveBinaryState?.error ??
          binaryError ??
          t('settings.agent.dialog.binaryDownloadFailed', 'The agent runtime download failed.')
        );
      }
      return formatBinaryStatusText(
        t,
        binaryStatus,
        effectiveBinaryState,
        usesDefaultManagedRuntime
      );
    }
    if (isCustom && !parsedCustomAcp) {
      return (formData.customCommandLine ?? '').trim()
        ? t('agents.disableReason.invalidCustomCommand', 'The launch command has unclosed quotes')
        : t('agents.disableReason.missingCustomCommand', 'Please enter the launch command');
    }
    if (isDeepSeekBuiltin && !formData.env[DEEPSEEK_HARNESS_API_KEY_ENV]?.trim()) {
      return t('agents.disableReason.missingDeepseekApiKey', 'Please enter your DeepSeek API Key');
    }
    if (isDeepSeekBuiltin && deepseekEndpointMode === 'custom') {
      const endpoint = (formData.deepseekCustomBaseUrl ?? '').trim();
      if (!endpoint) {
        return t('agents.disableReason.missingDeepseekEndpoint', 'Please enter an API Endpoint');
      }
      if (!isValidHttpUrl(endpoint)) {
        return t(
          'agents.disableReason.invalidDeepseekEndpoint',
          'Please enter a valid HTTP or HTTPS endpoint'
        );
      }
    }
    if (activePreset && !(formData.presetToken ?? '').trim()) {
      return t('agents.disableReason.missingPresetToken', 'Please paste your {{preset}} token', {
        preset: t(activePreset.labelKey, activePreset.label),
      });
    }
    if (activeCredentialMode?.baseUrlEnvKey) {
      const baseUrl = resolveCredentialModeBaseUrl(
        activeCredentialMode,
        formData.presetBaseUrlOptionId,
        formData.presetBaseUrl
      );
      if (!baseUrl) {
        return t(
          'agents.disableReason.missingPresetBaseUrl',
          'Please select or enter the {{preset}} Base URL',
          {
            preset: activePreset
              ? t(activePreset.labelKey, activePreset.label)
              : t('settings.agent.dialog.presetFallback', 'preset'),
          }
        );
      }
      if (!isValidHttpUrl(baseUrl)) {
        return t('agents.disableReason.invalidPresetBaseUrl', 'Please enter a valid Base URL');
      }
    }
    return null;
  })();

  const persistConfig = useCallback(async () => {
    try {
      setSubmitting(true);
      await persistConfigBeforeMachineLaunch();
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save agent config:', error);
    } finally {
      setSubmitting(false);
    }
  }, [onOpenChange, persistConfigBeforeMachineLaunch]);

  const submit = async () => {
    if (disableReason || submitting) return;
    if (
      requiresBuiltinCreationVerification &&
      !backgroundManagedBuiltinSetup &&
      !builtinCreationVerified
    ) {
      setPendingCreateBuiltinContext(builtinVerificationContext);
      setAuthRequired(false);
      setProbeError(null);
      setManuallyTested(false);
      setVerifiedBuiltinContext(null);
      setProbeTick((tick) => tick + 1);
      return;
    }
    await persistConfig();
  };

  useEffect(() => {
    if (!requiresBuiltinCreationVerification || backgroundManagedBuiltinSetup) return;
    if (pendingCreateBuiltinContext !== builtinVerificationContext) return;
    if (!builtinCreationVerified || probing || authRequired || submitting) return;
    if (disableReason) {
      setPendingCreateBuiltinContext(null);
      return;
    }
    setPendingCreateBuiltinContext(null);
    void persistConfig();
  }, [
    authRequired,
    backgroundManagedBuiltinSetup,
    builtinCreationVerified,
    builtinVerificationContext,
    disableReason,
    pendingCreateBuiltinContext,
    persistConfig,
    probing,
    requiresBuiltinCreationVerification,
    submitting,
  ]);

  const selectedOption = useMemo<AgentTypeOption | undefined>(() => {
    if (formData.presetId) return PRESET_OPTIONS.find((o) => o.presetId === formData.presetId);
    if (formData.cliType === 'custom') return CUSTOM_OPTION;
    return ALL_OPTIONS.find(
      (o) =>
        o.kind !== 'preset' && o.cliType === formData.cliType && o.agentType === formData.agentType
    );
  }, [formData.cliType, formData.agentType, formData.presetId]);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ALL_OPTIONS;
    return ALL_OPTIONS.filter((o) => o.searchKeys.toLowerCase().includes(q));
  }, [query]);

  const groupedOptions = useMemo(() => {
    return {
      builtin: filteredOptions.filter((o) => o.kind === 'builtin'),
      preset: filteredOptions.filter((o) => o.kind === 'preset'),
      custom: filteredOptions.filter((o) => o.kind === 'custom'),
      registry: filteredOptions.filter((o) => o.kind === 'registry'),
    };
  }, [filteredOptions]);

  const selectedOptionLabel = selectedOption ? getOptionLabel(t, selectedOption) : undefined;
  const selectedOptionDescription = selectedOption
    ? getOptionDescription(t, selectedOption)
    : undefined;

  const dialogTitle =
    mode.kind === 'edit'
      ? t('settings.agent.dialog.title.edit', {
          name: selectedOptionLabel ?? formData.name,
          defaultValue: 'Edit {{name}}',
        })
      : t('settings.agent.dialog.title.create', 'New provider');

  const showPicker = !isNarrowLayout || mobileView === 'picker';
  const showForm = !isNarrowLayout || mobileView === 'form';
  const canGoBack = isNarrowLayout && mode.kind === 'create' && mobileView === 'form';

  const pickerPane = (
    <aside
      aria-label={t('agents.agentTypeList', 'Agent types')}
      className={cn(
        'flex h-full flex-col border-border/60 bg-muted/20',
        isNarrowLayout ? 'w-full' : 'w-[292px] shrink-0 border-r'
      )}
    >
      <div
        className={cn(
          'flex h-[60px] items-center gap-2 border-b border-border/60',
          isNarrowLayout ? 'pl-2 pr-4' : 'pl-5 pr-14'
        )}
      >
        {isNarrowLayout && (
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t('common.close', 'Close')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
          {t('settings.agent.dialog.chooseType', 'Choose a type')}
        </div>
      </div>
      <div className="px-3 pt-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common.search', 'Search')}
            className={cn('pl-7 pr-7', isNarrowLayout ? 'h-9 text-sm' : 'h-8 text-xs')}
            aria-label={t('common.search', 'Search')}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('common.clear', 'Clear')}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-xs text-muted-foreground hover:bg-hover/50 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <nav className="scrollbar-pro mt-2 flex-1 overflow-y-auto px-2 pb-3" role="listbox">
        <RailGroup title={t('settings.agent.dialog.group.builtin', 'Built-in')}>
          {groupedOptions.builtin.map((opt) => (
            <RailItem
              key={opt.value}
              option={opt}
              selected={selectedOption?.value === opt.value}
              disabled={mode.kind === 'edit'}
              chevron={isNarrowLayout}
              onSelect={() => selectOption(opt)}
            />
          ))}
        </RailGroup>
        {groupedOptions.preset.length > 0 && (
          <RailGroup title={t('settings.agent.dialog.group.presets', 'Presets')}>
            {groupedOptions.preset.map((opt) => (
              <RailItem
                key={opt.value}
                option={opt}
                selected={selectedOption?.value === opt.value}
                disabled={mode.kind === 'edit'}
                chevron={isNarrowLayout}
                onSelect={() => selectOption(opt)}
              />
            ))}
          </RailGroup>
        )}
        {groupedOptions.custom.length > 0 && (
          <RailGroup title={t('settings.agent.dialog.group.custom', 'Custom')}>
            {groupedOptions.custom.map((opt) => (
              <RailItem
                key={opt.value}
                option={opt}
                selected={selectedOption?.value === opt.value}
                disabled={mode.kind === 'edit'}
                chevron={isNarrowLayout}
                onSelect={() => selectOption(opt)}
              />
            ))}
          </RailGroup>
        )}
        {groupedOptions.registry.length > 0 && (
          <RailGroup title={t('settings.agent.dialog.group.registry', 'ACP Provider')}>
            {groupedOptions.registry.map((opt) => (
              <RailItem
                key={opt.value}
                option={opt}
                selected={selectedOption?.value === opt.value}
                disabled={mode.kind === 'edit'}
                chevron={isNarrowLayout}
                onSelect={() => selectOption(opt)}
              />
            ))}
          </RailGroup>
        )}
        {filteredOptions.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t('settings.agent.dialog.noResults', 'No agents match that search')}
          </div>
        )}
      </nav>
    </aside>
  );

  const formPane = (
    <section className="flex min-h-0 flex-1 flex-col">
      <header
        className={cn(
          'flex h-[60px] shrink-0 items-center justify-between gap-3 border-b border-border/60',
          isNarrowLayout ? 'pl-2 pr-4' : 'pl-5 pr-14'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {isNarrowLayout && (
            <button
              type="button"
              onClick={() => (canGoBack ? setMobileView('picker') : onOpenChange(false))}
              aria-label={
                canGoBack
                  ? t('settings.agent.dialog.back', 'Back to type list')
                  : t('common.close', 'Close')
              }
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <span
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/30 text-foreground/90'
            )}
          >
            {selectedOption ? <OptionIcon option={selectedOption} className="h-4 w-4" /> : null}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-tight">{dialogTitle}</h2>
            {selectedOptionDescription && (
              <p className="line-clamp-1 text-xs text-muted-foreground">
                {selectedOptionDescription}
              </p>
            )}
          </div>
        </div>
        <ProbeStatus
          isPreset={isPreset}
          probing={probing}
          probeError={probeError}
          ready={capabilitiesReady && !builtinNeedsCredentialCheck && !authRequired}
          showIdleAction={!isCustom}
          onRetry={() => {
            setProbeError(null);
            if (isCustom) {
              void runCustomProbe();
              return;
            }
            setManuallyTested(false);
            setVerifiedBuiltinContext(null);
            setProbeTick((n) => n + 1);
          }}
        />
      </header>

      <div ref={formScrollRef} className="scrollbar-pro min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="space-y-5">
          <Field
            htmlFor="agent-config-name"
            label={t('agents.configName', 'Name')}
            hint={t(
              'settings.agent.dialog.nameHint',
              'Shown in the provider list and session menus.'
            )}
          >
            <Input
              id="agent-config-name"
              value={formData.name}
              onChange={(event) => setFormData({ ...formData, name: event.target.value })}
              placeholder={t('agents.configNamePlaceholder', 'Enter configuration name')}
              className="h-9"
              autoComplete="off"
            />
          </Field>

          {activePreset ? (
            <PresetPanel
              preset={activePreset}
              credentialMode={activeCredentialMode}
              credentialModeId={activeCredentialMode?.id}
              onCredentialModeChange={updatePresetCredentialMode}
              token={formData.presetToken ?? ''}
              onTokenChange={updatePresetToken}
              baseUrlOptionId={formData.presetBaseUrlOptionId}
              onBaseUrlOptionChange={(value) =>
                setFormData({ ...formData, presetBaseUrlOptionId: value })
              }
              customBaseUrl={formData.presetBaseUrl ?? ''}
              onCustomBaseUrlChange={(value) => setFormData({ ...formData, presetBaseUrl: value })}
              injectedEnv={buildPresetInjectedEnvPreview(
                activePreset,
                activeCredentialMode,
                formData
              )}
            />
          ) : null}

          {isDeepSeekBuiltin ? (
            <DeepSeekHarnessPanel
              endpointMode={deepseekEndpointMode}
              onEndpointModeChange={updateDeepSeekEndpointMode}
              apiKey={formData.env[DEEPSEEK_HARNESS_API_KEY_ENV] ?? ''}
              onApiKeyChange={updateDeepSeekApiKey}
              customBaseUrl={formData.deepseekCustomBaseUrl ?? ''}
              onCustomBaseUrlChange={updateDeepSeekCustomBaseUrl}
            />
          ) : null}

          {isCustom && (
            <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/[0.04] p-4">
              <Field
                htmlFor="custom-acp-command"
                label={t('settings.agent.dialog.custom.commandLabel', 'Launch command')}
                hint={t(
                  'settings.agent.dialog.custom.commandHint',
                  'The full command that starts an ACP-compatible agent over stdio, e.g. "npx -y my-acp-agent --flag". Quotes are supported for arguments with spaces; shell features like pipes or $VARS are not.'
                )}
                icon={<SquareTerminal className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                <Input
                  id="custom-acp-command"
                  value={formData.customCommandLine ?? ''}
                  onChange={(event) =>
                    setFormData({ ...formData, customCommandLine: event.target.value })
                  }
                  placeholder={t(
                    'settings.agent.dialog.custom.commandPlaceholder',
                    'npx -y my-acp-agent'
                  )}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 font-mono"
                />
              </Field>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!parsedCustomAcp || probing}
                  onClick={() => void runCustomProbe()}
                >
                  {probing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FlaskConical className="h-3.5 w-3.5" />
                  )}
                  {probing
                    ? t('settings.agent.dialog.custom.testing', 'Testing…')
                    : t('settings.agent.dialog.custom.test', 'Test command')}
                </Button>
                {customReady && !probing && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-status-success">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('settings.agent.dialog.ready', 'Ready')}
                  </span>
                )}
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t(
                  'settings.agent.dialog.custom.testHint',
                  'Custom providers are only probed when you click Test — re-test after changing the command.'
                )}
              </p>
            </div>
          )}

          {builtinRuntimeOverrideKey && !activePreset ? (
            <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
              <Field
                htmlFor="builtin-runtime-path"
                label={t('settings.agent.dialog.runtimeOverride.label', 'Runtime binary path')}
                hint={t(
                  'settings.agent.dialog.runtimeOverride.hint',
                  'Advanced: leave empty to let Lody install and verify the managed runtime. Filling this is not recommended unless you need a local enterprise mirror or are debugging runtime startup.'
                )}
                icon={<SquareTerminal className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                <Input
                  id="builtin-runtime-path"
                  value={builtinRuntimeOverrideValue}
                  onChange={(event) => updateBuiltinRuntimeOverride(event.target.value)}
                  placeholder={
                    formData.agentType === 'codex'
                      ? t(
                          'settings.agent.dialog.runtimeOverride.codexPlaceholder',
                          '/path/to/codex'
                        )
                      : formData.agentType === 'kimi'
                        ? t(
                            'settings.agent.dialog.runtimeOverride.kimiPlaceholder',
                            '/path/to/kimi'
                          )
                        : formData.agentType === 'grok'
                          ? t(
                              'settings.agent.dialog.runtimeOverride.grokPlaceholder',
                              '/path/to/grok'
                            )
                          : t(
                              'settings.agent.dialog.runtimeOverride.claudePlaceholder',
                              '/path/to/claude'
                            )
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 font-mono"
                />
              </Field>
              <div className="mt-3 flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!hasBuiltinRuntimeOverride || probing}
                  onClick={() => {
                    setProbeError(null);
                    setManuallyTested(false);
                    setVerifiedBuiltinContext(null);
                    setProbeTick((n) => n + 1);
                  }}
                >
                  {probing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FlaskConical className="h-3.5 w-3.5" />
                  )}
                  {probing
                    ? t('settings.agent.dialog.runtimeOverride.testing', 'Testing…')
                    : t('settings.agent.dialog.runtimeOverride.test', 'Test runtime')}
                </Button>
                {capabilitiesReady && !probing && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-status-success">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('settings.agent.dialog.ready', 'Ready')}
                  </span>
                )}
              </div>
            </div>
          ) : null}

          {probeError && !isPreset && (
            <div className="rounded-lg border border-status-warning/30 bg-status-warning/[0.08] px-3 py-2 text-xs text-status-warning">
              {probeError}
            </div>
          )}

          {showAuthenticationPanel ? (
            <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
              <Field
                label={t('settings.agent.dialog.section.account', 'Account')}
                hint={
                  authRequired
                    ? t(
                        'settings.agent.dialog.authRequiredHint',
                        'This provider has no credentials on this machine yet.'
                      )
                    : t(
                        'settings.agent.dialog.reauthenticateHint',
                        'Sign in again if this provider stopped accepting your account.'
                      )
                }
                icon={<KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                <AcpAuthenticationPanel
                  machineId={machine.id}
                  configId={agentConfigId}
                  cliType={formData.cliType}
                  agentType={formData.agentType}
                  providerName={formData.name}
                  customAcp={parsedCustomAcp ?? undefined}
                  runtimeOverrides={formData.runtimeOverrides}
                  env={formData.env}
                  compact
                  reauthentication={!authRequired}
                  onBeforeStart={persistConfigBeforeMachineLaunch}
                  onAuthenticated={() => {
                    setAuthRequired(false);
                    setProbeError(null);
                    setManuallyTested(true);
                    if (isCustom && parsedCustomAcp) {
                      setTestedCustomKey(customAcpKey);
                    }
                    if (requiresBuiltinCreationVerification) {
                      setVerifiedBuiltinContext(builtinVerificationContext);
                    }
                  }}
                />
              </Field>
            </div>
          ) : null}

          {showBinaryPanel && (
            <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-3 text-xs">
              {incompatibleHostMessage ? (
                <p className="text-status-warning">{incompatibleHostMessage}</p>
              ) : binaryStatus === 'unsupported-platform' ? (
                <p className="text-status-warning">
                  {t(
                    'settings.agent.dialog.binaryUnsupported',
                    "This agent isn't available for this machine's platform."
                  )}
                </p>
              ) : binaryStatus === 'unknown' || binaryProgressActive ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {formatBinaryStatusText(
                    t,
                    binaryStatus,
                    effectiveBinaryState,
                    usesDefaultManagedRuntime
                  )}
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-muted-foreground">
                    {binaryStatus === 'error'
                      ? t(
                          'settings.agent.dialog.binaryDownloadFailed',
                          'The agent runtime download failed.'
                        )
                      : usesDefaultManagedRuntime
                        ? backgroundManagedBuiltinSetup
                          ? t(
                              'settings.agent.dialog.managedRuntimeQueuedAfterCreate',
                              'The managed runtime is not downloaded or is out of date. Lody will download and verify it in the background after you add this provider.'
                            )
                          : t(
                              'settings.agent.dialog.managedRuntimeNotInstalled',
                              'The managed runtime is not downloaded or is out of date. Lody will download and verify it before creating this provider.'
                            )
                        : t(
                            'settings.agent.dialog.binaryNotInstalled',
                            'This agent must download a binary to this machine before it can be enabled.'
                          )}
                  </p>
                  {(effectiveBinaryState?.error ?? binaryError) && (
                    <p className="text-status-warning">
                      {effectiveBinaryState?.error ?? binaryError}
                    </p>
                  )}
                  {onInstallBinary &&
                  (binaryStatus === 'not-installed' || binaryStatus === 'error') ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={installingBinary || probing}
                      onClick={() => void handleInstallBinary()}
                    >
                      {installingBinary ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {t('settings.agent.dialog.binaryDownloading', 'Downloading…')}
                        </>
                      ) : (
                        <>
                          <Download className="h-3.5 w-3.5" />
                          {binaryStatus === 'error'
                            ? t('settings.agent.dialog.binaryRetryDownload', 'Retry download')
                            : t('settings.agent.dialog.binaryDownload', 'Download agent')}
                        </>
                      )}
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {!isPreset &&
            !acpProvidesSessionTitle &&
            (capabilitiesReady ? titleSelectors.length > 0 : true) && (
              <Section
                title={t('settings.agent.dialog.section.titleGen', 'Title generation')}
                defaultOpen
                disabled={!capabilitiesReady}
                disabledHint={t('settings.agent.dialog.probing', 'Loading available options…')}
              >
                <TitleGenerationFields
                  selectors={titleSelectors}
                  values={formData.titleGeneration?.configOptionValues}
                  onChange={(configId, value) => {
                    const nextValues = {
                      ...formData.titleGeneration?.configOptionValues,
                      [configId]: value,
                    };
                    setFormData({
                      ...formData,
                      titleGeneration: {
                        ...formData.titleGeneration,
                        configOptionValues: nextValues,
                      },
                    });
                  }}
                />
              </Section>
            )}

          <Section
            title={t('settings.agent.dialog.section.prompt', 'Custom prompt')}
            action={
              formData.prompt.trim().length > 0 ? (
                <InlineCopyButton value={formData.prompt} ariaLabel={t('common.copy', 'Copy')} />
              ) : null
            }
          >
            <Textarea
              value={formData.prompt}
              onChange={(event) => setFormData({ ...formData, prompt: event.target.value })}
              placeholder={t(
                'agents.customPromptPlaceholder',
                'Optional instructions to include before task details'
              )}
              rows={3}
            />
          </Section>

          <Section
            title={
              activePreset || isDeepSeekBuiltin
                ? t(
                    'settings.agent.dialog.section.envAdditional',
                    'Additional environment variables'
                  )
                : t('settings.agent.dialog.section.env', 'Environment variables')
            }
            count={envCount}
            action={
              envCount > 0 ? (
                <InlineCopyButton
                  value={envVarsToText(additionalEnv)}
                  ariaLabel={t('common.copy', 'Copy')}
                />
              ) : null
            }
          >
            {activePreset ? (
              <p className="mb-2 text-xs text-muted-foreground">
                {t(
                  'settings.agent.dialog.presetEnvHint',
                  'Preset variables (shown above) are injected automatically and cannot be overridden here.'
                )}
              </p>
            ) : null}
            {!activePreset && isDeepSeekBuiltin ? (
              <p className="mb-2 text-xs text-muted-foreground">
                {t(
                  'settings.agent.dialog.deepseek.envHint',
                  'DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL are set above and cannot be overridden here.'
                )}
              </p>
            ) : null}
            <EnvVarsTextarea
              value={additionalEnv}
              onChange={(env) => {
                if (!isDeepSeekBuiltin) {
                  updateEnvironment(env);
                  return;
                }
                const next = omitDeepSeekProtectedEnv(env);
                if (formData.env[DEEPSEEK_HARNESS_API_KEY_ENV]) {
                  next[DEEPSEEK_HARNESS_API_KEY_ENV] = formData.env[DEEPSEEK_HARNESS_API_KEY_ENV];
                }
                updateEnvironment(next);
              }}
              showLabel={false}
              rows={5}
            />
          </Section>
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-5 py-3">
        <div className="min-w-0 text-xs text-muted-foreground">
          {selectedOption?.kind === 'registry' && (
            <span className="inline-flex items-center gap-1">
              <FlaskConical className="h-3 w-3" aria-hidden="true" />
              {t('settings.agent.dialog.registryNote', 'Experimental — uses ACP Providers.')}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            size="sm"
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  onClick={() => void submit()}
                  disabled={
                    !!disableReason || submitting || (builtinCreationPending && !probeError)
                  }
                  size="sm"
                >
                  {(submitting || (builtinCreationPending && !authRequired && !probeError)) && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {mode.kind === 'edit' ? t('common.save', 'Save') : t('common.create', 'Create')}
                </Button>
              </span>
            </TooltipTrigger>
            {disableReason && <TooltipContent>{disableReason}</TooltipContent>}
          </Tooltip>
        </div>
      </footer>
    </section>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName={
          nestedInDialog
            ? // Radix portals are siblings under body. Matching the parent content's
              // z-index lets this later overlay cover it without stacking another /80 veil.
              'z-[var(--z-dialog)] bg-black/20'
            : undefined
        }
        className={cn(
          'flex max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none md:p-0',
          nestedInDialog && 'shadow-popover',
          isNarrowLayout
            ? cn(
                // True full-screen sheet on mobile: override the safe-area-aware
                // centering/max-height that DialogContent applies by default.
                // Keep keyboard height changes synchronous: the form scroll hook
                // measures the container on the keyboard event.
                'h-[calc(100dvh-var(--native-keyboard-height,0px))] max-h-none w-screen rounded-none border-none top-0 translate-y-0 transition-none',
                // Inset content from the device safe area (notch, home indicator,
                // landscape side cutouts). Padding pushes the inner picker/form
                // panes — including their fixed-height headers and footers —
                // away from the safe-area edges.
                'pt-[var(--safe-area-top)] pb-[max(0px,var(--safe-area-bottom,0px)-var(--native-keyboard-height,0px))] pl-[var(--safe-area-left)] pr-[var(--safe-area-right)]',
                // Hide the Radix-rendered X close button: on mobile the
                // picker/form headers render their own left-aligned back
                // button (which doubles as a close on the root step), so the
                // top-right X would be redundant and easy to hit by accident.
                '[&>button.absolute]:hidden'
              )
            : 'h-[min(680px,92dvh)] w-[min(1040px,96dvw)]'
        )}
      >
        <DialogTitle className="sr-only">{dialogTitle}</DialogTitle>
        <DialogDescription className="sr-only">
          {t(
            'settings.agent.dialog.a11yDescription',
            'Choose an agent type on the left and fill in the configuration on the right.'
          )}
        </DialogDescription>

        <div className="flex h-full min-h-0 flex-1">
          {showPicker && pickerPane}
          {showForm && formPane}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Returns true when the dialog should switch to the narrow / mobile two-step
 * flow. We watch viewport width directly (instead of `useIsMobile`) so a
 * narrow desktop window also switches.
 */
function useNarrowDialogLayout() {
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mql = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    setNarrow(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return narrow;
}

// =============================================================================
// Presentational helpers
// =============================================================================

function isAutoGeneratedName(name: string) {
  const n = name.trim();
  if (!n) return true;
  return ALL_OPTIONS.some((o) => o.label === n);
}

function getOptionLabel(t: Translate, option: AgentTypeOption) {
  return option.labelKey ? t(option.labelKey, option.label) : option.label;
}

function getOptionDescription(t: Translate, option: AgentTypeOption) {
  if (option.descriptionKey && option.descriptionDefault) {
    return t(option.descriptionKey, option.descriptionDefault);
  }
  return option.description;
}

function RailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-1">
      <div className="px-2 pt-3 pb-1.5 text-[11px] font-medium text-muted-foreground/80">
        {title}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function RailItem({
  option,
  selected,
  disabled,
  onSelect,
  chevron,
}: {
  option: AgentTypeOption;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** Show a chevron-right at the end of the row (used in mobile picker). */
  chevron?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled && !selected}
      onClick={onSelect}
      className={cn(
        'group relative flex w-full items-center gap-2.5 rounded-md text-left transition-colors',
        chevron ? 'px-2 py-2.5 text-[15px]' : 'px-2 py-1.5 text-sm',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
        selected
          ? 'bg-primary/10 text-foreground'
          : 'text-foreground/80 hover:bg-hover/50 hover:text-foreground',
        disabled && !selected && 'cursor-not-allowed opacity-40'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-primary transition-opacity',
          selected ? 'opacity-100' : 'opacity-0'
        )}
      />
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md border border-transparent',
          chevron ? 'h-7 w-7' : 'h-6 w-6',
          selected ? 'text-foreground' : 'text-foreground/70'
        )}
      >
        <OptionIcon option={option} className={chevron ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
      </span>
      <span className="min-w-0 flex-1 truncate leading-tight">{getOptionLabel(t, option)}</span>
      {selected && !chevron && (
        <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
      )}
      {chevron && (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      )}
    </button>
  );
}

function OptionIcon({ option, className }: { option: AgentTypeOption; className?: string }) {
  const brandId = option.presetId ? PRESETS_BY_ID[option.presetId]?.brandId : undefined;
  return (
    <AgentIcon
      cliType={option.cliType}
      agentType={option.agentType}
      brandId={brandId}
      className={className}
    />
  );
}

function formatBinaryStatusText(
  t: Translate,
  status: 'unknown' | AgentBinaryRuntimeStatus,
  state: { percent?: number } | null,
  managedRuntime: boolean
): string {
  if (status === 'downloading') {
    if (typeof state?.percent === 'number') {
      return t('settings.agent.dialog.binaryDownloadingPercent', 'Downloading… {{percent}}%', {
        percent: Math.round(state.percent),
      });
    }
    return t('settings.agent.dialog.binaryDownloading', 'Downloading…');
  }
  if (status === 'verifying') {
    return t('settings.agent.dialog.binaryVerifying', 'Verifying download…');
  }
  if (status === 'extracting') {
    return t('settings.agent.dialog.binaryExtracting', 'Extracting runtime…');
  }
  if (status === 'publishing') {
    return t('settings.agent.dialog.binaryPublishing', 'Installing runtime…');
  }
  if (status === 'not-installed') {
    return managedRuntime
      ? t('settings.agent.dialog.managedRuntimeDownloadRequired', 'Runtime download required…')
      : t('settings.agent.dialog.binaryDownloadRequired', 'Agent download required…');
  }
  return t('settings.agent.dialog.binaryChecking', 'Checking download status…');
}

function ProbeStatus({
  isPreset,
  probing,
  probeError,
  ready,
  showIdleAction,
  onRetry,
}: {
  isPreset: boolean;
  probing: boolean;
  probeError: string | null;
  ready: boolean;
  showIdleAction: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (isPreset) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
        <Sparkles className="h-3 w-3" aria-hidden="true" />
        {t('settings.agent.dialog.presetBadge', 'Preset')}
      </span>
    );
  }
  if (probing) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        {t('settings.agent.dialog.probing', 'Probing…')}
      </span>
    );
  }
  if (probeError) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-xs text-status-warning"
        onClick={onRetry}
        aria-label={t('settings.agent.dialog.retryProbe', 'Retry capability probe')}
      >
        <RefreshCw className="h-3 w-3" />
        {t('common.retry', 'Retry')}
      </Button>
    );
  }
  if (ready) {
    return (
      <div className="inline-flex shrink-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onRetry}
              aria-label={t(
                'settings.agent.dialog.refreshCapabilities',
                'Refresh agent capabilities'
              )}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {t(
              'settings.agent.dialog.refreshCapabilitiesHint',
              'Re-probe modes, models, and config options'
            )}
          </TooltipContent>
        </Tooltip>
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-status-success/30 bg-status-success/10 px-2.5 py-1 text-[11px] font-medium text-status-success">
          <Check className="h-3 w-3" aria-hidden="true" />
          {t('settings.agent.dialog.ready', 'Ready')}
        </span>
      </div>
    );
  }
  if (!showIdleAction) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="h-7 gap-1 px-2 text-xs"
      onClick={onRetry}
      aria-label={t('settings.agent.dialog.testCapabilities', 'Test agent capabilities')}
    >
      <FlaskConical className="h-3 w-3" />
      {t('settings.agent.dialog.testCapabilitiesShort', 'Test')}
    </Button>
  );
}

function DeepSeekApiKeyField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <Field
      htmlFor="deepseek-api-key"
      label={label ?? t('settings.agent.dialog.deepseek.apiKeyLabel', 'DeepSeek API Key')}
      hint={t(
        'settings.agent.dialog.deepseek.apiKeyHelp',
        'Saved with this provider and injected as DEEPSEEK_API_KEY when DSH starts.'
      )}
      icon={<KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
    >
      <Input
        id="deepseek-api-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('settings.agent.dialog.deepseek.apiKeyPlaceholder', 'sk-XXXXXXXXXXXX')}
        className="h-9 font-mono"
      />
    </Field>
  );
}

function DeepSeekHarnessPanel({
  endpointMode,
  onEndpointModeChange,
  apiKey,
  onApiKeyChange,
  customBaseUrl,
  onCustomBaseUrlChange,
}: {
  endpointMode: DeepSeekEndpointMode;
  onEndpointModeChange: (value: DeepSeekEndpointMode) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  customBaseUrl: string;
  onCustomBaseUrlChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/[0.04] p-4">
      <Tabs
        value={endpointMode}
        onValueChange={(value) => {
          if (value === 'official' || value === 'custom') {
            onEndpointModeChange(value);
          }
        }}
      >
        <TabsList className="grid h-8 w-full grid-cols-2">
          <TabsTrigger value="official" className="px-2.5 text-xs">
            {t('settings.agent.dialog.deepseek.officialTab', 'DeepSeek official')}
          </TabsTrigger>
          <TabsTrigger value="custom" className="px-2.5 text-xs">
            {t('settings.agent.dialog.deepseek.customTab', 'Custom Endpoint')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="official" className="mt-3">
          <DeepSeekApiKeyField value={apiKey} onChange={onApiKeyChange} />
        </TabsContent>
        <TabsContent value="custom" className="mt-3 space-y-3">
          <Field
            htmlFor="deepseek-endpoint"
            label={t('settings.agent.dialog.deepseek.endpointLabel', 'API Endpoint')}
            hint={t(
              'settings.agent.dialog.deepseek.endpointHelp',
              'Required HTTP or HTTPS URL. Saved as DEEPSEEK_BASE_URL without adding or removing /v1.'
            )}
          >
            <Input
              id="deepseek-endpoint"
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={customBaseUrl}
              onChange={(event) => onCustomBaseUrlChange(event.target.value)}
              placeholder={t(
                'settings.agent.dialog.deepseek.endpointPlaceholder',
                'https://example.com'
              )}
              className="h-9 font-mono"
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            {t(
              'settings.agent.dialog.deepseek.modelsDiscovered',
              'Available models are discovered automatically from the endpoint when this provider is verified.'
            )}
          </p>
          <DeepSeekApiKeyField
            value={apiKey}
            onChange={onApiKeyChange}
            label={t('settings.agent.dialog.deepseek.customApiKeyLabel', 'API Key')}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PresetPanel({
  preset,
  credentialMode,
  credentialModeId,
  onCredentialModeChange,
  token,
  onTokenChange,
  baseUrlOptionId,
  onBaseUrlOptionChange,
  customBaseUrl,
  onCustomBaseUrlChange,
  injectedEnv,
}: {
  preset: PresetDefinition;
  credentialMode: PresetCredentialMode | undefined;
  credentialModeId: string | undefined;
  onCredentialModeChange: (value: string) => void;
  token: string;
  onTokenChange: (value: string) => void;
  baseUrlOptionId: string | undefined;
  onBaseUrlOptionChange: (value: string) => void;
  customBaseUrl: string;
  onCustomBaseUrlChange: (value: string) => void;
  injectedEnv: Record<string, string>;
}) {
  const { t } = useTranslation();
  const credentialModes = preset.credentialModes ?? [];
  const baseUrlOption = getBaseUrlOption(credentialMode, baseUrlOptionId);
  const selectedBaseUrlOptionId = baseUrlOption?.id;
  const showCustomBaseUrl =
    !!credentialMode?.baseUrlEnvKey && baseUrlOption?.id === credentialMode.customBaseUrlOptionId;
  const tokenEnvKey = getPresetTokenEnvKey(preset, credentialMode);
  return (
    <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/[0.04] p-4">
      {credentialModes.length > 0 ? (
        <Field
          label={t(
            preset.credentialModeGroupLabelKey ?? 'settings.agent.dialog.preset.usageMethod',
            preset.credentialModeGroupLabelDefault ?? 'Usage method'
          )}
          hint={t(
            preset.credentialModeGroupHintKey ?? 'settings.agent.dialog.preset.usageMethodHint',
            preset.credentialModeGroupHintDefault ??
              'Choose the MiMo credential type you copied from the console.'
          )}
        >
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
            {credentialModes.map((mode) => {
              const selected = mode.id === credentialModeId;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onCredentialModeChange(mode.id)}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                    selected
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border/60 bg-background/50 text-foreground/80 hover:bg-background'
                  )}
                >
                  <span className="block text-xs font-medium">
                    {t(mode.labelKey, mode.labelDefault)}
                  </span>
                  <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                    {t(mode.descriptionKey, mode.descriptionDefault)}
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
      ) : null}

      <Field
        htmlFor="preset-token"
        label={t(
          credentialMode?.tokenLabelKey ?? preset.tokenLabelKey,
          credentialMode?.tokenLabelDefault ?? preset.tokenLabelDefault
        )}
        hint={
          <>
            {t(
              credentialMode?.tokenHelpKey ?? preset.tokenHelpKey,
              credentialMode?.tokenHelpDefault ?? preset.tokenHelpDefault
            )}
            {preset.helpUrl ? (
              <>
                {' '}
                <a
                  href={preset.helpUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  {t(
                    preset.helpLinkLabelKey ?? 'settings.agent.dialog.preset.helpLink',
                    preset.helpLinkLabelDefault ?? 'Open setup guide'
                  )}
                </a>
              </>
            ) : null}
          </>
        }
        icon={<KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        <Input
          id="preset-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder={t(
            credentialMode?.tokenPlaceholderKey ?? preset.tokenPlaceholderKey,
            credentialMode?.tokenPlaceholderDefault ?? preset.tokenPlaceholderDefault
          )}
          className="h-9 font-mono"
        />
      </Field>

      {credentialMode?.baseUrlEnvKey && credentialMode.baseUrlOptions ? (
        <Field
          htmlFor={showCustomBaseUrl ? 'preset-base-url' : undefined}
          label={t(
            credentialMode.baseUrlLabelKey ?? 'settings.agent.dialog.preset.baseUrlLabelFallback',
            credentialMode.baseUrlLabelDefault ?? 'Base URL'
          )}
          hint={t(
            credentialMode.baseUrlHelpKey ?? 'settings.agent.dialog.preset.baseUrlHelpFallback',
            credentialMode.baseUrlHelpDefault ?? 'Select or enter the provider Base URL.'
          )}
        >
          <div className="space-y-2">
            <Select value={selectedBaseUrlOptionId} onValueChange={onBaseUrlOptionChange}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {credentialMode.baseUrlOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id} className="text-xs">
                    {t(option.labelKey, option.labelDefault)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {showCustomBaseUrl ? (
              <Input
                id="preset-base-url"
                type="url"
                autoComplete="off"
                spellCheck={false}
                value={customBaseUrl}
                onChange={(e) => onCustomBaseUrlChange(e.target.value)}
                placeholder={t(
                  credentialMode.baseUrlPlaceholderKey ??
                    'settings.agent.dialog.preset.baseUrlPlaceholderFallback',
                  credentialMode.baseUrlPlaceholderDefault ?? 'https://example.com/anthropic'
                )}
                className="h-9 font-mono"
              />
            ) : null}
          </div>
        </Field>
      ) : null}

      <Collapsible>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group inline-flex items-center gap-1.5 rounded-md text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
            {t('settings.agent.dialog.preset.showInjected', 'Show injected variables')}
            <Lock className="h-3 w-3 opacity-70" aria-hidden="true" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <div className="rounded-md border border-border/60 bg-background/50">
            <dl className="divide-y divide-border/40 text-[11px]">
              {Object.entries(injectedEnv).map(([key, value]) => (
                <div key={key} className="flex items-center gap-3 px-3 py-1.5">
                  <dt className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 flex-1 truncate text-right font-mono text-foreground/80">
                    {value || t('settings.agent.dialog.required', '(required)')}
                  </dd>
                </div>
              ))}
              <div className="flex items-center gap-3 px-3 py-1.5">
                <dt className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                  {tokenEnvKey}
                </dt>
                <dd className="min-w-0 flex-1 truncate text-right font-mono text-primary/90">
                  {token.trim() ? '••••••••' : t('settings.agent.dialog.required', '(required)')}
                </dd>
              </div>
            </dl>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function Field({
  htmlFor,
  label,
  hint,
  icon,
  children,
}: {
  htmlFor?: string;
  label: string;
  hint?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <Label htmlFor={htmlFor} className="text-xs font-medium">
          {label}
        </Label>
      </div>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({
  title,
  count,
  children,
  disabled,
  disabledHint,
  defaultOpen,
  action,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  disabled?: boolean;
  disabledHint?: string;
  defaultOpen?: boolean;
  action?: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <div className="flex h-9 items-center gap-1 rounded-md border border-border/60 bg-card/40 pr-1 hover:bg-card/70">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-left text-sm font-medium text-foreground/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
            <span className="min-w-0 truncate">{title}</span>
            {typeof count === 'number' && count > 0 ? (
              <span className="ml-auto rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                {count}
              </span>
            ) : null}
          </button>
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent className="mt-2">
        <div className="pl-1">
          {disabled ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">{disabledHint}</p>
          ) : (
            children
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function InlineCopyButton({ value, ariaLabel }: { value: string; ariaLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        if (!value) return;
        void navigator.clipboard.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function TitleGenerationFields({
  selectors,
  values,
  onChange,
}: {
  selectors: AcpConfigOptionSelector[];
  values: Record<string, AcpConfigOptionValue> | undefined;
  onChange: (configId: string, value: AcpConfigOptionValue) => void;
}) {
  const { t } = useTranslation();
  if (selectors.length === 0) return null;
  return (
    <div className="space-y-2 pt-1">
      {selectors.map((sel) => {
        const stored = values?.[sel.configId];
        if (sel.type === 'boolean') {
          const isEnabled = (stored ?? sel.currentValue) === true;
          return (
            <div
              key={sel.configId}
              className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center"
            >
              <Label className="text-xs text-muted-foreground">{sel.label}</Label>
              <Button
                type="button"
                variant="outline"
                className="h-8 w-fit gap-1 rounded-md px-2 text-xs"
                onClick={() => onChange(sel.configId, !isEnabled)}
                aria-pressed={isEnabled}
              >
                {isEnabled ? <Check className="h-3 w-3" /> : null}
                {isEnabled
                  ? t('agents.booleanEnabled', 'Enabled')
                  : t('agents.booleanDisabled', 'Disabled')}
              </Button>
            </div>
          );
        }
        return (
          <div
            key={sel.configId}
            className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center"
          >
            <Label className="text-xs text-muted-foreground">{sel.label}</Label>
            <Select
              value={(stored as string | undefined) ?? sel.currentValue}
              onValueChange={(value) => onChange(sel.configId, value)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sel.options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}

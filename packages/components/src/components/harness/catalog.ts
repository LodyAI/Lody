/*
 * Static catalogue for the harness surface: how a machine can join, which
 * providers it can sign in to, and what can be injected and allowed. The
 * machine list itself is live (see machines.tsx); this file holds only the
 * copy and the drawn types.
 */

/** The product the copy and shell name. */
export const BRAND = 'Lody';
export const CLI = 'lody';

export type DeviceKind = 'laptop' | 'desktop' | 'server' | 'cloud';
export type DeviceStatus = 'online' | 'idle' | 'offline';

/**
 * The drawn machine row. `id` is the machine's `MachineId` — the harness
 * store keys selection and per-device overrides by it. `MachineViewMeta`
 * carries no `arch`, so the drawn "System" fact is the OS label alone.
 */
export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  os: string;
  host: string;
  version: string;
  status: DeviceStatus;
}

export type PairMethod = 'local' | 'remote' | 'cloud';

export const PAIR_METHODS: {
  id: PairMethod;
  title: string;
  body: string;
  tag?: string;
  kind: DeviceKind;
  /** Hidden methods keep their code but are not offered in the picker. */
  hidden?: boolean;
}[] = [
  {
    id: 'local',
    title: 'This computer',
    body: "Run agents next to your editor. Uses the desktop app that's already open.",
    tag: 'Detected',
    kind: 'laptop',
  },
  {
    id: 'remote',
    title: 'Remote machine',
    body: 'A workstation, homelab box or VM. Pair it with one terminal command.',
    kind: 'server',
  },
  // Hidden until there is a cloud-VM backend to call; CloudPair stays in pair.tsx.
  {
    id: 'cloud',
    title: 'Cloud sandbox',
    body: 'An isolated VM we host for you. Ready in about 20 seconds.',
    kind: 'cloud',
    hidden: true,
  },
];

export type AuthMethod = 'oauth' | 'key' | 'local';

/**
 * How a provider is reached. The page groups by this because it is the one
 * thing that changes what the row asks for: a subscription is a sign-in, a
 * token is a key, a local runtime is a scan, and a custom endpoint is a base
 * URL plus a key.
 */
export type ProviderKind = 'subscription' | 'token' | 'local' | 'custom';

export interface Provider {
  id: string;
  name: string;
  /** The glyph drawn in the row; the tabular letter, not a logo import. */
  mark: string;
  tint: string;
  kind: ProviderKind;
  auth: AuthMethod[];
  blurb: string;
  keyHint?: string;
  keyPattern?: RegExp;
  /** The runtime the brand is driven through, as Lody states it per preset. */
  runtime?: string;
  /** Endpoints the brand's own key can belong to, in the order to offer them. */
  endpoints?: { id: string; label: string; url: string }[];
  /** Whether the row also accepts a base URL the user types. */
  allowCustomEndpoint?: boolean;
  /** Writable from the account (credentials) or owned by a machine. */
  scope?: 'account' | 'machine';
}

/**
 * The provider set Lody actually ships presets for, plus the runtimes a
 * machine can host. A user-defined endpoint is not a row here: it is added at
 * runtime and rendered from the credentials.
 */
export const PROVIDERS: Provider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    mark: 'D',
    tint: '#4d6bfe',
    kind: 'token',
    auth: ['key'],
    blurb: 'Official endpoint or your own gateway, driven through Claude Code or Reasonix.',
    keyHint: 'sk-…',
    keyPattern: /^sk-[\w-]{12,}$/,
    runtime: 'Claude Code · Reasonix',
    endpoints: [
      {
        id: 'official',
        label: 'Official · api.deepseek.com',
        url: 'https://api.deepseek.com/anthropic',
      },
    ],
    allowCustomEndpoint: true,
  },
  {
    id: 'mimo',
    name: 'MiMo',
    mark: 'M',
    tint: '#f97316',
    kind: 'token',
    auth: ['key'],
    blurb: 'Pay as you go or a token plan; the token plan can point at your own base URL.',
    keyHint: 'mimo-…',
    runtime: 'Claude Code',
    endpoints: [
      {
        id: 'payg',
        label: 'Pay as you go · api.mimo.xiaomi.com',
        url: 'https://api.mimo.xiaomi.com/anthropic',
      },
      {
        id: 'token-plan',
        label: 'Token plan · token.mimo.xiaomi.com',
        url: 'https://token.mimo.xiaomi.com/anthropic',
      },
    ],
    allowCustomEndpoint: true,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    mark: 'X',
    tint: '#7c3aed',
    kind: 'token',
    auth: ['key'],
    blurb: 'MiniMax M-series through Claude Code.',
    keyHint: 'eyJ…',
    runtime: 'Claude Code',
  },
  {
    id: 'glm',
    name: 'GLM',
    mark: 'G',
    tint: '#0ea5a4',
    kind: 'token',
    auth: ['key'],
    blurb: 'BigModel or Z.AI credentials; pick the endpoint your key belongs to.',
    keyHint: 'glm-…',
    runtime: 'Claude Code',
    endpoints: [
      {
        id: 'bigmodel',
        label: 'BigModel · open.bigmodel.cn',
        url: 'https://open.bigmodel.cn/api/anthropic',
      },
      { id: 'zai', label: 'Z.AI · api.z.ai', url: 'https://api.z.ai/api/anthropic' },
    ],
    allowCustomEndpoint: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    mark: 'A',
    tint: '#d97757',
    kind: 'subscription',
    auth: ['oauth', 'key'],
    blurb: 'Claude Code on a subscription, or an API key on the official endpoint.',
    keyHint: 'sk-ant-…',
    keyPattern: /^sk-ant-[\w-]{12,}$/,
    runtime: 'Claude Code',
    scope: 'machine',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    mark: 'O',
    tint: '#10a37f',
    kind: 'subscription',
    auth: ['oauth', 'key'],
    blurb: 'Codex on a ChatGPT plan, or an API key.',
    keyHint: 'sk-…',
    runtime: 'Codex',
    scope: 'machine',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    mark: 'L',
    tint: '#71717a',
    kind: 'local',
    auth: ['local'],
    blurb: 'Local models on this device. Nothing leaves the machine.',
    scope: 'machine',
  },
];

export interface Model {
  id: string;
  provider: string;
  name: string;
  context: string;
  tier: 'frontier' | 'balanced' | 'fast' | 'local';
}

export const MODELS: Model[] = [
  {
    id: 'deepseek-chat',
    provider: 'deepseek',
    name: 'DeepSeek Chat',
    context: '128K',
    tier: 'balanced',
  },
  {
    id: 'deepseek-reasoner',
    provider: 'deepseek',
    name: 'DeepSeek Reasoner',
    context: '128K',
    tier: 'frontier',
  },
  { id: 'mimo-v2', provider: 'mimo', name: 'MiMo V2', context: '128K', tier: 'balanced' },
  { id: 'mimo-v2-flash', provider: 'mimo', name: 'MiMo V2 Flash', context: '64K', tier: 'fast' },
  { id: 'minimax-m2', provider: 'minimax', name: 'MiniMax M2', context: '200K', tier: 'balanced' },
  { id: 'glm-4-6', provider: 'glm', name: 'GLM-4.6', context: '200K', tier: 'balanced' },
  { id: 'glm-4-5-air', provider: 'glm', name: 'GLM-4.5 Air', context: '128K', tier: 'fast' },
  {
    id: 'claude-opus-4-5',
    provider: 'anthropic',
    name: 'Claude Opus 4.5',
    context: '200K',
    tier: 'frontier',
  },
  {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    name: 'Claude Sonnet 4.5',
    context: '200K',
    tier: 'balanced',
  },
  { id: 'gpt-5-1', provider: 'openai', name: 'GPT-5.1', context: '400K', tier: 'frontier' },
  { id: 'gpt-5-mini', provider: 'openai', name: 'GPT-5 mini', context: '400K', tier: 'fast' },
  {
    id: 'qwen3-coder',
    provider: 'ollama',
    name: 'qwen3-coder 30b',
    context: '128K',
    tier: 'local',
  },
  { id: 'llama-70b', provider: 'ollama', name: 'llama 3.3 70b', context: '128K', tier: 'local' },
];

export type Autonomy = 'ask' | 'smart' | 'auto';

/**
 * The three cards are Sorbet's selectable permission modes (`ask`, `auto`,
 * `full-access`; see `AUTONOMY_PERMISSION_MODE`), described as Sorbet runs them.
 */
export const AUTONOMY: { id: Autonomy; title: string; body: string; example: string }[] = [
  {
    id: 'ask',
    title: 'Ask first',
    body: 'Every edit and command waits for you.',
    example: 'Best for a new repo or a production box.',
  },
  {
    id: 'smart',
    title: 'Automatic review',
    body: 'Runs inside the workspace sandbox; a reviewer model approves each action instead of you.',
    example: 'Hands-off without leaving the workspace.',
  },
  {
    id: 'auto',
    title: 'Full access',
    body: 'No approvals and no sandbox: the agent can do whatever you can on this machine.',
    example: 'For throwaway machines and long background jobs.',
  },
];

export type FsScope = 'workspace' | 'home' | 'full';
export type Network = 'off' | 'allowlist' | 'on';

export const GUARDED_ACTIONS: { id: string; label: string }[] = [
  { id: 'push', label: 'git push' },
  { id: 'delete', label: 'Delete files' },
  { id: 'install', label: 'Install packages' },
  { id: 'send', label: 'Send messages' },
  { id: 'spend', label: 'Spend money' },
  { id: 'deploy', label: 'Deploy' },
];

/**
 * The stored effort pick. The values an agent advertises are its own
 * (`minimal`..`max` on some, `low`..`ultra` on others), so this is any option
 * value — the classic ladder stays as the type's documentation.
 */
export type Effort = string;

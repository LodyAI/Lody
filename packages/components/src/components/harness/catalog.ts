/*
 * Static catalogue for the harness surface: what can be paired, signed in to,
 * injected and allowed. Every screen reads from here, so swapping this for the
 * real registry (providers, models, plugins, machine list) is one file.
 *
 * Nothing here talks to a backend yet: the port wires the design first.
 */

/** The product the copy and shell name. */
export const BRAND = 'Lody';
export const CLI = 'lody';

export type DeviceKind = 'laptop' | 'desktop' | 'server' | 'cloud';
export type DeviceStatus = 'online' | 'idle' | 'offline';

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  os: string;
  arch: string;
  host: string;
  version: string;
  status: DeviceStatus;
  pairedAt: number;
}

export type PairMethod = 'local' | 'remote' | 'cloud';

export const PAIR_METHODS: {
  id: PairMethod;
  title: string;
  body: string;
  tag?: string;
  kind: DeviceKind;
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
  {
    id: 'cloud',
    title: 'Cloud sandbox',
    body: 'An isolated VM we host for you. Ready in about 20 seconds.',
    kind: 'cloud',
  },
];

/** The device each pairing method produces in this demo. */
export const PAIR_RESULT: Record<PairMethod, Omit<Device, 'id' | 'pairedAt'>> = {
  local: {
    name: 'MacBook Pro',
    kind: 'laptop',
    os: 'macOS 16.1',
    arch: 'arm64',
    host: 'ada-mbp.local',
    version: '2.14.0',
    status: 'online',
  },
  remote: {
    name: 'build-box',
    kind: 'server',
    os: 'Ubuntu 24.04',
    arch: 'x86_64',
    host: '10.0.4.21',
    version: '2.14.0',
    status: 'online',
  },
  cloud: {
    name: 'Sandbox · iad-1',
    kind: 'cloud',
    os: 'Linux 6.12',
    arch: 'x86_64',
    host: 'sbx-7f3k.lody.dev',
    version: '2.14.0',
    status: 'online',
  },
};

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

export type PluginGroup = 'mcp' | 'skills' | 'hooks' | 'context';

export interface Plugin {
  id: string;
  group: PluginGroup;
  name: string;
  body: string;
  /** Tokens the injection adds to every request. */
  tokens: number;
  needsAuth?: boolean;
}

export const PLUGIN_GROUPS: { id: PluginGroup; label: string; hint: string }[] = [
  { id: 'context', label: 'Context', hint: 'Injected into the system prompt' },
  { id: 'mcp', label: 'MCP servers', hint: 'Tools the agent can call' },
  { id: 'skills', label: 'Skills', hint: 'Loaded on demand, near-zero idle cost' },
  { id: 'hooks', label: 'Hooks', hint: 'Run around tool calls, never in context' },
];

export const PLUGINS: Plugin[] = [
  {
    id: 'rules',
    group: 'context',
    name: 'Project rules',
    body: 'AGENTS.md and .rules files from the repo root',
    tokens: 900,
  },
  {
    id: 'repomap',
    group: 'context',
    name: 'Repo map',
    body: 'A ranked outline of symbols the agent can navigate',
    tokens: 2400,
  },
  {
    id: 'git',
    group: 'context',
    name: 'Git status',
    body: 'Branch, diff stat and recent commits at session start',
    tokens: 300,
  },
  {
    id: 'fs',
    group: 'mcp',
    name: 'Filesystem',
    body: 'Read, write and search inside the workspace',
    tokens: 1100,
  },
  {
    id: 'github',
    group: 'mcp',
    name: 'GitHub',
    body: 'Issues, pull requests, reviews and checks',
    tokens: 2600,
    needsAuth: true,
  },
  {
    id: 'browser',
    group: 'mcp',
    name: 'Browser',
    body: 'Headless Chromium for docs, previews and screenshots',
    tokens: 1800,
  },
  {
    id: 'postgres',
    group: 'mcp',
    name: 'Postgres',
    body: 'Read-only queries against a connection string',
    tokens: 900,
    needsAuth: true,
  },
  {
    id: 'linear',
    group: 'mcp',
    name: 'Linear',
    body: 'Read and update tickets in your team',
    tokens: 1500,
    needsAuth: true,
  },
  {
    id: 'review',
    group: 'skills',
    name: 'Code review',
    body: 'A checklist pass before anything is committed',
    tokens: 60,
  },
  {
    id: 'tests',
    group: 'skills',
    name: 'Test writer',
    body: 'Generates and runs tests for changed files',
    tokens: 60,
  },
  {
    id: 'design',
    group: 'skills',
    name: 'UI verify',
    body: 'Screenshots the app and compares against intent',
    tokens: 60,
  },
  {
    id: 'fmt',
    group: 'hooks',
    name: 'Format on write',
    body: 'Runs the project formatter after every edit',
    tokens: 0,
  },
  {
    id: 'notify',
    group: 'hooks',
    name: 'Notify when done',
    body: 'Desktop and phone notification on finish or block',
    tokens: 0,
  },
  {
    id: 'guard',
    group: 'hooks',
    name: 'Secret guard',
    body: 'Blocks writes that contain keys or tokens',
    tokens: 0,
  },
];

export type PluginPreset = 'minimal' | 'recommended' | 'everything';

export const PLUGIN_PRESETS: Record<PluginPreset, string[]> = {
  minimal: ['rules', 'fs', 'guard'],
  recommended: [
    'rules',
    'git',
    'fs',
    'github',
    'browser',
    'review',
    'tests',
    'fmt',
    'notify',
    'guard',
  ],
  everything: PLUGINS.map((plugin) => plugin.id),
};

/** Context window the token meter is measured against. */
export const CONTEXT_BUDGET = 16000;

export type Autonomy = 'ask' | 'smart' | 'auto';

export const AUTONOMY: { id: Autonomy; title: string; body: string; example: string }[] = [
  {
    id: 'ask',
    title: 'Ask first',
    body: 'Every edit and command waits for you.',
    example: 'Best for a new repo or a production box.',
  },
  {
    id: 'smart',
    title: 'Ask when it matters',
    body: 'Reads and edits run. Anything outward or destructive waits.',
    example: 'What most teams pick.',
  },
  {
    id: 'auto',
    title: 'Autonomous',
    body: 'Runs end to end inside the sandbox. Locked actions still wait.',
    example: 'For sandboxes and long background jobs.',
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

export type Effort = 'low' | 'medium' | 'high';

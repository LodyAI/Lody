import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AgentConfigCliType,
  DEEPSEEK_HARNESS_BASE_URL_ENV,
  type BuiltinRuntimeOverrides,
  type CliType,
  type CustomAcpLaunchSpec,
  getBuiltinRuntimeOverrideSourceVersionSuffix,
  getRegistryAcpLaunchKind,
  isBuiltinAgentType,
  isManagedBuiltinAgentType,
  REGISTRY_ACP_AGENTS,
  type RegistryAcpAgent,
  type RegistryNpxDistribution,
  serializeCustomAcpLaunchSpec,
} from '@lody/shared';

import { getAcpBinaryManager } from '@/agent/acp-binary-manager';
import {
  BUILTIN_CLAUDE_CAPABILITY_SOURCE_VERSION,
  BUILTIN_CODEX_CAPABILITY_SOURCE_VERSION,
  BUILTIN_GROK_CAPABILITY_SOURCE_VERSION,
  BUILTIN_KIMI_CAPABILITY_SOURCE_VERSION,
  CLAUDE_ACP_ADAPTER_VERSION,
  CLAUDE_AGENT_SDK_VERSION,
  CODEX_ACP_ADAPTER_VERSION,
  getManagedAgentRuntimeManager,
  GROK_ACP_ADAPTER_VERSION,
  KIMI_CODE_VERSION,
  type ManagedRuntimeLaunch,
  type ManagedRuntimeName,
  type ManagedRuntimeProgressCallback,
} from '@/agent/managed-agent-runtime';
import { getManagedRuntimeUpdateCoordinator } from '@/agent/managed-runtime-update-coordinator';
import {
  DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION,
  resolveDeepSeekHarnessProcessLaunch,
} from '@/agent/deepseek-harness-runtime';

export interface ACPSetting {
  packageName: string;
  version: string;
  /**
   * Executable name when installed globally.
   */
  binName: string;
  /**
   * Args forwarded to the ACP agent binary itself.
   */
  args?: string[];
}

export type ResolveACPSettingInput = {
  cliType: AgentConfigCliType;
  agentType: string;
  /**
   * Launch spec for `cliType: 'custom'` agents. Builtin/registry launches are
   * resolved from static tables keyed by `agentType`; custom launches are
   * user-defined per agent config, so callers must thread the spec through
   * (it travels with the session/config the same way `env` does).
   */
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  /** Environment values that can alter an agent's advertised capabilities. */
  env?: NodeJS.ProcessEnv;
};

export type ResolvedACPSetting = {
  /**
   * What we report to the UI.
   */
  status: {
    agent: string;
    command: string;
  };
  /**
   * What we actually execute.
   */
  exec: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
};

export type ResolveACPProcessLaunchInput = ResolveACPSettingInput & {
  /**
   * Args appended after the ACP agent's configured launch args.
   */
  extraArgs?: string[];
  /** Reports managed-runtime download/extract progress for builtin agents. */
  onManagedRuntimeProgress?: ManagedRuntimeProgressCallback;
  signal?: AbortSignal;
};

export type ResolvedACPProcessLaunch = {
  command: string;
  args: string[];
  capabilitySourceVersion?: string;
  /**
   * Environment overlay required by this ACP launch. Callers that spawn a
   * process directly should merge this over their base environment.
   */
  env?: Record<string, string>;
};

export type BuiltinAuthenticationAction = 'login' | 'status';

export type ResolveBuiltinAuthenticationProcessLaunchInput = ResolveACPSettingInput & {
  action: BuiltinAuthenticationAction;
  /** Reports managed-runtime download/extract progress for builtin agents. */
  onManagedRuntimeProgress?: ManagedRuntimeProgressCallback;
  signal?: AbortSignal;
};

export const BuiltinACPSetting: Record<CliType, ACPSetting> = {
  kimi: {
    packageName: '@moonshot-ai/kimi-code',
    version: KIMI_CODE_VERSION,
    binName: 'kimi',
  },
  grok: {
    packageName: 'acp-extension-grok',
    version: GROK_ACP_ADAPTER_VERSION,
    binName: 'grok',
  },
  claude: {
    packageName: 'acp-extension-claude',
    version: CLAUDE_ACP_ADAPTER_VERSION,
    binName: 'acp-extension-claude',
  },
  codex: {
    packageName: 'acp-extension-codex',
    version: CODEX_ACP_ADAPTER_VERSION,
    binName: 'acp-extension-codex',
    args: [
      '-c',
      'shell_environment_policy.ignore_default_excludes=true',
      '-c',
      'features.goals=true',
    ],
  },
};

// Serve npx launches from the local cache when the package is already
// installed; go to the registry only on a cache miss. Registry agent specs are
// exact-version pinned, so a cache hit is immutable and integrity-checked —
// there is nothing to revalidate online. The previous '--prefer-online' forced
// a registry round-trip on EVERY launch, which offline hung ACP startup until
// the 300s cold-npx timeout ×3 attempts (~15min of "Starting ACP";
// specs/local-first-two-plane.md: local tasks must not block on the cloud).
// Broken/poisoned caches are handled by runNpxStartupWithRecovery: it purges
// the offending _npx dir(s) and retries, and a purged cache re-downloads from
// the registry regardless of this flag.
const NPX_CACHE_MODE_ARG = '--prefer-offline';

export function resolveRegistryNpxPackage(
  distribution: RegistryNpxDistribution,
  platform: string = process.platform,
  arch: string = process.arch
): string {
  return distribution.platformPackages?.[platform]?.[arch] ?? distribution.package;
}

const DEFAULT_ACP_PATH_RELATIVE_DIRS = ['.local/bin', 'bin', '.claude/local'] as const;
const KIMI_CODE_ACP_PATH_RELATIVE_DIR = '.kimi-code/bin';

const registryAgentsById: Record<string, RegistryAcpAgent> = Object.fromEntries(
  REGISTRY_ACP_AGENTS.map((agent) => [agent.id, agent])
);

export function resolveBuiltinACPSetting(agentType: string): ResolvedACPSetting {
  if (!isBuiltinAgentType(agentType)) {
    throw new Error(`Unsupported builtin ACP type: ${agentType}`);
  }

  const builtinType = agentType;
  throw new Error(
    `Builtin ${builtinType} requires resolveACPProcessLaunchAsync because launch preparation is asynchronous`
  );
}

export function getAcpCapabilitySourceVersion(
  input: ResolveACPSettingInput,
  managedRuntimeVersion?: string
): string {
  if (input.cliType === 'custom') {
    // Derive from the launch spec itself so editing the command invalidates
    // cached capabilities; there is no package version to key on.
    return input.customAcp
      ? `custom:${serializeCustomAcpLaunchSpec(input.customAcp)}`
      : `custom:${input.agentType}:unknown`;
  }
  if (input.cliType === 'builtin') {
    if (isBuiltinAgentType(input.agentType)) {
      const runtimeOverrideSuffix = getBuiltinRuntimeOverrideSourceVersionSuffix(
        input.runtimeOverrides
      );
      if (input.agentType === 'codex') {
        return managedRuntimeVersion
          ? `builtin-codex-acp:${CODEX_ACP_ADAPTER_VERSION}+codex:${managedRuntimeVersion}`
          : `${BUILTIN_CODEX_CAPABILITY_SOURCE_VERSION}${runtimeOverrideSuffix}`;
      }
      if (input.agentType === 'claude') {
        return managedRuntimeVersion
          ? `builtin-claude-acp:${CLAUDE_ACP_ADAPTER_VERSION}+agent-sdk:${CLAUDE_AGENT_SDK_VERSION}+claude-code:${managedRuntimeVersion}`
          : `${BUILTIN_CLAUDE_CAPABILITY_SOURCE_VERSION}${runtimeOverrideSuffix}`;
      }
      if (input.agentType === 'kimi') {
        return managedRuntimeVersion
          ? `builtin-kimi:${managedRuntimeVersion}`
          : `${BUILTIN_KIMI_CAPABILITY_SOURCE_VERSION}${runtimeOverrideSuffix}`;
      }
      if (input.agentType === 'grok') {
        return managedRuntimeVersion
          ? `builtin-grok-acp:${GROK_ACP_ADAPTER_VERSION}+official-grok:${managedRuntimeVersion}`
          : `${BUILTIN_GROK_CAPABILITY_SOURCE_VERSION}${runtimeOverrideSuffix}`;
      }
      if (input.agentType === 'deepseek') {
        const baseUrl = input.env?.[DEEPSEEK_HARNESS_BASE_URL_ENV];
        return baseUrl?.trim()
          ? `${DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION}+endpoint:${createHash('sha256').update(baseUrl).digest('hex').slice(0, 12)}`
          : DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION;
      }
    }
    return `builtin:${input.agentType}:unknown`;
  }

  const agent = registryAgentsById[input.agentType];
  if (!agent) {
    return `registry:${input.agentType}:unknown`;
  }

  return `${agent.id}@${agent.version}`;
}

export function resolveRegistryAgentACPSetting(agent: RegistryAcpAgent): ResolvedACPSetting {
  if (agent.distribution.local?.command) {
    const isNpx = agent.distribution.local.command === 'npx';
    const args = [...(isNpx ? [NPX_CACHE_MODE_ARG] : []), ...(agent.distribution.local.args ?? [])];
    return {
      status: {
        agent: `${agent.name}@${agent.version}`,
        command: agent.distribution.local.command,
      },
      exec: {
        command: agent.distribution.local.command,
        args,
        env: agent.distribution.local.env,
      },
    };
  }

  if (agent.distribution.npx?.package) {
    const npxDistribution = agent.distribution.npx;
    const packageSpec = resolveRegistryNpxPackage(npxDistribution);
    const args = [
      ...(npxDistribution.registry ? [`--registry=${npxDistribution.registry}`] : []),
      NPX_CACHE_MODE_ARG,
      '-y',
      packageSpec,
      ...(npxDistribution.args ?? []),
    ];
    return {
      status: { agent: `${agent.name}@${agent.version}`, command: 'npx' },
      exec: {
        command: 'npx',
        args,
        env: npxDistribution.env,
      },
    };
  }

  if (agent.distribution.uvx?.package) {
    const args = [agent.distribution.uvx.package, ...(agent.distribution.uvx.args ?? [])];
    return {
      status: { agent: `${agent.name}@${agent.version}`, command: 'uvx' },
      exec: {
        command: 'uvx',
        args,
        env: agent.distribution.uvx.env,
      },
    };
  }

  if (agent.distribution.binary && Object.keys(agent.distribution.binary).length > 0) {
    // Binary distributions require an async download/unpack step; the caller must
    // go through resolveACPProcessLaunchAsync (which routes to the binary manager)
    // rather than this synchronous resolver.
    throw new Error(
      `Registry ACP ${agent.id} ships only a binary distribution; resolve it via resolveACPProcessLaunchAsync`
    );
  }

  throw new Error(`Registry ACP ${agent.id} has no supported launcher`);
}

function resolveRegistryACPSetting(agentType: string): ResolvedACPSetting {
  const agent = registryAgentsById[agentType];
  if (!agent) {
    throw new Error(`Unknown registry ACP type: ${agentType}`);
  }
  return resolveRegistryAgentACPSetting(agent);
}

export function resolveCustomACPSetting(
  agentType: string,
  customAcp: CustomAcpLaunchSpec | undefined
): ResolvedACPSetting {
  const command = customAcp?.command.trim();
  if (!command) {
    throw new Error(`Custom ACP ${agentType} has no launch command configured`);
  }
  return {
    status: { agent: `custom:${agentType}`, command },
    exec: { command, args: [...(customAcp?.args ?? [])] },
  };
}

export function resolveACPSetting(input: ResolveACPSettingInput): ResolvedACPSetting {
  if (input.cliType === 'builtin') {
    return resolveBuiltinACPSetting(input.agentType);
  }
  if (input.cliType === 'registry') {
    return resolveRegistryACPSetting(input.agentType);
  }
  if (input.cliType === 'custom') {
    return resolveCustomACPSetting(input.agentType, input.customAcp);
  }
  throw new Error(`Unsupported ACP cliType: ${input.cliType as string}`);
}

function expandHomePath(pathValue: string): string {
  if (pathValue === '~') return homedir();
  if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function trimRuntimeOverride(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(expandHomePath(trimmed)) : undefined;
}

async function resolveManagedRuntimeForLaunch(
  name: ManagedRuntimeName,
  input: Pick<ResolveACPProcessLaunchInput, 'onManagedRuntimeProgress' | 'signal'>
): Promise<ManagedRuntimeLaunch> {
  const launch = await getManagedAgentRuntimeManager().resolveRuntimeForLaunch(name, {
    onProgress: input.onManagedRuntimeProgress,
    signal: input.signal,
  });
  if (launch.updateAvailable) {
    getManagedRuntimeUpdateCoordinator().enqueue(name);
  }
  return launch;
}

function resolveCliAdapterEntry(
  adapter: 'claude-acp' | 'codex-acp' | 'deepseek-acp' | 'grok-acp'
): [string] {
  const argvEntry = process.argv[1] ? resolve(process.argv[1]) : undefined;
  const candidates: string[] = [];
  if (argvEntry) {
    candidates.push(resolve(dirname(argvEntry), `${adapter}.js`));
  }
  const importDir = dirname(fileURLToPath(import.meta.url));
  candidates.push(resolve(importDir, `${adapter}.js`));
  candidates.push(resolve(importDir, '..', `${adapter}.js`));

  const entry = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  if (!entry) {
    throw new Error(`Unable to resolve bundled ${adapter} entry`);
  }
  return [entry];
}

async function resolveBuiltinACPProcessLaunch(
  input: ResolveACPProcessLaunchInput
): Promise<ResolvedACPProcessLaunch> {
  if (!isBuiltinAgentType(input.agentType)) {
    throw new Error(`Unsupported builtin ACP type: ${input.agentType}`);
  }
  if (input.agentType === 'deepseek') {
    const [adapterPath] = resolveCliAdapterEntry('deepseek-acp');
    const launch = await resolveDeepSeekHarnessProcessLaunch({
      adapterPath,
      extraArgs: input.extraArgs,
    });
    return {
      ...launch,
      capabilitySourceVersion: getAcpCapabilitySourceVersion(input),
    };
  }
  if (!isManagedBuiltinAgentType(input.agentType)) {
    throw new Error(`Unsupported managed builtin ACP type: ${input.agentType}`);
  }
  if (input.agentType === 'kimi') {
    const overridePath = trimRuntimeOverride(input.runtimeOverrides?.kimiPath);
    const runtime = overridePath
      ? { command: overridePath, version: undefined }
      : await resolveManagedRuntimeForLaunch('kimi-code', input);
    return {
      command: overridePath ? runtime.command : process.execPath,
      args: overridePath
        ? ['acp', ...(input.extraArgs ?? [])]
        : [runtime.command, 'acp', ...(input.extraArgs ?? [])],
      env: {
        KIMI_CODE_NO_AUTO_UPDATE: '1',
      },
      capabilitySourceVersion: getAcpCapabilitySourceVersion(input, runtime.version),
    };
  }
  if (input.agentType === 'codex') {
    const overridePath = trimRuntimeOverride(input.runtimeOverrides?.codexPath);
    const runtime = overridePath
      ? { command: overridePath, version: undefined }
      : await resolveManagedRuntimeForLaunch('codex', input);
    return {
      command: process.execPath,
      args: [
        ...resolveCliAdapterEntry('codex-acp'),
        ...(BuiltinACPSetting.codex.args ?? []),
        ...(input.extraArgs ?? []),
      ],
      env: { CODEX_PATH: runtime.command },
      capabilitySourceVersion: getAcpCapabilitySourceVersion(input, runtime.version),
    };
  }
  if (input.agentType === 'grok') {
    const overridePath = trimRuntimeOverride(input.runtimeOverrides?.grokPath);
    const runtime = overridePath
      ? { command: overridePath, version: undefined }
      : await resolveManagedRuntimeForLaunch('grok-build', input);
    return {
      command: process.execPath,
      args: [...resolveCliAdapterEntry('grok-acp'), ...(input.extraArgs ?? [])],
      env: { GROK_PATH: runtime.command, GROK_DISABLE_AUTOUPDATER: '1' },
      capabilitySourceVersion: getAcpCapabilitySourceVersion(input, runtime.version),
    };
  }

  const overridePath = trimRuntimeOverride(input.runtimeOverrides?.claudeCodeExecutable);
  const runtime = overridePath
    ? { command: overridePath, version: undefined }
    : await resolveManagedRuntimeForLaunch('claude-code', input);
  return {
    command: process.execPath,
    args: [
      ...resolveCliAdapterEntry('claude-acp'),
      ...(BuiltinACPSetting.claude.args ?? []),
      ...(input.extraArgs ?? []),
    ],
    env: { CLAUDE_CODE_EXECUTABLE: runtime.command },
    capabilitySourceVersion: getAcpCapabilitySourceVersion(input, runtime.version),
  };
}

/**
 * Resolves the trusted provider CLI used for builtin authentication. Claude and
 * Codex keep credentials in their own stores, so authentication runs their
 * official managed binaries directly instead of going through the ACP adapter.
 * Kimi exposes login through its ACP entry point. Kimi and Grok have no
 * separate status command that Lody can probe.
 */
export async function resolveBuiltinAuthenticationProcessLaunch(
  input: ResolveBuiltinAuthenticationProcessLaunchInput
): Promise<ResolvedACPProcessLaunch | null> {
  if (input.cliType !== 'builtin' || !isManagedBuiltinAgentType(input.agentType)) {
    throw new Error(`Unsupported builtin authentication type: ${input.agentType}`);
  }

  if (input.agentType === 'kimi') {
    if (input.action === 'status') return null;
    const { capabilitySourceVersion: _capabilitySourceVersion, ...launch } =
      await resolveBuiltinACPProcessLaunch({
        ...input,
        extraArgs: ['--login'],
      });
    return launch;
  }

  if (input.agentType === 'codex') {
    const overridePath = trimRuntimeOverride(input.runtimeOverrides?.codexPath);
    const codexPath =
      overridePath ?? (await resolveManagedRuntimeForLaunch('codex', input)).command;
    return {
      command: codexPath,
      args: input.action === 'login' ? ['login', '--device-auth'] : ['login', 'status'],
    };
  }
  if (input.agentType === 'grok') {
    if (input.action === 'status') return null;
    const overridePath = trimRuntimeOverride(input.runtimeOverrides?.grokPath);
    const grokPath =
      overridePath ?? (await resolveManagedRuntimeForLaunch('grok-build', input)).command;
    return {
      command: grokPath,
      args: ['login', '--device-auth'],
      env: { GROK_DISABLE_AUTOUPDATER: '1' },
    };
  }

  const overridePath = trimRuntimeOverride(input.runtimeOverrides?.claudeCodeExecutable);
  const claudePath =
    overridePath ?? (await resolveManagedRuntimeForLaunch('claude-code', input)).command;
  return {
    command: claudePath,
    args: input.action === 'login' ? ['auth', 'login', '--claudeai'] : ['auth', 'status', '--json'],
  };
}

export function resolveACPProcessLaunch(
  input: ResolveACPProcessLaunchInput
): ResolvedACPProcessLaunch {
  const setting = resolveACPSetting(input);
  return {
    command: setting.exec.command,
    args: [...setting.exec.args, ...(input.extraArgs ?? [])],
    env: setting.exec.env,
    capabilitySourceVersion: getAcpCapabilitySourceVersion(input),
  };
}

/**
 * Async launch resolution. Identical to {@link resolveACPProcessLaunch} for
 * builtin/npx/uvx/local agents, but for a registry agent whose only launcher is
 * a `binary` distribution it first ensures the platform binary is downloaded and
 * unpacked (via the ACP binary manager), then returns the resolved executable.
 *
 * All process-spawning paths must use this; the synchronous resolver throws for
 * binary-only agents because the download cannot happen synchronously.
 */
export async function resolveACPProcessLaunchAsync(
  input: ResolveACPProcessLaunchInput
): Promise<ResolvedACPProcessLaunch> {
  if (input.cliType === 'builtin') {
    return await resolveBuiltinACPProcessLaunch(input);
  }
  if (input.cliType === 'registry') {
    const agent = registryAgentsById[input.agentType];
    if (agent && getRegistryAcpLaunchKind(agent.distribution) === 'binary') {
      const launch = await getAcpBinaryManager().ensureBinary(agent, { signal: input.signal });
      return {
        command: launch.command,
        args: [...launch.args, ...(input.extraArgs ?? [])],
        env: launch.env,
        capabilitySourceVersion: getAcpCapabilitySourceVersion(input),
      };
    }
  }
  return resolveACPProcessLaunch(input);
}

export function mergeACPProcessEnv(
  launch: Pick<ResolvedACPProcessLaunch, 'env'>,
  baseEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return launch.env ? { ...baseEnv, ...launch.env } : baseEnv;
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') {
    return 'PATH';
  }
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
}

function normalizePathEntry(entry: string): string {
  const normalized = normalize(entry);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, '') : normalized;
}

export function getDefaultAcpPathEntries(homeDir = homedir(), agentType?: string): string[] {
  if (!homeDir) {
    return [];
  }
  const relativeDirs =
    agentType === 'kimi' || agentType === 'kimi-code'
      ? [KIMI_CODE_ACP_PATH_RELATIVE_DIR, ...DEFAULT_ACP_PATH_RELATIVE_DIRS]
      : DEFAULT_ACP_PATH_RELATIVE_DIRS;
  return relativeDirs.map((relativeDir) => join(homeDir, relativeDir));
}

export function withDefaultAcpPathEntries(
  env: NodeJS.ProcessEnv,
  agentType?: string
): NodeJS.ProcessEnv {
  const defaultEntries = getDefaultAcpPathEntries(homedir(), agentType);
  if (defaultEntries.length === 0) {
    return env;
  }

  const pathKey = getPathEnvKey(env);
  const currentParts = (env[pathKey] ?? '').split(delimiter).filter(Boolean);
  const defaultEntrySet = new Set(defaultEntries.map(normalizePathEntry));
  const currentWithoutDefaults = currentParts.filter(
    (entry) => !defaultEntrySet.has(normalizePathEntry(entry))
  );
  const nextPath = [...defaultEntries, ...currentWithoutDefaults].join(delimiter);

  if (env[pathKey] === nextPath) {
    return env;
  }

  return {
    ...env,
    [pathKey]: nextPath,
  };
}

/**
 * Overlay a login-shell environment (see `getLoginShellEnv`) onto a base env when
 * spawning ACP agents.
 *
 * - Non-PATH vars: base wins. The base carries lody-injected values (e.g.
 *   `CODEX_HOME`, `LODY_*`) that must not be clobbered; the shell env only fills
 *   in vars the base process never had.
 * - PATH: union with the shell entries first, so user-installed agent binaries
 *   resolve from wherever the user actually put them (homebrew/cargo/volta/asdf/
 *   `~/.local/bin`/...). A GUI/daemon launch inherits a minimal PATH, so without
 *   this `opencode acp` & friends fail with ENOENT. Base-only entries (e.g.
 *   runtime-injected `node_modules/.bin`) are appended so nothing is lost.
 *
 * Hardcoding a few dirs (see `withDefaultAcpPathEntries`) was rejected: it cannot
 * cover the open-ended set of locations different users install tools into.
 */
export function mergeLoginShellEnv(
  base: NodeJS.ProcessEnv,
  shellEnv: NodeJS.ProcessEnv | null | undefined
): NodeJS.ProcessEnv {
  if (!shellEnv || Object.keys(shellEnv).length === 0) {
    return base;
  }

  const merged: NodeJS.ProcessEnv = { ...shellEnv, ...base };

  const pathKey = getPathEnvKey(base);
  const shellPathKey = getPathEnvKey(shellEnv);
  const shellParts = (shellEnv[shellPathKey] ?? '').split(delimiter).filter(Boolean);
  const baseParts = (base[pathKey] ?? '').split(delimiter).filter(Boolean);

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of [...shellParts, ...baseParts]) {
    const normalized = normalizePathEntry(entry);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(entry);
  }

  if (ordered.length > 0) {
    merged[pathKey] = ordered.join(delimiter);
  }

  return merged;
}

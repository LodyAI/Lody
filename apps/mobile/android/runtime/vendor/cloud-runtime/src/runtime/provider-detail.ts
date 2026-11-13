import type { z } from 'zod/v4';
import { ProviderCodexAuth } from '../contract/provider-details.ts';
import type {
  AgentProviderDetailParams,
  AgentProviderDetail,
  ProviderCapabilities,
} from '../contract/provider-details.ts';
import { providerPresets } from '../protocol/provider-presets';
import { isSubscriptionQuotaEligible } from '../protocol/subscription-quota';
import { openSettings } from './settings';
import { machineRpc } from './machine-rpc';
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const sensitive = /secret|password|token|api.?key|authorization/i;
export const overrideKeys = [
  'codexPath',
  'claudeCodeExecutable',
  'kimiPath',
  'grokPath',
  'devinPath',
  'piPath',
  'piExtensions',
] as const;
const endpointKeys = new Set([
  'ANTHROPIC_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'OPENAI_BASE_URL',
]);
export type ProviderScope = z.infer<typeof AgentProviderDetailParams>;
export type ProviderGrant = Parameters<typeof openSettings>[1];
export function endpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('invalid_provider_endpoint');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid_provider_endpoint');
  return url.toString().replace(/\/+$/, '');
}
export function providerRevision(
  flock: Awaited<ReturnType<typeof openSettings>>['flock'],
) {
  return JSON.stringify(flock.version());
}
export function presetCatalog() {
  return providerPresets.map((p) => ({
    id: p.id,
    name: p.name,
    cliType: p.cliType,
    agentType: p.agentType,
    tokenEnvKey: p.tokenEnvKey,
    protectedEnvKeys: [...new Set(p.modes.flatMap((m) => Object.keys(m.env)))],
    modes: p.modes.map((m) => ({
      id: m.id,
      name: m.name,
      endpoint: m.endpoint,
      tokenPrefix: m.tokenPrefix,
      customEndpoint: m.customEndpoint,
      endpoints: m.endpoints,
    })),
  }));
}
export function capabilityProjection(
  raw: unknown,
  config: Record<string, unknown> = {},
): z.infer<typeof ProviderCapabilities> {
  const value = record(raw);
  const choices = (raw: unknown, idKey = 'id') =>
    list(raw)
      .map(record)
      .flatMap((item) => {
        const id = text(item[idKey] ?? item.value);
        return id ? [{ id, name: text(item.name ?? item.label) || id }] : [];
      });
  const methods = list(value.authMethods)
    .map(record)
    .filter((m) => m.type === 'agent' && text(m.id))
    .map((m) => ({
      id: text(m.id).slice(0, 1024),
      name: (text(m.name) || text(m.id)).slice(0, 4096),
    }));
  return {
    models: choices(value.models, 'modelId'),
    modes: choices(value.modes),
    sessionTitle:
      value.sessionTitle === true &&
      !(config.cliType === 'builtin' && config.agentType === 'codex'),
    authMethods: methods,
    options: list(value.configOptions)
      .map(record)
      .filter((o) => text(o.id) && !sensitive.test(text(o.id)))
      .map((o) => ({
        id: text(o.id),
        name: text(o.name) || text(o.id),
        type: o.type === 'boolean' ? ('boolean' as const) : ('select' as const),
        ...(typeof o.currentValue === 'string' ||
        typeof o.currentValue === 'boolean'
          ? { value: o.currentValue }
          : {}),
        choices: list(o.options).flatMap((option) => {
          const item = record(option);
          return Array.isArray(item.options)
            ? choices(item.options)
            : choices([item]);
        }),
      })),
  };
}
export async function readProviderMachine(
  args: Omit<ProviderScope, 'id'>,
  grant: ProviderGrant,
  signal: AbortSignal,
  check: () => void,
) {
  check();
  const meta = await openSettings(`${args.workspaceId}:meta`, grant, signal);
  check();
  const room = `machine-${args.machineId}`,
    root = record(meta.flock.get(['m', room]));
  const field = (name: string) =>
    meta.flock.get(['m', room, name]) ?? root[name];
  if (meta.flock.get(['e', room]) !== true)
    throw new Error('machine_unavailable');
  if (!args.userId || field('ownerUserId') !== args.userId)
    throw new Error('setting_read_only');
  return { protocol: record(field('protocolCapabilities')) };
}
export async function readProvider(
  args: ProviderScope,
  grant: ProviderGrant,
  signal: AbortSignal,
  check: () => void,
) {
  const { protocol } = await readProviderMachine(args, grant, signal, check);
  const replica = await openSettings(
    `${args.workspaceId}:mf:${args.machineId}`,
    grant,
    signal,
  );
  check();
  const direct = record(replica.flock.get(['agentConfig', args.id]));
  const pending = record(replica.flock.get(['providerSetup', args.id]));
  const config = direct.id === args.id ? direct : record(pending.config);
  if (
    config.id !== args.id ||
    config.machineId !== args.machineId ||
    replica.flock.get(['providerSetupCancellation', args.id])
  )
    throw new Error('provider_not_found');
  return {
    ...replica,
    config,
    protocol,
    pending: direct.id !== args.id,
  };
}
export async function providerDetail(
  args: ProviderScope,
  grant: ProviderGrant,
  signal: AbortSignal,
  check: () => void,
): Promise<z.infer<typeof AgentProviderDetail>> {
  const { flock, config, protocol } = await readProvider(
    args,
    grant,
    signal,
    check,
  );
  const env = record(config.env),
    runtime = record(config.runtimeOverrides),
    title = record(config.titleGeneration);
  const runtimeOverrides: Record<string, unknown> = {};
  for (const key of overrideKeys)
    if (
      runtime[key] !== undefined &&
      !(key === 'codexPath' && text(runtime[key]).startsWith('\0'))
    )
      runtimeOverrides[key] = runtime[key];
  const endpoints = Object.entries(env)
    .filter(([key]) => endpointKeys.has(key))
    .flatMap(([key, value]) => {
      try {
        return [{ key, value: endpoint(text(value)) }];
      } catch {
        return [];
      }
    });
  const preset = providerPresets.find(
    (p) =>
      p.brandId === config.brandId &&
      p.cliType === config.cliType &&
      p.agentType === config.agentType,
  );
  let safeProfile: z.infer<typeof ProviderCodexAuth> | undefined;
  try {
    const profile = ProviderCodexAuth.parse(config.codexAuth);
    safeProfile =
      profile.mode === 'api-key'
        ? { ...profile, baseUrl: endpoint(profile.baseUrl) }
        : profile;
  } catch {
    /* Invalid or credential-bearing profile endpoints are not projected. */
  }
  const supportsRateLimitsRefresh =
    Number(protocol.providerRateLimitsRefresh) >= 1 &&
    record(record(flock.get(['acpCapability', args.id])).rateLimits).query ===
      true &&
    isSubscriptionQuotaEligible(config);
  const unavailableActions: { action: string; reason: string }[] = [];
  if (!supportsRateLimitsRefresh)
    unavailableActions.push({
      action: 'rate-limits-refresh',
      reason: 'provider_quota_capability_missing',
    });
  if (
    config.cliType === 'custom' ||
    (config.cliType === 'builtin' &&
      !['kimi', 'devin', 'grok', 'claude', 'codex', 'pi'].includes(
        text(config.agentType),
      ))
  ) {
    unavailableActions.push(
      ...['binary-status', 'binary-install'].map((action) => ({
        action,
        reason: 'provider_runtime_not_managed',
      })),
    );
  }
  if (
    config.cliType !== 'builtin' ||
    config.agentType !== 'pi' ||
    Number(protocol.piExtensions ?? 0) < 1
  )
    unavailableActions.push({
      action: 'pi-extension-scan',
      reason: 'machine_capability_missing',
    });
  if (config.agentType === 'sorbet')
    unavailableActions.push(
      ...['sorbetCredentials', 'sorbetProviders'].map((action) => ({
        action,
        reason:
          Number(protocol[action + 'Remote']) >= 1
            ? 'encrypted_feature_transport_unavailable'
            : 'machine_capability_missing',
      })),
    );
  return {
    id: args.id,
    machineId: args.machineId,
    revision: providerRevision(flock),
    description: text(config.description),
    env: Object.entries(env).map(([key, value]) => ({
      key,
      hasValue: !!text(value),
    })),
    endpoints,
    runtimeOverrides,
    titleGeneration: config.titleGeneration
      ? {
          configOptionValues: Object.fromEntries(
            Object.entries(record(title.configOptionValues)).filter(
              ([key, value]) =>
                !sensitive.test(key) &&
                (typeof value === 'string' || typeof value === 'boolean'),
            ),
          ),
        }
      : null,
    ...(safeProfile ? { codexAuth: safeProfile } : {}),
    ...(preset ? { presetId: preset.id } : {}),
    capabilities: capabilityProjection(
      flock.get(['acpCapability', args.id]),
      config,
    ),
    supportsAuthentication:
      config.cliType === 'builtin' ||
      Number(protocol.acpProtocolAuthentication) >= 2,
    supportsMethodSelection:
      Number(protocol.acpAuthenticationMethodSelection) >= 1,
    supportsCodexProfiles: Number(protocol.codexAuthProfiles) >= 1,
    supportsPiExtensions: Number(protocol.piExtensions) >= 1,
    supportsRateLimitsRefresh,
    unavailableActions,
  } as z.infer<typeof AgentProviderDetail>;
}
/** Upper bound for a refresh that switches through every model. */
export const MODEL_OPTIONS_READ_TIMEOUT_MS = 1_200_000;

export type ModelOptionsProgress = {
  modelId: string;
  modelName: string;
  index: number;
  total: number;
};

export async function probeProvider(
  args: ProviderScope & { readModelOptions?: boolean },
  grant: ProviderGrant,
  signal: AbortSignal,
  check: () => void,
  onModelOptionsProgress?: (progress: ModelOptionsProgress) => void,
) {
  const { config, pending, protocol } = await readProvider(
    args,
    grant,
    signal,
    check,
  );
  if (pending) throw new Error('provider_setup_busy');
  // The machine parses this request strictly; only a daemon that advertises
  // `acpModelOptionsRead` receives the field.
  const readModels =
    args.readModelOptions === true && protocol.acpModelOptionsRead === 1;
  let reply;
  try {
    reply = await machineRpc(
      args.workspaceId,
      args.machineId,
      'machine/acp-capabilities-refresh',
      {
        configId: args.id,
        force: true,
        ...(readModels ? { readModelOptions: true } : {}),
      },
      grant,
      signal,
      readModels
        ? (progress) => {
            if (
              progress.status !== 'reading-model-options' ||
              progress.configId !== args.id ||
              typeof progress.modelId !== 'string' ||
              typeof progress.modelIndex !== 'number' ||
              typeof progress.modelCount !== 'number'
            )
              return;
            onModelOptionsProgress?.({
              modelId: progress.modelId,
              modelName:
                typeof progress.modelName === 'string'
                  ? progress.modelName
                  : progress.modelId,
              index: progress.modelIndex,
              total: progress.modelCount,
            });
          }
        : undefined,
      readModels ? MODEL_OPTIONS_READ_TIMEOUT_MS : 120000,
    );
  } catch {
    throw new Error('provider_refresh_unknown');
  }
  check();
  const value = record(reply.result);
  if (
    reply.error ||
    value.machineId !== args.machineId ||
    value.configId !== args.id ||
    value.cliType !== config.cliType ||
    value.agentType !== config.agentType
  )
    throw new Error('provider_refresh_failed');
  return {
    success: value.success === true,
    authRequired: value.authRequired === true,
    capabilities: capabilityProjection(
      {
        ...record(value.capability),
        authMethods: value.authMethods ?? record(value.capability).authMethods,
      },
      config,
    ),
  };
}
export function applyProviderAdvanced(
  config: Record<string, unknown>,
  fields: Record<string, unknown>,
  editing: boolean,
  revision: string,
  protocol: Record<string, unknown>,
) {
  const advanced = [
    'description',
    'envPatch',
    'runtimeOverrides',
    'titleGeneration',
    'codexAuth',
    'presetId',
    'presetModeId',
    'presetEndpoint',
  ];
  if (
    editing &&
    advanced.some((key) => fields[key] !== undefined) &&
    fields.detailRevision !== revision
  )
    throw new Error('provider_conflict');
  if (fields.description !== undefined) config.description = fields.description;
  let env = { ...record(config.env) };
  for (const [key, value] of Object.entries(record(fields.envPatch))) {
    if (value === null) delete env[key];
    else {
      if (typeof value !== 'string' || value.includes('\0'))
        throw new Error('invalid_provider_env');
      env[key] = value;
    }
  }
  if (fields.presetId !== undefined) {
    const preset = providerPresets.find((p) => p.id === fields.presetId);
    if (
      !preset ||
      preset.cliType !== config.cliType ||
      preset.agentType !== config.agentType
    )
      throw new Error('invalid_provider_preset');
    const mode = preset.modes.find(
      (m) => m.id === (fields.presetModeId ?? preset.modes[0]?.id),
    );
    if (!mode) throw new Error('invalid_provider_preset');
    const token = text(env[preset.tokenEnvKey]);
    if (mode.tokenPrefix && token && !token.startsWith(mode.tokenPrefix))
      throw new Error('invalid_provider_credential');
    env = { ...env, ...mode.env };
    if (
      fields.presetEndpoint &&
      !mode.customEndpoint &&
      endpoint(text(fields.presetEndpoint)) !== mode.endpoint
    )
      throw new Error('invalid_provider_endpoint');
    if (mode.endpoint)
      env.ANTHROPIC_BASE_URL = endpoint(
        text(fields.presetEndpoint) || mode.endpoint,
      );
    config.brandId = preset.brandId;
  }
  for (const key of endpointKeys)
    if (
      fields.envPatch &&
      Object.hasOwn(record(fields.envPatch), key) &&
      env[key] !== undefined
    )
      env[key] = endpoint(text(env[key]));
  config.env = env;
  if (record(fields.runtimeOverrides).action === 'clear')
    delete config.runtimeOverrides;
  else if (fields.runtimeOverrides !== undefined) {
    if (config.cliType !== 'builtin')
      throw new Error('provider_override_unsupported');
    const current = { ...record(config.runtimeOverrides) };
    const applicable: Record<string, string[]> = {
      codex: ['codexPath'],
      claude: ['claudeCodeExecutable'],
      kimi: ['kimiPath'],
      grok: ['grokPath'],
      devin: ['devinPath'],
      pi: ['piPath', 'piExtensions'],
    };
    if (
      Object.keys(record(record(fields.runtimeOverrides).value)).some(
        (key) => !applicable[text(config.agentType)]?.includes(key),
      )
    )
      throw new Error('provider_override_unsupported');
    for (const key of list(record(fields.runtimeOverrides).remove)) {
      if (!overrideKeys.includes(key as (typeof overrideKeys)[number]))
        throw new Error('invalid_provider_override');
      delete current[text(key)];
    }
    for (const [key, value] of Object.entries(
      record(record(fields.runtimeOverrides).value),
    )) {
      if (value === null) delete current[key];
      else {
        if (
          (typeof value === 'string' && value.includes('\0')) ||
          (Array.isArray(value) &&
            value.some((v) => typeof v !== 'string' || v.includes('\0')))
        )
          throw new Error('invalid_provider_override');
        current[key] = value;
      }
    }
    config.runtimeOverrides = current;
  }
  if (record(fields.titleGeneration).action === 'clear')
    delete config.titleGeneration;
  else if (fields.titleGeneration !== undefined) {
    if (
      Object.keys(
        record(record(record(fields.titleGeneration).value).configOptionValues),
      ).some((key) => sensitive.test(key))
    )
      throw new Error('invalid_provider_title');
    config.titleGeneration = record(fields.titleGeneration).value;
  }
  if (fields.codexAuth !== undefined) {
    if (
      editing &&
      ['mode', 'profileId', 'baseUrl'].some(
        (key) =>
          record(config.codexAuth)[key] !== record(fields.codexAuth)[key],
      )
    )
      throw new Error('provider_identity_immutable');
    if (Number(protocol.codexAuthProfiles ?? 0) < 1)
      throw new Error('codex_profiles_unsupported');
    const profile = { ...record(fields.codexAuth) };
    if (profile.mode === 'api-key')
      profile.baseUrl = endpoint(text(profile.baseUrl));
    config.codexAuth = profile;
  }
  if (config.codexAuth) {
    if (
      config.cliType !== 'builtin' ||
      config.agentType !== 'codex' ||
      config.customAcp
    )
      throw new Error('invalid_codex_profile');
    const overrides = record(config.runtimeOverrides);
    if (
      Object.entries(overrides).some(
        ([key, value]) =>
          key !== 'codexPath' || value !== '\0lody-codex-profile-v1',
      )
    )
      throw new Error('invalid_codex_profile');
    const protectedKeys =
      /^(CODEX_|OPENAI_|LODY_CODEX_|DYLD_|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|XDG_CONFIG_HOME$|DBUS_SESSION_BUS_ADDRESS$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|SSL_CERT_FILE$|SSL_CERT_DIR$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|MODEL_PROVIDER$|DEFAULT_AUTH_REQUEST$|NODE_OPTIONS$|LD_PRELOAD$|LD_LIBRARY_PATH$)/i;
    if (Object.keys(env).some((key) => protectedKeys.test(key)))
      throw new Error('invalid_codex_profile');
    config.runtimeOverrides = { codexPath: '\0lody-codex-profile-v1' };
  }
}

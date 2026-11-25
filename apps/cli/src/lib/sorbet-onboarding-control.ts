import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import {
  openSorbetControl,
  SorbetControlError,
  type AuthEvent,
  type AvailableAgentModel,
  type SorbetControl,
} from '@sorbetai/control';
import type {
  ArrivalProbe,
  EnvImportCandidate,
  ImportSourceDescription,
  ImportSourceId,
  ImportSourceResult,
  SorbetAuthMethodSummary,
  SorbetConnectApiKeyInput,
  SorbetConnectCustomProviderInput,
  SorbetConnectedProviderSummary,
  SorbetConnectionSource,
  SorbetConnectResult,
  SorbetImportRequest,
  SorbetModelSummary,
} from '@lody/shared/electron-ipc';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import { getLoginShellEnvLegacy } from '@/agent/login-shell-env';
import { toShared } from '@/platform/process-options';

const CONNECTION_SOURCES_FILE = 'sorbet-connection-sources.json';

type ConnectionSourceStoreData = {
  version: 1;
  sources: Record<string, SorbetConnectionSource>;
};

const KNOWN_ENV_PROVIDER_KEYS: ReadonlyArray<{
  envName: string;
  providerId: string;
  providerName: string;
}> = [
  { envName: 'ANTHROPIC_API_KEY', providerId: 'anthropic', providerName: 'Anthropic' },
  { envName: 'OPENAI_API_KEY', providerId: 'openai', providerName: 'OpenAI' },
  { envName: 'GEMINI_API_KEY', providerId: 'google', providerName: 'Google Gemini' },
  {
    envName: 'GOOGLE_GENERATIVE_AI_API_KEY',
    providerId: 'google',
    providerName: 'Google Gemini',
  },
  { envName: 'OPENROUTER_API_KEY', providerId: 'openrouter', providerName: 'OpenRouter' },
  { envName: 'DEEPSEEK_API_KEY', providerId: 'deepseek', providerName: 'DeepSeek' },
  { envName: 'XAI_API_KEY', providerId: 'xai', providerName: 'xAI' },
  { envName: 'GROQ_API_KEY', providerId: 'groq', providerName: 'Groq' },
  { envName: 'MISTRAL_API_KEY', providerId: 'mistral', providerName: 'Mistral' },
  { envName: 'CEREBRAS_API_KEY', providerId: 'cerebras', providerName: 'Cerebras' },
];

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  'openai-codex': 'ChatGPT',
  'github-copilot': 'GitHub Copilot',
  copilot: 'GitHub Copilot',
  google: 'Google Gemini',
  'google-gemini-cli': 'Google Gemini',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  groq: 'Groq',
  mistral: 'Mistral',
  cerebras: 'Cerebras',
};

const RECOMMENDED_MODEL_PATTERNS: Record<string, RegExp[]> = {
  anthropic: [/claude-sonnet-4[-.]6/i, /claude-sonnet-4[-.]5/i, /claude-.*sonnet/i, /claude-opus/i],
  openai: [/^gpt-5([-.]\d+)?$/i, /gpt-5/i, /codex/i, /gpt-4\.1/i, /o3/i],
  'openai-codex': [/gpt-5.*codex/i, /codex/i, /gpt-5/i],
  'github-copilot': [/claude-sonnet-4/i, /gpt-5/i, /claude-.*sonnet/i],
  google: [/gemini-2\.5-pro/i, /gemini-.*-pro/i, /gemini-2\.5-flash/i],
  deepseek: [/deepseek-chat/i, /deepseek-reasoner/i],
  xai: [/grok-4/i, /grok-3/i, /grok/i],
  openrouter: [/claude-sonnet-4/i, /gpt-5/i, /deepseek/i],
};

function resolveSorbetDataDir(dataDirOverride?: string): string {
  return dataDirOverride ?? join(getLodyDataDir(), 'sorbet');
}

function resolveSourcesFilePath(sorbetDataDir: string): string {
  return join(dirname(sorbetDataDir), CONNECTION_SOURCES_FILE);
}

export function readConnectionSources(
  sorbetDataDir = resolveSorbetDataDir()
): Record<string, SorbetConnectionSource> {
  const filePath = resolveSourcesFilePath(sorbetDataDir);
  try {
    if (!existsSync(filePath)) return {};
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ConnectionSourceStoreData>;
    if (parsed?.version !== 1 || !parsed.sources || typeof parsed.sources !== 'object') {
      return {};
    }
    return { ...parsed.sources };
  } catch {
    return {};
  }
}

export function recordConnectionSource(
  providerId: string,
  source: SorbetConnectionSource,
  sorbetDataDir = resolveSorbetDataDir()
): void {
  const filePath = resolveSourcesFilePath(sorbetDataDir);
  const current = readConnectionSources(sorbetDataDir);
  current[providerId] = { ...source, updatedAtMs: source.updatedAtMs ?? Date.now() };
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify({ version: 1, sources: current }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tempPath, filePath);
}

export function removeConnectionSource(
  providerId: string,
  sorbetDataDir = resolveSorbetDataDir()
): void {
  const filePath = resolveSourcesFilePath(sorbetDataDir);
  const current = readConnectionSources(sorbetDataDir);
  if (!(providerId in current)) return;
  delete current[providerId];
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify({ version: 1, sources: current }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tempPath, filePath);
}

export function extractKeyLast4(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length < 6) return '';
  return trimmed.slice(-4);
}

function toModelSummary(model: AvailableAgentModel): SorbetModelSummary {
  return {
    selector: model.selector,
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
  };
}

export function pickRecommendedSorbetModel(
  models: readonly SorbetModelSummary[],
  preferredProviderId?: string
): SorbetModelSummary | null {
  if (models.length === 0) return null;
  const scoped = preferredProviderId
    ? models.filter((model) => model.providerId === preferredProviderId)
    : models;
  const pool = scoped.length > 0 ? scoped : models;
  const providerKey = (preferredProviderId ?? pool[0]?.providerId ?? '').toLowerCase();
  const patterns = RECOMMENDED_MODEL_PATTERNS[providerKey] ?? [];
  for (const pattern of patterns) {
    const match = pool.find(
      (model) => pattern.test(model.modelId) || pattern.test(model.displayName)
    );
    if (match) return match;
  }
  return pool[0] ?? null;
}

function resolveProviderDisplayName(
  providerId: string,
  methods: readonly SorbetAuthMethodSummary[],
  customNames?: ReadonlyMap<string, string>
): string {
  const custom = customNames?.get(providerId);
  if (custom) return custom;
  const known = PROVIDER_DISPLAY_NAMES[providerId];
  if (known) return known;
  const advertised = methods.find((method) => method.providerId === providerId)?.providerName;
  if (advertised) return advertised;
  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

async function withSorbetControl<T>(
  sorbetDataDir: string | undefined,
  signal: AbortSignal | undefined,
  fn: (control: SorbetControl, resolvedDir: string) => Promise<T>
): Promise<T> {
  const resolvedDir = resolveSorbetDataDir(sorbetDataDir);
  const control = await openSorbetControl({ dataDirectory: resolvedDir, signal });
  try {
    return await fn(control, resolvedDir);
  } finally {
    await control.hostSettings.get().catch(() => undefined);
    await control.close();
  }
}

export async function probeSorbetArrival(options?: {
  sorbetDataDir?: string;
  signal?: AbortSignal;
}): Promise<ArrivalProbe> {
  return await withSorbetControl(
    options?.sorbetDataDir,
    options?.signal,
    async (control, resolvedDir) => {
      const [credentials, rawMethods, customProviders] = await Promise.all([
        control.credentials.list({ signal: options?.signal }),
        control.authentication.methods({ signal: options?.signal }),
        control.providers.listCustom({ signal: options?.signal }),
      ]);
      const methods: SorbetAuthMethodSummary[] = rawMethods.map((method) => ({
        providerId: method.providerId,
        providerName: method.providerName,
        type: method.type === 'oauth' ? 'oauth' : 'api_key',
        name: method.name,
      }));
      const customById = new Map(customProviders.map((provider) => [provider.id, provider]));
      const customNames = new Map(customProviders.map((provider) => [provider.id, provider.name]));
      const storedSources = readConnectionSources(resolvedDir);

      if (credentials.length === 0) {
        return {
          model: {
            kind: 'none',
            methods: methods.filter((method) => method.type === 'oauth'),
          },
          methods,
          connectedProviders: [],
          models: [],
        };
      }

      const rawModels = await control.providers.availableModels({ signal: options?.signal });
      const models = rawModels.map(toModelSummary);
      const connectedProviders: SorbetConnectedProviderSummary[] = credentials.map((credential) => {
        const stored = storedSources[credential.providerId];
        const fallbackSource: SorbetConnectionSource =
          credential.type === 'oauth' ? { kind: 'oauth' } : { kind: 'api_key' };
        const custom = customById.get(credential.providerId);
        return {
          providerId: credential.providerId,
          providerName: resolveProviderDisplayName(credential.providerId, methods, customNames),
          authType: credential.type,
          source: stored ?? fallbackSource,
          ...(custom ? { baseUrl: custom.baseUrl, isCustom: true } : {}),
        };
      });

      const primaryProvider = connectedProviders[0]!;
      const recommended =
        pickRecommendedSorbetModel(models, primaryProvider.providerId) ??
        pickRecommendedSorbetModel(models);

      if (!recommended) {
        return {
          model: {
            kind: 'none',
            methods: methods.filter((method) => method.type === 'oauth'),
          },
          methods,
          connectedProviders,
          models,
        };
      }

      const matchedProvider =
        connectedProviders.find((item) => item.providerId === recommended.providerId) ??
        primaryProvider;

      return {
        model: {
          kind: 'ready',
          provider: recommended.providerId,
          providerName: resolveProviderDisplayName(recommended.providerId, methods, customNames),
          model: recommended.selector,
          modelName: recommended.displayName,
          source: matchedProvider.source,
        },
        methods,
        connectedProviders,
        models,
      };
    }
  );
}

function classifyConnectError(error: unknown): {
  code: Extract<SorbetConnectResult, { ok: false }>['code'];
  message?: string;
} {
  if (error instanceof SorbetControlError) {
    if (error.code === 'provider_not_found') return { code: 'provider_not_found' };
    if (error.code === 'invalid_provider_endpoint') return { code: 'invalid_endpoint' };
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthorized|forbidden|invalid.*key|authentication/i.test(text)) {
    return { code: 'invalid_key' };
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(text)) {
    return { code: 'network_error' };
  }
  return { code: 'unknown', message: text.slice(0, 240) };
}

export async function connectSorbetApiKey(
  input: SorbetConnectApiKeyInput,
  options?: {
    sorbetDataDir?: string;
    signal?: AbortSignal;
    sourceOverride?: SorbetConnectionSource;
  }
): Promise<SorbetConnectResult> {
  const apiKey = input.apiKey.trim();
  const providerId = input.providerId.trim();
  if (!apiKey || !providerId) {
    return { ok: false, code: 'invalid_key' };
  }

  return await withSorbetControl(
    options?.sorbetDataDir,
    options?.signal,
    async (control, resolvedDir) => {
      const existing = await control.credentials.list({ signal: options?.signal });
      const hadExisting = existing.some((entry) => entry.providerId === providerId);
      const rawMethods = await control.authentication.methods({ signal: options?.signal });
      const methods: SorbetAuthMethodSummary[] = rawMethods.map((method) => ({
        providerId: method.providerId,
        providerName: method.providerName,
        type: method.type === 'oauth' ? 'oauth' : 'api_key',
        name: method.name,
      }));

      try {
        await control.authentication.login({
          providerId,
          type: 'api_key',
          interaction: {
            signal: options?.signal,
            prompt: async () => apiKey,
            notify: () => {},
          },
          signal: options?.signal,
        });

        await control.providers
          .refresh({ providers: [providerId], signal: options?.signal })
          .catch(() => undefined);

        const rawModels = await control.providers.availableModels({
          providerId,
          signal: options?.signal,
        });
        const models = rawModels.map(toModelSummary);
        const recommended = pickRecommendedSorbetModel(models, providerId);
        if (!recommended) {
          if (!hadExisting) {
            await control.credentials.logout(providerId).catch(() => undefined);
          }
          return { ok: false, code: 'no_models' };
        }

        const source: SorbetConnectionSource = options?.sourceOverride ?? {
          kind: 'api_key',
          last4: extractKeyLast4(apiKey),
          updatedAtMs: Date.now(),
        };
        recordConnectionSource(providerId, source, resolvedDir);

        return {
          ok: true,
          providerId,
          providerName: resolveProviderDisplayName(providerId, methods),
          modelSelector: recommended.selector,
          modelName: recommended.displayName,
          source,
          models,
        };
      } catch (error) {
        if (!hadExisting) {
          await control.credentials.logout(providerId).catch(() => undefined);
        }
        return { ok: false, ...classifyConnectError(error) };
      }
    }
  );
}

export async function connectSorbetCustomProvider(
  input: SorbetConnectCustomProviderInput,
  options?: { sorbetDataDir?: string; signal?: AbortSignal }
): Promise<SorbetConnectResult> {
  const baseUrl = input.baseUrl.trim();
  let derivedName = input.name?.trim() ?? '';
  if (!derivedName) {
    try {
      derivedName = new URL(baseUrl).hostname || 'Custom';
    } catch {
      return { ok: false, code: 'invalid_endpoint' };
    }
  }
  const apiKey = input.apiKey?.trim() ?? '';

  return await withSorbetControl(
    options?.sorbetDataDir,
    options?.signal,
    async (control, resolvedDir) => {
      let createdId: string | null = null;
      try {
        const created = await control.providers.createCustom(
          {
            name: derivedName,
            baseUrl,
            protocol: input.protocol,
            models: [],
          },
          { signal: options?.signal }
        );
        createdId = created.id;

        if (apiKey) {
          await control.authentication.login({
            providerId: created.id,
            type: 'api_key',
            interaction: {
              signal: options?.signal,
              prompt: async () => apiKey,
              notify: () => {},
            },
            signal: options?.signal,
          });
        }

        await control.providers.refresh({
          providers: [created.id],
          signal: options?.signal,
        });

        const rawModels = await control.providers.availableModels({
          providerId: created.id,
          signal: options?.signal,
        });
        const models = rawModels.map(toModelSummary);
        const recommended = pickRecommendedSorbetModel(models, created.id);
        if (!recommended) {
          if (apiKey) {
            await control.credentials.logout(created.id).catch(() => undefined);
          }
          await control.providers.deleteCustom(created.id).catch(() => undefined);
          return { ok: false, code: 'no_models' };
        }

        const source: SorbetConnectionSource = {
          kind: 'api_key',
          ...(apiKey ? { last4: extractKeyLast4(apiKey) } : {}),
          updatedAtMs: Date.now(),
        };
        recordConnectionSource(created.id, source, resolvedDir);

        return {
          ok: true,
          providerId: created.id,
          providerName: created.name,
          modelSelector: recommended.selector,
          modelName: recommended.displayName,
          source,
          models,
        };
      } catch (error) {
        if (createdId) {
          await control.credentials.logout(createdId).catch(() => undefined);
          await control.providers.deleteCustom(createdId).catch(() => undefined);
        }
        return { ok: false, ...classifyConnectError(error) };
      }
    }
  );
}

export async function disconnectSorbetProvider(
  providerId: string,
  options?: { sorbetDataDir?: string; signal?: AbortSignal }
): Promise<void> {
  await withSorbetControl(options?.sorbetDataDir, options?.signal, async (control, resolvedDir) => {
    await control.credentials.logout(providerId, { signal: options?.signal });
    const customs = await control.providers.listCustom({ signal: options?.signal });
    if (customs.some((item) => item.id === providerId)) {
      await control.providers
        .deleteCustom(providerId, { signal: options?.signal })
        .catch(() => undefined);
    }
    removeConnectionSource(providerId, resolvedDir);
  });
}

export function describeImportSource(
  source: ImportSourceId,
  platform: NodeJS.Platform = process.platform
): ImportSourceDescription {
  return {
    source,
    systemPromptKind: source === 'claude-code' && platform === 'darwin' ? 'macos-keychain' : 'none',
  };
}

function parseJsonFileSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readMacOsKeychainPassword(
  service: string
): Promise<{ status: 'found'; value: string } | { status: 'not_found' } | { status: 'denied' }> {
  if (process.platform !== 'darwin') return { status: 'not_found' };
  try {
    const output = await runCommandTextLegacy(
      {
        command: '/usr/bin/security',
        args: ['find-generic-password', '-s', service, '-w'],
        timeout: '30 seconds',
        check: 'none',
      },
      toShared()
    );
    if (output.code === 0 && output.stdout.trim()) {
      return { status: 'found', value: output.stdout.trim() };
    }
    const stderr = output.stderr.toLowerCase();
    if (output.code === 128 || stderr.includes('user canceled') || stderr.includes('auth')) {
      return { status: 'denied' };
    }
    return { status: 'not_found' };
  } catch {
    return { status: 'not_found' };
  }
}

async function importFromClaudeCode(options: {
  homeDir: string;
  sorbetDataDir?: string;
  readKeychain?: typeof readMacOsKeychainPassword;
}): Promise<ImportSourceResult> {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(options.homeDir, '.claude');
  const claudeJson = parseJsonFileSafe(join(options.homeDir, '.claude.json'));
  const settingsJson = parseJsonFileSafe(join(claudeDir, 'settings.json'));

  const settingsEnv =
    settingsJson?.env && typeof settingsJson.env === 'object' && !Array.isArray(settingsJson.env)
      ? (settingsJson.env as Record<string, unknown>)
      : null;

  const staticApiKeyCandidate = [claudeJson?.primaryApiKey, settingsEnv?.ANTHROPIC_API_KEY].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );

  if (staticApiKeyCandidate) {
    const key = staticApiKeyCandidate.trim();
    const source: SorbetConnectionSource = {
      kind: 'imported',
      from: 'claude-code',
      authKind: 'api_key',
      last4: extractKeyLast4(key),
      updatedAtMs: Date.now(),
    };
    const connected = await connectSorbetApiKey(
      { providerId: 'anthropic', apiKey: key },
      { sorbetDataDir: options.sorbetDataDir, sourceOverride: source }
    );
    if (connected.ok) {
      return {
        status: 'imported',
        source: 'claude-code',
        providerId: connected.providerId,
        providerName: connected.providerName,
        modelSelector: connected.modelSelector,
        modelName: connected.modelName,
        connectionSource: source,
      };
    }
    return {
      status: 'error',
      source: 'claude-code',
      code: connected.code === 'no_models' ? 'no_models' : 'invalid_key',
    };
  }

  const credentialsFile = parseJsonFileSafe(join(claudeDir, '.credentials.json'));
  if (credentialsFile?.claudeAiOauth && typeof credentialsFile.claudeAiOauth === 'object') {
    return {
      status: 'oauth_conflict',
      source: 'claude-code',
      providerId: 'anthropic',
      providerName: 'Claude',
    };
  }

  const keychainReader = options.readKeychain ?? readMacOsKeychainPassword;
  const keychain = await keychainReader('Claude Code-credentials');
  if (keychain.status === 'denied') {
    return {
      status: 'error',
      source: 'claude-code',
      code: 'keychain_denied',
    };
  }
  if (keychain.status === 'found') {
    try {
      const parsed = JSON.parse(keychain.value) as Record<string, unknown>;
      if (typeof parsed.primaryApiKey === 'string' && parsed.primaryApiKey.trim()) {
        const key = parsed.primaryApiKey.trim();
        const source: SorbetConnectionSource = {
          kind: 'imported',
          from: 'claude-code',
          authKind: 'api_key',
          last4: extractKeyLast4(key),
          updatedAtMs: Date.now(),
        };
        const connected = await connectSorbetApiKey(
          { providerId: 'anthropic', apiKey: key },
          { sorbetDataDir: options.sorbetDataDir, sourceOverride: source }
        );
        if (connected.ok) {
          return {
            status: 'imported',
            source: 'claude-code',
            providerId: connected.providerId,
            providerName: connected.providerName,
            modelSelector: connected.modelSelector,
            modelName: connected.modelName,
            connectionSource: source,
          };
        }
      }
      if (parsed.claudeAiOauth && typeof parsed.claudeAiOauth === 'object') {
        return {
          status: 'oauth_conflict',
          source: 'claude-code',
          providerId: 'anthropic',
          providerName: 'Claude',
        };
      }
    } catch {}
  }

  return {
    status: 'not_found',
    source: 'claude-code',
    fallbackProviderId: 'anthropic',
    fallbackProviderName: 'Claude',
  };
}

async function importFromCodex(options: {
  homeDir: string;
  sorbetDataDir?: string;
}): Promise<ImportSourceResult> {
  const codexHome = process.env.CODEX_HOME?.trim() || join(options.homeDir, '.codex');
  const authJson = parseJsonFileSafe(join(codexHome, 'auth.json'));
  if (!authJson) {
    return {
      status: 'not_found',
      source: 'codex',
      fallbackProviderId: 'openai-codex',
      fallbackProviderName: 'ChatGPT',
    };
  }

  const staticOpenAiKey =
    typeof authJson.OPENAI_API_KEY === 'string' && authJson.OPENAI_API_KEY.trim().length > 0
      ? authJson.OPENAI_API_KEY.trim()
      : null;

  if (staticOpenAiKey) {
    const source: SorbetConnectionSource = {
      kind: 'imported',
      from: 'codex',
      authKind: 'api_key',
      last4: extractKeyLast4(staticOpenAiKey),
      updatedAtMs: Date.now(),
    };
    const connected = await connectSorbetApiKey(
      { providerId: 'openai', apiKey: staticOpenAiKey },
      { sorbetDataDir: options.sorbetDataDir, sourceOverride: source }
    );
    if (connected.ok) {
      return {
        status: 'imported',
        source: 'codex',
        providerId: connected.providerId,
        providerName: connected.providerName,
        modelSelector: connected.modelSelector,
        modelName: connected.modelName,
        connectionSource: source,
      };
    }
    return {
      status: 'error',
      source: 'codex',
      code: connected.code === 'no_models' ? 'no_models' : 'invalid_key',
    };
  }

  const tokens =
    authJson.tokens && typeof authJson.tokens === 'object' && !Array.isArray(authJson.tokens)
      ? (authJson.tokens as Record<string, unknown>)
      : null;
  if (
    tokens &&
    ((typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim().length > 0) ||
      (typeof tokens.access_token === 'string' && tokens.access_token.trim().length > 0))
  ) {
    return {
      status: 'oauth_conflict',
      source: 'codex',
      providerId: 'openai-codex',
      providerName: 'ChatGPT',
    };
  }

  return {
    status: 'not_found',
    source: 'codex',
    fallbackProviderId: 'openai-codex',
    fallbackProviderName: 'ChatGPT',
  };
}

export function scanEnvCandidatesFromMap(
  envMap: Readonly<Record<string, string | undefined>>
): EnvImportCandidate[] {
  const candidates: EnvImportCandidate[] = [];
  for (const entry of KNOWN_ENV_PROVIDER_KEYS) {
    const raw = envMap[entry.envName]?.trim();
    if (!raw || raw.length < 8) continue;
    candidates.push({
      envName: entry.envName,
      providerId: entry.providerId,
      providerName: entry.providerName,
      last4: extractKeyLast4(raw),
    });
  }
  return candidates;
}

async function importFromEnvironment(
  request: Extract<SorbetImportRequest, { source: 'env' }>,
  options: {
    sorbetDataDir?: string;
    readShellEnv?: () => Promise<Record<string, string | undefined>>;
  }
): Promise<ImportSourceResult> {
  let mergedEnv: Record<string, string | undefined>;
  try {
    if (options.readShellEnv) {
      mergedEnv = await options.readShellEnv();
    } else {
      const shellEnv = await getLoginShellEnvLegacy();
      mergedEnv = { ...process.env, ...shellEnv };
    }
  } catch {
    mergedEnv = options.readShellEnv ? {} : { ...process.env };
  }

  const candidates = scanEnvCandidatesFromMap(mergedEnv);
  if (candidates.length === 0) {
    return {
      status: 'not_found',
      source: 'env',
    };
  }

  if (request.mode === 'scan') {
    return {
      status: 'env_candidates',
      candidates,
    };
  }

  const selectedSet = new Set(
    request.selectedEnvNames && request.selectedEnvNames.length > 0
      ? request.selectedEnvNames
      : candidates.map((item) => item.envName)
  );
  const chosen = candidates.filter((item) => selectedSet.has(item.envName));
  if (chosen.length === 0) {
    return { status: 'not_found', source: 'env' };
  }

  let primarySuccess: Extract<SorbetConnectResult, { ok: true }> | null = null;
  let primarySource: SorbetConnectionSource | null = null;

  for (const candidate of chosen) {
    const secret = mergedEnv[candidate.envName]?.trim();
    if (!secret) continue;
    const source: SorbetConnectionSource = {
      kind: 'imported',
      from: 'env',
      authKind: 'api_key',
      last4: candidate.last4,
      updatedAtMs: Date.now(),
    };
    const result = await connectSorbetApiKey(
      { providerId: candidate.providerId, apiKey: secret },
      { sorbetDataDir: options.sorbetDataDir, sourceOverride: source }
    );
    if (result.ok && !primarySuccess) {
      primarySuccess = result;
      primarySource = source;
    }
  }

  if (!primarySuccess || !primarySource) {
    return {
      status: 'error',
      source: 'env',
      code: 'invalid_key',
    };
  }

  return {
    status: 'imported',
    source: 'env',
    providerId: primarySuccess.providerId,
    providerName: primarySuccess.providerName,
    modelSelector: primarySuccess.modelSelector,
    modelName: primarySuccess.modelName,
    connectionSource: primarySource,
  };
}

export async function runSorbetImportSource(
  request: SorbetImportRequest,
  options?: {
    homeDir?: string;
    sorbetDataDir?: string;
    readKeychain?: typeof readMacOsKeychainPassword;
    readShellEnv?: () => Promise<Record<string, string | undefined>>;
  }
): Promise<ImportSourceResult> {
  const homeDir = options?.homeDir ?? os.homedir();
  if (request.source === 'claude-code') {
    return await importFromClaudeCode({
      homeDir,
      sorbetDataDir: options?.sorbetDataDir,
      readKeychain: options?.readKeychain,
    });
  }
  if (request.source === 'codex') {
    return await importFromCodex({
      homeDir,
      sorbetDataDir: options?.sorbetDataDir,
    });
  }
  return await importFromEnvironment(request, {
    sorbetDataDir: options?.sorbetDataDir,
    readShellEnv: options?.readShellEnv,
  });
}

export type SorbetOAuthStreamEvent =
  | {
      event: 'authorization';
      url: string;
      userCode?: string;
      expiresInSeconds?: number;
    }
  | {
      event: 'authenticated';
      providerId: string;
      providerName: string;
      modelSelector: string;
      modelName: string;
      source: SorbetConnectionSource;
    }
  | {
      event: 'error';
      error: string;
    };

function isAllowedHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export async function runSorbetOAuthLogin(
  providerId: string,
  onEvent: (event: SorbetOAuthStreamEvent) => void,
  options?: { sorbetDataDir?: string; signal?: AbortSignal }
): Promise<void> {
  await withSorbetControl(options?.sorbetDataDir, options?.signal, async (control, resolvedDir) => {
    const rawMethods = await control.authentication.methods({ signal: options?.signal });
    const methods: SorbetAuthMethodSummary[] = rawMethods.map((method) => ({
      providerId: method.providerId,
      providerName: method.providerName,
      type: method.type === 'oauth' ? 'oauth' : 'api_key',
      name: method.name,
    }));
    const oauthMethod = rawMethods.find(
      (method) => method.providerId === providerId && method.type === 'oauth'
    );
    if (!oauthMethod) {
      onEvent({
        event: 'error',
        error: 'oauth_method_unavailable',
      });
      return;
    }

    const notify = (authEvent: AuthEvent): void => {
      if (authEvent.type === 'auth_url' && isAllowedHttpUrl(authEvent.url)) {
        onEvent({ event: 'authorization', url: authEvent.url });
        return;
      }
      if (authEvent.type === 'device_code' && isAllowedHttpUrl(authEvent.verificationUri)) {
        onEvent({
          event: 'authorization',
          url: authEvent.verificationUri,
          userCode: authEvent.userCode,
          expiresInSeconds: authEvent.expiresInSeconds,
        });
        return;
      }
      if (authEvent.type === 'info') {
        const link = authEvent.links?.find((item) => isAllowedHttpUrl(item.url));
        if (link) {
          onEvent({ event: 'authorization', url: link.url });
        }
      }
    };

    await control.authentication.login({
      providerId: oauthMethod.providerId,
      type: 'oauth',
      interaction: {
        signal: options?.signal,
        prompt: async () => {
          throw new Error('Interactive text prompt is not supported in browser OAuth flow');
        },
        notify,
      },
      signal: options?.signal,
    });

    const source: SorbetConnectionSource = {
      kind: 'oauth',
      updatedAtMs: Date.now(),
    };
    recordConnectionSource(providerId, source, resolvedDir);

    const rawModels = await control.providers.availableModels({
      providerId,
      signal: options?.signal,
    });
    const models = rawModels.map(toModelSummary);
    const recommended = pickRecommendedSorbetModel(models, providerId);

    onEvent({
      event: 'authenticated',
      providerId,
      providerName: resolveProviderDisplayName(providerId, methods),
      modelSelector: recommended?.selector ?? '',
      modelName: recommended?.displayName ?? '',
      source,
    });
  });
}

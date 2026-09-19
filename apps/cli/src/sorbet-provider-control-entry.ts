#!/usr/bin/env node

import {
  createNodeAgent,
  type NodeAgent,
  type CustomProviderDefinition,
} from '../../../packages/sorbet/packages/node-agent/dist/index.js';
import {
  SorbetProviderCenterLocalOperationSchema,
  SorbetProviderCenterSnapshotSchema,
  type SorbetProviderCenterLocalOperation,
  type SorbetProviderCenterSnapshot,
  type SorbetProviderConnection,
} from '@lody/shared';

import {
  readSorbetProviderPreferences,
  writeSorbetProviderPreferences,
  type SorbetProviderPreferences,
} from '@/agent/sorbet-provider-preferences';

const MAX_INPUT_BYTES = 1_048_576;
const CODEX_PROVIDER_ID = 'openai-codex';
const CLAUDE_PROVIDER_ID = 'anthropic';

type ControlOutput = {
  snapshot: SorbetProviderCenterSnapshot;
  affectedProviderId?: string;
};

const encodeModelSelector = (providerId: string, modelId: string): string =>
  `${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}`;

async function readRequest(): Promise<SorbetProviderCenterLocalOperation> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_INPUT_BYTES) throw new Error('Sorbet Provider request is too large');
    chunks.push(bytes);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return SorbetProviderCenterLocalOperationSchema.parse(parsed);
}

function providerModels(agent: NodeAgent, providerId: string) {
  return agent.models
    .getModels(providerId)
    .slice(0, 500)
    .map((model) => ({
      id: model.id,
      name: model.name,
      selector: encodeModelSelector(providerId, model.id),
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
}

function customInput(provider: CustomProviderDefinition) {
  return {
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    ...(provider.catalogRefs === undefined ? {} : { catalogRefs: [...provider.catalogRefs] }),
    models: provider.models.map((model) => ({
      ...model,
      ...(model.input === undefined ? {} : { input: [...model.input] }),
      ...(model.thinkingLevelMap === undefined
        ? {}
        : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    })),
  };
}

async function snapshot(
  agent: NodeAgent,
  preferences: SorbetProviderPreferences,
  persistRepair: boolean
): Promise<SorbetProviderCenterSnapshot> {
  const [credentialEntries, customProviders] = await Promise.all([
    agent.listCredentials(),
    agent.listCustomProviders(),
  ]);
  const credentials = new Map(credentialEntries.map((entry) => [entry.providerId, entry.type]));
  const runtimeProviders = new Map(
    agent.models.getProviders().map((provider) => [provider.id, provider])
  );
  const subscriptionProviders = [...runtimeProviders.values()]
    .filter((provider) => provider.auth.oauth?.isSubscription === true)
    .sort((left, right) => {
      if (left.id === CODEX_PROVIDER_ID) return -1;
      if (right.id === CODEX_PROVIDER_ID) return 1;
      return left.name.localeCompare(right.name);
    });
  const oauthConnections: SorbetProviderConnection[] = subscriptionProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    kind: 'oauth' as const,
    credentialType: credentials.get(provider.id),
    connected: credentials.has(provider.id),
    enabled: provider.id !== CLAUDE_PROVIDER_ID || preferences.claudeOAuthEnabled,
    models: providerModels(agent, provider.id),
  }));
  const customConnections: SorbetProviderConnection[] = customProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    kind: 'custom' as const,
    credentialType: credentials.get(provider.id),
    connected: credentials.has(provider.id),
    enabled: true,
    models: providerModels(agent, provider.id),
    custom: customInput(provider),
  }));
  const providers = [...oauthConnections, ...customConnections];
  const ready = (provider: SorbetProviderConnection): boolean =>
    provider.enabled && provider.connected && provider.models.length > 0;
  let selected = providers.find(
    (provider) => provider.id === preferences.defaultProviderId && ready(provider)
  );
  if (selected === undefined) {
    selected = providers.find((provider) => provider.id === CODEX_PROVIDER_ID && ready(provider));
  }
  if (selected === undefined) selected = oauthConnections.find(ready);
  if (selected === undefined) selected = customConnections.find(ready);

  const preferredModel =
    selected?.models.find((model) => model.selector === preferences.defaultModelSelector) ??
    selected?.models[0];
  const repairedPreferences: SorbetProviderPreferences = {
    version: 1,
    claudeOAuthEnabled: preferences.claudeOAuthEnabled,
    ...(selected === undefined ? {} : { defaultProviderId: selected.id }),
    ...(preferredModel === undefined ? {} : { defaultModelSelector: preferredModel.selector }),
  };
  if (
    persistRepair &&
    (repairedPreferences.defaultProviderId !== preferences.defaultProviderId ||
      repairedPreferences.defaultModelSelector !== preferences.defaultModelSelector)
  ) {
    await writeSorbetProviderPreferences(repairedPreferences);
  }
  return SorbetProviderCenterSnapshotSchema.parse({
    version: 1,
    claudeOAuthEnabled: repairedPreferences.claudeOAuthEnabled,
    defaultProviderId: repairedPreferences.defaultProviderId,
    defaultModelSelector: repairedPreferences.defaultModelSelector,
    providers,
  });
}

async function execute(
  agent: NodeAgent,
  operation: SorbetProviderCenterLocalOperation
): Promise<ControlOutput> {
  let preferences = await readSorbetProviderPreferences();
  let affectedProviderId: string | undefined;
  switch (operation.action) {
    case 'snapshot':
      break;
    case 'set-claude-oauth-enabled':
      preferences = { ...preferences, claudeOAuthEnabled: operation.enabled };
      await writeSorbetProviderPreferences(preferences);
      break;
    case 'set-default': {
      const current = await snapshot(agent, preferences, false);
      const provider = current.providers.find((entry) => entry.id === operation.providerId);
      if (!provider || !provider.enabled || !provider.connected) {
        throw new Error('Connect and enable this Provider before making it the default');
      }
      const model =
        provider.models.find((entry) => entry.selector === preferences.defaultModelSelector) ??
        provider.models[0];
      if (!model) throw new Error('This Provider has no available model');
      preferences = {
        ...preferences,
        defaultProviderId: provider.id,
        defaultModelSelector: model.selector,
      };
      await writeSorbetProviderPreferences(preferences);
      affectedProviderId = provider.id;
      break;
    }
    case 'create-custom': {
      const provider = await agent.createCustomProvider(operation.provider);
      affectedProviderId = provider.id;
      break;
    }
    case 'update-custom':
      await agent.updateCustomProvider(operation.providerId, operation.provider);
      affectedProviderId = operation.providerId;
      break;
    case 'delete-custom':
      await agent.deleteCustomProvider(operation.providerId);
      affectedProviderId = operation.providerId;
      break;
    case 'logout':
      await agent.logout(operation.providerId);
      affectedProviderId = operation.providerId;
      break;
    case 'set-api-key': {
      const customProviders = await agent.listCustomProviders();
      if (!customProviders.some((provider) => provider.id === operation.providerId)) {
        throw new Error('API keys can only be stored for a custom Sorbet Provider');
      }
      await agent.credentials.modify(operation.providerId, async () => ({
        type: 'api_key',
        key: operation.apiKey,
      }));
      affectedProviderId = operation.providerId;
      break;
    }
  }
  preferences = await readSorbetProviderPreferences();
  return {
    snapshot: await snapshot(agent, preferences, true),
    ...(affectedProviderId === undefined ? {} : { affectedProviderId }),
  };
}

let agent: NodeAgent | undefined;
try {
  const operation = await readRequest();
  agent = await createNodeAgent({ sandboxMode: 'disabled', allowedSandboxModes: ['disabled'] });
  process.stdout.write(`${JSON.stringify(await execute(agent, operation))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await agent?.close().catch(() => undefined);
}

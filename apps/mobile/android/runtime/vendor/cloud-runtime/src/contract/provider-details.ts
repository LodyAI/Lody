import { z } from 'zod/v4';

const scope = {
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  machineId: z.string().min(1),
  id: z.string().min(1),
};
const text = z.string().max(4096);
export const ProviderRuntimeOverrides = z
  .object({
    codexPath: text.optional(),
    claudeCodeExecutable: text.optional(),
    kimiPath: text.optional(),
    grokPath: text.optional(),
    devinPath: text.optional(),
    piPath: text.optional(),
    piExtensions: z.array(text).max(128).optional(),
  })
  .meta({ id: 'ProviderRuntimeOverrides' });
export const ProviderTitleGeneration = z
  .object({
    configOptionValues: z
      .record(z.string().max(128), z.unknown())
      .refine((values) =>
        Object.values(values).every(
          (value) =>
            typeof value === 'boolean' ||
            (typeof value === 'string' && value.length <= 4096),
        ),
      ),
  })
  .meta({ id: 'ProviderTitleGeneration' });
export const ProviderCodexAuth = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('chatgpt'), profileId: z.uuid() }),
    z.object({
      mode: z.literal('api-key'),
      profileId: z.uuid(),
      baseUrl: z.string().max(2048),
    }),
  ])
  .meta({ id: 'ProviderCodexAuth' });
export const providerAdvancedFields = {
  detailRevision: z.string().max(32000).optional(),
  description: text.optional(),
  envPatch: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(128),
      z.string().max(32000).nullable(),
    )
    .optional(),
  runtimeOverrides: z
    .discriminatedUnion('action', [
      z.object({
        action: z.literal('merge'),
        value: ProviderRuntimeOverrides,
        remove: z.array(z.string()).max(7),
      }),
      z.object({ action: z.literal('clear') }),
    ])
    .optional(),
  titleGeneration: z
    .discriminatedUnion('action', [
      z.object({ action: z.literal('set'), value: ProviderTitleGeneration }),
      z.object({ action: z.literal('clear') }),
    ])
    .optional(),
  codexAuth: ProviderCodexAuth.optional(),
  presetId: z.string().max(128).optional(),
  presetModeId: z.string().max(128).optional(),
  presetEndpoint: z.string().max(2048).optional(),
};
export const ProviderAuthMethod = z
  .object({ id: z.string(), name: z.string() })
  .meta({ id: 'ProviderAuthMethod' });
const choice = z.object({ id: z.string(), name: z.string() });
export const ProviderCapabilities = z
  .object({
    models: z.array(choice),
    modes: z.array(choice),
    sessionTitle: z.boolean(),
    options: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.enum(['select', 'boolean']),
        value: z.unknown().optional(),
        choices: z.array(choice),
      }),
    ),
    authMethods: z.array(ProviderAuthMethod),
  })
  .meta({ id: 'ProviderCapabilities' });
export const ProviderPreset = z
  .object({
    id: z.string(),
    name: z.string(),
    cliType: z.string(),
    agentType: z.string(),
    tokenEnvKey: z.string(),
    protectedEnvKeys: z.array(z.string()),
    modes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        endpoint: z.string().optional(),
        tokenPrefix: z.string().optional(),
        customEndpoint: z.boolean(),
        endpoints: z.array(
          z.object({ id: z.string(), name: z.string(), url: z.string() }),
        ),
      }),
    ),
  })
  .meta({ id: 'ProviderPreset' });
export const AgentProviderDetailParams = z
  .object(scope)
  .meta({ id: 'AgentProviderDetailParams' });
export const AgentProviderDetail = z
  .object({
    id: z.string(),
    machineId: z.string(),
    revision: z.string(),
    description: z.string(),
    env: z.array(z.object({ key: z.string(), hasValue: z.boolean() })),
    endpoints: z.array(z.object({ key: z.string(), value: z.string() })),
    runtimeOverrides: ProviderRuntimeOverrides,
    titleGeneration: ProviderTitleGeneration.nullable(),
    codexAuth: ProviderCodexAuth.optional(),
    presetId: z.string().optional(),
    capabilities: ProviderCapabilities,
    supportsAuthentication: z.boolean(),
    supportsMethodSelection: z.boolean(),
    supportsCodexProfiles: z.boolean(),
    supportsPiExtensions: z.boolean(),
    supportsRateLimitsRefresh: z.boolean().optional(),
    unavailableActions: z.array(
      z.object({ action: z.string(), reason: z.string() }),
    ),
  })
  .meta({ id: 'AgentProviderDetail' });
export const AgentProviderProbeParams = z
  .object(scope)
  .meta({ id: 'AgentProviderProbeParams' });
export const AgentProviderProbeResult = z
  .object({
    success: z.boolean(),
    authRequired: z.boolean(),
    capabilities: ProviderCapabilities,
  })
  .meta({ id: 'AgentProviderProbeResult' });
export const ProviderAuthField = z
  .object({
    id: z.string(),
    label: z.string(),
    type: z.enum(['text', 'secret', 'select']),
    required: z.boolean(),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
  })
  .meta({ id: 'ProviderAuthField' });
export const AgentProviderAuthParams = z
  .discriminatedUnion('action', [
    z.object({
      ...scope,
      action: z.literal('start'),
      flowId: z.uuid(),
      methodId: z.string().max(1024).optional(),
    }),
    z.object({ ...scope, action: z.literal('status'), flowId: z.uuid() }),
    z.object({ ...scope, action: z.literal('cancel'), flowId: z.uuid() }),
    z.object({
      ...scope,
      action: z.literal('submit'),
      flowId: z.uuid(),
      interactionId: z.string().max(1024).optional(),
      values: z.record(z.string(), z.string().max(32000)).optional(),
      authorizationCode: z.string().max(4096).optional(),
      responseAction: z.enum(['accept', 'decline', 'cancel']).optional(),
      methodId: z.string().max(1024).optional(),
    }),
  ])
  .meta({ id: 'AgentProviderAuthParams' });
export const AgentProviderAuthState = z
  .object({
    flowId: z.string(),
    status: z.enum([
      'starting',
      'verifying',
      'method-required',
      'authorization',
      'input-required',
      'authenticated',
      'cancelled',
      'error',
    ]),
    methods: z.array(ProviderAuthMethod),
    fields: z.array(ProviderAuthField),
    interactionId: z.string().optional(),
    authorizationUrl: z.string().optional(),
    userCode: z.string().optional(),
    acceptsAuthorizationCode: z.boolean(),
    requiresAuthorizationConsent: z.boolean(),
    errorCode: z.string().optional(),
  })
  .meta({ id: 'AgentProviderAuthState' });

const draftBinaryScope = {
  ...scope,
  id: z.string().min(1).optional(),
  cliType: z.enum(['builtin', 'registry']).optional(),
  agentType: z.string().min(1).max(512).optional(),
};
export const AgentProviderOperationParams = z
  .discriminatedUnion('action', [
    z.object({ ...draftBinaryScope, action: z.literal('binary-status') }),
    z.object({ ...draftBinaryScope, action: z.literal('binary-install') }),
    z.object({
      ...scope,
      id: z.string().min(1).optional(),
      action: z.literal('pi-extension-scan'),
    }),
    z.object({ ...scope, action: z.literal('rate-limits-refresh') }),
  ])
  .meta({ id: 'AgentProviderOperationParams' });
export const AgentProviderOperationResult = z
  .object({
    action: z.string(),
    success: z.boolean(),
    status: z.string().optional(),
    extensions: z
      .array(
        z.object({
          path: z.string(),
          name: z.string(),
          source: z.string().optional(),
        }),
      )
      .optional(),
    version: z.string().optional(),
    current: z.string().optional(),
    required: z.string().optional(),
    errorCode: z.string().optional(),
  })
  .meta({ id: 'AgentProviderOperationResult' });
export const AgentProviderOperationProgress = z
  .object({
    machineId: z.string(),
    id: z.string(),
    status: z.string(),
    percent: z.number().optional(),
  })
  .meta({ id: 'AgentProviderOperationProgress' });

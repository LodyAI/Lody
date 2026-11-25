import { z } from 'zod';

export const SORBET_CUSTOM_PROVIDER_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const;

export type SorbetOnboardingCustomProtocol = (typeof SORBET_CUSTOM_PROVIDER_PROTOCOLS)[number];

export type SorbetAuthMethodSummary = {
  providerId: string;
  providerName: string;
  type: 'oauth' | 'api_key';
  name: string;
};

export const IMPORT_SOURCE_IDS = ['claude-code', 'codex', 'env'] as const;
export type ImportSourceId = (typeof IMPORT_SOURCE_IDS)[number];

export type SorbetConnectionSource =
  | { kind: 'oauth'; updatedAtMs?: number }
  | {
      kind: 'imported';
      from: ImportSourceId;
      authKind: 'oauth' | 'api_key';
      last4?: string;
      updatedAtMs?: number;
    }
  | { kind: 'api_key'; last4?: string; updatedAtMs?: number };

export type SorbetConnectedProviderSummary = {
  providerId: string;
  providerName: string;
  authType: 'oauth' | 'api_key';
  source: SorbetConnectionSource;
  baseUrl?: string;
  isCustom?: boolean;
};

export type SorbetModelSummary = {
  selector: string;
  providerId: string;
  modelId: string;
  displayName: string;
};

export type ArrivalProbe = {
  model:
    | {
        kind: 'ready';
        provider: string;
        providerName: string;
        model: string;
        modelName: string;
        source: SorbetConnectionSource;
      }
    | {
        kind: 'none';
        methods: SorbetAuthMethodSummary[];
      };
  methods: SorbetAuthMethodSummary[];
  connectedProviders: SorbetConnectedProviderSummary[];
  models: SorbetModelSummary[];
};

export type ImportSourceDescription = {
  source: ImportSourceId;
  /** Non-null only when confirming will trigger an OS permission dialog (e.g. macOS Keychain). */
  systemPromptKind: 'macos-keychain' | 'none';
};

export type EnvImportCandidate = {
  envName: string;
  providerId: string;
  providerName: string;
  last4: string;
};

export type ImportSourceResult =
  | {
      status: 'imported';
      source: ImportSourceId;
      providerId: string;
      providerName: string;
      modelSelector: string;
      modelName: string;
      connectionSource: SorbetConnectionSource;
    }
  | {
      status: 'env_candidates';
      candidates: EnvImportCandidate[];
    }
  | {
      status: 'oauth_conflict';
      source: 'claude-code' | 'codex';
      providerId: string;
      providerName: string;
    }
  | {
      status: 'not_found';
      source: ImportSourceId;
      fallbackProviderId?: string;
      fallbackProviderName?: string;
    }
  | {
      status: 'error';
      source: ImportSourceId;
      code: 'invalid_key' | 'no_models' | 'keychain_denied' | 'read_failed';
      message?: string;
    };

export const SorbetConnectApiKeyInputSchema = z
  .object({
    providerId: z.string().trim().min(1).max(120),
    apiKey: z.string().trim().min(1).max(8192),
  })
  .strict();

export type SorbetConnectApiKeyInput = z.infer<typeof SorbetConnectApiKeyInputSchema>;

export const SorbetConnectCustomProviderInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    baseUrl: z.string().trim().url().max(2048),
    protocol: z.enum(SORBET_CUSTOM_PROVIDER_PROTOCOLS),
    apiKey: z.string().trim().max(8192).optional(),
  })
  .strict();

export type SorbetConnectCustomProviderInput = z.infer<
  typeof SorbetConnectCustomProviderInputSchema
>;

export type SorbetConnectResult =
  | {
      ok: true;
      providerId: string;
      providerName: string;
      modelSelector: string;
      modelName: string;
      source: SorbetConnectionSource;
      models: SorbetModelSummary[];
    }
  | {
      ok: false;
      code:
        | 'invalid_key'
        | 'no_models'
        | 'invalid_endpoint'
        | 'provider_not_found'
        | 'network_error'
        | 'unknown';
      message?: string;
    };

export const SorbetStartOAuthInputSchema = z
  .object({
    providerId: z.string().trim().min(1).max(120),
    providerName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type SorbetStartOAuthInput = z.infer<typeof SorbetStartOAuthInputSchema>;

export const SorbetImportRequestSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('claude-code') }).strict(),
  z.object({ source: z.literal('codex') }).strict(),
  z
    .object({
      source: z.literal('env'),
      mode: z.enum(['scan', 'confirm']),
      selectedEnvNames: z.array(z.string().trim().min(1).max(120)).max(32).optional(),
    })
    .strict(),
]);

export type SorbetImportRequest = z.infer<typeof SorbetImportRequestSchema>;

export type ElectronSorbetOAuthState = {
  revision: number;
  attemptId: string | null;
  providerId: string | null;
  providerName: string | null;
  phase: 'idle' | 'starting' | 'waiting' | 'authenticated' | 'cancelled' | 'error';
  authorizationUrl: string | null;
  userCode: string | null;
  modelSelector: string | null;
  modelName: string | null;
  source: SorbetConnectionSource | null;
  error: string | null;
};

export type DiscoveredLocalRepo = {
  name: string;
  rootPath: string;
  mtimeMs: number;
};

export type LocalRepoPromptHints = {
  hasTests: boolean;
  isDirty: boolean;
  hasTodos: boolean;
};

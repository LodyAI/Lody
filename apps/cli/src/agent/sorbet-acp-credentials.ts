import { z } from 'zod';
import {
  SorbetProviderIdSchema,
  SorbetCredentialTypeSchema,
  SORBET_CREDENTIALS_MAX_COUNT,
  SORBET_CUSTOM_PROVIDER_MODELS_MAX_COUNT,
  SorbetCustomProviderProtocolSchema,
  type SorbetCustomProviderInput,
} from '@lody/shared/local-machine-rpc';

const CredentialsCapabilitySchema = z.object({
  'sorbet.dev': z.object({ credentials: z.object({ version: z.literal(1) }) }),
});
/**
 * Custom Providers are a separate extension version. `sorbet.dev.version` moves on its own,
 * so the capability is read by its own key rather than from the envelope's version.
 */
const CustomProvidersCapabilitySchema = z.object({
  'sorbet.dev': z.object({ customProviders: z.object({ version: z.literal(1) }) }),
});

const CredentialSchema = z.object({
  providerId: SorbetProviderIdSchema,
  type: SorbetCredentialTypeSchema,
});
const CredentialsResponseSchema = z.object({
  credentials: z.array(CredentialSchema).max(SORBET_CREDENTIALS_MAX_COUNT),
});

/** Mirrors the wire shape: `models` entries carry `id` and an optional display name. */
const CustomProviderModelSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const CustomProviderSchema = z
  .object({
    id: SorbetProviderIdSchema,
    name: z.string().trim().min(1).max(200),
    protocol: SorbetCustomProviderProtocolSchema,
    baseUrl: z.string().trim().min(1).max(2048),
    models: z.array(CustomProviderModelSchema).max(SORBET_CUSTOM_PROVIDER_MODELS_MAX_COUNT),
  })
  .strict();
const CustomProvidersResponseSchema = z.object({
  providers: z.array(CustomProviderSchema).max(SORBET_CREDENTIALS_MAX_COUNT),
});
const CustomProviderResponseSchema = z.object({ provider: CustomProviderSchema });

export type SorbetAcpCredential = z.infer<typeof CredentialSchema>;
export type SorbetAcpCustomProvider = z.infer<typeof CustomProviderSchema>;

/** A caller-owned, initialized ACP connection. The caller owns its deadline and shutdown. */
export type SorbetAcpCredentialsConnection = {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
};

export function supportsSorbetAcpCredentials(agentCapabilities: unknown): boolean {
  const capabilities = z
    .object({ _meta: CredentialsCapabilitySchema })
    .safeParse(agentCapabilities);
  return capabilities.success;
}

export function supportsSorbetAcpCustomProviders(agentCapabilities: unknown): boolean {
  const capabilities = z
    .object({ _meta: CustomProvidersCapabilitySchema })
    .safeParse(agentCapabilities);
  return capabilities.success;
}

function requireCredentialsCapability(agentCapabilities: unknown): void {
  if (!supportsSorbetAcpCredentials(agentCapabilities)) {
    throw new Error('Sorbet ACP credentials are unsupported');
  }
}

function requireCustomProvidersCapability(agentCapabilities: unknown): void {
  if (!supportsSorbetAcpCustomProviders(agentCapabilities)) {
    throw new Error('Sorbet custom providers are unsupported');
  }
}

/** Returns only non-secret credential descriptors; malformed responses are rejected. */
export async function listSorbetAcpCredentials(
  connection: SorbetAcpCredentialsConnection,
  agentCapabilities: unknown
): Promise<SorbetAcpCredential[]> {
  requireCredentialsCapability(agentCapabilities);
  let response: unknown;
  try {
    response = await connection.request('_sorbet/auth/credentials/list', {});
  } catch {
    throw new Error('Sorbet ACP credentials list failed');
  }
  const parsed = CredentialsResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error('Invalid Sorbet ACP credentials list response');
  return parsed.data.credentials;
}

/** Logout is an explicit mutation; the caller must not retry an ambiguous result. */
export async function logoutSorbetAcpCredential(
  connection: SorbetAcpCredentialsConnection,
  agentCapabilities: unknown,
  providerId: string
): Promise<void> {
  requireCredentialsCapability(agentCapabilities);
  if (!SorbetProviderIdSchema.safeParse(providerId).success) {
    throw new Error('Invalid Sorbet ACP credential provider ID');
  }
  try {
    await connection.request('_sorbet/auth/credentials/logout', { providerId });
  } catch {
    throw new Error('Sorbet ACP credentials logout failed');
  }
}

/**
 * Custom Providers define an endpoint Lody names. The definition lives in Sorbet's data
 * directory, so it survives restarts and is offered to every later process.
 */
export async function listSorbetAcpCustomProviders(
  connection: SorbetAcpCredentialsConnection,
  agentCapabilities: unknown
): Promise<SorbetAcpCustomProvider[]> {
  requireCustomProvidersCapability(agentCapabilities);
  let response: unknown;
  try {
    response = await connection.request('_sorbet/providers/custom/list', {});
  } catch {
    throw new Error('Sorbet custom providers list failed');
  }
  const parsed = CustomProvidersResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error('Invalid Sorbet custom providers list response');
  return parsed.data.providers;
}

/** Creation is an explicit mutation; Sorbet assigns the Provider ID. */
export async function createSorbetAcpCustomProvider(
  connection: SorbetAcpCredentialsConnection,
  agentCapabilities: unknown,
  provider: SorbetCustomProviderInput
): Promise<SorbetAcpCustomProvider> {
  requireCustomProvidersCapability(agentCapabilities);
  let response: unknown;
  try {
    response = await connection.request('_sorbet/providers/custom/create', {
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      models: provider.models,
    });
  } catch {
    throw new Error('Sorbet custom provider create failed');
  }
  const parsed = CustomProviderResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error('Invalid Sorbet custom provider response');
  return parsed.data.provider;
}

/** Deletion also drops the stored credential and endpoint selection for that Provider. */
export async function deleteSorbetAcpCustomProvider(
  connection: SorbetAcpCredentialsConnection,
  agentCapabilities: unknown,
  providerId: string
): Promise<void> {
  requireCustomProvidersCapability(agentCapabilities);
  if (!SorbetProviderIdSchema.safeParse(providerId).success) {
    throw new Error('Invalid Sorbet custom provider ID');
  }
  try {
    await connection.request('_sorbet/providers/custom/delete', { providerId });
  } catch {
    throw new Error('Sorbet custom provider delete failed');
  }
}

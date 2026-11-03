import { z } from 'zod';
import {
  SorbetProviderIdSchema,
  SorbetCredentialTypeSchema,
  SORBET_CREDENTIALS_MAX_COUNT,
} from '@lody/shared/local-machine-rpc';

const CredentialsCapabilitySchema = z.object({
  'sorbet.dev': z.object({ credentials: z.object({ version: z.literal(1) }) }),
});
const CredentialSchema = z.object({
  providerId: SorbetProviderIdSchema,
  type: SorbetCredentialTypeSchema,
});
const CredentialsResponseSchema = z.object({
  credentials: z.array(CredentialSchema).max(SORBET_CREDENTIALS_MAX_COUNT),
});

export type SorbetAcpCredential = z.infer<typeof CredentialSchema>;

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

function requireCredentialsCapability(agentCapabilities: unknown): void {
  if (!supportsSorbetAcpCredentials(agentCapabilities)) {
    throw new Error('Sorbet ACP credentials are unsupported');
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

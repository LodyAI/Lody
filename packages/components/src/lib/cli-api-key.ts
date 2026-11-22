import type {
  CliApiKeyRecord,
  GenerateCliApiKeyResult,
  MachinePairingCreateResponse,
} from '@lody/shared';
import { z } from 'zod';
import { requireCloudAuthBaseUrl } from './cloud-http-port';

const CliApiKeyRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    keyStart: z.string().nullable(),
    keyPreview: z.string().nullable().optional().default(null),
    note: z.string().nullable(),
    source: z.enum(['auto', 'manual', 'pairing']).nullable().optional(),
    createdAt: z.number().nullable(),
    lastRequest: z.number().nullable(),
    expiresAt: z.number().nullable(),
    enabled: z.boolean(),
    machineIds: z.array(z.string()).optional(),
  })
  .passthrough();

const CliApiKeyCreateResponseSchema = z
  .object({
    apiKey: z.string().min(1),
    apiKeyId: z.string().optional(),
    apiKeyStart: z.string().nullable().optional(),
    record: CliApiKeyRecordSchema.optional(),
  })
  .passthrough();

const CliApiKeyListResponseSchema = z
  .object({
    records: z.array(CliApiKeyRecordSchema),
  })
  .passthrough();

const CliApiKeyRevokeResponseSchema = z
  .object({
    success: z.literal(true),
  })
  .passthrough();

const CliApiKeyErrorResponseSchema = z
  .object({
    error: z.unknown().optional(),
  })
  .passthrough();

const MachinePairingCreateResponseSchema = z.object({
  request: z.object({
    id: z.string(),
    status: z.enum(['pending', 'claimed', 'registered', 'cancelled', 'expired']),
    machineId: z.string().optional(),
    machineName: z.string().optional(),
    expiresAt: z.number(),
  }),
  token: z.string(),
});

type GenerateWebCliApiKeyOptions = {
  sessionToken: string;
  authBaseUrl?: string;
  note?: string;
};

type AuthenticatedCliApiKeyRequestOptions = {
  sessionToken: string;
  authBaseUrl?: string;
};

type RevokeWebCliApiKeyOptions = AuthenticatedCliApiKeyRequestOptions & {
  keyId: string;
};

export type ListWebCliApiKeysResult =
  | {
      ok: true;
      records: CliApiKeyRecord[];
    }
  | {
      ok: false;
      error: string;
    };

export type RevokeWebCliApiKeyResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

export type CreateMachinePairingResult =
  | { ok: true; value: MachinePairingCreateResponse }
  | { ok: false; error: string };

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatCliApiKeyError(status: number, bodyText: string): string {
  const parsed = CliApiKeyErrorResponseSchema.safeParse(safeJsonParse(bodyText));
  if (parsed.success) {
    const error = parsed.data.error;
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
    if (error && typeof error === 'object') {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && code.trim()) {
        return code;
      }
    }
  }

  return bodyText.trim() || `http_${status}`;
}

export async function createMachinePairing({
  sessionToken,
  workspaceId,
  authBaseUrl,
}: AuthenticatedCliApiKeyRequestOptions & {
  workspaceId: string;
}): Promise<CreateMachinePairingResult> {
  authBaseUrl = requireCloudAuthBaseUrl('remoteMachines', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) return { ok: false, error: 'not_authenticated' };
  if (!authBaseUrl) return { ok: false, error: 'missing_auth_site_url' };

  try {
    const response = await fetch(
      `${trimTrailingSlash(authBaseUrl)}/api/cli/machine-pairing/create`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trimmedToken}`,
        },
        body: JSON.stringify({ workspaceId }),
      }
    );
    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, error: formatCliApiKeyError(response.status, bodyText) };
    }
    const parsed = MachinePairingCreateResponseSchema.safeParse(safeJsonParse(bodyText));
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: 'invalid_response' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateWebCliApiKey({
  sessionToken,
  authBaseUrl,
  note,
}: GenerateWebCliApiKeyOptions): Promise<GenerateCliApiKeyResult> {
  authBaseUrl = requireCloudAuthBaseUrl('cloudAccount', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) {
    return { ok: false, error: 'not_authenticated' };
  }

  if (!authBaseUrl) {
    return { ok: false, error: 'missing_auth_site_url' };
  }

  try {
    const response = await fetch(`${trimTrailingSlash(authBaseUrl)}/api/cli/api-key/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trimmedToken}`,
      },
      body: JSON.stringify({ note, source: 'manual' }),
    });

    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, error: formatCliApiKeyError(response.status, bodyText) };
    }

    const parsed = CliApiKeyCreateResponseSchema.safeParse(safeJsonParse(bodyText));
    if (!parsed.success) {
      return { ok: false, error: 'invalid_response' };
    }

    return {
      ok: true,
      apiKey: parsed.data.apiKey,
      apiKeyId: parsed.data.apiKeyId,
      apiKeyStart: parsed.data.apiKeyStart,
      record: parsed.data.record,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listWebCliApiKeys({
  sessionToken,
  authBaseUrl,
}: AuthenticatedCliApiKeyRequestOptions): Promise<ListWebCliApiKeysResult> {
  authBaseUrl = requireCloudAuthBaseUrl('cloudAccount', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) {
    return { ok: false, error: 'not_authenticated' };
  }

  if (!authBaseUrl) {
    return { ok: false, error: 'missing_auth_site_url' };
  }

  try {
    const response = await fetch(`${trimTrailingSlash(authBaseUrl)}/api/cli/api-key/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trimmedToken}`,
      },
      body: JSON.stringify({}),
    });

    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, error: formatCliApiKeyError(response.status, bodyText) };
    }

    const parsed = CliApiKeyListResponseSchema.safeParse(safeJsonParse(bodyText));
    if (!parsed.success) {
      return { ok: false, error: 'invalid_response' };
    }

    return { ok: true, records: parsed.data.records };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function revokeWebCliApiKey({
  sessionToken,
  authBaseUrl,
  keyId,
}: RevokeWebCliApiKeyOptions): Promise<RevokeWebCliApiKeyResult> {
  authBaseUrl = requireCloudAuthBaseUrl('cloudAccount', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) {
    return { ok: false, error: 'not_authenticated' };
  }

  if (!authBaseUrl) {
    return { ok: false, error: 'missing_auth_site_url' };
  }

  try {
    const response = await fetch(`${trimTrailingSlash(authBaseUrl)}/api/cli/api-key/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trimmedToken}`,
      },
      body: JSON.stringify({ keyId }),
    });

    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, error: formatCliApiKeyError(response.status, bodyText) };
    }

    const parsed = CliApiKeyRevokeResponseSchema.safeParse(safeJsonParse(bodyText));
    if (!parsed.success) {
      return { ok: false, error: 'invalid_response' };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

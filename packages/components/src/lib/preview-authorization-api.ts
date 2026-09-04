import { z } from 'zod';
import type { PreviewTarget } from '@lody/shared';
import { requireCloudAuthBaseUrl } from './cloud-http-port';

const PreviewRequestTokenResponseSchema = z.object({
  requestToken: z.string().min(1),
  requesterUserId: z.string().min(1),
});

export type MintPreviewRequestTokenResult =
  | { ok: true; requestToken: string; requesterUserId: string }
  | { ok: false; error: string };

export async function mintPreviewRequestToken({
  workspaceId,
  machineId,
  sessionId,
  target,
  replaceExisting,
  expectedGrantId,
  requestId,
  localProjectId,
  sessionToken,
  authBaseUrl,
}: {
  workspaceId: string;
  machineId: string;
  sessionId: string;
  target: PreviewTarget;
  replaceExisting: boolean;
  expectedGrantId?: string;
  requestId: string;
  localProjectId?: string;
  sessionToken: string;
  authBaseUrl?: string;
}): Promise<MintPreviewRequestTokenResult> {
  authBaseUrl = requireCloudAuthBaseUrl('remoteMachines', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) return { ok: false, error: 'not_authenticated' };
  if (!authBaseUrl) return { ok: false, error: 'missing_auth_site_url' };

  try {
    const response = await fetch(
      `${authBaseUrl.replace(/\/+$/, '')}/api/session-preview/request-token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trimmedToken}`,
        },
        body: JSON.stringify({
          workspaceId,
          machineId,
          sessionId,
          target,
          replaceExisting,
          ...(expectedGrantId === undefined ? {} : { expectedGrantId }),
          requestId,
          ...(localProjectId === undefined ? {} : { localProjectId }),
        }),
      }
    );
    if (!response.ok) {
      return { ok: false, error: `Preview authorization failed with status ${response.status}.` };
    }
    const parsed = PreviewRequestTokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: 'Preview authorization returned an invalid response.' };
    }
    return { ok: true, ...parsed.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

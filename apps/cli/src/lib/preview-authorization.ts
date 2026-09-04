import { z } from 'zod';
import type { PreviewRequestVerification, PreviewRequestVerificationRequest } from '@lody/platform';

const PreviewVerifyResponseSchema = z
  .object({
    valid: z.literal(true),
    requesterUserId: z.string().trim().min(1),
  })
  .strict();

export async function verifyPreviewRequestWithCloud(args: {
  siteUrl: string;
  cliToken: string;
  request: PreviewRequestVerificationRequest;
  fetchImpl: typeof fetch;
}): Promise<PreviewRequestVerification> {
  try {
    const response = await args.fetchImpl(`${args.siteUrl}/api/session-preview/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.cliToken}`,
      },
      body: JSON.stringify(args.request),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const error = `Preview request verification failed with status ${response.status}${
        detail ? `: ${detail.slice(0, 200)}` : ''
      }`;
      if (response.status === 401) {
        return { outcome: 'indeterminate', cause: 'auth', error };
      }
      if (response.status === 403 || response.status === 400) {
        return { outcome: 'denied', reason: 'not_visible' };
      }
      return { outcome: 'indeterminate', cause: 'network', error };
    }

    const parsed = PreviewVerifyResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.requesterUserId !== args.request.requesterUserId) {
      return { outcome: 'denied', reason: 'not_visible' };
    }
    return { outcome: 'allowed' };
  } catch (error) {
    return {
      outcome: 'indeterminate',
      cause: 'network',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

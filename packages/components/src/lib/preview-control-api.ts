import { z } from 'zod';
import type { PreviewControlIntent, PreviewControlProof } from '@lody/shared';
import { requireCloudAuthBaseUrl } from './cloud-http-port';

const TokenResponse = z
  .object({ requestToken: z.string().min(1), requesterUserId: z.string().min(1) })
  .strict();

export async function mintPreviewControlProof(
  intent: PreviewControlIntent,
  sessionToken: string | null
): Promise<PreviewControlProof> {
  const baseUrl = requireCloudAuthBaseUrl('remotePreview');
  if (!sessionToken) throw new Error('Sign in before managing a remote preview.');
  const { requesterUserId, ...request } = intent;
  const response = await fetch(new URL('/api/session-preview/request-token', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Preview authorization failed (${response.status}).`);
  const token = TokenResponse.parse(await response.json());
  if (token.requesterUserId !== requesterUserId) throw new Error('Preview user identity changed.');
  return {
    runtimeNonce: intent.runtimeNonce,
    requestId: intent.requestId,
    requestToken: token.requestToken,
  };
}

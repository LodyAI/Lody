import { z } from 'zod';
import {
  PreviewControlIntentSchema,
  type PreviewControlIntent,
  type PreviewControlProof,
} from '@lody/shared';
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
  const { requesterUserId, ...request } = PreviewControlIntentSchema.parse(intent);
  const response = await fetch(new URL('/api/session-preview/request-token', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
  if (
    response.status === 400 &&
    (intent.operation.action === 'ios-simulator' || intent.operation.action === 'android-emulator')
  )
    throw new Error(
      'Preview authorization failed (400): the Cloud authorization service rejected the validated device preview protocol. Update the connected Cloud backend to the matching version.'
    );
  if (!response.ok) throw new Error(`Preview authorization failed (${response.status}).`);
  const token = TokenResponse.parse(await response.json());
  if (token.requesterUserId !== requesterUserId) throw new Error('Preview user identity changed.');
  return {
    runtimeNonce: intent.runtimeNonce,
    requestId: intent.requestId,
    requestToken: token.requestToken,
  };
}

/** Only the short-lived read proof, never the app credential, crosses machine RPC. */
export async function mintSessionHistoryReadProof(
  intent: {
    workspaceId: string;
    machineId: string;
    sessionId: string;
    requestId?: string;
    intentDigest?: string;
  },
  sessionToken: string | null,
  edit = false
): Promise<string> {
  const baseUrl = requireCloudAuthBaseUrl('teamSharing');
  if (!sessionToken) throw new Error('Session history authorization is unavailable.');
  const response = await fetch(
    new URL(
      edit ? '/api/session-history/request-edit-token' : '/api/session-history/request-token',
      baseUrl
    ),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify(intent),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!response.ok) throw new Error('Session history authorization was refused.');
  return z
    .object({ requestToken: z.string().min(1).max(8192) })
    .strict()
    .parse(await response.json()).requestToken;
}

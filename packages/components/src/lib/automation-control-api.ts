import { z } from 'zod';
import {
  remoteAutomationIntentSchema,
  type RemoteAutomationIntent,
  type RemoteAutomationProof,
} from '@lody/shared/automations';
import { requireCloudAuthBaseUrl } from './cloud-http-port';

const TokenResponse = z
  .object({ requestToken: z.string().min(1), requesterUserId: z.string().min(1) })
  .strict();

export async function mintAutomationControlProof(
  intent: RemoteAutomationIntent,
  sessionToken: string
): Promise<RemoteAutomationProof> {
  const { requesterUserId, ...request } = remoteAutomationIntentSchema.parse(intent);
  const response = await fetch(
    new URL('/api/session-automation/request-token', requireCloudAuthBaseUrl('remoteMachines')),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!response.ok) throw new Error(`Automation authorization failed (${response.status}).`);
  const result = TokenResponse.parse(await response.json());
  if (result.requesterUserId !== requesterUserId)
    throw new Error('Automation user identity changed.');
  return {
    runtimeNonce: intent.runtimeNonce,
    requestId: intent.requestId,
    requestToken: result.requestToken,
  };
}

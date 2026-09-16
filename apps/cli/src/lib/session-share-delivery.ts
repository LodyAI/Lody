import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  createShareDeliveryKey,
  ShareDeliveryPublicKeySchema,
  decryptShareDelivery,
} from '@lody/shared/session-share-delivery';
import { createSessionShareUrl } from '@lody/shared/session-share-credentials';
import type { SessionShareRequestInput } from '@lody/shared/session-sharing';
import type { CloudSessionSharingPort } from '@lody/platform';

const keySchema = z
  .object({
    publicKey: ShareDeliveryPublicKeySchema,
    privateKey: z
      .string()
      .min(2000)
      .max(8192)
      .regex(/^[a-f0-9]+$/),
  })
  .strict();

/** Durable before intent submission, account/session scoped, atomic across MCP processes. */
export async function loadShareDeliveryKey(
  scope: string,
  directory = join(getLodyDataDir(), 'share-delivery-keys')
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${createHash('sha256').update(scope).digest('hex')}.json`);
  try {
    return keySchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(await createShareDeliveryKey()), {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return keySchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export async function requestSessionShare(
  port: CloudSessionSharingPort,
  input: Omit<SessionShareRequestInput, 'deliveryPublicKey'>,
  authenticatedUserId: string,
  signal?: AbortSignal
) {
  if (input.requesterUserId !== authenticatedUserId) {
    throw new Error(
      'MCP sharing requires the active user and CLI signed-in account to match. Use a machine signed in to your account, or share manually in the app.'
    );
  }
  const key = await loadShareDeliveryKey(
    JSON.stringify([
      authenticatedUserId,
      input.workspaceId,
      input.requesterUserId,
      input.sourceSessionId,
      input.requestId,
    ])
  );
  signal?.throwIfAborted();
  const accepted = await port.request({ ...input, deliveryPublicKey: key.publicKey });
  // Bounded below common MCP request timeouts. Reusing requestId resumes on a later turn.
  const deadline = Date.now() + 25_000;
  for (;;) {
    signal?.throwIfAborted();
    const outcome = await port.getResult({
      workspaceId: input.workspaceId,
      sourceSessionId: input.sourceSessionId,
      requesterUserId: input.requesterUserId,
      shareRequestId: accepted.shareRequestId,
      deliveryPublicKey: key.publicKey,
    });
    const result = {
      requestId: outcome.requestId,
      shareRequestId: outcome.shareRequestId,
      status: outcome.status,
    };
    if (outcome.status === 'published') {
      if (!outcome.shareId || !outcome.delivery) throw new Error('Share delivery unavailable');
      const secret = await decryptShareDelivery(
        key.privateKey,
        outcome.shareRequestId,
        outcome.delivery
      );
      return {
        ...result,
        shareId: outcome.shareId,
        url: createSessionShareUrl(outcome.shareId, secret, outcome.delivery.origin),
      };
    }
    if (outcome.status === 'cancelled' || outcome.status === 'expired') return result;
    if (Date.now() >= deadline)
      return {
        ...result,
        next: 'Call lody_session_share again with the same requestId, purpose and sessionIds to receive the result. No further user action is needed after approval.',
      };
    await setTimeout(1000, undefined, { signal });
  }
}

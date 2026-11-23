import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createSessionShareSecret,
  encryptShareDelivery,
  decryptShareDelivery,
  type SessionShareRequestInput,
} from '@lody/shared/session-sharing';
import type { CloudSessionSharingPort } from '@lody/platform';
import { loadShareDeliveryKey, requestSessionShare } from '../src/lib/session-share-delivery';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lody-share-delivery-'));
  vi.stubEnv('LODY_DATA_DIR', directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it('atomically retains one recipient across concurrent callers and process-style reloads', async () => {
  const [first, second] = await Promise.all([
    loadShareDeliveryKey('scope', directory),
    loadShareDeliveryKey('scope', directory),
  ]);
  expect(second).toEqual(first);
  const persisted = await loadShareDeliveryKey('scope', directory);
  const envelope = await encryptShareDelivery(
    first.publicKey,
    'request',
    'https://share.test',
    'a'.repeat(64)
  );
  expect(await decryptShareDelivery(persisted.privateKey, 'request', envelope)).toBe(
    'a'.repeat(64)
  );
  expect((await readdir(directory)).length).toBe(1);
  if (process.platform !== 'win32') {
    const files = await readdir(directory);
    expect((await stat(join(directory, files[0] ?? 'missing'))).mode & 0o777).toBe(0o600);
  }
  expect((await loadShareDeliveryKey('other-account', directory)).publicKey).not.toBe(
    first.publicKey
  );
});

const input = {
  workspaceId: 'workspace',
  requesterUserId: 'alice',
  sourceSessionId: 'session',
  sourceTurnId: 'turn',
  requestId: 'request',
  sessionIds: ['session'],
  purpose: 'Share for review',
};

it('returns the full URL and reuses the recipient when a later turn resumes', async () => {
  let accepted: SessionShareRequestInput | undefined;
  const secret = createSessionShareSecret();
  const port: CloudSessionSharingPort = {
    request: async (request) => {
      if (accepted) expect(request.deliveryPublicKey).toBe(accepted.deliveryPublicKey);
      accepted = request;
      return { requestId: request.requestId, shareRequestId: 'record', status: 'confirmed' };
    },
    getResult: async (request) => ({
      requestId: 'request',
      shareRequestId: 'record',
      status: 'published',
      shareId: 'share',
      delivery: await encryptShareDelivery(
        request.deliveryPublicKey,
        'record',
        'https://share.test',
        secret
      ),
    }),
  };
  const first = await requestSessionShare(port, input, 'alice');
  expect(first).toMatchObject({
    status: 'published',
    url: `https://share.test/s/share#access=v1.${secret}`,
  });
  expect(first).not.toHaveProperty('delivery');
  expect(await requestSessionShare(port, { ...input, sourceTurnId: 'next-turn' }, 'alice')).toEqual(
    first
  );
});

it('returns cancellation without a credential and honors abort before submission', async () => {
  const port: CloudSessionSharingPort = {
    request: async () => ({ requestId: 'request', shareRequestId: 'record', status: 'cancelled' }),
    getResult: async () => ({
      requestId: 'request',
      shareRequestId: 'record',
      status: 'cancelled',
    }),
  };
  expect(await requestSessionShare(port, input, 'alice')).toEqual({
    requestId: 'request',
    shareRequestId: 'record',
    status: 'cancelled',
  });
  await expect(requestSessionShare(port, input, 'alice', AbortSignal.abort())).rejects.toThrow();
});

it('rejects a shared-machine account mismatch before creating keys or submitting intent', async () => {
  const port: CloudSessionSharingPort = {
    request: async () => {
      throw new Error('Unexpected submission');
    },
    getResult: async () => {
      throw new Error('Unexpected retrieval');
    },
  };
  await expect(requestSessionShare(port, input, 'bob')).rejects.toThrow(
    'active user and CLI signed-in account to match'
  );
  expect(await readdir(directory)).toEqual([]);
});

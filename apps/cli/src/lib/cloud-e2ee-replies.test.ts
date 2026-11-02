import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const reply = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('@/utils/http-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/http-transport')>()),
  // Serve a synthetic Convex HTTP reply; no network.
  getCliHttpFetch: () => async () =>
    new Response(JSON.stringify({ status: 'success', value: reply.value, logLines: [] }), {
      headers: { 'Content-Type': 'application/json' },
    }),
}));

import { createCloudE2eePort } from './cloud-cli-port';

const port = () =>
  createCloudE2eePort({ token: 'synthetic-token', authBaseUrl: 'https://synthetic.invalid' });
const page = {
  workspaceId: 'workspace',
  genesisHash: 'ab'.repeat(32),
  checkpoint: { headHash: 'cd'.repeat(32), length: 2 },
  startIndex: 0,
  recordsHex: ['0102'],
  position: 'opaque',
  nextCursor: null,
};
const access = { workspaceId: 'workspace', credential: 'credential' };

afterEach(() => {
  reply.value = undefined;
});

describe('CLI E2EE cloud port reply validation', () => {
  it('returns a well-formed history page', async () => {
    reply.value = page;
    await expect(port().getHistory(access)).resolves.toEqual(page);
  });

  it('rejects a malformed history page at the boundary', async () => {
    reply.value = { ...page, recordsHex: 'not-an-array' };
    await expect(port().getHistory(access)).rejects.toBeInstanceOf(ZodError);
  });

  it('rejects a mailbox reply of the wrong shape', async () => {
    reply.value = { unexpected: true };
    await expect(port().mailboxCall('read', { ...access, id: 'id' })).rejects.toBeInstanceOf(
      ZodError
    );
    reply.value = 'ab';
    await expect(port().mailboxCall('read', { ...access, id: 'id' })).resolves.toBe('ab');
  });
});

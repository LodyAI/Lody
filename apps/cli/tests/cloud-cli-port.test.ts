import { afterEach, expect, it, vi } from 'vitest';
import { createCloudSessionSharingPort } from '../src/lib/cloud-cli-port';

afterEach(() => vi.unstubAllGlobals());

it('preserves the client retry key and separate server ID through the real HTTP result parser', async () => {
  const requests = new Map<string, string>();
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    expect(body.path).toBe('sessionSharing:requestFromCli');
    const { requestId } = body.args[0] as { requestId: string };
    if (!requests.has(requestId)) requests.set(requestId, `server-${requests.size + 1}`);
    return Response.json({
      status: 'success',
      value: { requestId, shareRequestId: requests.get(requestId), status: 'pending' },
    });
  });
  const port = createCloudSessionSharingPort({
    authBaseUrl: 'https://share-fixture.convex.cloud',
    token: 'synthetic-cli-token',
  });
  const input = {
    workspaceId: 'workspace',
    requestId: 'client-retry-key',
    requesterUserId: 'alice',
    sourceSessionId: 'root',
    sourceTurnId: 'turn',
    sessionIds: ['root'],
  };
  const first = await port.request(input);
  expect(first).toEqual({
    requestId: 'client-retry-key',
    shareRequestId: 'server-1',
    status: 'pending',
  });
  expect(await port.request({ ...input, requestId: first.requestId })).toEqual(first);
  expect(requests.size).toBe(1);
});

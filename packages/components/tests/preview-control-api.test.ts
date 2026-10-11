import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewControlIntent } from '@lody/shared';
import { installCloudHttpPort } from '../src/lib/cloud-http-port';
import { mintPreviewControlProof } from '../src/lib/preview-control-api';

const intent: PreviewControlIntent = {
  workspaceId: 'workspace',
  machineId: 'machine',
  sessionId: 'session',
  requesterUserId: 'owner',
  runtimeNonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  operation: { action: 'status', renewEndpointId: 'endpoint' },
};
let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.unstubAllGlobals();
});

describe('preview control proof minting', () => {
  it('keeps login credentials on the authenticated HTTP channel and returns only the narrow proof', async () => {
    uninstall = installCloudHttpPort({ authBaseUrl: 'https://auth.test', serverBaseUrl: null });
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      expect(url.href).toBe('https://auth.test/api/session-preview/request-token');
      const request = new Request(url, init);
      expect(request.headers.get('Authorization')).toBe('Bearer private-session');
      const { requesterUserId: _user, ...body } = intent;
      expect(await request.json()).toEqual(body);
      return Response.json({ requesterUserId: 'owner', requestToken: 'signed-operation' });
    });
    expect(await mintPreviewControlProof(intent, 'private-session')).toEqual({
      runtimeNonce: intent.runtimeNonce,
      requestId: intent.requestId,
      requestToken: 'signed-operation',
    });
  });

  it('fails closed for local-only composition, missing login, identity changes and backend errors', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('Unexpected cloud request');
    });
    await expect(mintPreviewControlProof(intent, 'session')).rejects.toThrow();
    uninstall = installCloudHttpPort({ authBaseUrl: 'https://auth.test', serverBaseUrl: null });
    await expect(mintPreviewControlProof(intent, null)).rejects.toThrow('Sign in');
    vi.stubGlobal('fetch', async () =>
      Response.json({ requesterUserId: 'other', requestToken: 'signed-operation' })
    );
    await expect(mintPreviewControlProof(intent, 'session')).rejects.toThrow('identity changed');
    vi.stubGlobal('fetch', async () => new Response('private diagnostic', { status: 503 }));
    await expect(mintPreviewControlProof(intent, 'session')).rejects.toThrow(
      'Preview authorization failed (503)'
    );
  });
});

it('validates simulator intents locally and diagnoses an older authorization service without retrying', async () => {
  uninstall = installCloudHttpPort({ authBaseUrl: 'https://auth.test', serverBaseUrl: null });
  const { PreviewControlIntentSchema } = await import('@lody/shared');
  const { createRpcSecretRecipient } = await import('@lody/loro-streams-rpc');
  const recipient = await createRpcSecretRecipient();
  const simulator = {
    ...intent,
    operation: {
      action: 'ios-simulator' as const,
      command: { action: 'list' as const },
      responseKey: recipient.publicKey,
    },
  };
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    expect(PreviewControlIntentSchema.parse({ ...request, requesterUserId: 'owner' })).toEqual(
      simulator
    );
    calls.push(request);
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  });
  await expect(mintPreviewControlProof(simulator, 'session')).rejects.toThrow(
    'Update the connected Cloud backend'
  );
  expect(calls).toHaveLength(1);
  await expect(
    mintPreviewControlProof({ ...simulator, runtimeNonce: 'invalid' }, 'session')
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

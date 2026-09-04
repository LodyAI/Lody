import { describe, expect, it, vi } from 'vitest';
import { verifyPreviewRequestWithCloud } from './preview-authorization';

const request = {
  workspaceId: 'workspace-1',
  machineId: 'machine-1',
  sessionId: 'session-1',
  requesterUserId: 'user-2',
  requestId: 'request-1',
  requestToken: 'signed-token',
  target: { protocol: 'http' as const, host: 'localhost', port: 5173 },
  replaceExisting: false,
  localProjectId: 'project-1',
};

describe('verifyPreviewRequestWithCloud', () => {
  it('sends the daemon credential and accepts a matching signed requester', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ valid: true, requesterUserId: 'user-2' }), { status: 200 })
    );

    await expect(
      verifyPreviewRequestWithCloud({
        siteUrl: 'https://auth.example.test',
        cliToken: 'cli-token',
        request,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ outcome: 'allowed' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://auth.example.test/api/session-preview/verify',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer cli-token' }),
        body: JSON.stringify(request),
      })
    );
  });

  it('fails closed when the attested requester does not match', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ valid: true, requesterUserId: 'forged-user' }), {
          status: 200,
        })
    );

    await expect(
      verifyPreviewRequestWithCloud({
        siteUrl: 'https://auth.example.test',
        cliToken: 'cli-token',
        request,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ outcome: 'denied', reason: 'not_visible' });
  });

  it('distinguishes definitive denial from retryable auth and transport failures', async () => {
    const denied = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const unauthorized = vi.fn(async () => new Response('expired', { status: 401 }));
    const unavailable = vi.fn(async () => new Response('down', { status: 503 }));

    await expect(
      verifyPreviewRequestWithCloud({
        siteUrl: 'https://auth.example.test',
        cliToken: 'cli-token',
        request,
        fetchImpl: denied as typeof fetch,
      })
    ).resolves.toEqual({ outcome: 'denied', reason: 'not_visible' });
    await expect(
      verifyPreviewRequestWithCloud({
        siteUrl: 'https://auth.example.test',
        cliToken: 'cli-token',
        request,
        fetchImpl: unauthorized as typeof fetch,
      })
    ).resolves.toMatchObject({ outcome: 'indeterminate', cause: 'auth' });
    await expect(
      verifyPreviewRequestWithCloud({
        siteUrl: 'https://auth.example.test',
        cliToken: 'cli-token',
        request,
        fetchImpl: unavailable as typeof fetch,
      })
    ).resolves.toMatchObject({ outcome: 'indeterminate', cause: 'network' });
  });
});

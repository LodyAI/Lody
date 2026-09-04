import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintPreviewRequestToken } from '../src/lib/preview-authorization-api';
import { installCloudHttpPort } from '../src/lib/cloud-http-port';

let uninstallCloudHttpPort: (() => void) | undefined;

beforeEach(() => {
  uninstallCloudHttpPort = installCloudHttpPort({
    authBaseUrl: 'https://auth.example.com',
    serverBaseUrl: null,
  });
});

describe('mintPreviewRequestToken', () => {
  afterEach(() => {
    uninstallCloudHttpPort?.();
    uninstallCloudHttpPort = undefined;
    vi.restoreAllMocks();
  });

  it('sends every signed preview field and uses the backend-derived requester', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ requestToken: 'signed-preview', requesterUserId: 'user-2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(
      mintPreviewRequestToken({
        workspaceId: 'workspace-1',
        machineId: 'machine-1',
        sessionId: 'session-1',
        target: { protocol: 'http', host: '127.0.0.1', port: 5173, path: '/app' },
        replaceExisting: true,
        expectedGrantId: 'grant-1',
        requestId: 'request-1',
        localProjectId: 'project-1',
        sessionToken: 'browser-session',
        authBaseUrl: 'https://auth.example.com/',
      })
    ).resolves.toEqual({
      ok: true,
      requestToken: 'signed-preview',
      requesterUserId: 'user-2',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.example.com/api/session-preview/request-token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer browser-session' }),
        body: JSON.stringify({
          workspaceId: 'workspace-1',
          machineId: 'machine-1',
          sessionId: 'session-1',
          target: { protocol: 'http', host: '127.0.0.1', port: 5173, path: '/app' },
          replaceExisting: true,
          expectedGrantId: 'grant-1',
          requestId: 'request-1',
          localProjectId: 'project-1',
        }),
      })
    );
  });

  it('fails before fetch without an authenticated browser session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(
      mintPreviewRequestToken({
        workspaceId: 'workspace-1',
        machineId: 'machine-1',
        sessionId: 'session-1',
        target: { protocol: 'http', host: '127.0.0.1', port: 5173 },
        replaceExisting: false,
        requestId: 'request-1',
        sessionToken: ' ',
        authBaseUrl: 'https://auth.example.com',
      })
    ).resolves.toEqual({ ok: false, error: 'not_authenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

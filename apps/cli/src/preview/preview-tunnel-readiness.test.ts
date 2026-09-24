import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewTarget } from '@lody/shared';
import {
  verifyPreviewTunnelRoundTrip,
  PREVIEW_PROXY_RESPONSE_HEADER,
  PREVIEW_PROXY_RESPONSE_VERSION,
  VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER,
  VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION,
} from './preview-tunnel-readiness';

const target: PreviewTarget = {
  protocol: 'http',
  host: '127.0.0.1',
  port: 5173,
};

describe('verifyPreviewTunnelRoundTrip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('validates the target path through the public route and preserves capability parameters', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<html></html>', {
          headers: {
            [VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER]: VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION,
          },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await verifyPreviewTunnelRoundTrip({
      publicUrl:
        'https://session-grant.lody.uk/?__lody_preview_token=secret&viewer_scope=workspace',
      target: { ...target, path: '/docs?tab=api' },
    });

    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.pathname).toBe('/docs');
    expect(requestedUrl.searchParams.get('tab')).toBe('api');
    expect(requestedUrl.searchParams.get('__lody_preview_token')).toBe('secret');
    expect(requestedUrl.searchParams.get('viewer_scope')).toBe('workspace');
  });

  it('keeps capability parameters while following preview-origin redirects', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://session-grant.lody.uk/login?next=%2Fdocs' },
        })
      )
      .mockResolvedValueOnce(
        new Response('<html></html>', {
          headers: {
            [VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER]: VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION,
          },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://session-grant.lody.uk/?__lody_preview_token=secret',
      target,
    });

    const redirectedUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(redirectedUrl.pathname).toBe('/login');
    expect(redirectedUrl.searchParams.get('next')).toBe('/docs');
    expect(redirectedUrl.searchParams.get('__lody_preview_token')).toBe('secret');
  });

  it.each([200, 404, 500])(
    'accepts a forwarded HTTP %i page without an annotation runtime',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('plain page', {
              status,
              headers: { [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION },
            })
        )
      );
      await expect(
        verifyPreviewTunnelRoundTrip({
          publicUrl: 'https://session-grant.lody.uk/?__lody_preview_token=secret',
          target,
        })
      ).resolves.toBeUndefined();
    }
  );

  it('fails explicitly when wildcard traffic does not reach the Preview Worker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('error code: 522', {
            status: 522,
            headers: { server: 'cloudflare' },
          })
      )
    );

    await expect(
      verifyPreviewTunnelRoundTrip({
        publicUrl: 'https://session-grant.lody.uk/?__lody_preview_token=secret',
        target,
      })
    ).rejects.toThrow(
      'Preview public route round-trip failed for session-grant.lody.uk: HTTP 522 did not return the preview proxy marker'
    );
  });
});

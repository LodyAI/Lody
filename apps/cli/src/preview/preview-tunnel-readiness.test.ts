import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewTarget } from '@lody/shared';
import {
  verifyPreviewTunnelRoundTrip,
  PREVIEW_PROXY_RESPONSE_HEADER,
  PREVIEW_PROXY_RESPONSE_VERSION,
} from './preview-tunnel-readiness';

const target: PreviewTarget = {
  protocol: 'http',
  host: '127.0.0.1',
  port: 5173,
};

describe('verifyPreviewTunnelRoundTrip', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('validates the target path through the public route and preserves capability parameters', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<html></html>', {
          headers: {
            [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION,
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
            [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION,
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

  it('fails explicitly when public traffic does not reach the proxy', async () => {
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

  it('waits for transient DNS propagation but never retries an authorization failure', async () => {
    vi.useFakeTimers();
    const dns = Object.assign(new Error('not resolved'), { code: 'ENOTFOUND' });
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed', { cause: dns });
      return new Response('ok', {
        headers: { [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION },
      });
    });
    const ready = verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://test.trycloudflare.com/?__lody_preview_token=secret',
      target,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(ready).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    vi.stubGlobal('fetch', async () => new Response('no', { status: 403 }));
    await expect(
      verifyPreviewTunnelRoundTrip({ publicUrl: 'https://test.trycloudflare.com', target })
    ).rejects.toThrow('HTTP 403');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops retrying at its deadline and never publishes a route without a proxy marker', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('no DNS'), { code: 'ENOTFOUND' });
    });
    const ready = verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://test.trycloudflare.com',
      target,
    });
    const failure = expect(ready).rejects.toThrow('round-trip failed');
    await vi.advanceTimersByTimeAsync(20_000);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails an active health check immediately without applying startup propagation retries', async () => {
    vi.useFakeTimers();
    const pending = verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://test.trycloudflare.com/?__lody_preview_token=secret',
      target,
      mode: 'health',
      fetch: async () =>
        new Response('Tunnel unavailable', { status: 503, headers: { server: 'cloudflare' } }),
    });
    await expect(pending).rejects.toThrow('HTTP 503');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a silent active-route failure to five seconds', async () => {
    vi.useFakeTimers();
    const pending = verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://test.trycloudflare.com/?__lody_preview_token=secret',
      target,
      mode: 'health',
      fetch: async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    });
    const failure = expect(pending).rejects.toThrow('5000 ms limit');
    await vi.advanceTimersByTimeAsync(5_000);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
});

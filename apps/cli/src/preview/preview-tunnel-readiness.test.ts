import { Resolver } from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => {
    vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['203.0.113.1']);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('avoids poisoning hostname caches before DNS publication and edge registration', async () => {
    vi.useFakeTimers();
    let published = false;
    let connected = false;
    let poisoned = false;
    let settled = false;
    const registration = Promise.withResolvers<void>();
    vi.mocked(Resolver.prototype.resolve4).mockImplementation(async () => {
      if (!published) throw Object.assign(new Error('not published'), { code: 'ENOTFOUND' });
      return ['203.0.113.1'];
    });
    const ready = verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://test.trycloudflare.com/?__lody_preview_token=secret',
      target,
      registered: registration.promise,
      fetch: async () => {
        if (!published || !connected) poisoned = true;
        if (poisoned) throw Object.assign(new Error('negative cache'), { code: 'ECONNRESET' });
        return new Response(null, {
          headers: { [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION },
        });
      },
    }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    published = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    connected = true;
    registration.resolve();
    await ready;
    expect(poisoned).toBe(false);
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancel', 'deadline', 'exit'])(
    'releases a pending registration and DNS query on %s',
    async (reason) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const registration = Promise.withResolvers<void>();
      const dns = Promise.withResolvers<string[]>();
      let cancelled = false;
      vi.mocked(Resolver.prototype.resolve4).mockReturnValue(dns.promise);
      vi.spyOn(Resolver.prototype, 'cancel').mockImplementation(() => {
        cancelled = true;
        dns.reject(Object.assign(new Error('DNS cancelled'), { code: 'ECANCELLED' }));
      });
      const ready = verifyPreviewTunnelRoundTrip({
        publicUrl: 'https://test.trycloudflare.com',
        target,
        registered: registration.promise,
        signal: controller.signal,
        fetch: async () => {
          throw new Error('HTTP must not start');
        },
      });
      const failure = expect(ready).rejects.toThrow(
        reason === 'deadline' ? '90000 ms limit' : reason
      );
      if (reason === 'deadline') await vi.advanceTimersByTimeAsync(90_000);
      else if (reason === 'exit') registration.reject(new Error('exit'));
      else controller.abort(new Error('cancel'));
      await failure;
      expect(cancelled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(['cancel', 'deadline'])(
    'settles on %s after DNS completes while registration is still pending',
    async (reason) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const registration = Promise.withResolvers<void>();
      let failure: unknown;
      const ready = verifyPreviewTunnelRoundTrip({
        publicUrl: 'https://test.trycloudflare.com',
        target,
        registered: registration.promise,
        signal: controller.signal,
        fetch: async () => {
          throw new Error('HTTP must not start');
        },
      }).catch((error: unknown) => {
        failure = error;
      });
      try {
        // Complete DNS before cancellation: DNS can no longer reject Promise.all.
        await vi.advanceTimersByTimeAsync(0);
        if (reason === 'deadline') await vi.advanceTimersByTimeAsync(90_000);
        else {
          controller.abort(new Error('cancel'));
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain(
          reason === 'deadline' ? '90000 ms limit' : 'cancel'
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        registration.resolve();
        await ready;
      }
    }
  );

  it('retains HTTP proxy support when configured DNS servers cannot be reached', async () => {
    vi.mocked(Resolver.prototype.resolve4).mockRejectedValue(
      Object.assign(new Error('blocked DNS'), { code: 'ETIMEOUT' })
    );
    await expect(
      verifyPreviewTunnelRoundTrip({
        publicUrl: 'https://test.trycloudflare.com',
        target,
        fetch: async () =>
          new Response(null, {
            headers: { [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION },
          }),
      })
    ).resolves.toBeUndefined();
  });

  it.each(['ENOTFOUND', 'ENODATA', 'empty'])(
    'falls back to the authenticated public route after bounded local DNS negatives: %s',
    async (code) => {
      vi.useFakeTimers();
      vi.mocked(Resolver.prototype.resolve4).mockImplementation(async () => {
        if (code === 'empty') return [];
        throw Object.assign(new Error('local filtering DNS'), { code });
      });
      const controller = new AbortController();
      let ready = false;
      const result = verifyPreviewTunnelRoundTrip({
        publicUrl: 'https://test.trycloudflare.com',
        target,
        signal: controller.signal,
        registered: Promise.resolve(),
        fetch: async () =>
          new Response(null, {
            headers: { [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION },
          }),
      }).then(() => {
        ready = true;
      });
      void result.catch(() => {});
      try {
        await vi.advanceTimersByTimeAsync(9_999);
        expect(ready).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(ready).toBe(true);
        await result;
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort(new Error('test cleanup'));
        await result.catch(() => {});
      }
    }
  );

  it('still requires the authenticated marker after the DNS publication budget expires', async () => {
    vi.useFakeTimers();
    vi.mocked(Resolver.prototype.resolve4).mockRejectedValue(
      Object.assign(new Error('local filtering DNS'), { code: 'ENOTFOUND' })
    );
    const result = verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://test.trycloudflare.com',
      target,
      registered: Promise.resolve(),
      fetch: async () => new Response('denied', { status: 403 }),
    });
    const rejected = expect(result).rejects.toThrow('HTTP 403');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an in-flight DNS query at its budget but still waits for edge registration', async () => {
    vi.useFakeTimers();
    const dns = Promise.withResolvers<string[]>();
    const registered = Promise.withResolvers<void>();
    let cancelled = false;
    let ready = false;
    vi.mocked(Resolver.prototype.resolve4).mockReturnValue(dns.promise);
    vi.spyOn(Resolver.prototype, 'cancel').mockImplementation(() => {
      cancelled = true;
      dns.reject(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }));
    });
    const result = verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://test.trycloudflare.com',
      target,
      registered: registered.promise,
      fetch: async () =>
        new Response(null, {
          headers: { [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION },
        }),
    }).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cancelled).toBe(true);
    expect(ready).toBe(false);
    registered.resolve();
    await result;
    expect(ready).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never waits for DNS publication or registration during active health checks', async () => {
    vi.useFakeTimers();
    vi.mocked(Resolver.prototype.resolve4).mockReturnValue(new Promise(() => {}));
    await expect(
      verifyPreviewTunnelRoundTrip({
        publicUrl: 'https://test.trycloudflare.com',
        target,
        mode: 'health',
        registered: new Promise(() => {}),
        fetch: async () =>
          new Response(null, {
            headers: { [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION },
          }),
      })
    ).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
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

  it('accepts a forwarded error page without an annotation runtime', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('plain page', {
            status: 500,
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

  it('accepts the same route when propagation takes 65 seconds', async () => {
    vi.useFakeTimers();
    let reachable = false;
    let settled = false;
    const ready = verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://test.trycloudflare.com',
      target,
      fetch: async () => {
        if (!reachable)
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('TLS reset'), { code: 'ECONNRESET' }),
          });
        return new Response(null, {
          headers: { [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION },
        });
      },
    }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(settled).toBe(false);
    reachable = true;
    await vi.advanceTimersByTimeAsync(500);
    await ready;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ENETUNREACH', 'EHOSTUNREACH', 'aggregate'])(
    'recovers from %s after the DNS budget without replacing the tunnel',
    async (kind) => {
      vi.useFakeTimers();
      vi.mocked(Resolver.prototype.resolve4).mockRejectedValue(
        Object.assign(new Error('not yet published'), { code: 'ENOTFOUND' })
      );
      const unreachable = Object.assign(new Error('secret URL'), {
        code: kind === 'aggregate' ? 'ENETUNREACH' : kind,
        address: '2001:db8::1',
      });
      const cause =
        kind === 'aggregate'
          ? new AggregateError(
              [
                unreachable,
                Object.assign(new Error('secret'), {
                  code: 'ETIMEDOUT',
                  address: '192.0.2.1',
                }),
              ],
              'secret aggregate'
            )
          : unreachable;
      let reachable = false;
      let ready = false;
      const diagnostics: string[] = [];
      const result = verifyPreviewTunnelRoundTrip({
        publicUrl: 'https://test.trycloudflare.com/?__lody_preview_token=secret',
        target,
        registered: Promise.resolve(),
        onDiagnostic: (message) => diagnostics.push(message),
        fetch: async () => {
          if (!reachable) throw new TypeError('secret fetch', { cause });
          return new Response(null, {
            headers: {
              [PREVIEW_PROXY_RESPONSE_HEADER]: PREVIEW_PROXY_RESPONSE_VERSION,
            },
          });
        },
      }).then(() => {
        ready = true;
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(ready).toBe(false);
      reachable = true;
      await vi.advanceTimersByTimeAsync(500);
      await result;
      expect(ready).toBe(true);
      expect(diagnostics.join('\n')).toContain('IPv6 2001:db8::1');
      if (kind === 'aggregate') expect(diagnostics.join('\n')).toContain('IPv4 192.0.2.1');
      expect(diagnostics.join('\n')).not.toContain('secret');
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('does not retry an aggregate containing a permanent TLS failure', async () => {
    vi.useFakeTimers();
    const result = verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://test.trycloudflare.com',
      target,
      fetch: async () => {
        throw new TypeError('fetch failed', {
          cause: new AggregateError([
            Object.assign(new Error('secret unreachable'), {
              code: 'ENETUNREACH',
              address: 'fe80::1%secret',
            }),
            Object.assign(new Error('secret certificate'), {
              code: 'CERT_HAS_EXPIRED',
              address: 'https://secret.test/?token=secret',
            }),
          ]),
        });
      },
    });
    await expect(result).rejects.toThrow('CERT_HAS_EXPIRED');
    await expect(result).rejects.not.toThrow('secret');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancel', 'deadline', 'health'])(
    'bounds persistent network unreachability on %s',
    async (mode) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const result = verifyPreviewTunnelRoundTrip({
        publicUrl: 'https://test.trycloudflare.com',
        target,
        signal: controller.signal,
        mode: mode === 'health' ? 'health' : 'readiness',
        fetch: async () => {
          throw Object.assign(new Error('unreachable'), { code: 'ENETUNREACH' });
        },
      });
      const rejected = expect(result).rejects.toThrow(
        mode === 'cancel'
          ? 'user cancelled'
          : mode === 'deadline'
            ? '90000 ms limit'
            : 'ENETUNREACH'
      );
      if (mode === 'deadline') await vi.advanceTimersByTimeAsync(90_000);
      if (mode === 'cancel') {
        await vi.advanceTimersByTimeAsync(1_000);
        controller.abort(new Error('user cancelled'));
      }
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('cancels propagation immediately without waiting for the extended deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const ready = verifyPreviewTunnelRoundTrip({
      publicUrl: 'https://test.trycloudflare.com',
      target,
      signal: controller.signal,
      fetch: async () => new Response(null, { status: 530, headers: { server: 'cloudflare' } }),
    });
    const failure = expect(ready).rejects.toThrow('user cancelled');
    await vi.advanceTimersByTimeAsync(65_000);
    controller.abort(new Error('user cancelled'));
    await failure;
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
    await vi.advanceTimersByTimeAsync(90_000);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ECONNRESET', 'HTTP 530'])(
    'retains the last %s failure without leaking request credentials',
    async (failureKind) => {
      vi.useFakeTimers();
      const diagnostics: string[] = [];
      const ready = verifyPreviewTunnelRoundTrip({
        publicUrl: 'https://test.trycloudflare.com/?__lody_preview_token=secret',
        target,
        onDiagnostic: (message) => diagnostics.push(message),
        fetch: async () => {
          if (failureKind === 'HTTP 530')
            return new Response('secret response', {
              status: 530,
              headers: { server: 'cloudflare' },
            });
          throw new TypeError('fetch failed with secret', {
            cause: Object.assign(new Error('secret request URL'), { code: 'ECONNRESET' }),
          });
        },
      });
      const failure = ready.catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(90_000);
      const error = await failure;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('90000 ms limit');
      expect((error as Error).message).toContain(`lastOutcome=${failureKind}`);
      expect((error as Error).message).toMatch(/attempts=[1-9]/);
      expect([...diagnostics, (error as Error).message].join('\n')).not.toContain('secret');
      expect(vi.getTimerCount()).toBe(0);
    }
  );

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

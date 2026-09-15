import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewTarget } from '@lody/shared';
import {
  buildInjectedHtmlHeaders,
  buildLocalPreviewRequestHeaders,
  headersToEntries,
  maybeInjectVisualAnnotationRuntime,
  startPreviewTunnel,
} from './preview-tunnel-client';
import {
  VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER,
  VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION,
} from './preview-tunnel-readiness';

const createRequest = {
  workspaceId: 'workspace-preview',
  machineId: 'machine-preview',
  sessionId: 'session-preview',
  grantId: 'grant-preview',
  approvedByUserId: 'user-preview',
  leaseExpiresAt: 1_800_000_000_000,
  idleTimeoutMs: 45 * 60_000,
} as const;

const target: PreviewTarget = {
  protocol: 'http',
  host: '127.0.0.1',
  port: 5173,
};

describe('startPreviewTunnel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('includes status, content type, and body snippet when create returns non-JSON', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('<html><body>preview gateway returned a login page</body></html>', {
        status: 201,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      startPreviewTunnel({
        gatewayUrl: 'https://preview.example.com',
        authToken: 'auth-token',
        createRequest,
        target,
      })
    ).rejects.toThrow(
      /Received an invalid preview tunnel create response\. \(HTTP 201, content-type text\/html; charset=utf-8\)\. Response body: <html><body>preview gateway returned a login page<\/body><\/html>/
    );
  });

  it('redacts tunnel tokens from invalid create response details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            tunnelId: 'preview-tunnel',
            publicUrl: 'https://preview.example.com/?__lody_preview_token=preview-secret-token',
            sessionToken: 'session-secret-token',
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }
        );
      })
    );

    const error = await startPreviewTunnel({
      gatewayUrl: 'https://preview.example.com',
      authToken: 'auth-token',
      createRequest,
      target,
    }).catch((reason: unknown) => {
      if (!(reason instanceof Error)) {
        throw reason;
      }
      return reason;
    });

    expect(error.message).toMatch(/__lody_preview_token=\*\*\*/);
    expect(error.message).not.toMatch(/preview-secret-token|session-secret-token/);
  });

  it('rejects oversized HTML before visual annotation injection', async () => {
    const html = '<html><body>large preview document</body></html>';

    await expect(
      maybeInjectVisualAnnotationRuntime(
        new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
        'GET',
        Buffer.byteLength(html, 'utf8') - 1
      )
    ).rejects.toThrow(/Preview response exceeds \d+ byte limit/);
  });

  it('preserves the page when only optional injection would exceed the body limit', async () => {
    const html = '<html><body>small preview document</body></html>';
    const result = await maybeInjectVisualAnnotationRuntime(
      new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
      'GET',
      Buffer.byteLength(html, 'utf8')
    );
    expect(Buffer.from(result?.body ?? []).toString('utf8')).toBe(html);
    expect(result?.runtimeInjected).toBe(false);
    const headers = buildInjectedHtmlHeaders(
      new Headers({ 'content-security-policy': "script-src 'self'" }),
      Buffer.byteLength(html),
      false
    );
    expect(headers.get('x-lody-preview-runtime')).toBeNull();
    expect(headers.get('content-security-policy')).toBe("script-src 'self'");
  });

  it('requests identity encoding from local preview servers so HTML can be annotated', () => {
    const headers = buildLocalPreviewRequestHeaders([
      ['accept-encoding', 'gzip, br'],
      ['host', 'preview.example.com'],
      ['if-none-match', '"cached-html"'],
      ['if-modified-since', 'Tue, 05 May 2026 00:00:00 GMT'],
      ['referer', 'http://127.0.0.1:61234/?__lody_local_preview_token=secret'],
      ['x-preview-test', 'kept'],
    ]);

    expect(headers.get('accept-encoding')).toBe('identity');
    expect(headers.get('host')).toBeNull();
    expect(headers.get('if-none-match')).toBeNull();
    expect(headers.get('if-modified-since')).toBeNull();
    expect(headers.get('referer')).toBeNull();
    expect(headers.get('x-preview-test')).toBe('kept');
  });

  it('rewrites same-preview-origin referers for local preview proxy requests', () => {
    const headers = buildLocalPreviewRequestHeaders(
      [
        [
          'referer',
          'http://127.0.0.1:61234/DownloadPage.vue?vue&type=style&index=0&lang.css&__lody_local_preview_token=secret#section',
        ],
        ['x-preview-test', 'kept'],
      ],
      {
        localOrigin: new URL('http://127.0.0.1:5173'),
        previewOrigin: new URL('http://127.0.0.1:61234'),
        localPreviewTokenQueryParam: '__lody_local_preview_token',
      }
    );

    expect(headers.get('referer')).toBe(
      'http://127.0.0.1:5173/DownloadPage.vue?vue&type=style&index=0&lang.css#section'
    );
    expect(headers.get('x-preview-test')).toBe('kept');
  });

  it('does not forward cross-origin referers for local preview proxy requests', () => {
    const headers = buildLocalPreviewRequestHeaders([['referer', 'https://attacker.example/app']], {
      localOrigin: new URL('http://127.0.0.1:5173'),
      previewOrigin: new URL('http://127.0.0.1:61234'),
      localPreviewTokenQueryParam: '__lody_local_preview_token',
    });

    expect(headers.get('referer')).toBeNull();
  });

  it('inlines the visual annotation runtime into decoded compressed HTML responses', async () => {
    const html = '<html><body>small preview document</body></html>';
    const injected = await maybeInjectVisualAnnotationRuntime(
      new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'gzip',
        },
      }),
      'GET',
      Buffer.byteLength(html, 'utf8') + 100_000
    );

    const injectedHtml = Buffer.from(injected?.body ?? new Uint8Array()).toString('utf8');
    expect(injectedHtml).toContain('data-lody-visual-annotation-runtime="true"');
    expect(injectedHtml).toContain('data-lody-visual-annotation-overlay');
    expect(injectedHtml).toContain('window.__lodyVisualCommentInspector');
  });

  it('removes stale compression metadata from decoded asset responses', () => {
    const headers = headersToEntries(
      new Headers({
        'content-encoding': 'br',
        'content-length': '128',
        'content-type': 'application/javascript',
        etag: '"asset-v1"',
      })
    );

    expect(new Headers(headers).get('content-encoding')).toBeNull();
    expect(new Headers(headers).get('content-length')).toBeNull();
    expect(new Headers(headers).get('content-type')).toBe('application/javascript');
    expect(new Headers(headers).get('etag')).toBe('"asset-v1"');
  });

  it('marks injected HTML responses for end-to-end tunnel validation', () => {
    const headers = buildInjectedHtmlHeaders(
      new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      123
    );

    expect(headers.get(VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER)).toBe(
      VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION
    );
  });
});

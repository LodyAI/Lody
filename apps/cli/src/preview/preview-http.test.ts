import { describe, expect, it } from 'vitest';
import {
  buildInjectedHtmlHeaders,
  buildLocalPreviewRequestHeaders,
  headersToEntries,
  maybeInjectVisualAnnotationRuntime,
} from './preview-http';
import {
  VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER,
  VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION,
} from './preview-tunnel-readiness';

describe('preview HTTP forwarding and annotation', () => {
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

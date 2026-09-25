import { describe, expect, it } from 'vitest';
import { buildInjectedHtmlHeaders, maybeInjectVisualAnnotationRuntime } from './preview-http';

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
});

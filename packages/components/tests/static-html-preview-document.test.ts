// @vitest-environment jsdom

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { STATIC_HTML_PREVIEW_DOCUMENT_MARKER } from '@lody/shared';

import {
  buildStaticHtmlPreviewDocument,
  buildReadOnlyHtmlPreviewDocument,
  STATIC_HTML_PREVIEW_CONTENT_SECURITY_POLICY,
} from '../src/components/sessions/static-html-preview-document';

describe('static HTML preview document', () => {
  it('installs the owned policy and annotation runtime before source scripts', () => {
    const preview = buildStaticHtmlPreviewDocument(`<!doctype html>
      <html>
        <head>
          <meta http-equiv="content-security-policy" content="default-src *">
          <meta http-equiv="refresh" content="0;url=https://example.com">
          <meta name="referrer" content="unsafe-url">
          <base href="https://example.com/">
          <script data-source-script>window.sourceScript = true</script>
        </head>
        <body><h1>Agent result</h1></body>
      </html>`);
    const document = new DOMParser().parseFromString(preview, 'text/html');
    const headElements = [...document.head.children];

    expect(document.documentElement.getAttribute(STATIC_HTML_PREVIEW_DOCUMENT_MARKER)).toBe('true');
    expect(headElements[0]).toMatchObject({
      httpEquiv: 'Content-Security-Policy',
      content: STATIC_HTML_PREVIEW_CONTENT_SECURITY_POLICY,
    });
    expect(headElements[1]).toMatchObject({ name: 'referrer', content: 'no-referrer' });
    expect(headElements[2]).toMatchObject({ href: 'https://html-file-preview.invalid/' });
    expect(headElements[3]?.getAttribute('data-lody-visual-annotation-runtime')).toBe('true');
    expect(headElements[4]?.getAttribute('data-source-script')).not.toBeNull();
    expect(document.querySelectorAll('meta[http-equiv="content-security-policy" i]')).toHaveLength(
      1
    );
    expect(document.querySelector('meta[http-equiv="refresh" i]')).toBeNull();
    expect(document.querySelectorAll('meta[name="referrer" i]')).toHaveLength(1);
    expect(document.querySelectorAll('base')).toHaveLength(1);
    expect(document.querySelector('h1')?.textContent).toBe('Agent result');
    expect(document.querySelector('script[data-lody-visual-annotation-runtime="true"]')).not.toBe(
      null
    );
  });

  it('preserves layout while removing executable and navigable content for a readonly frame', () => {
    const preview = buildReadOnlyHtmlPreviewDocument(`
      <style>h1 { color: red; }</style><h1>Report</h1>
      <script>location = 'https://example.com'</script>
      <meta http-equiv="refresh" content="0;url=https://example.com">
      <a href="https://example.com" onclick="alert(1)">Link</a>
      <svg><a xlink:href="https://example.com">SVG link</a><set attributeName="href" to="https://example.com" /></svg>
      <template shadowrootmode="open"><a href="https://example.com">Shadow link</a></template>
      <iframe srcdoc="<a href='https://example.com'>Link</a>"></iframe>
      <form action="https://example.com"><button formaction="https://example.com">Submit</button></form>
      <img src="data:image/png;base64,AA==">
    `);
    const document = new DOMParser().parseFromString(preview, 'text/html');
    expect(document.querySelector('h1')?.textContent).toBe('Report');
    expect(document.querySelector('style')?.textContent).toContain('color: red');
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(
      document.querySelector(
        'script, template, iframe, set, [href], [onclick], [action], [formaction]'
      )
    ).toBeNull();
    expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(document.head.firstElementChild?.getAttribute('content')).toContain("script-src 'none'");
  });
});

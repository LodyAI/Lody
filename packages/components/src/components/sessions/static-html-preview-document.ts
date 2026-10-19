import {
  STATIC_HTML_PREVIEW_DOCUMENT_MARKER,
  VISUAL_ANNOTATION_INSPECTOR_BROWSER_SCRIPT,
} from '@lody/shared';

const VISUAL_ANNOTATION_RUNTIME_MARKER = 'data-lody-visual-annotation-runtime';

export const STATIC_HTML_PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "worker-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  'base-uri https://html-file-preview.invalid',
].join('; ');

const escapeHtmlScriptContent = (script: string): string =>
  script.replace(/<\/script/giu, '<\\/script');

export function buildStaticHtmlPreviewDocument(sourceHtml: string): string {
  const document = new DOMParser().parseFromString(sourceHtml, 'text/html');
  document.documentElement.setAttribute(STATIC_HTML_PREVIEW_DOCUMENT_MARKER, 'true');

  // The preview owns the policy. Moving it to the first node in <head> makes
  // the restrictions effective before any script from the source document.
  document.querySelectorAll('meta[http-equiv], meta[name], base').forEach((element) => {
    const httpEquiv = element.getAttribute('http-equiv')?.trim().toLowerCase();
    const name = element.getAttribute('name')?.trim().toLowerCase();
    if (
      element.tagName === 'BASE' ||
      httpEquiv === 'content-security-policy' ||
      httpEquiv === 'refresh' ||
      name === 'referrer'
    ) {
      element.remove();
    }
  });
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = STATIC_HTML_PREVIEW_CONTENT_SECURITY_POLICY;
  const referrer = document.createElement('meta');
  referrer.name = 'referrer';
  referrer.content = 'no-referrer';
  const base = document.createElement('base');
  base.href = 'https://html-file-preview.invalid/';

  const runtime = document.createElement('script');
  runtime.setAttribute(VISUAL_ANNOTATION_RUNTIME_MARKER, 'true');
  runtime.textContent = escapeHtmlScriptContent(VISUAL_ANNOTATION_INSPECTOR_BROWSER_SCRIPT);
  document.head.prepend(policy, referrer, base, runtime);

  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

export function getStaticHtmlPreviewLogicalUrl(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/');
  const pathKind = normalizedPath.startsWith('//')
    ? 'windows-unc'
    : /^[a-z]:\//iu.test(normalizedPath)
      ? 'windows-drive-absolute'
      : normalizedPath.startsWith('/')
        ? 'posix-absolute'
        : 'relative';
  const logicalUrl = new URL(`/file/${pathKind}`, 'https://html-file-preview.invalid');
  logicalUrl.searchParams.set('path', filePath);
  return logicalUrl.toString();
}

/** Non-executable preview for engines without credentialless frames.
 * Keep CSS and embedded media, but remove document-driven navigation even when
 * activated by a user. The iframe must also have an empty sandbox permission set.
 */
export function buildReadOnlyHtmlPreviewDocument(sourceHtml: string): string {
  const document = new DOMParser().parseFromString(sourceHtml, 'text/html');
  document
    .querySelectorAll(
      'script, noscript, template, base, meta, iframe, frame, frameset, object, embed, link, animate, animateMotion, animateTransform, set'
    )
    .forEach((element) => element.remove());
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (
        attribute.localName.toLowerCase().startsWith('on') ||
        ['href', 'action', 'formaction', 'srcdoc', 'target', 'autofocus'].includes(
          attribute.localName.toLowerCase()
        )
      )
        element.removeAttributeNode(attribute);
    }
  }
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = STATIC_HTML_PREVIEW_CONTENT_SECURITY_POLICY.replace(
    "script-src 'unsafe-inline'",
    "script-src 'none'"
  );
  const referrer = document.createElement('meta');
  referrer.name = 'referrer';
  referrer.content = 'no-referrer';
  const viewport = document.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  document.head.prepend(policy, referrer, viewport);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

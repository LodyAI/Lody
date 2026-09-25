import { Buffer } from 'node:buffer';
import {
  VISUAL_ANNOTATION_INSPECTOR_BROWSER_SCRIPT,
  removePreviewQueryParamFromSearch,
  type HeaderEntry,
} from '@lody/shared';
import {
  PREVIEW_PROXY_RESPONSE_HEADER,
  PREVIEW_PROXY_RESPONSE_VERSION,
  VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER,
  VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION,
} from './preview-tunnel-readiness';

type LocalPreviewRequestHeaderOptions = {
  localOrigin: URL;
  previewOrigin: URL;
  localPreviewTokenQueryParam: string;
};

const HTTP_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'cf-connecting-ip',
  'forwarded',
  'x-real-ip',
  'x-lody-preview-probe',
]);

const LOCAL_WEBSOCKET_HEADER_EXCLUSIONS = new Set([
  ...HTTP_HOP_BY_HOP_HEADERS,
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
]);

const LOCAL_PREVIEW_REQUEST_HEADER_EXCLUSIONS = new Set([
  ...HTTP_HOP_BY_HOP_HEADERS,
  'if-modified-since',
  'if-none-match',
  'referer',
]);

const LOCAL_RESPONSE_HEADER_EXCLUSIONS = new Set([
  ...HTTP_HOP_BY_HOP_HEADERS,
  'set-cookie',
  'set-cookie2',
]);

const VISUAL_ANNOTATION_INJECTED_MARKER = 'data-lody-visual-annotation-runtime';
const LOCAL_PREVIEW_ACCEPT_ENCODING = 'identity';

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
};

const containsUnsafePathSegment = (value: string): boolean => {
  const pathOnly = value.split(/[?#]/, 1)[0] ?? '';
  for (const segment of pathOnly.split('/')) {
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (
      decodedSegment === '..' ||
      decodedSegment.includes('/') ||
      decodedSegment.includes('\\') ||
      containsControlCharacter(decodedSegment)
    ) {
      return true;
    }
  }
  return false;
};

const containsUnsafeDecodedCharacters = (value: string): boolean => {
  try {
    return containsControlCharacter(decodeURIComponent(value));
  } catch {
    return true;
  }
};

export const assertRelativePreviewPath = (value: string): void => {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    containsControlCharacter(value) ||
    containsUnsafeDecodedCharacters(value) ||
    containsUnsafePathSegment(value) ||
    /^https?:\/\//i.test(value)
  ) {
    throw new Error('Preview tunnel rejected a non-relative request URL.');
  }
};

export const assertBoundLocalUrl = (url: URL, localOrigin: URL): void => {
  if (
    url.protocol !== localOrigin.protocol ||
    url.hostname !== localOrigin.hostname ||
    url.port !== localOrigin.port
  ) {
    throw new Error('Preview tunnel rejected a request outside the bound local origin.');
  }
};

function stripLocalPreviewRequestHeaders(headers: HeaderEntry[]): HeaderEntry[] {
  const connectionHeaders = connectionHeaderNames(headers);
  return headers.filter(
    ([name]) =>
      !LOCAL_PREVIEW_REQUEST_HEADER_EXCLUSIONS.has(name.toLowerCase()) &&
      !connectionHeaders.has(name.toLowerCase()) &&
      !name.toLowerCase().startsWith('x-forwarded-')
  );
}

function connectionHeaderNames(headers: HeaderEntry[]): Set<string> {
  return new Set(
    headers
      .filter(([name]) => name.toLowerCase() === 'connection')
      .flatMap(([, value]) =>
        value
          .toLowerCase()
          .split(',')
          .map((name) => name.trim())
      )
  );
}

function getHeaderValue(headers: HeaderEntry[], headerName: string): string | null {
  const normalizedHeaderName = headerName.toLowerCase();
  const entry = headers.find(([name]) => name.toLowerCase() === normalizedHeaderName);
  return entry?.[1] ?? null;
}

function rewriteLocalPreviewReferer(
  referer: string,
  options: LocalPreviewRequestHeaderOptions
): string | null {
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== options.previewOrigin.origin) {
      return null;
    }
    refererUrl.search = removePreviewQueryParamFromSearch(
      refererUrl.search,
      options.localPreviewTokenQueryParam
    );
    return new URL(
      `${refererUrl.pathname}${refererUrl.search}${refererUrl.hash}`,
      options.localOrigin
    ).toString();
  } catch {
    return null;
  }
}

export function stripLocalWebSocketHeaders(headers: HeaderEntry[]): HeaderEntry[] {
  const connectionHeaders = connectionHeaderNames(headers);
  return headers.filter(
    ([name]) =>
      !LOCAL_WEBSOCKET_HEADER_EXCLUSIONS.has(name.toLowerCase()) &&
      !connectionHeaders.has(name.toLowerCase()) &&
      !name.toLowerCase().startsWith('x-forwarded-')
  );
}

function rewriteLocalRedirectLocation(value: string, localOrigin: URL, previewOrigin: URL): string {
  const locationUrl = new URL(value, localOrigin);
  assertBoundLocalUrl(locationUrl, localOrigin);
  return new URL(
    `${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`,
    previewOrigin
  ).toString();
}

function canInjectVisualAnnotationRuntime(response: Response, method: string): boolean {
  if (method === 'HEAD' || response.body === null) {
    return false;
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/html')) {
    return false;
  }
  return true;
}

export async function maybeInjectVisualAnnotationRuntime(
  response: Response,
  method: string,
  maxResponseBodyBytes: number
): Promise<{ body: Uint8Array; runtimeInjected: boolean } | null> {
  if (!canInjectVisualAnnotationRuntime(response, method)) {
    return null;
  }
  const responseBody = await readResponseBodyBytesWithinLimit(response, maxResponseBodyBytes);
  const html = Buffer.from(responseBody).toString('utf8');
  // Node's fetch transparently decodes compressed responses but preserves the
  // original content-encoding header. If a non-fetch Response still contains
  // encoded bytes, do not append JS to binary data.
  if (response.headers.has('content-encoding') && !looksLikeDecodedHtml(html)) {
    throw new Error('Preview HTML response was not decoded by the HTTP client.');
  }
  if (html.includes(VISUAL_ANNOTATION_INJECTED_MARKER)) {
    return { body: responseBody, runtimeInjected: true };
  }
  const scriptTag = `<script ${VISUAL_ANNOTATION_INJECTED_MARKER}="true">\n${escapeHtmlScriptContent(
    VISUAL_ANNOTATION_INSPECTOR_BROWSER_SCRIPT
  )}\n</script>`;
  const lowerHtml = html.toLowerCase();
  let injectedHtml: Uint8Array;
  const bodyCloseIndex = lowerHtml.lastIndexOf('</body>');
  if (bodyCloseIndex >= 0) {
    injectedHtml = Buffer.from(
      `${html.slice(0, bodyCloseIndex)}${scriptTag}${html.slice(bodyCloseIndex)}`,
      'utf8'
    );
  } else if (lowerHtml.lastIndexOf('</html>') >= 0) {
    const htmlCloseIndex = lowerHtml.lastIndexOf('</html>');
    injectedHtml = Buffer.from(
      `${html.slice(0, htmlCloseIndex)}${scriptTag}${html.slice(htmlCloseIndex)}`,
      'utf8'
    );
  } else {
    injectedHtml = Buffer.from(`${html}${scriptTag}`, 'utf8');
  }
  if (injectedHtml.byteLength > maxResponseBodyBytes) {
    // Optional instrumentation must not reject an otherwise valid response.
    return { body: responseBody, runtimeInjected: false };
  }
  return { body: injectedHtml, runtimeInjected: true };
}

function looksLikeDecodedHtml(value: string): boolean {
  return /<(?:!doctype|html|head|body|script|main|div|section|article|meta|title)\b/i.test(value);
}

export function buildLocalPreviewRequestHeaders(
  headers: HeaderEntry[],
  options?: LocalPreviewRequestHeaderOptions
): Headers {
  const proxyHeaders = new Headers(stripLocalPreviewRequestHeaders(headers));
  const fetchMode = proxyHeaders.get('sec-fetch-mode');
  if (fetchMode === 'navigate' || fetchMode === 'nested-navigate') {
    // Node fetch replaces navigation mode with "cors". Forwarding the browser's
    // cross-site metadata alongside that mode makes Astro reject an otherwise
    // permitted iframe navigation. Treat this hop as a server-side navigation
    // fetch, while retaining metadata on subresources and cross-site Origin.
    for (const name of ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) {
      proxyHeaders.delete(name);
    }
  }
  if (options) {
    // This endpoint represents the local app under one explicitly bound viewer
    // origin. Translate only that same-origin identity, as with Referer below;
    // foreign/opaque/missing origins must retain the app's cross-site checks.
    if (proxyHeaders.get('origin') === options.previewOrigin.origin) {
      proxyHeaders.set('origin', options.localOrigin.origin);
    }
    const rewrittenReferer = rewriteLocalPreviewReferer(getHeaderValue(headers, 'referer') ?? '', {
      localOrigin: options.localOrigin,
      previewOrigin: options.previewOrigin,
      localPreviewTokenQueryParam: options.localPreviewTokenQueryParam,
    });
    if (rewrittenReferer) {
      proxyHeaders.set('referer', rewrittenReferer);
    }
  }
  // Most local dev servers honor this and return plain HTML, which keeps the
  // annotation runtime injectable. Node fetch also decodes gzip/br bodies for
  // servers that ignore it, but avoiding compression is the safer fast path.
  proxyHeaders.set('accept-encoding', LOCAL_PREVIEW_ACCEPT_ENCODING);
  return proxyHeaders;
}

function escapeHtmlScriptContent(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

async function readResponseBodyBytesWithinLimit(
  response: Response,
  maxResponseBodyBytes: number
): Promise<Uint8Array> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let totalByteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value;
      totalByteLength += chunk.byteLength;
      if (totalByteLength > maxResponseBodyBytes) {
        await reader.cancel();
        throw new Error(`Preview response exceeds ${maxResponseBodyBytes} byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return concatUint8Arrays(chunks, totalByteLength);
}

export function buildInjectedHtmlHeaders(
  sourceHeaders: Headers,
  bodyByteLength: number,
  runtimeInjected = true
): Headers {
  const headers = new Headers(sourceHeaders);
  headers.delete('content-encoding');
  headers.delete('content-length');
  if (runtimeInjected) {
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
  }
  headers.delete('etag');
  headers.delete('last-modified');
  headers.set('cache-control', 'no-store');
  headers.set('content-length', String(bodyByteLength));
  headers.delete(VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER);
  if (runtimeInjected) {
    headers.set(
      VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER,
      VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION
    );
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8');
  }
  return headers;
}

export function headersToEntries(
  headers: Headers,
  options?: { localOrigin: URL; previewOrigin: URL }
): HeaderEntry[] {
  const responseHeaders: HeaderEntry[] = [];
  // Undici decodes fetch bodies but retains the local server's compression metadata.
  const bodyWasDecoded = headers.has('content-encoding');
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (
      !LOCAL_RESPONSE_HEADER_EXCLUSIONS.has(lowerName) &&
      lowerName !== PREVIEW_PROXY_RESPONSE_HEADER &&
      !(bodyWasDecoded && (lowerName === 'content-encoding' || lowerName === 'content-length'))
    ) {
      responseHeaders.push([
        name,
        options && lowerName === 'location'
          ? rewriteLocalRedirectLocation(value, options.localOrigin, options.previewOrigin)
          : value,
      ]);
    }
  }
  responseHeaders.push([PREVIEW_PROXY_RESPONSE_HEADER, PREVIEW_PROXY_RESPONSE_VERSION]);
  return responseHeaders;
}

export function buildLocalWebSocketUrl(localOrigin: URL, path: string): string {
  const proxyUrl = new URL(path, localOrigin);
  assertBoundLocalUrl(proxyUrl, localOrigin);
  proxyUrl.protocol = proxyUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return proxyUrl.toString();
}

function concatUint8Arrays(chunks: Uint8Array[], totalByteLength: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array();
  const merged = new Uint8Array(totalByteLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

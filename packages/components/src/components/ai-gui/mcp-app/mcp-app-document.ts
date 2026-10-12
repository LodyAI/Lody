/**
 * The MCP App document policy (SEP-1865 `_meta.ui.csp`). The Electron sandbox
 * origin's response header is only an upper bound; this per-app policy is what
 * actually narrows the app to the origins its resource declared.
 */

const MAX_DOMAINS_PER_DIRECTIVE = 32;
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const SECURE_SOURCE = new RegExp(
  `^(https|wss)://(\\*\\.)?(${HOST_LABEL}(?:\\.${HOST_LABEL})*)(?::(\\d{1,5}))?/?$`,
  'u'
);
// WebSockets fall under connect-src alone; plaintext `http:`/`ws:` is never admitted.
const HTTPS_ONLY: readonly string[] = ['https'];
const HTTPS_OR_WSS: readonly string[] = ['https', 'wss'];

/** Only `scheme://host[:port]` or `scheme://*.host[:port]` with an allowed scheme survive. */
const sanitizeSource = (value: unknown, schemes: readonly string[]): string | null => {
  if (typeof value !== 'string' || value.length > 300) return null;
  const match = SECURE_SOURCE.exec(value.toLowerCase());
  if (!match) return null;
  const [, scheme = '', wildcard, host = '', port] = match;
  if (!schemes.includes(scheme)) return null;
  // `https://*.com` would admit a whole public suffix.
  if (wildcard && !host.includes('.')) return null;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) return null;
  return `${scheme}://${wildcard ?? ''}${host}${port === undefined ? '' : `:${port}`}`;
};

const sanitizeSources = (value: unknown, schemes: readonly string[]): string[] => {
  if (!Array.isArray(value)) return [];
  const sources = new Set<string>();
  for (const entry of value) {
    const source = sanitizeSource(entry, schemes);
    if (source) sources.add(source);
    if (sources.size >= MAX_DOMAINS_PER_DIRECTIVE) break;
  }
  return [...sources];
};

export function buildMcpAppContentSecurityPolicy(csp: unknown): string {
  const declared = (typeof csp === 'object' && csp !== null ? csp : {}) as Record<string, unknown>;
  const resource = sanitizeSources(declared.resourceDomains, HTTPS_ONLY);
  const orNone = (sources: string[]) => (sources.length > 0 ? sources : ["'none'"]);
  return [
    ["default-src 'none'"],
    ["script-src 'unsafe-inline'", ...resource],
    ["style-src 'unsafe-inline'", ...resource],
    ['img-src data:', ...resource],
    ['font-src data:', ...resource],
    ['media-src data:', ...resource],
    ['connect-src', ...orNone(sanitizeSources(declared.connectDomains, HTTPS_OR_WSS))],
    ['frame-src', ...orNone(sanitizeSources(declared.frameDomains, HTTPS_ONLY))],
    ['base-uri', ...orNone(sanitizeSources(declared.baseUriDomains, HTTPS_ONLY))],
    ["object-src 'none'"],
    ["worker-src 'none'"],
    ["form-action 'none'"],
    ["manifest-src 'none'"],
  ]
    .map((parts) => parts.join(' '))
    .join('; ');
}

/** Installs the host policy as the first `<head>` node, ahead of any app script. */
export function buildMcpAppDocument(sourceHtml: string, csp: unknown): string {
  const document = new DOMParser().parseFromString(sourceHtml, 'text/html');
  document.querySelectorAll('meta[http-equiv]').forEach((element) => {
    if (element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') element.remove();
  });
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = buildMcpAppContentSecurityPolicy(csp);
  const referrer = document.createElement('meta');
  referrer.name = 'referrer';
  referrer.content = 'no-referrer';
  document.head.prepend(policy, referrer);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

const decodeBase64Utf8 = (blob: string): string | null => {
  try {
    const bytes = Uint8Array.from(atob(blob), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const htmlRank = (mimeType: unknown): number => {
  if (typeof mimeType !== 'string') return 0;
  const normalized = mimeType.toLowerCase().replace(/\s+/gu, '');
  if (normalized === 'text/html;profile=mcp-app') return 2;
  return normalized === 'text/html' || normalized.startsWith('text/html;') ? 1 : 0;
};

/** Picks the app document from `resources/read` contents, preferring the MCP App profile. */
export function selectMcpAppHtml(
  contents: readonly unknown[]
): { html: string; csp: unknown } | null {
  const candidates = contents
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => htmlRank(item.mimeType) > 0)
    .sort((left, right) => htmlRank(right.mimeType) - htmlRank(left.mimeType));
  const item = candidates[0];
  if (!item) return null;
  const html =
    typeof item.text === 'string'
      ? item.text
      : typeof item.blob === 'string'
        ? decodeBase64Utf8(item.blob)
        : null;
  if (html === null) return null;
  const meta = item._meta as { ui?: { csp?: unknown } } | undefined;
  return { html, csp: meta?.ui?.csp };
}

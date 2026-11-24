/**
 * The MCP Apps sandbox proxy (SEP-1865 "sandbox proxy" handshake).
 *
 * A `srcdoc`, `blob:` or `data:` iframe inherits the renderer's CSP, which has
 * no `'unsafe-inline'`, so an app's inline scripts would never run. A document
 * served from this network-like scheme gets only its own response policy. The
 * renderer frames it with `sandbox="allow-scripts"` (opaque origin), posts the
 * app HTML once the proxy reports ready, and the proxy replaces its own document
 * with it, so the app talks to `window.parent` directly.
 *
 * This header policy is only an upper bound; the renderer injects the per-app
 * policy built from the resource's `_meta.ui.csp` as the first `<head>` node.
 */
export const MCP_APP_SANDBOX_SCHEME = 'lody-mcp-app'

export const MCP_APP_SANDBOX_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: https:',
  'font-src data: https:',
  'media-src data: https:',
  'connect-src https: wss:',
  'frame-src https:',
  'base-uri https:',
  "object-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "manifest-src 'none'"
].join('; ')

/**
 * An opaque origin has no `localStorage`, `sessionStorage` or `document.cookie`:
 * each throws `SecurityError`, which breaks views that expect them. Granting
 * `allow-same-origin` is no fix: with `credentialless`, Chromium keeps every
 * load's nonce-partitioned storage in the default session's LevelDB, beyond the
 * reach of Electron's `clearData`/`clearStorageData`; without it, the view would
 * see the default session's cookies. The proxy therefore installs per-load
 * in-memory replacements before writing the app document; `document.open()`
 * keeps the same `window` and `document`, and with them these properties.
 *
 * Items follow `Storage` semantics: members shadow same-named items, and each
 * store holds at most 5 MiB of key and value characters. Cookies keep only
 * name=value; a past `Expires` or non-positive `Max-Age` deletes one.
 */
const MEMORY_STORAGE_SCRIPT = `(() => {
  const QUOTA = 5 * 1024 * 1024;
  const createStorage = () => {
    const items = new Map();
    let used = 0;
    const setItem = (key, value) => {
      key = String(key);
      value = String(value);
      const previous = items.get(key);
      const next =
        used - (previous === undefined ? 0 : key.length + previous.length) + key.length + value.length;
      if (next > QUOTA) {
        throw new DOMException('The 5 MiB storage quota has been exceeded.', 'QuotaExceededError');
      }
      items.set(key, value);
      used = next;
    };
    const removeItem = (key) => {
      key = String(key);
      const previous = items.get(key);
      if (previous === undefined) return;
      items.delete(key);
      used -= key.length + previous.length;
    };
    const members = Object.create(Object.prototype, {
      length: { get: () => items.size },
      key: { value: (index) => [...items.keys()][Number(index) >>> 0] ?? null },
      getItem: { value: (key) => items.get(String(key)) ?? null },
      setItem: { value: setItem },
      removeItem: { value: removeItem },
      clear: {
        value: () => {
          items.clear();
          used = 0;
        },
      },
    });
    const target = Object.create(members);
    const isItem = (property) =>
      typeof property === 'string' && !(property in target) && items.has(property);
    return new Proxy(target, {
      get: (object, property, receiver) =>
        isItem(property) ? items.get(property) : Reflect.get(object, property, receiver),
      set: (object, property, value, receiver) => {
        if (typeof property === 'symbol') return Reflect.set(object, property, value, receiver);
        setItem(property, value);
        return true;
      },
      has: (object, property) => isItem(property) || Reflect.has(object, property),
      deleteProperty: (object, property) => {
        if (!isItem(property)) return Reflect.deleteProperty(object, property);
        removeItem(property);
        return true;
      },
      ownKeys: (object) => [...[...items.keys()].filter(isItem), ...Reflect.ownKeys(object)],
      getOwnPropertyDescriptor: (object, property) =>
        isItem(property)
          ? { value: items.get(property), writable: true, enumerable: true, configurable: true }
          : Reflect.getOwnPropertyDescriptor(object, property),
    });
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, { configurable: true, value: createStorage() });
  }
  const cookies = new Map();
  const expires = (attribute) => {
    const separator = attribute.indexOf('=');
    if (separator < 0) return false;
    const name = attribute.slice(0, separator).trim().toLowerCase();
    const value = attribute.slice(separator + 1).trim();
    if (name === 'max-age') return value !== '' && Number(value) <= 0;
    return name === 'expires' && Date.parse(value) <= Date.now();
  };
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => [...cookies].map(([name, value]) => name + '=' + value).join('; '),
    set: (cookie) => {
      const [pair, ...attributes] = String(cookie).split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator).trim();
      if (separator < 0 || name === '') return;
      if (attributes.some(expires)) cookies.delete(name);
      else cookies.set(name, pair.slice(separator + 1).trim());
    },
  });
})();`

export const MCP_APP_SANDBOX_PROXY_SCRIPT = `${MEMORY_STORAGE_SCRIPT}
(() => {
  const host = window.parent;
  let delivered = false;
  addEventListener('message', (event) => {
    const message = event.data;
    if (delivered || event.source !== host || !message || message.jsonrpc !== '2.0') return;
    if (message.method !== 'ui/notifications/sandbox-resource-ready') return;
    if (typeof (message.params && message.params.html) !== 'string') return;
    delivered = true;
    document.open();
    document.write(message.params.html);
    document.close();
  });
  host.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, '*');
})();`

const PROXY_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><script>${MCP_APP_SANDBOX_PROXY_SCRIPT}</script></head><body></body></html>`

export function respondMcpAppSandbox(request: Request): Response {
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.host !== 'sandbox' || url.pathname !== '/') {
    return new Response(null, { status: 404 })
  }
  return new Response(PROXY_DOCUMENT, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': MCP_APP_SANDBOX_CONTENT_SECURITY_POLICY,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

/**
 * Host side of the MCP Apps (SEP-1865) JSON-RPC channel over `postMessage`.
 *
 * The app runs in an opaque-origin sandbox, so messages are trusted only by
 * window identity (`event.source`) plus the opaque `"null"` origin; replies use
 * target origin `*` because an opaque origin cannot be named.
 */

export type McpAppDisplayMode = 'inline' | 'fullscreen';

/**
 * The SDK schema intersects a height constraint (`height` | `maxHeight`) with a
 * width constraint (`width` | `maxWidth`); every message carries both halves.
 */
export type McpAppContainerDimensions =
  | { width: number; maxHeight: number }
  | { width: number; height: number };

export type McpAppHostContext = {
  theme: 'light' | 'dark';
  displayMode: McpAppDisplayMode;
  containerDimensions: McpAppContainerDimensions;
  locale: string;
};

export type McpAppBridgeHandlers = {
  readResource: (uri: string) => Promise<unknown>;
  callTool: (name: string, args: Record<string, unknown> | undefined) => Promise<unknown>;
  openLink: (url: string) => void;
  /** Returns the mode actually in effect after the request. */
  requestDisplayMode: (mode: McpAppDisplayMode) => McpAppDisplayMode;
  sizeChanged: (size: { width?: number; height?: number }) => void;
};

type MessageLike = { data: unknown; source: unknown; origin: string };
type MessageListener = (event: MessageLike) => void;

export type McpAppBridgeOptions = {
  listenTarget: {
    addEventListener: (type: 'message', listener: MessageListener) => void;
    removeEventListener: (type: 'message', listener: MessageListener) => void;
  };
  frame: () => { postMessage: (message: unknown, targetOrigin: string) => void } | null;
  documentHtml: string;
  toolInput: Record<string, unknown>;
  toolResult: Record<string, unknown> | null;
  hostVersion: string;
  hostContext: McpAppHostContext;
  handlers: McpAppBridgeHandlers;
};

export type McpAppBridge = {
  updateHostContext: (patch: Partial<McpAppHostContext>) => void;
  teardown: (reason: string) => void;
};

export const MCP_APP_PROTOCOL_VERSION = '2026-01-26';

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INVALID_REQUEST = -32600;
const HOST_ERROR = -32000;

type BridgeState =
  | 'awaiting-proxy'
  | 'awaiting-initialize'
  | 'initializing'
  | 'initialized'
  | 'torn-down';

class BridgeRequestError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidParams = (message: string) => new BridgeRequestError(INVALID_PARAMS, message);

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const readExternalUrl = (params: Record<string, unknown>): string => {
  try {
    const url = new URL(String(params.url));
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // Reported below as invalid params.
  }
  throw invalidParams('Only http(s) links can be opened');
};

export function createMcpAppBridge(options: McpAppBridgeOptions): McpAppBridge {
  const { handlers } = options;
  let state: BridgeState = 'awaiting-proxy';
  let hostContext = options.hostContext;
  let nextHostRequestId = 1;

  const post = (message: Record<string, unknown>) =>
    options.frame()?.postMessage({ jsonrpc: '2.0', ...message }, '*');

  // `toolInfo` is omitted: the SDK requires the complete tool definition
  // (including `inputSchema`), which the host does not receive.
  const initializeResult = () => ({
    protocolVersion: MCP_APP_PROTOCOL_VERSION,
    hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
    hostInfo: { name: 'Lody', version: options.hostVersion },
    hostContext: {
      theme: hostContext.theme,
      displayMode: hostContext.displayMode,
      availableDisplayModes: ['inline', 'fullscreen'],
      containerDimensions: hostContext.containerDimensions,
      locale: hostContext.locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: 'desktop',
    },
  });

  const handleRequest = async (method: string, params: Record<string, unknown>) => {
    if (method === 'ping') return {};
    if (method === 'ui/initialize') {
      // Tool data waits for the app's `initialized` confirmation.
      state = 'initializing';
      return initializeResult();
    }
    if (state !== 'initializing' && state !== 'initialized') {
      throw new BridgeRequestError(INVALID_REQUEST, 'ui/initialize has not completed');
    }
    switch (method) {
      case 'tools/call': {
        if (typeof params.name !== 'string' || params.name.length === 0) {
          throw invalidParams('tools/call requires a tool name');
        }
        if (params.arguments !== undefined && !isRecord(params.arguments)) {
          throw invalidParams('tools/call arguments must be an object');
        }
        return await handlers.callTool(params.name, params.arguments);
      }
      case 'resources/read':
        if (typeof params.uri !== 'string' || params.uri.length === 0) {
          throw invalidParams('resources/read requires a uri');
        }
        return await handlers.readResource(params.uri);
      case 'ui/open-link':
        handlers.openLink(readExternalUrl(params));
        return {};
      case 'ui/request-display-mode': {
        const mode = params.mode;
        if (mode !== 'inline' && mode !== 'fullscreen') return { mode: hostContext.displayMode };
        return { mode: handlers.requestDisplayMode(mode) };
      }
      default:
        throw new BridgeRequestError(METHOD_NOT_FOUND, `Unsupported method: ${method}`);
    }
  };

  const handleNotification = (method: string, params: Record<string, unknown>) => {
    if (method === 'ui/notifications/sandbox-proxy-ready') {
      // Also the reload path: a reloaded frame starts from a blank proxy again.
      state = 'awaiting-initialize';
      post({
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: options.documentHtml },
      });
      return;
    }
    if (method === 'ui/notifications/initialized' && state === 'initializing') {
      state = 'initialized';
      post({ method: 'ui/notifications/tool-input', params: { arguments: options.toolInput } });
      if (options.toolResult) {
        post({ method: 'ui/notifications/tool-result', params: options.toolResult });
      }
      return;
    }
    if (method === 'ui/notifications/size-changed') {
      const size: { width?: number; height?: number } = {};
      if (Number.isFinite(params.width)) size.width = params.width as number;
      if (Number.isFinite(params.height)) size.height = params.height as number;
      if (size.width !== undefined || size.height !== undefined) handlers.sizeChanged(size);
    }
    // `notifications/message` (app logging) and unknown notifications are ignored.
  };

  const listener: MessageListener = (event) => {
    if (state === 'torn-down') return;
    const frame = options.frame();
    if (!frame || event.source !== frame || event.origin !== 'null') return;
    const message = event.data;
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return;
    }
    const method = message.method;
    const params = isRecord(message.params) ? message.params : {};
    const id = message.id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      handleNotification(method, params);
      return;
    }
    if (state === 'awaiting-proxy') return;
    void handleRequest(method, params).then(
      (result) => {
        if (state !== 'torn-down') post({ id, result });
      },
      (error: unknown) => {
        if (state === 'torn-down') return;
        const code = error instanceof BridgeRequestError ? error.code : HOST_ERROR;
        post({
          id,
          error: { code, message: error instanceof Error ? error.message : String(error) },
        });
      }
    );
  };

  options.listenTarget.addEventListener('message', listener);

  return {
    updateHostContext: (patch) => {
      const changed = Object.entries(patch).filter(
        ([key, value]) =>
          value !== undefined && !sameValue(value, hostContext[key as keyof McpAppHostContext])
      );
      if (changed.length === 0) return;
      const params = Object.fromEntries(changed) as Partial<McpAppHostContext>;
      hostContext = { ...hostContext, ...params };
      if (state === 'initialized')
        post({ method: 'ui/notifications/host-context-changed', params });
    },
    teardown: (reason) => {
      if (state === 'torn-down') return;
      // Best effort: the frame is removed right after, so the reply is not awaited.
      if (state === 'initializing' || state === 'initialized') {
        post({
          id: `lody-teardown-${nextHostRequestId++}`,
          method: 'ui/resource-teardown',
          params: { reason },
        });
      }
      state = 'torn-down';
      options.listenTarget.removeEventListener('message', listener);
    },
  };
}

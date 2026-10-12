import {
  McpUiHostContextChangedNotificationSchema,
  McpUiInitializeResultSchema,
} from '@modelcontextprotocol/ext-apps';
import { describe, expect, it, vi } from 'vitest';

import {
  createMcpAppBridge,
  type McpAppBridgeHandlers,
} from '../src/components/ai-gui/mcp-app/mcp-app-bridge';

type Listener = (event: { data: unknown; source: unknown; origin: string }) => void;

const setup = (options: { toolResult?: Record<string, unknown> | null } = {}) => {
  const listeners = new Set<Listener>();
  const target = {
    addEventListener: (_type: 'message', listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: 'message', listener: Listener) => listeners.delete(listener),
  };
  const sent: Array<Record<string, unknown>> = [];
  const frame = {
    postMessage: (message: unknown) => sent.push(message as Record<string, unknown>),
  };
  const handlers: McpAppBridgeHandlers = {
    readResource: vi.fn(async (uri: string) => ({ contents: [{ uri, text: 'resource' }] })),
    callTool: vi.fn(async (name: string) => ({
      content: [{ type: 'text', text: `called ${name}` }],
    })),
    openLink: vi.fn(),
    requestDisplayMode: vi.fn((mode: 'inline' | 'fullscreen') => mode),
    sizeChanged: vi.fn(),
  };
  const bridge = createMcpAppBridge({
    listenTarget: target,
    frame: () => frame,
    documentHtml: '<p>app</p>',
    toolInput: { query: 'q' },
    toolResult:
      options.toolResult === undefined
        ? { content: [{ type: 'text', text: 'result' }] }
        : options.toolResult,
    hostVersion: '1.2.3',
    hostContext: {
      theme: 'dark',
      displayMode: 'inline',
      containerDimensions: { width: 640, maxHeight: 900 },
      locale: 'en',
    },
    handlers,
  });
  const receive = async (data: unknown, source: unknown = frame, origin = 'null') => {
    for (const listener of [...listeners]) listener({ data, source, origin });
    // Let handler promises settle.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
  };
  const request = (id: number, method: string, params: unknown = {}) =>
    receive({ jsonrpc: '2.0', id, method, params });
  const reply = (id: number) => sent.find((message) => message.id === id);
  const start = async () => {
    await receive({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} });
    await request(1, 'ui/initialize', { protocolVersion: '2026-01-26' });
    await receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
  };
  return { bridge, handlers, sent, frame, listeners, receive, request, reply, start };
};

describe('MCP App bridge: rejected input', () => {
  it('ignores messages from any window other than the app frame, or from a real origin', async () => {
    const { sent, frame, receive } = setup();
    const proxyReady = { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' };
    await receive(proxyReady, { postMessage: () => {} });
    await receive(proxyReady, null);
    await receive(proxyReady, frame, 'https://attacker.example');
    expect(sent).toEqual([]);
  });

  it('ignores data that is not JSON-RPC 2.0', async () => {
    const { sent, receive } = setup();
    await receive({ method: 'ui/notifications/sandbox-proxy-ready' });
    await receive('ui/notifications/sandbox-proxy-ready');
    expect(sent).toEqual([]);
  });

  it('refuses app requests before ui/initialize', async () => {
    const { handlers, receive, request, reply } = setup();
    await receive({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
    await request(7, 'tools/call', { name: 'x' });
    expect(reply(7)?.error).toMatchObject({ code: -32600 });
    expect(handlers.callTool).not.toHaveBeenCalled();
  });

  it('answers unsupported and model-facing methods with -32601', async () => {
    const { start, request, reply } = setup();
    await start();
    await request(10, 'ui/message', { role: 'user', content: { type: 'text', text: 'hi' } });
    await request(11, 'ui/update-model-context', { content: [] });
    await request(12, 'sampling/createMessage', {});
    for (const id of [10, 11, 12]) expect(reply(id)?.error).toMatchObject({ code: -32601 });
  });

  it('rejects malformed tool, resource and link parameters without calling the host', async () => {
    const { handlers, start, request, reply } = setup();
    await start();
    await request(20, 'tools/call', { arguments: {} });
    await request(21, 'tools/call', { name: 'x', arguments: ['not', 'an', 'object'] });
    await request(22, 'resources/read', {});
    await request(23, 'ui/open-link', { url: 'javascript:alert(1)' });
    await request(24, 'ui/open-link', { url: 'file:///etc/passwd' });
    await request(25, 'ui/open-link', { url: 'not a url' });
    for (const id of [20, 21, 22, 23, 24, 25])
      expect(reply(id)?.error).toMatchObject({ code: -32602 });
    expect(handlers.callTool).not.toHaveBeenCalled();
    expect(handlers.readResource).not.toHaveBeenCalled();
    expect(handlers.openLink).not.toHaveBeenCalled();
  });

  it('turns a host failure into a JSON-RPC error instead of a hung request', async () => {
    const { handlers, start, request, reply } = setup();
    vi.mocked(handlers.callTool).mockRejectedValueOnce(new Error('Tool is not visible to apps'));
    await start();
    await request(30, 'tools/call', { name: 'hidden' });
    expect(reply(30)?.error).toMatchObject({
      code: -32000,
      message: 'Tool is not visible to apps',
    });
  });

  it('stops answering after teardown', async () => {
    const { bridge, handlers, sent, start, request, listeners } = setup();
    await start();
    bridge.teardown('unmount');
    expect(sent.at(-1)).toMatchObject({
      method: 'ui/resource-teardown',
      params: { reason: 'unmount' },
    });
    expect(listeners.size).toBe(0);
    await request(40, 'tools/call', { name: 'x' });
    expect(handlers.callTool).not.toHaveBeenCalled();
  });
});

describe('MCP App bridge: lifecycle', () => {
  it('delivers the document once the sandbox proxy is ready', async () => {
    const { sent, receive } = setup();
    await receive({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} });
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: '<p>app</p>' },
      },
    ]);
  });

  it('initializes with Lody host capabilities and context, then sends input before result', async () => {
    const { sent, start, reply } = setup();
    await start();
    expect(reply(1)?.result).toEqual({
      protocolVersion: '2026-01-26',
      hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
      hostInfo: { name: 'Lody', version: '1.2.3' },
      hostContext: {
        theme: 'dark',
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
        containerDimensions: { width: 640, maxHeight: 900 },
        locale: 'en',
        timeZone: expect.any(String),
        platform: 'desktop',
      },
    });
    expect(sent.slice(-2)).toEqual([
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-input',
        params: { arguments: { query: 'q' } },
      },
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { content: [{ type: 'text', text: 'result' }] },
      },
    ]);
  });

  it('omits the tool result notification when the call has no result', async () => {
    const { sent, start } = setup({ toolResult: null });
    await start();
    expect(sent.at(-1)?.method).toBe('ui/notifications/tool-input');
  });

  it('re-delivers the document and requires a new handshake when the frame reloads', async () => {
    const { sent, start, receive, request, reply, handlers } = setup();
    await start();
    await receive({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
    expect(sent.at(-1)?.method).toBe('ui/notifications/sandbox-resource-ready');
    await request(50, 'tools/call', { name: 'x' });
    expect(reply(50)?.error).toMatchObject({ code: -32600 });
    expect(handlers.callTool).not.toHaveBeenCalled();
  });
});

describe('MCP App bridge: app requests', () => {
  it('forwards tool calls and resource reads to the originating agent call', async () => {
    const { handlers, start, request, reply } = setup();
    await start();
    await request(60, 'tools/call', { name: 'add_node', arguments: { id: 1 } });
    await request(61, 'resources/read', { uri: 'ui://graph/data.json' });
    expect(handlers.callTool).toHaveBeenCalledWith('add_node', { id: 1 });
    expect(reply(60)?.result).toEqual({ content: [{ type: 'text', text: 'called add_node' }] });
    expect(reply(61)?.result).toEqual({
      contents: [{ uri: 'ui://graph/data.json', text: 'resource' }],
    });
  });

  it('opens http(s) links through the host and answers ping', async () => {
    const { handlers, start, request, reply } = setup();
    await start();
    await request(70, 'ui/open-link', { url: 'https://example.com/docs' });
    await request(71, 'ping');
    expect(handlers.openLink).toHaveBeenCalledWith('https://example.com/docs');
    expect(reply(70)?.result).toEqual({});
    expect(reply(71)?.result).toEqual({});
  });

  it('switches display mode and reports the mode actually in effect', async () => {
    const { bridge, handlers, sent, start, request, reply } = setup();
    await start();
    await request(80, 'ui/request-display-mode', { mode: 'fullscreen' });
    expect(reply(80)?.result).toEqual({ mode: 'fullscreen' });
    bridge.updateHostContext({
      displayMode: 'fullscreen',
      containerDimensions: { width: 1200, height: 800 },
    });
    expect(sent.at(-1)).toEqual({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: { displayMode: 'fullscreen', containerDimensions: { width: 1200, height: 800 } },
    });
    await request(81, 'ui/request-display-mode', { mode: 'pip' });
    expect(reply(81)?.result).toEqual({ mode: 'fullscreen' });
    expect(handlers.requestDisplayMode).toHaveBeenCalledTimes(1);
  });

  it('reports finite size changes and ignores logging notifications', async () => {
    const { handlers, sent, start, receive } = setup();
    await start();
    const before = sent.length;
    await receive({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { height: 420 },
    });
    await receive({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { height: 'x' },
    });
    await receive({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } });
    expect(handlers.sizeChanged).toHaveBeenCalledTimes(1);
    expect(handlers.sizeChanged).toHaveBeenCalledWith({ height: 420 });
    expect(sent.length).toBe(before);
  });
});

/**
 * The official MCP Apps SDK (`@modelcontextprotocol/ext-apps`) validates host
 * messages with these schemas and closes the connection on a mismatch.
 */
describe('MCP App bridge: MCP Apps SDK schema conformance', () => {
  it('sends an initialize result the SDK accepts', async () => {
    const { start, reply } = setup();
    await start();
    const parsed = McpUiInitializeResultSchema.safeParse(reply(1)?.result);
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.data?.hostContext.containerDimensions).toEqual({ width: 640, maxHeight: 900 });
  });

  it('sends host context changes the SDK accepts, always with complete dimensions', async () => {
    const { bridge, sent, start } = setup();
    await start();
    bridge.updateHostContext({
      displayMode: 'fullscreen',
      containerDimensions: { width: 1200, height: 800 },
    });
    bridge.updateHostContext({ containerDimensions: { width: 480, maxHeight: 900 } });
    bridge.updateHostContext({ theme: 'light' });
    const changes = sent.filter(
      (message) => message.method === 'ui/notifications/host-context-changed'
    );
    expect(changes.map((message) => message.params)).toEqual([
      { displayMode: 'fullscreen', containerDimensions: { width: 1200, height: 800 } },
      { containerDimensions: { width: 480, maxHeight: 900 } },
      { theme: 'light' },
    ]);
    for (const message of changes) {
      const parsed = McpUiHostContextChangedNotificationSchema.safeParse(message);
      expect(parsed.error?.issues).toBeUndefined();
    }
  });

  it('sends only fields that changed, and nothing when nothing changed', async () => {
    const { bridge, sent, start } = setup();
    await start();
    const before = sent.length;
    bridge.updateHostContext({
      displayMode: 'inline',
      theme: 'dark',
      containerDimensions: { width: 640, maxHeight: 900 },
    });
    expect(sent.length).toBe(before);
    bridge.updateHostContext({
      displayMode: 'inline',
      containerDimensions: { width: 641, maxHeight: 900 },
    });
    expect(sent.slice(before)).toEqual([
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: { containerDimensions: { width: 641, maxHeight: 900 } },
      },
    ]);
  });

  it('initializes a reloaded frame with the latest context', async () => {
    const { bridge, start, request, receive, reply } = setup();
    await start();
    bridge.updateHostContext({ containerDimensions: { width: 700, maxHeight: 900 } });
    await receive({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
    await request(2, 'ui/initialize', { protocolVersion: '2026-01-26' });
    const parsed = McpUiInitializeResultSchema.safeParse(reply(2)?.result);
    expect(parsed.data?.hostContext.containerDimensions).toEqual({ width: 700, maxHeight: 900 });
  });
});

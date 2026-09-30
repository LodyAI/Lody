// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageContent, SessionId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAssistantTurnRenderLayout } from '../src/components/ai-gui/assistant-turn-render-blocks';
import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { McpAppHostContext, type McpAppHost } from '../src/components/ai-gui/mcp-app/mcp-app-host';
import { McpAppToolCallCard } from '../src/components/ai-gui/mcp-app/mcp-app-tool-call-card';
import { SessionReadonlyContext } from '../src/components/ai-gui/session-readonly-context';
import { SessionChatStreamView } from '../src/components/ai-gui/view';
import { initI18n } from '../src/i18n';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';
import { clearSavedScrollStates } from '../src/lib/conversation-scroll/saved-state';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ToolCall = Extract<MessageContent, { type: 'tool_call' }>;

const appToolCall = (status: ToolCall['status'] = 'completed'): ToolCall => ({
  type: 'tool_call',
  toolCallId: 'call-1',
  title: 'mcp.synthetic.show_board',
  kind: 'execute',
  status,
  mcpApp: {
    server: 'synthetic',
    tool: 'show_board',
    resourceUri: 'ui://synthetic/board.html',
    appName: 'Synthetic Board',
  },
});

const fakeHost = (overrides: Partial<McpAppHost> = {}): McpAppHost => ({
  sandboxUrl: 'lody-mcp-app://sandbox/',
  load: vi.fn(async () => ({ toolInput: {}, toolResult: { content: [] } })),
  readResource: vi.fn(async (_toolCallId: string, uri: string) => ({
    contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>board</p>' }],
  })),
  callTool: vi.fn(async () => ({ content: [] })),
  ...overrides,
});

describe('MCP App tool call layout', () => {
  it('keeps a completed app call out of the folded work region', () => {
    const layout = buildAssistantTurnRenderLayout(
      'turn',
      [{ type: 'text', text: 'Opening.' }, appToolCall(), { type: 'text', text: 'Here it is.' }],
      true
    );
    const appBlock = layout.blocks.find(
      (block) => block.kind === 'content' && block.entry.content.type === 'tool_call'
    );
    expect(appBlock).toBeDefined();
    expect(layout.workBlockKeys.has(appBlock!.key)).toBe(false);
  });

  it('folds a failed app call like any other tool step', () => {
    const layout = buildAssistantTurnRenderLayout(
      'turn',
      [appToolCall('failed'), { type: 'text', text: 'It failed.' }],
      true
    );
    expect(layout.blocks[0]?.kind).toBe('activity_group');
  });
});

type FakeResizeObserver = { callback: () => void; targets: Set<Element> };

describe('McpAppToolCallCard', () => {
  let root: Root;
  let container: HTMLDivElement;
  let resizeObservers: FakeResizeObserver[];

  beforeEach(async () => {
    await initI18n('en');
    resizeObservers = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly entry: FakeResizeObserver;
        constructor(callback: () => void) {
          this.entry = { callback, targets: new Set() };
          resizeObservers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.targets.add(target);
        }
        unobserve(target: Element) {
          this.entry.targets.delete(target);
        }
        disconnect() {
          this.entry.targets.clear();
        }
      }
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clearSavedScrollStates();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const render = async (node: ReactNode) => {
    await act(async () => root.render(node));
  };
  const withHost = (host: McpAppHost | null, child: ReactNode) =>
    createElement(McpAppHostContext.Provider, { value: host }, child);
  const card = (toolCall: ToolCall = appToolCall()) =>
    createElement(McpAppToolCallCard, { toolCall, app: toolCall.mcpApp! });
  const frame = () => container.querySelector('iframe');

  it('shows only the header while the call is running', async () => {
    const host = fakeHost();
    await render(withHost(host, card(appToolCall('in_progress'))));
    expect(container.textContent).toContain('Opened Synthetic Board');
    expect(frame()).toBeNull();
    expect(host.load).not.toHaveBeenCalled();
  });

  it('shows the unavailable placeholder without a host, in read-only replay, or when loading fails', async () => {
    await render(withHost(null, card()));
    expect(container.textContent).toContain('App unavailable');

    const readonlyHost = fakeHost();
    await render(
      createElement(
        SessionReadonlyContext.Provider,
        { value: { renderImage: () => null, renderFiles: () => null } },
        withHost(readonlyHost, card())
      )
    );
    expect(container.textContent).toContain('App unavailable');
    expect(readonlyHost.load).not.toHaveBeenCalled();

    await render(
      withHost(fakeHost({ load: vi.fn(async () => Promise.reject(new Error('offline'))) }), card())
    );
    expect(container.textContent).toContain('App unavailable');
    expect(frame()).toBeNull();

    await render(
      withHost(
        fakeHost({
          readResource: vi.fn(async () => ({ contents: [{ uri: 'ui://x', text: '{}' }] })),
        }),
        card()
      )
    );
    expect(container.textContent).toContain('App unavailable');
    expect(frame()).toBeNull();
  });

  it('runs the app in an opaque-origin sandbox served from the proxy origin', async () => {
    const host = fakeHost();
    await render(withHost(host, card()));
    const iframe = frame();
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe!.hasAttribute('credentialless')).toBe(true);
    expect(iframe!.getAttribute('src')).toBe('lody-mcp-app://sandbox/');
    expect(iframe!.getAttribute('title')).toBe('Synthetic Board');
    expect(iframe!.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe!.getAttribute('data-testid')).toBe('mcp-app-frame');
    expect(host.readResource).toHaveBeenCalledWith('call-1', 'ui://synthetic/board.html');
  });

  const expandTrigger = () => container.querySelector<HTMLButtonElement>('button[aria-expanded]');
  const fullscreenButton = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Open full screen"]');
  const fullscreenDialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

  it('collapses to its header, which still offers to expand, and removes the frame', async () => {
    await render(withHost(fakeHost(), card()));
    expect(expandTrigger()!.getAttribute('aria-expanded')).toBe('true');
    await act(async () => expandTrigger()!.click());
    expect(frame()).toBeNull();
    expect(container.textContent).toContain('Opened Synthetic Board');
    expect(expandTrigger()!.getAttribute('aria-expanded')).toBe('false');
    await act(async () => expandTrigger()!.click());
    expect(expandTrigger()!.getAttribute('aria-expanded')).toBe('true');
    expect(frame()).not.toBeNull();
  });

  it('offers full screen from the header, beside the title and outside the toggle', async () => {
    await render(withHost(fakeHost(), card()));
    const button = fullscreenButton();
    expect(button).not.toBeNull();
    const trigger = expandTrigger()!;
    // A nested button is invalid HTML, and a click on it must not fold the card.
    expect(trigger.contains(button)).toBe(false);
    const header = trigger.parentElement!;
    expect(header.contains(button)).toBe(true);
    // Nothing is drawn over the app's own content.
    expect(header.contains(frame())).toBe(false);
  });

  it('offers full screen only while a completed, expanded app is showing', async () => {
    await render(withHost(fakeHost(), card(appToolCall('in_progress'))));
    expect(fullscreenButton()).toBeNull();

    let finishLoad: (value: Awaited<ReturnType<McpAppHost['load']>>) => void = () => {};
    const slowHost = fakeHost({
      load: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<McpAppHost['load']>>>((resolve) => {
            finishLoad = resolve;
          })
      ),
    });
    await render(withHost(slowHost, card()));
    expect(fullscreenButton()).toBeNull();
    await act(async () => finishLoad({ toolInput: {}, toolResult: { content: [] } }));
    expect(fullscreenButton()).not.toBeNull();

    await act(async () => expandTrigger()!.click());
    expect(fullscreenButton()).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(withHost(null, card()));
    expect(container.textContent).toContain('App unavailable');
    expect(fullscreenButton()).toBeNull();

    await render(
      withHost(fakeHost({ load: vi.fn(async () => Promise.reject(new Error('offline'))) }), card())
    );
    expect(container.textContent).toContain('App unavailable');
    expect(fullscreenButton()).toBeNull();
  });

  it('moves the running app into a full-screen dialog without folding the card', async () => {
    await render(withHost(fakeHost(), card()));
    const iframe = frame()!;
    await act(async () => fullscreenButton()!.click());
    const dialog = fullscreenDialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.contains(iframe)).toBe(true);
    expect(expandTrigger()!.getAttribute('aria-expanded')).toBe('true');
  });

  it('tells the app its measured container size, on resize and across full screen', async () => {
    let inlineWidth = 640.4;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const fullscreen = this.closest('[role="dialog"]') !== null;
        const width = fullscreen ? 1200.4 : inlineWidth;
        const height = fullscreen ? 800.6 : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: height,
          width,
          height,
          toJSON: () => ({}),
        };
      }
    );
    await render(withHost(fakeHost(), card()));
    const iframe = frame()!;
    // The app side of the channel: what the bridge posts, and what the app sends back.
    const received: Array<Record<string, unknown>> = [];
    const appWindow = { postMessage: (message: Record<string, unknown>) => received.push(message) };
    Object.defineProperty(iframe, 'contentWindow', { value: appWindow });
    const fromApp = (data: Record<string, unknown>) =>
      act(async () => {
        const event = new Event('message');
        Object.defineProperties(event, {
          data: { value: { jsonrpc: '2.0', ...data } },
          source: { value: appWindow },
          origin: { value: 'null' },
        });
        window.dispatchEvent(event);
        await Promise.resolve();
      });
    const contextChanges = () =>
      received
        .filter((message) => message.method === 'ui/notifications/host-context-changed')
        .map((message) => message.params);
    const resize = (target: Element) =>
      act(async () => {
        for (const observer of resizeObservers) {
          if (observer.targets.has(target)) observer.callback();
        }
      });

    await fromApp({ method: 'ui/notifications/sandbox-proxy-ready' });
    await fromApp({ id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26' } });
    const initialize = received.find((message) => message.id === 1)?.result as {
      hostContext: Record<string, unknown>;
    };
    expect(initialize.hostContext.containerDimensions).toEqual({ width: 640, maxHeight: 900 });
    await fromApp({ method: 'ui/notifications/initialized' });

    inlineWidth = 480;
    await resize(iframe.parentElement!);
    expect(contextChanges()).toEqual([{ containerDimensions: { width: 480, maxHeight: 900 } }]);

    await act(async () => fullscreenButton()!.click());
    expect(fullscreenDialog()!.contains(iframe)).toBe(true);
    expect(contextChanges().at(-1)).toEqual({
      displayMode: 'fullscreen',
      containerDimensions: { width: 1200, height: 801 },
    });

    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Exit full screen"]')!
        .click()
    );
    expect(fullscreenDialog()).toBeNull();
    expect(contextChanges().at(-1)).toEqual({
      displayMode: 'inline',
      containerDimensions: { width: 480, maxHeight: 900 },
    });
  });
});

describe('MCP App tool call in the conversation', () => {
  it('renders the app card in place of the "Ran" row', async () => {
    await initI18n('en');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const sessionId = 'mcp-app-session' as SessionId;
    const history = [
      {
        id: 'u',
        role: 'user',
        timestamp: '2026-09-30T00:00:00Z',
        items: [{ type: 'text', text: 'Show it' }],
      },
      {
        id: 'a',
        role: 'assistant',
        timestamp: '2026-09-30T00:00:01Z',
        items: [appToolCall(), { type: 'text', text: 'Board opened.' }],
        fileDiff: [],
        finished: true,
      },
    ];
    const view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => history as never,
      subscribe: () => () => {},
    });
    const { items } = buildChatStreamItems(view, sessionId);
    view.dispose();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(SessionChatStreamView, {
          items,
          sessionId,
          renderMessageRow: () => null,
          lastAssistantMessageId: 'a',
        })
      )
    );
    expect(container.querySelector('[data-testid="mcp-app-tool-call"]')?.textContent).toContain(
      'Opened Synthetic Board'
    );
    expect(container.textContent).not.toContain('mcp.synthetic.show_board');
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
});

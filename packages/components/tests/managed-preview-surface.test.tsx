// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, SessionId, SessionMeta } from '@lody/shared';
import {
  MANAGED_BROWSER_STATE_MESSAGE_TYPE,
  MANAGED_BROWSER_READY_MESSAGE_TYPE,
  SET_ANNOTATION_MODE_MESSAGE_TYPE,
  RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
  VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
  VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
} from '@lody/shared/visual-annotation-types';

import { userAtom } from '../src/atoms';
import { ManagedPreviewSurface } from '../src/components/sessions/managed-preview-surface';
import { clearManagedPreviewFrame } from '../src/components/sessions/managed-preview-frame-cache';

const mocks = vi.hoisted(() => ({
  comments: [],
  createComment: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

vi.mock('../src/components/preview/visual-annotation-comments-overlay', () => ({
  VisualAnnotationCommentsOverlay: () => null,
}));

vi.mock('../src/hooks/use-preview-visual-comment-doc', () => ({
  usePreviewVisualCommentDoc: () => ({
    doc: { meta: { sessionId: 'session-annotation' }, turns: {} },
    comments: mocks.comments,
    createComment: mocks.createComment,
    toggleResolved: vi.fn(),
    markSubmitted: vi.fn(),
    waitUntilSynced: vi.fn(),
    ready: true,
    synced: true,
  }),
}));

vi.mock('../src/hooks/use-session-doc', () => ({
  useSessionDoc: () => ({ doc: { history: [] } }),
}));

vi.mock('../src/lib/resize-observer', () => ({
  observeResizeOnAnimationFrame: () => () => {},
}));

const session: SessionMeta = {
  id: 'session-annotation' as SessionId,
  machineId: 'machine-annotation' as MachineId,
  createdAt: '2026-07-21T00:00:00.000Z',
  userId: 'user-1',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
};

const targetMessage = {
  type: VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
  payload: {
    page: {
      url: '/docs',
      pathname: '/docs',
      title: 'Docs',
      viewport: {
        width: 800,
        height: 600,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
      },
    },
    click: { clientX: 120, clientY: 160, pageX: 120, pageY: 160 },
    target: {
      tag: 'button',
      id: 'save',
      attributes: { id: 'save' },
      text: 'Save',
      rect: {
        x: 100,
        y: 140,
        width: 120,
        height: 40,
        top: 140,
        left: 100,
        right: 220,
        bottom: 180,
      },
      selector: '#save',
      xpath: '//*[@id="save"]',
      outerHTMLPreview: '<button id="save">Save</button>',
    },
    ancestors: [],
    nearbyText: { self: 'Save', siblingTexts: [] },
    style: {},
  },
};

type StatePreservingElement = HTMLElement & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

describe('ManagedPreviewSurface', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  // The frame cache only engages on engines with an atomic, state-preserving
  // move; jsdom has none, so give it an equivalent (jsdom's insertBefore does
  // not discard a browsing context) instead of exercising the uncached path.
  beforeAll(() => {
    Object.defineProperty(HTMLIFrameElement.prototype, 'credentialless', {
      configurable: true,
      value: false,
      writable: true,
    });
    (HTMLElement.prototype as StatePreservingElement).moveBefore = function moveBefore(
      this: HTMLElement,
      node: Node,
      child: Node | null
    ) {
      this.insertBefore(node, child);
    };
  });

  afterAll(() => {
    delete (HTMLIFrameElement.prototype as HTMLIFrameElement & { credentialless?: boolean })
      .credentialless;
    delete (HTMLElement.prototype as StatePreservingElement).moveBefore;
  });

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.comments.length = 0;
    mocks.createComment.mockImplementation(async (input) => ({
      id: 'comment-1',
      turnId: input.turnId,
      status: 'completed',
      body: input.body,
      anchor: input.anchor,
      authorId: 'user-1',
      authorName: 'Test User',
      createdAt: 1,
      updatedAt: 1,
    }));
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    clearManagedPreviewFrame(session.id);
    root = undefined;
    container?.remove();
    container = undefined;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('runs static HTML as an uncached opaque-origin srcdoc', async () => {
    const store = createStore();
    store.set(userAtom, { id: 'user-1', name: 'Test User', email: 'test@example.com' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onBrowserStateChange = vi.fn();
    const logicalUrl = 'https://html-file-preview.invalid/result.html';
    const documentHtml = '<!doctype html><html><body>Preview</body></html>';

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <ManagedPreviewSurface
            session={session}
            viewerUrl={logicalUrl}
            logicalUrl={logicalUrl}
            documentHtml={documentHtml}
            annotationEnabled={false}
            onAnnotationAvailabilityChange={vi.fn()}
            onRuntimeError={vi.fn()}
            onLoadingChange={vi.fn()}
            onBrowserStateChange={onBrowserStateChange}
            onNavigationRequest={vi.fn()}
          />
        </Provider>
      );
    });

    const iframe = container.querySelector('iframe');
    if (!iframe?.contentWindow) throw new Error('Expected static preview iframe');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('srcdoc')).toBe(documentHtml);
    expect(iframe.getAttribute('src')).toBeNull();
    expect(iframe.hasAttribute('credentialless')).toBe(true);
    expect(iframe.referrerPolicy).toBe('no-referrer');
    expect(iframe.getAttribute('allow')).toContain("camera 'none'");

    const postMessage = vi.spyOn(iframe.contentWindow, 'postMessage').mockImplementation(() => {});
    await act(async () => iframe.dispatchEvent(new Event('load')));
    expect(postMessage).toHaveBeenCalledWith(expect.any(Object), '*');

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'null',
          source: iframe.contentWindow,
          data: {
            type: MANAGED_BROWSER_STATE_MESSAGE_TYPE,
            payload: {
              url: 'about:srcdoc',
              title: 'Preview',
              loading: false,
              canGoBack: false,
              canGoForward: false,
            },
          },
        })
      );
    });
    expect(onBrowserStateChange).toHaveBeenCalledWith(expect.objectContaining({ url: logicalUrl }));

    await act(async () => {
      root?.render(<Provider store={store}>{null}</Provider>);
    });
    expect(iframe.isConnected).toBe(false);
  });

  it('stages a newly created annotation reference in the matching chat input', async () => {
    const onAddVisualAnnotationToChat = vi.fn(() => true);
    const store = createStore();
    store.set(userAtom, { id: 'user-1', name: 'Test User', email: 'test@example.com' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <ManagedPreviewSurface
            session={session}
            viewerUrl="http://127.0.0.1:61234/"
            logicalUrl="http://localhost:5173/"
            annotationEnabled
            onAnnotationAvailabilityChange={vi.fn()}
            onRuntimeError={vi.fn()}
            onLoadingChange={vi.fn()}
            onBrowserStateChange={vi.fn()}
            onNavigationRequest={vi.fn()}
            onAddVisualAnnotationToChat={onAddVisualAnnotationToChat}
          />
        </Provider>
      );
    });

    const iframe = container.querySelector('iframe');
    if (!iframe?.contentWindow) throw new Error('Expected managed preview iframe');
    const postMessage = vi.spyOn(iframe.contentWindow, 'postMessage').mockImplementation(() => {});
    await act(async () => {
      iframe.dispatchEvent(new Event('load'));
    });
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://127.0.0.1:61234',
          source: iframe.contentWindow,
          data: targetMessage,
        })
      );
    });

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Expected annotation comment textarea');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'Move this action to the toolbar');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sendButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Send')
    );
    if (!sendButton) throw new Error('Expected annotation Send button');
    await act(async () => {
      sendButton.click();
    });

    expect(mocks.createComment).toHaveBeenCalledOnce();
    expect(onAddVisualAnnotationToChat).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'visual_annotation',
        commentId: 'comment-1',
        body: 'Move this action to the toolbar',
      })
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
        payload: {
          anchors: expect.arrayContaining([expect.objectContaining({ commentId: 'comment-1' })]),
        },
      }),
      'http://127.0.0.1:61234'
    );
  });

  it('moves an open comment draft when its target scrolls inside the preview', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const store = createStore();
    store.set(userAtom, { id: 'user-1', name: 'Test User', email: 'test@example.com' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <ManagedPreviewSurface
            session={session}
            viewerUrl="http://127.0.0.1:61234/"
            logicalUrl="http://localhost:5173/"
            annotationEnabled
            onAnnotationAvailabilityChange={vi.fn()}
            onRuntimeError={vi.fn()}
            onLoadingChange={vi.fn()}
            onBrowserStateChange={vi.fn()}
            onNavigationRequest={vi.fn()}
          />
        </Provider>
      );
    });

    const iframe = container.querySelector('iframe');
    if (!iframe?.contentWindow) throw new Error('Expected managed preview iframe');
    const postMessage = vi.spyOn(iframe.contentWindow, 'postMessage').mockImplementation(() => {});
    await act(async () => {
      iframe.dispatchEvent(new Event('load'));
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://127.0.0.1:61234',
          source: iframe.contentWindow,
          data: targetMessage,
        })
      );
    });

    const resolveMessage = postMessage.mock.calls
      .map(
        ([message]) =>
          message as {
            type?: string;
            payload?: { anchors?: Array<{ commentId: string }> };
          }
      )
      .find(
        (message) =>
          message.type === RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE &&
          message.payload?.anchors?.some(({ commentId }) => commentId.includes('draft'))
      );
    const draftAnchorId = resolveMessage?.payload?.anchors?.find(({ commentId }) =>
      commentId.includes('draft')
    )?.commentId;
    if (!draftAnchorId) throw new Error('Expected the comment draft anchor to be tracked');

    let draft = container.querySelector(
      '[data-lody-visual-comment-draft="true"]'
    ) as HTMLDivElement | null;
    expect(draft?.style.top).toBe('192px');

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://127.0.0.1:61234',
          source: iframe.contentWindow,
          data: {
            type: VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
            payload: {
              viewport: {
                width: 800,
                height: 600,
                scrollX: 0,
                scrollY: 120,
                devicePixelRatio: 1,
              },
              results: [
                {
                  commentId: draftAnchorId,
                  resolved: true,
                  rect: {
                    x: 100,
                    y: 60,
                    width: 120,
                    height: 30,
                    top: 60,
                    left: 100,
                    right: 220,
                    bottom: 90,
                  },
                  rectRatio: { x: 0.125, y: 0.1, width: 0.15, height: 0.05 },
                },
              ],
            },
          },
        })
      );
    });

    draft = container.querySelector(
      '[data-lody-visual-comment-draft="true"]'
    ) as HTMLDivElement | null;
    expect(draft?.style.top).toBe('102px');
  });

  it('keeps the page and reload usable without a runtime and accepts a late handshake', async () => {
    vi.useFakeTimers();
    const store = createStore();
    const viewerUrl = 'http://127.0.0.1:61234/';
    function Browser() {
      const [available, setAvailable] = useState(false);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState<string | null>(null);
      const [command, setCommand] = useState<{ id: number; action: 'reload' }>();
      return (
        <>
          <output>
            {loading ? 'loading' : 'loaded'};{available ? 'annotatable' : 'unavailable'};
            {error ?? 'no error'}
          </output>
          <button
            onClick={() =>
              setCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'reload' }))
            }
          >
            Reload
          </button>
          <ManagedPreviewSurface
            session={session}
            viewerUrl={viewerUrl}
            logicalUrl="http://localhost:5173/"
            annotationEnabled={false}
            command={command}
            onAnnotationAvailabilityChange={setAvailable}
            onLoadingChange={setLoading}
            onRuntimeError={setError}
            onBrowserStateChange={() => {}}
            onNavigationRequest={() => {}}
          />
        </>
      );
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    try {
      await act(async () =>
        root?.render(
          <Provider store={store}>
            <Browser />
          </Provider>
        )
      );
      const iframe = container.querySelector('iframe');
      if (!iframe?.contentWindow) throw new Error('Expected preview iframe');
      const postMessage = vi
        .spyOn(iframe.contentWindow, 'postMessage')
        .mockImplementation(() => {});
      await act(async () =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source: iframe.contentWindow,
            origin: 'http://127.0.0.1:61234',
            data: { type: MANAGED_BROWSER_READY_MESSAGE_TYPE },
          })
        )
      );
      expect(postMessage).toHaveBeenCalledWith(
        { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: false },
        'http://127.0.0.1:61234'
      );
      expect(container.querySelector('output')?.textContent).toBe('loading;unavailable;no error');
      await act(async () => iframe.dispatchEvent(new Event('load')));
      await act(async () => vi.advanceTimersByTime(30_000));
      expect(container.querySelector('output')?.textContent).toBe('loaded;unavailable;no error');
      expect(container.querySelector('iframe')).toBe(iframe);
      // A parent-driven reload still works when there is no injected receiver.
      iframe.src = 'http://127.0.0.1:61234/error';
      await act(async () => container?.querySelector('button')?.click());
      expect(iframe.src).toBe(viewerUrl);
      await act(async () => iframe.dispatchEvent(new Event('load')));
      await act(async () =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source: iframe.contentWindow,
            origin: 'http://127.0.0.1:61234',
            data: {
              type: MANAGED_BROWSER_STATE_MESSAGE_TYPE,
              payload: {
                url: viewerUrl,
                title: 'Preview',
                loading: true,
                canGoBack: false,
                canGoForward: false,
              },
            },
          })
        )
      );
      expect(container.querySelector('output')?.textContent).toBe('loading;annotatable;no error');
      expect(container.querySelector('iframe')).toBe(iframe);
      // A page-initiated navigation has no parent src change. Its runtime can
      // report loading, but native load must finish it without a runtime reply.
      await act(async () => iframe.dispatchEvent(new Event('load')));
      expect(container.querySelector('output')?.textContent).toBe('loaded;unavailable;no error');
      // A previously healthy runtime can disappear too. Reload must still be
      // performed by the parent rather than sent to the missing receiver.
      iframe.src = 'http://127.0.0.1:61234/error';
      await act(async () => container?.querySelector('button')?.click());
      expect(iframe.src).toBe(viewerUrl);
    } finally {
      vi.useRealTimers();
    }
  });

  const mountRemountCycle = async (onLoadingChange: ReturnType<typeof vi.fn>) => {
    const store = createStore();
    store.set(userAtom, { id: 'user-1', name: 'Test User', email: 'test@example.com' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const renderSurface = () => (
      <Provider store={store}>
        <ManagedPreviewSurface
          session={session}
          viewerUrl="http://127.0.0.1:61234/"
          logicalUrl="http://localhost:5173/"
          annotationEnabled={false}
          onAnnotationAvailabilityChange={vi.fn()}
          onRuntimeError={vi.fn()}
          onLoadingChange={onLoadingChange}
          onBrowserStateChange={vi.fn()}
          onNavigationRequest={vi.fn()}
        />
      </Provider>
    );

    await act(async () => {
      root?.render(renderSurface());
    });
    const firstIframe = container?.querySelector('iframe');
    if (!firstIframe) throw new Error('Expected managed preview iframe');
    await act(async () => {
      firstIframe.dispatchEvent(new Event('load'));
    });

    await act(async () => {
      root?.render(null);
    });
    expect(container?.querySelector('iframe')).toBeNull();

    await act(async () => {
      root?.render(renderSurface());
    });
    return { firstIframe, remountedIframe: container?.querySelector('iframe') ?? null };
  };

  it('reuses the live iframe after the preview surface remounts', async () => {
    const moveBefore = vi.spyOn(HTMLElement.prototype as StatePreservingElement, 'moveBefore');
    const onLoadingChange = vi.fn();

    const { firstIframe, remountedIframe } = await mountRemountCycle(onLoadingChange);

    expect(remountedIframe).toBe(firstIframe);
    expect(onLoadingChange).toHaveBeenLastCalledWith(false);
    // A plain appendChild would also pass the identity check above while
    // silently discarding the page, so assert the atomic move actually ran.
    expect(moveBefore).toHaveBeenCalled();
  });

  it('mounts a fresh iframe when the engine cannot reparent without a reload', async () => {
    // Without an atomic move, parking and re-hosting a frame each reload the
    // page, so caching would cost more loads than a plain remount.
    const moveBefore = (HTMLElement.prototype as StatePreservingElement).moveBefore;
    delete (HTMLElement.prototype as StatePreservingElement).moveBefore;
    const onLoadingChange = vi.fn();

    try {
      const { firstIframe, remountedIframe } = await mountRemountCycle(onLoadingChange);

      expect(remountedIframe).not.toBeNull();
      expect(remountedIframe).not.toBe(firstIframe);
      expect(firstIframe.isConnected).toBe(false);
      expect(onLoadingChange).toHaveBeenLastCalledWith(true);
    } finally {
      (HTMLElement.prototype as StatePreservingElement).moveBefore = moveBefore;
    }
  });
});

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MANAGED_BROWSER_COMMAND_MESSAGE_TYPE,
  MANAGED_BROWSER_NAVIGATION_REQUEST_MESSAGE_TYPE,
  MANAGED_BROWSER_STATE_MESSAGE_TYPE,
  MANAGED_BROWSER_READY_MESSAGE_TYPE,
  RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
  SET_ANNOTATION_MODE_MESSAGE_TYPE,
  VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
  VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
} from '../src/visual-annotation-types';
import {
  STATIC_HTML_PREVIEW_DOCUMENT_MARKER,
  VISUAL_ANNOTATION_INSPECTOR_BROWSER_SCRIPT,
} from '../src/visual-annotation-injected-script';

type LodyVisualCommentInspector = {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  destroy(): void;
};

declare global {
  interface Window {
    __lodyVisualCommentInspector?: LodyVisualCommentInspector;
  }
}

const setRect = (
  element: Element,
  rect: { x: number; y: number; width: number; height: number }
) => {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON() {
      return this;
    },
  } as DOMRect);
};

const installInjectedScript = (handshake = false) => {
  (0, eval)(VISUAL_ANNOTATION_INSPECTOR_BROWSER_SCRIPT);
  if (handshake) {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: false },
        origin: 'https://app.example.test',
        source: window,
      })
    );
  }
};

const mockElementFromPoint = (element: Element) => {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => element),
  });
};

describe('visual annotation injected script', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://app.example.test/session',
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 });
    window.history.replaceState(null, '', '/preview');
  });

  afterEach(() => {
    window.__lodyVisualCommentInspector?.destroy();
    delete window.__lodyVisualCommentInspector;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.querySelectorAll('base').forEach((element) => element.remove());
    document.documentElement.removeAttribute(STATIC_HTML_PREVIEW_DOCUMENT_MARKER);
    Reflect.deleteProperty(window, 'navigation');
  });

  it('posts inspect payloads to the parent that completed the handshake', () => {
    const button = document.createElement('button');
    button.textContent = 'Send';
    setRect(button, { x: 40, y: 50, width: 120, height: 32 });
    document.body.append(button);
    mockElementFromPoint(button);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    const interactionLayer = document.querySelector<HTMLElement>(
      '[data-lody-visual-annotation-interaction-layer="true"]'
    );
    expect(interactionLayer).not.toBeNull();
    expect(interactionLayer?.style.pointerEvents).toBe('auto');
    expect(interactionLayer?.style.zIndex).toBe('2147483647');
    interactionLayer?.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 60,
      })
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
        payload: expect.objectContaining({
          target: expect.objectContaining({ tag: 'button', text: 'Send' }),
        }),
      }),
      'https://app.example.test'
    );
  });

  it('reports managed browser state and executes trusted history commands', async () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: false },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: MANAGED_BROWSER_COMMAND_MESSAGE_TYPE, command: 'back' },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(back).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MANAGED_BROWSER_STATE_MESSAGE_TYPE,
        payload: expect.objectContaining({ url: window.location.href }),
      }),
      'https://app.example.test'
    );
  });

  it('queues early navigation until the real parent responds to the ready signal', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    installInjectedScript();
    expect(postMessage.mock.calls).toEqual([[{ type: MANAGED_BROWSER_READY_MESSAGE_TYPE }, '*']]);
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com/early';
    document.body.append(anchor);
    expect(
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    ).toBe(false);
    expect(postMessage.mock.calls).toEqual([[{ type: MANAGED_BROWSER_READY_MESSAGE_TYPE }, '*']]);
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: 'https://app.example.test',
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: false },
      })
    );
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: MANAGED_BROWSER_NAVIGATION_REQUEST_MESSAGE_TYPE,
        payload: { url: 'https://example.com/early' },
      },
      'https://app.example.test'
    );
  });

  it('hands cross-origin links back to the parent browser controller', () => {
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com/docs';
    anchor.textContent = 'External docs';
    document.body.append(anchor);
    const appClick = vi.fn();
    anchor.addEventListener('click', appClick);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

    installInjectedScript(true);
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });

    expect(anchor.dispatchEvent(click)).toBe(false);
    expect(appClick).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: MANAGED_BROWSER_NAVIGATION_REQUEST_MESSAGE_TYPE,
        payload: { url: 'https://example.com/docs' },
      },
      'https://app.example.test'
    );
  });

  it('keeps marked static-document fragment links inside the srcdoc page', () => {
    document.documentElement.setAttribute(STATIC_HTML_PREVIEW_DOCUMENT_MARKER, 'true');
    const base = document.createElement('base');
    base.href = 'https://html-file-preview.invalid/';
    document.head.append(base);
    const target = document.createElement('h2');
    target.id = 'details';
    const anchor = document.createElement('a');
    anchor.href = '#details';
    anchor.textContent = 'Details';
    document.body.append(anchor, target);
    const appClick = vi.fn();
    let runtimePreventedAtTarget = false;
    anchor.addEventListener('click', (event) => {
      appClick();
      runtimePreventedAtTarget = event.defaultPrevented;
    });
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

    installInjectedScript();
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });

    expect(anchor.dispatchEvent(click)).toBe(false);
    expect(appClick).toHaveBeenCalledOnce();
    expect(runtimePreventedAtTarget).toBe(false);
    expect(window.location.hash).toBe('#details');
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MANAGED_BROWSER_NAVIGATION_REQUEST_MESSAGE_TYPE }),
      expect.anything()
    );
  });

  it('preserves page cancellation of marked static-document fragment links', () => {
    document.documentElement.setAttribute(STATIC_HTML_PREVIEW_DOCUMENT_MARKER, 'true');
    const base = document.createElement('base');
    base.href = 'https://html-file-preview.invalid/';
    document.head.append(base);
    const anchor = document.createElement('a');
    anchor.href = '#details';
    document.body.append(anchor);
    anchor.addEventListener('click', (event) => event.preventDefault());
    const initialHash = window.location.hash;

    installInjectedScript();
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });

    expect(anchor.dispatchEvent(click)).toBe(false);
    expect(window.location.hash).toBe(initialHash);
  });

  it('completes a fragment when the page stops propagation', () => {
    document.documentElement.setAttribute(STATIC_HTML_PREVIEW_DOCUMENT_MARKER, 'true');
    const anchor = document.createElement('a');
    anchor.href = '#details';
    document.body.append(anchor);
    anchor.addEventListener('click', (event) => event.stopPropagation());
    installInjectedScript();
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    expect(anchor.dispatchEvent(click)).toBe(false);
    expect(window.location.hash).toBe('#details');
  });

  it('still hands marked static-document cross-page links to the parent', () => {
    document.documentElement.setAttribute(STATIC_HTML_PREVIEW_DOCUMENT_MARKER, 'true');
    const base = document.createElement('base');
    base.href = 'https://html-file-preview.invalid/';
    document.head.append(base);
    const anchor = document.createElement('a');
    anchor.href = `${window.location.origin}/same-origin-page`;
    anchor.textContent = 'Another page';
    document.body.append(anchor);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

    installInjectedScript(true);
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });

    expect(anchor.dispatchEvent(click)).toBe(false);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: MANAGED_BROWSER_NAVIGATION_REQUEST_MESSAGE_TYPE,
        payload: { url: `${window.location.origin}/same-origin-page` },
      },
      'https://app.example.test'
    );
  });

  it('captures primary pointerdown before the preview app handles the click', () => {
    const button = document.createElement('button');
    button.textContent = 'Send';
    setRect(button, { x: 40, y: 50, width: 120, height: 32 });
    document.body.append(button);
    mockElementFromPoint(button);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    const appPointerDown = vi.fn();
    const appClick = vi.fn();
    button.addEventListener('pointerdown', appPointerDown);
    button.addEventListener('click', appClick);

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    const pointerEvent = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 50,
      clientY: 60,
    });
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 60,
    });

    const interactionLayer = document.querySelector<HTMLElement>(
      '[data-lody-visual-annotation-interaction-layer="true"]'
    );
    expect(interactionLayer).not.toBeNull();
    expect(interactionLayer?.dispatchEvent(pointerEvent)).toBe(false);
    expect(interactionLayer?.dispatchEvent(clickEvent)).toBe(false);

    expect(appPointerDown).not.toHaveBeenCalled();
    expect(appClick).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
        payload: expect.objectContaining({
          target: expect.objectContaining({ tag: 'button', text: 'Send' }),
        }),
      }),
      'https://app.example.test'
    );
  });

  it('learns the parent origin from the first valid control message when referrer is unavailable', () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: '',
    });
    const button = document.createElement('button');
    button.textContent = 'Send';
    setRect(button, { x: 40, y: 50, width: 120, height: 32 });
    document.body.append(button);
    mockElementFromPoint(button);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    button.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 60,
      })
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
        payload: expect.objectContaining({
          target: expect.objectContaining({ tag: 'button', text: 'Send' }),
        }),
      }),
      'https://app.example.test'
    );
  });

  it('accepts the real parent after navigation changes the referrer to the preview origin', () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://preview.example.test/workspace/session',
    });
    const button = document.createElement('button');
    button.textContent = 'Send';
    setRect(button, { x: 40, y: 50, width: 120, height: 32 });
    document.body.append(button);
    mockElementFromPoint(button);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    button.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 60,
      })
    );

    expect(window.__lodyVisualCommentInspector?.isEnabled()).toBe(true);
    document
      .querySelector('[data-lody-visual-annotation-interaction-layer="true"]')
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 })
      );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE }),
      'https://app.example.test'
    );
  });

  it('rejects a non-parent window even when its origin matches the referrer', () => {
    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: null,
      })
    );
    expect(window.__lodyVisualCommentInspector?.isEnabled()).toBe(false);
    expect(document.querySelector('[data-lody-visual-annotation-interaction-layer]')).toBeNull();
  });

  it('keeps the first learned parent origin locked for later control messages', () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: '',
    });
    const button = document.createElement('button');
    button.textContent = 'Send';
    setRect(button, { x: 40, y: 50, width: 120, height: 32 });
    document.body.append(button);
    mockElementFromPoint(button);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: false },
        origin: 'https://evil.example.test',
        source: window,
      })
    );
    button.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 60,
      })
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE }),
      'https://app.example.test'
    );
  });

  it('uses a wildcard post target for opaque parent origins', () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'capacitor://localhost/session',
    });
    const button = document.createElement('button');
    button.textContent = 'Send';
    setRect(button, { x: 40, y: 50, width: 120, height: 32 });
    document.body.append(button);
    mockElementFromPoint(button);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'null',
        source: window,
      })
    );
    button.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 60,
      })
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE }),
      '*'
    );
  });

  it('preserves data-test and data-cy attribute names in generated selectors', () => {
    const target = document.createElement('div');
    target.setAttribute('data-test', 'hero');
    target.textContent = 'Hero';
    setRect(target, { x: 12, y: 16, width: 200, height: 80 });
    document.body.append(target);
    mockElementFromPoint(target);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    target.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 32,
      })
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          target: expect.objectContaining({ selector: 'div[data-test="hero"]' }),
        }),
      }),
      'https://app.example.test'
    );
  });

  it('removes annotation listeners on destroy', () => {
    const button = document.createElement('button');
    button.textContent = 'Send';
    setRect(button, { x: 40, y: 50, width: 120, height: 32 });
    document.body.append(button);
    mockElementFromPoint(button);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    window.__lodyVisualCommentInspector?.destroy();
    postMessage.mockClear();
    button.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 60,
      })
    );

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('pins the hover overlay to the viewport origin before translating it', () => {
    const button = document.createElement('button');
    button.textContent = 'Send';
    setRect(button, { x: 40, y: 50, width: 120, height: 32 });
    document.body.append(button);
    mockElementFromPoint(button);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    button.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: 50,
        clientY: 60,
      })
    );

    const overlay = document.querySelector(
      '[data-lody-visual-annotation-overlay="true"]'
    ) as HTMLElement | null;
    expect(overlay?.style.position).toBe('fixed');
    expect(overlay?.style.top).toBe('0px');
    expect(overlay?.style.left).toBe('0px');
    expect(overlay?.style.transform).toBe('translate(40px, 50px)');
  });

  it('updates tracked anchors on scroll even when annotation mode is off', () => {
    const target = document.createElement('button');
    target.id = 'tracked-anchor';
    target.textContent = 'Tracked';
    setRect(target, { x: 80, y: 120, width: 160, height: 40 });
    document.body.append(target);
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    installInjectedScript();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
          payload: {
            anchors: [
              {
                commentId: 'comment-1',
                anchor: {
                  target: {
                    id: 'tracked-anchor',
                    selector: '#tracked-anchor',
                  },
                },
              },
            ],
          },
        },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    postMessage.mockClear();

    window.dispatchEvent(new Event('scroll'));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
        payload: expect.objectContaining({
          results: [
            expect.objectContaining({
              commentId: 'comment-1',
              resolved: true,
            }),
          ],
        }),
      }),
      'https://app.example.test'
    );
  });
});

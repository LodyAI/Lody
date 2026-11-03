// @vitest-environment jsdom

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
  SET_ANNOTATION_MODE_MESSAGE_TYPE,
  VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
  VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
  createMinimalVisualAnnotationAnchor,
  createVisualAnnotationInspectPayload,
  createVisualCommentInspector,
} from '../src/visual-annotation-inspector';

import type { VisualAnnotationInspectPayload } from '../src/visual-annotation-inspector';

const setRect = (
  element: Element,
  rect: { x: number; y: number; width: number; height: number }
) => {
  const domRect = {
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
  } as DOMRect;
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(domRect);
};

describe('visual annotation inspector runtime', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 });
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    window.history.replaceState(null, '', '/preview/path?tab=ui#hero');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('enables annotation mode through parent messages', () => {
    const inspector = createVisualCommentInspector({
      allowedParentOrigins: ['https://app.example.test'],
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://other.example.test',
        source: window,
      })
    );
    expect(inspector.isEnabled()).toBe(false);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: window,
      })
    );
    expect(inspector.isEnabled()).toBe(true);

    inspector.destroy();
    expect(inspector.isEnabled()).toBe(false);
  });

  it('rejects parent messages when allowed parent origins are not configured', () => {
    const warn = vi.spyOn(window.console, 'warn').mockImplementation(() => {});
    const inspector = createVisualCommentInspector();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: true },
        origin: 'https://app.example.test',
        source: window,
      })
    );

    expect(inspector.isEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('allowedParentOrigins is not configured')
    );

    inspector.destroy();
  });

  it('refuses to post inspect payloads when target origin is not configured', () => {
    const button = document.createElement('button');
    button.textContent = 'Send comment';
    setRect(button, { x: 40, y: 50, width: 120, height: 32 });
    document.body.append(button);

    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => button),
    });

    const postMessage = vi.fn();
    const warn = vi.spyOn(window.console, 'warn').mockImplementation(() => {});
    vi.spyOn(window.parent, 'postMessage').mockImplementation(postMessage);
    const inspector = createVisualCommentInspector();
    inspector.setEnabled(true);

    button.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 42,
        clientY: 54,
      })
    );

    expect(postMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('postMessageTargetOrigin is not configured')
    );

    inspector.destroy();
  });

  it('captures clicks, blocks page behavior, and promotes SVG children to semantic targets', () => {
    const button = document.createElement('button');
    button.id = 'send-button';
    button.setAttribute('data-testid', 'send-comment');
    button.textContent = 'Send comment';
    setRect(button, { x: 40, y: 50, width: 120, height: 32 });

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.append(path);
    button.append(svg);
    document.body.append(button);

    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => path),
    });

    const postMessage = vi.fn();
    vi.spyOn(window.parent, 'postMessage').mockImplementation(postMessage);
    const inspector = createVisualCommentInspector({ postMessageTargetOrigin: '*' });
    inspector.setEnabled(true);

    let bubbled = false;
    button.addEventListener('click', () => {
      bubbled = true;
    });

    const interactionLayer = document.querySelector<HTMLElement>(
      '[data-lody-visual-annotation-interaction-layer="true"]'
    );
    expect(interactionLayer).not.toBeNull();
    expect(interactionLayer?.style.pointerEvents).toBe('auto');
    expect(interactionLayer?.style.zIndex).toBe('2147483647');
    const dispatched = interactionLayer?.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 42,
        clientY: 54,
      })
    );

    expect(dispatched).toBe(false);
    expect(bubbled).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const message = postMessage.mock.calls[0]?.[0] as
      | { type: string; payload: VisualAnnotationInspectPayload }
      | undefined;
    expect(message?.type).toBe(VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE);
    expect(message?.payload.target.tag).toBe('button');
    expect(message?.payload.target.id).toBe('send-button');
    expect(message?.payload.target.attributes['data-testid']).toBe('send-comment');
    expect(message?.payload.page.url).toBe('/preview/path?tab=ui#hero');

    inspector.destroy();
  });

  it('keeps text blocks as targets instead of promoting them to stable section ancestors', () => {
    const section = document.createElement('section');
    section.setAttribute('data-testid', 'marketing-hero');
    const copy = document.createElement('div');
    const heading = document.createElement('h1');
    const headingText = document.createElement('span');
    headingText.textContent = 'Design reviews should point at pixels.';
    heading.append(headingText);
    copy.append(heading);
    section.append(copy);
    document.body.append(section);
    setRect(heading, { x: 80, y: 120, width: 520, height: 96 });

    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => headingText),
    });

    const postMessage = vi.fn();
    vi.spyOn(window.parent, 'postMessage').mockImplementation(postMessage);
    const inspector = createVisualCommentInspector({ postMessageTargetOrigin: '*' });
    inspector.setEnabled(true);

    headingText.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 140,
      })
    );

    const message = postMessage.mock.calls[0]?.[0] as
      | { type: string; payload: VisualAnnotationInspectPayload }
      | undefined;
    expect(message?.payload.target.tag).toBe('h1');
    expect(message?.payload.target.text).toBe('Design reviews should point at pixels.');
    expect(message?.payload.target.selector).toBe('h1');
    expect(message?.payload.ancestors[1]).toMatchObject({
      tag: 'section',
      selector: 'section[data-testid="marketing-hero"]',
    });

    inspector.destroy();
  });

  it('resolves tracked anchors and refreshes them on scroll', async () => {
    vi.useFakeTimers();
    const heading = document.createElement('h1');
    heading.setAttribute('data-testid', 'live-heading');
    heading.textContent = 'Design reviews should point at pixels.';
    setRect(heading, { x: 120, y: 160, width: 300, height: 80 });
    document.body.append(heading);

    const anchor = createMinimalVisualAnnotationAnchor(
      createVisualAnnotationInspectPayload(
        heading,
        {
          clientX: 140,
          clientY: 180,
          pageX: 140,
          pageY: 180,
        },
        { includeComputedStyle: false }
      )
    );

    const postMessage = vi.fn();
    vi.spyOn(window.parent, 'postMessage').mockImplementation(postMessage);
    const inspector = createVisualCommentInspector({
      allowedParentOrigins: ['https://app.example.test'],
      postMessageTargetOrigin: 'https://app.example.test',
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
          payload: {
            anchors: [{ commentId: 'comment-1', anchor }],
          },
        },
        origin: 'https://app.example.test',
        source: window,
      })
    );

    expect(postMessage).toHaveBeenCalledTimes(1);
    let message = postMessage.mock.calls[0]?.[0] as
      | { type: string; payload: { results: Array<{ commentId: string; resolved: boolean }> } }
      | undefined;
    expect(message?.type).toBe(VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE);
    expect(message?.payload.results[0]).toMatchObject({
      commentId: 'comment-1',
      resolved: true,
      rect: { x: 120, y: 160, width: 300, height: 80 },
      rectRatio: { x: 0.12, y: 0.32, width: 0.3, height: 0.16 },
    });

    postMessage.mockClear();
    setRect(heading, { x: 120, y: 40, width: 300, height: 80 });
    window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(20);

    expect(postMessage).toHaveBeenCalledTimes(1);
    message = postMessage.mock.calls[0]?.[0] as
      | { type: string; payload: { results: Array<{ commentId: string; resolved: boolean }> } }
      | undefined;
    expect(message?.payload.results[0]).toMatchObject({
      commentId: 'comment-1',
      resolved: true,
      rect: { x: 120, y: 40, width: 300, height: 80 },
      rectRatio: { x: 0.12, y: 0.08, width: 0.3, height: 0.16 },
    });

    inspector.destroy();
  });

  it('redacts form values from outerHTML previews', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="hidden" name="csrf" value="secret-token" />
      <input type="email" name="email" value="designer@example.test" />
      <textarea name="notes">private note</textarea>
      <button>Send</button>
    `;
    setRect(form, { x: 10, y: 20, width: 320, height: 180 });
    document.body.append(form);

    const payload = createVisualAnnotationInspectPayload(
      form,
      {
        clientX: 20,
        clientY: 40,
        pageX: 20,
        pageY: 40,
      },
      { includeComputedStyle: false }
    );

    expect(payload.target.outerHTMLPreview).toContain('<input type="hidden" name="csrf">');
    expect(payload.target.outerHTMLPreview).toContain('<input type="email" name="email">');
    expect(payload.target.outerHTMLPreview).toContain('<textarea name="notes"></textarea>');
    expect(payload.target.outerHTMLPreview).not.toContain('secret-token');
    expect(payload.target.outerHTMLPreview).not.toContain('designer@example.test');
    expect(payload.target.outerHTMLPreview).not.toContain('private note');
  });
});

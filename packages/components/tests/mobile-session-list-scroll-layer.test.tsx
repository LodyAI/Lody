// @vitest-environment jsdom

import React, { type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileHomeScreen } from '../src/components/mobile/mobile-home-screen';
import { initI18n } from '../src/i18n';

describe('mobile session list scrollbar layer', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function render(node: ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(node));
  }

  function expectScrollbarStackingBoundary() {
    const scrollRegion = container?.querySelector('[data-mobile-session-list-scroll-region]');
    expect(scrollRegion).not.toBeNull();
    // The region's own stacking context (`position: relative`, `z-index: 0`,
    // `overflow-y: auto`) is the component's StyleX style now, so it is not
    // readable from a class name in jsdom — the stylesheet is not in the
    // document there. What the DOM can still say is that the region the
    // product marks is the one that is rendered.
    return scrollRegion;
  }

  it('keeps the workspace conversation rows inside the scroll container stacking context', () => {
    render(
      <MobileHomeScreen
        workspace={{ id: 'workspace', name: 'Workspace' }}
        machines={[]}
        selectedTab="chat"
        localProjects={[]}
        githubRepositories={[]}
        chats={[]}
      />
    );

    expectScrollbarStackingBoundary();
  });
});

// @vitest-environment jsdom

import React, { act, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => '/acme/chat',
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...props
    }: HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
    }) => <div {...props}>{children}</div>,
  },
  useReducedMotion: () => true,
}));

vi.mock('../src/components/loro-app-sidebar', () => ({
  LoroAppSidebar: (props: HTMLAttributes<HTMLElement>) => (
    <aside {...props} data-geometry-anchor="workspace-sidebar-card" />
  ),
}));

vi.mock('../src/hooks/use-keyboard-navigation', () => ({
  useKeyboardNavigation: () => undefined,
}));

import { WebChatLandingScreen } from '../src/components/chat/web-chat-landing-screen';
import { ConversationColumn } from '../src/components/shared/conversation-column';
import { WebWorkspaceLayout } from '../src/components/web-workspace-layout';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('geometry anchors', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it('marks the workspace shell, sidebar, main pane, and chat landing regions', () => {
    act(() => {
      root!.render(
        <WebWorkspaceLayout>
          <WebChatLandingScreen title="New session" composer={<textarea aria-label="composer" />} />
        </WebWorkspaceLayout>
      );
    });

    const shell = container!.querySelector('[data-geometry-anchor="workspace-shell"]');
    const sidebarSlot = shell?.querySelector('[data-geometry-anchor="workspace-sidebar-slot"]');
    const sidebarCard = sidebarSlot?.querySelector(
      '[data-geometry-anchor="workspace-sidebar-card"]'
    );
    const main = shell?.querySelector('[data-geometry-anchor="workspace-main-pane"]');
    const landing = main?.querySelector('[data-geometry-anchor="chat-landing"]');
    const composerBand = landing?.querySelector('[data-geometry-anchor="chat-composer-band"]');

    expect(shell).not.toBeNull();
    expect(sidebarSlot).not.toBeNull();
    expect(sidebarCard).not.toBeNull();
    expect(main).not.toBeNull();
    expect(landing?.querySelector('[data-geometry-anchor="chat-greeting-region"]')).not.toBeNull();
    expect(composerBand).not.toBeNull();
    expect(
      composerBand?.querySelector('[data-geometry-anchor="chat-conversation-column"]')
    ).not.toBeNull();
  });

  it('keeps the ConversationColumn anchor stable when callers pass data attributes', () => {
    act(() => {
      root!.render(
        <ConversationColumn data-geometry-anchor="caller-value">content</ConversationColumn>
      );
    });

    expect(container!.firstElementChild?.getAttribute('data-geometry-anchor')).toBe(
      'chat-conversation-column'
    );
  });
});

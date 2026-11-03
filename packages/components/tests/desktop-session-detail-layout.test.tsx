// @vitest-environment jsdom

// @vitest-environment jsdom
import React, { act, forwardRef, useImperativeHandle, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sidebarPanelMock = vi.hoisted(() => ({
  collapse: vi.fn(),
  getSize: vi.fn(() => 25),
  resize: vi.fn(),
}));

vi.mock('../src/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: forwardRef<
    unknown,
    { children: React.ReactNode; id?: string; style?: React.CSSProperties }
  >(function MockResizablePanel({ children, id, style }, ref) {
    useImperativeHandle(ref, () =>
      id === 'sidebar'
        ? {
            collapse: sidebarPanelMock.collapse,
            getSize: sidebarPanelMock.getSize,
            resize: sidebarPanelMock.resize,
          }
        : {}
    );
    return (
      <div data-panel-id={id} style={style}>
        {children}
      </div>
    );
  }),
  ResizableHandle: ({ disabled }: { disabled?: boolean }) => (
    <div data-disabled={String(Boolean(disabled))} />
  ),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({
      animate: _animate,
      initial: _initial,
      transition: _transition,
      ...props
    }: HTMLAttributes<HTMLDivElement> & {
      animate?: unknown;
      initial?: unknown;
      transition?: unknown;
    }) => <div {...props} />,
  },
  useReducedMotion: () => false,
}));

import {
  DesktopSessionDetailLayout,
  type DesktopSessionDetailLayoutProps,
} from '../src/components/sessions/desktop-session-detail-layout';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('DesktopSessionDetailLayout', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  const renderLayout = (overrides: Partial<DesktopSessionDetailLayoutProps>) => {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    act(() => {
      root?.render(
        <DesktopSessionDetailLayout
          defaultSizes={{ main: 70, sidebar: 30 }}
          topBar={null}
          chatSurfaces={null}
          terminalDock={null}
          secondaryPanel={null}
          sidebarOpen
          onSidebarCollapse={() => {}}
          deleteConfirmDialog={null}
          {...overrides}
        />
      );
    });
    if (!container) throw new Error('Expected a mounted container');
    return container;
  };

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('keeps the terminal dock inside the chat panel and outside the sidebar panel', () => {
    const mounted = renderLayout({
      topBar: <div data-testid="top-bar" />,
      chatSurfaces: <div data-testid="chat-surfaces" />,
      terminalDock: <div data-testid="terminal-dock" />,
      secondaryPanel: <div data-testid="secondary-panel" />,
    });

    const terminalDock = mounted.querySelector('[data-testid="terminal-dock"]');
    const chatPanel = mounted.querySelector('[data-panel-id="chat"]');
    const sidebarPanel = mounted.querySelector('[data-panel-id="sidebar"]');

    expect(terminalDock).not.toBeNull();
    expect(chatPanel?.contains(terminalDock)).toBe(true);
    expect(sidebarPanel?.contains(terminalDock)).toBe(false);
  });

  it('keeps the secondary panel mounted while the sidebar is collapsed', () => {
    const secondaryPanel = <div data-testid="secondary-panel" />;
    const mounted = renderLayout({ secondaryPanel, sidebarOpen: true });
    const openPanel = mounted.querySelector('[data-testid="secondary-panel"]');
    expect(openPanel).not.toBeNull();

    renderLayout({ secondaryPanel, sidebarOpen: false });
    const collapsedPanel = mounted.querySelector('[data-testid="secondary-panel"]');

    // A remount would have produced a different DOM node.
    expect(collapsedPanel).toBe(openPanel);
    expect(collapsedPanel?.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

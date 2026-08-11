// @vitest-environment jsdom

import React, { act, forwardRef, useImperativeHandle, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('only enables the resize handle while the sidebar is open', () => {
    const mounted = renderLayout({ sidebarOpen: false });
    expect(mounted.querySelector('[data-disabled]')?.getAttribute('data-disabled')).toBe('true');

    renderLayout({ sidebarOpen: true });
    expect(mounted.querySelector('[data-disabled]')?.getAttribute('data-disabled')).toBe('false');
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

describe('DesktopSessionDetailLayout sidebarMinWidthRequest', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let rectSpy: ReturnType<typeof vi.spyOn> | undefined;

  const GROUP_WIDTH = 1200;
  // 500px of a 1200px group.
  const REQUEST_PERCENT = (500 / GROUP_WIDTH) * 100;

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
  };

  const stubGroupWidth = (width: number) => {
    rectSpy?.mockRestore();
    rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width } as DOMRect);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sidebarPanelMock.getSize.mockReturnValue(25);
    stubGroupWidth(GROUP_WIDTH);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
    rectSpy?.mockRestore();
    rectSpy = undefined;
  });

  it('raises the restored size to the requested width when expanding from collapsed', () => {
    renderLayout({ sidebarOpen: false });
    expect(sidebarPanelMock.collapse).toHaveBeenCalled();

    renderLayout({
      sidebarOpen: true,
      sidebarMinWidthRequest: { seq: 1, minWidthPx: 500 },
    });

    // Restored default is 30%; the request raises it to the 500px percent.
    expect(sidebarPanelMock.resize).toHaveBeenCalledTimes(1);
    expect(sidebarPanelMock.resize).toHaveBeenCalledWith(REQUEST_PERCENT);
  });

  it('restores the previous size when the window is too narrow to spare the request', () => {
    stubGroupWidth(900);
    renderLayout({ sidebarOpen: false });

    renderLayout({
      sidebarOpen: true,
      sidebarMinWidthRequest: { seq: 1, minWidthPx: 500 },
    });

    expect(sidebarPanelMock.resize).toHaveBeenCalledTimes(1);
    expect(sidebarPanelMock.resize).toHaveBeenCalledWith(30);
  });

  it('applies the request in place when the sidebar is already open', () => {
    sidebarPanelMock.getSize.mockReturnValue(25);
    renderLayout({ sidebarOpen: true });
    expect(sidebarPanelMock.resize).not.toHaveBeenCalled();

    renderLayout({
      sidebarOpen: true,
      sidebarMinWidthRequest: { seq: 1, minWidthPx: 500 },
    });

    expect(sidebarPanelMock.resize).toHaveBeenCalledTimes(1);
    expect(sidebarPanelMock.resize).toHaveBeenCalledWith(REQUEST_PERCENT);
  });

  it('never shrinks a panel that is already wider than the request', () => {
    sidebarPanelMock.getSize.mockReturnValue(45);
    renderLayout({
      sidebarOpen: true,
      sidebarMinWidthRequest: { seq: 1, minWidthPx: 500 },
    });

    expect(sidebarPanelMock.resize).toHaveBeenCalledTimes(1);
    expect(sidebarPanelMock.resize).toHaveBeenCalledWith(45);
  });

  it('consumes each request once — rerendering the same request does not resize again', () => {
    renderLayout({ sidebarOpen: false });

    const request = { seq: 1, minWidthPx: 500 };
    renderLayout({ sidebarOpen: true, sidebarMinWidthRequest: request });
    renderLayout({ sidebarOpen: true, sidebarMinWidthRequest: request });

    expect(sidebarPanelMock.resize).toHaveBeenCalledTimes(1);
  });
});

describe('DesktopSessionDetailLayout sidebarRestoreSeq', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  /** Captured `requestAnimationFrame` callbacks, flushed explicitly by the test. */
  let pendingFrames: Array<FrameRequestCallback> = [];

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

  const sidebarTransitionDuration = () =>
    container?.querySelector<HTMLElement>('[data-panel-id="sidebar"]')?.style.transitionDuration;

  const flushFrames = () => {
    const frames = pendingFrames;
    pendingFrames = [];
    act(() => {
      for (const frame of frames) frame(0);
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pendingFrames = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  it('animates a sidebar change the user asked for', () => {
    renderLayout({ sidebarOpen: false, sidebarRestoreSeq: 1 });
    flushFrames();

    renderLayout({ sidebarOpen: true, sidebarRestoreSeq: 1 });

    expect(sidebarPanelMock.resize).toHaveBeenCalled();
    expect(sidebarTransitionDuration()).toBe('220ms');
  });

  it('applies a restored sidebar state without a transition', () => {
    renderLayout({ sidebarOpen: false, sidebarRestoreSeq: 1 });
    flushFrames();

    // A session switch: the new session's sidebar state arrives with a bumped seq.
    renderLayout({ sidebarOpen: true, sidebarRestoreSeq: 2 });

    expect(sidebarPanelMock.resize).toHaveBeenCalled();
    expect(sidebarTransitionDuration()).toBe('0ms');
  });

  it('re-arms the transition only after a frame has rendered with it suppressed', () => {
    renderLayout({ sidebarOpen: true, sidebarRestoreSeq: 1 });
    flushFrames();

    renderLayout({ sidebarOpen: false, sidebarRestoreSeq: 2 });
    expect(sidebarTransitionDuration()).toBe('0ms');

    flushFrames();
    expect(sidebarTransitionDuration()).toBe('220ms');
  });
});

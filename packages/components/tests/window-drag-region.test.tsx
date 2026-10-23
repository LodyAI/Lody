// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as electron from '../src/lib/electron';
import { useMacTrafficLightRowPadClass, WindowDragStrip } from '../src/ui/window-drag-region';
import { WebChatLandingScreen } from '../src/components/chat/web-chat-landing-screen';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('WindowDragStrip', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    delete window.__LODY_ELECTRON__;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
    delete window.__LODY_ELECTRON__;
  });

  const renderStrip = () => {
    root = createRoot(container!);
    act(() => {
      root!.render(<WindowDragStrip />);
    });
  };

  it('renders nothing outside Electron', () => {
    renderStrip();
    expect(container!.querySelector('[data-window-drag-strip]')).toBeNull();
  });

  it('renders a title-bar-height drag region in Electron', () => {
    window.__LODY_ELECTRON__ = true;
    vi.spyOn(electron, 'useElectronFullscreen').mockReturnValue(false);
    renderStrip();
    const strip = container!.querySelector('[data-window-drag-strip]');
    expect(strip).not.toBeNull();
    expect(strip!.className).toContain('app-region-drag');
    expect(strip!.className).toContain('h-11');
  });

  it('hides the drag region in native fullscreen', () => {
    window.__LODY_ELECTRON__ = true;
    vi.spyOn(electron, 'useElectronFullscreen').mockReturnValue(true);
    renderStrip();
    expect(container!.querySelector('[data-window-drag-strip]')).toBeNull();
  });
});

describe('macOS traffic-light row alignment', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    window.__LODY_ELECTRON__ = true;
    window.__LODY_PLATFORM__ = { os: 'darwin', homeDir: '/Users/test' };
    vi.spyOn(electron, 'useElectronFullscreen').mockReturnValue(false);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
    delete window.__LODY_ELECTRON__;
    delete window.__LODY_PLATFORM__;
  });

  const renderRow = (options?: { bottomBorder?: boolean; insideWorkspaceFrame?: boolean }) => {
    function Row() {
      const padClass = useMacTrafficLightRowPadClass(options);
      return <div data-testid="row" className={padClass} />;
    }

    root = createRoot(container!);
    act(() => {
      root!.render(<Row />);
    });
    return container!.querySelector('[data-testid="row"]')!;
  };

  it('compensates for the workspace frame while preserving window-origin rows', () => {
    expect(renderRow().className).toBe('pt-[2px]');
    act(() => root?.unmount());
    root = undefined;

    expect(renderRow({ insideWorkspaceFrame: true }).className).toBe('pb-[6px]');
  });

  it('accounts for a bottom border inside the workspace frame', () => {
    expect(renderRow({ bottomBorder: true, insideWorkspaceFrame: true }).className).toBe(
      'pb-[5px]'
    );
  });
});

describe('WebChatLandingScreen window drag', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    window.__LODY_ELECTRON__ = true;
    vi.spyOn(electron, 'useElectronFullscreen').mockReturnValue(false);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
    delete window.__LODY_ELECTRON__;
    delete window.__LODY_PLATFORM__;
  });

  it('hangs a virtual title-bar drag strip when the landing has no header', () => {
    root = createRoot(container!);
    act(() => {
      root!.render(
        <WebChatLandingScreen title="New session" composer={<textarea aria-label="composer" />} />
      );
    });
    const strip = container!.querySelector('[data-window-drag-strip]');
    expect(strip).not.toBeNull();
    expect(strip!.className).toContain('h-11');
  });

  it('aligns the sidebar expander with the macOS traffic lights inside the thin frame', () => {
    window.__LODY_PLATFORM__ = { os: 'darwin', homeDir: '/Users/test' };
    root = createRoot(container!);
    act(() => {
      root!.render(
        <WebChatLandingScreen
          title="New session"
          composer={<textarea aria-label="composer" />}
          leftSidebarExpandSlot={<button type="button">Open sidebar</button>}
        />
      );
    });

    const expander = container!.querySelector('button')!.parentElement!;
    expect(expander.className).toContain('top-[5px]');
    expect(expander.className).toContain('left-[92px]');
  });
});

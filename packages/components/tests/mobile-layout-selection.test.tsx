// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { useIsCompactDesktop, useIsMobile } from '../src/hooks/use-mobile';

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
}

function setNavigatorIdentity(userAgent: string, mobileHint?: boolean) {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  });
  Object.defineProperty(window.navigator, 'userAgentData', {
    configurable: true,
    value: mobileHint === undefined ? undefined : { mobile: mobileHint },
  });
}

function setElectronShell(enabled: boolean) {
  Object.defineProperty(window, '__LODY_ELECTRON__', {
    configurable: true,
    value: enabled ? true : undefined,
  });
}

function LayoutProbe() {
  const isMobile = useIsMobile();
  const compact = useIsCompactDesktop();
  return (
    <div data-testid="layout">
      {isMobile ? 'mobile' : 'desktop'}:{compact ? 'compact' : 'full'}
    </div>
  );
}

describe('mobile layout selection', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    Reflect.deleteProperty(window.navigator, 'userAgent');
    Reflect.deleteProperty(window.navigator, 'userAgentData');
    Reflect.deleteProperty(window, '__LODY_ELECTRON__');
    vi.restoreAllMocks();
  });

  function renderLayoutProbe() {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width') && window.innerWidth < 768,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(<LayoutProbe />));
  }

  it('rotates a phone past the breakpoint into the desktop renderer', () => {
    setNavigatorIdentity(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
    );
    setViewportWidth(430);
    renderLayoutProbe();

    expect(container?.textContent).toBe('mobile:full');

    // A phone is a non-desktop device, so the breakpoint still applies:
    // rotated wide enough it earns the full desktop renderer instead of a
    // stretched mobile stack.
    setViewportWidth(932);
    flushSync(() => window.dispatchEvent(new Event('resize')));

    expect(container?.textContent).toBe('desktop:full');
  });

  it('gives a wide phone reported by client hints the desktop renderer', () => {
    setNavigatorIdentity('Mozilla/5.0 AppleWebKit/537.36 Chrome/140 Safari/537.36', true);
    setViewportWidth(915);
    renderLayoutProbe();

    expect(container?.textContent).toBe('desktop:full');
  });

  it('keeps a wide tablet on the desktop renderer', () => {
    setNavigatorIdentity(
      'Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 Chrome/140 Safari/537.36'
    );
    setViewportWidth(1280);
    renderLayoutProbe();

    expect(container?.textContent).toBe('desktop:full');
  });

  it('keeps a narrow desktop browser window on the compact desktop renderer', () => {
    setNavigatorIdentity(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36'
    );
    setViewportWidth(600);
    renderLayoutProbe();

    // A desktop-class device stays in the desktop family at every width —
    // resizing a browser window below the breakpoint takes the compact
    // presentation instead of remounting the mobile renderer.
    expect(container?.textContent).toBe('desktop:compact');
  });

  it('flips a narrow tablet viewport to the mobile renderer', () => {
    setNavigatorIdentity(
      'Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 Chrome/140 Safari/537.36'
    );
    setViewportWidth(600);
    renderLayoutProbe();

    // Split-view width on a touch tablet still gets the mobile renderer.
    expect(container?.textContent).toBe('mobile:full');
  });

  it('keeps the desktop renderer at every width inside the Electron shell', () => {
    setElectronShell(true);
    setNavigatorIdentity(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36'
    );
    setViewportWidth(480);
    renderLayoutProbe();

    // A narrow desktop window keeps the desktop layout family and switches to
    // the compact presentation instead of remounting the mobile renderer.
    expect(container?.textContent).toBe('desktop:compact');

    setViewportWidth(1200);
    flushSync(() => window.dispatchEvent(new Event('resize')));

    expect(container?.textContent).toBe('desktop:full');

    setViewportWidth(400);
    flushSync(() => window.dispatchEvent(new Event('resize')));

    expect(container?.textContent).toBe('desktop:compact');
  });
});

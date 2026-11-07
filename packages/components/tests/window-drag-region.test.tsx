// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as electron from '../src/lib/electron';
import { useMacTrafficLightRowPadClass } from '../src/ui/window-drag-region';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

  it('does not reserve native control space in fullscreen or outside Electron', () => {
    vi.mocked(electron.useElectronFullscreen).mockReturnValue(true);
    expect(renderRow({ insideWorkspaceFrame: true }).className).toBe('');
    act(() => root?.unmount());
    root = undefined;

    vi.mocked(electron.useElectronFullscreen).mockReturnValue(false);
    delete window.__LODY_ELECTRON__;
    expect(renderRow({ bottomBorder: true }).className).toBe('');
  });
});

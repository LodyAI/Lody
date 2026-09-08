// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeCurrentTabOrWindow,
  registerDesktopTabCloser,
  useDesktopTabCloser,
  __resetDesktopTabClosersForTests,
} from '../src/lib/desktop-tab-or-window-close';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('closeCurrentTabOrWindow', () => {
  let closeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetDesktopTabClosersForTests();
    closeSpy = vi.spyOn(window, 'close').mockImplementation(() => undefined);
  });

  afterEach(() => {
    closeSpy.mockRestore();
    __resetDesktopTabClosersForTests();
  });

  it('closes the window when no tab closer is registered', () => {
    closeCurrentTabOrWindow();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not close the window when the closer handles the chord', () => {
    const closer = vi.fn(() => 'handled' as const);
    const dispose = registerDesktopTabCloser(closer);

    closeCurrentTabOrWindow();

    expect(closer).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();
    dispose();
  });

  it('closes the window when the closer returns unhandled', () => {
    registerDesktopTabCloser(() => 'unhandled');

    closeCurrentTabOrWindow();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the most recently registered closer', () => {
    const older = vi.fn(() => 'unhandled' as const);
    const newer = vi.fn(() => 'handled' as const);
    registerDesktopTabCloser(older);
    registerDesktopTabCloser(newer);

    closeCurrentTabOrWindow();

    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('restores the previous closer after dispose', () => {
    registerDesktopTabCloser(() => 'handled');
    const dispose = registerDesktopTabCloser(() => 'unhandled');
    dispose();

    closeCurrentTabOrWindow();

    expect(closeSpy).not.toHaveBeenCalled();
  });
});

describe('useDesktopTabCloser', () => {
  let container: HTMLDivElement;
  let root: Root;
  let closeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetDesktopTabClosersForTests();
    closeSpy = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    closeSpy.mockRestore();
    __resetDesktopTabClosersForTests();
  });

  it('registers while mounted and closes the window after unmount', () => {
    function Harness() {
      useDesktopTabCloser(() => 'handled');
      return null;
    }

    act(() => root.render(<Harness />));
    closeCurrentTabOrWindow();
    expect(closeSpy).not.toHaveBeenCalled();

    act(() => root.render(null));
    closeCurrentTabOrWindow();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const nativeState = vi.hoisted(() => ({ windows: new Map<number, unknown>(), nextId: 1 }));
// Resolve Electron from its owning app; components does not depend on Electron at runtime.
vi.mock('../../../apps/electron/node_modules/electron', () => ({
  app: { focus() {} },
  BrowserWindow: { fromId: (id: number) => nativeState.windows.get(id) ?? null },
}));

import {
  getMainWindow,
  isWarmWindow,
  productWindows,
  registerProductWindow,
  setAppQuitting,
  setMainWindow,
} from '../../../apps/electron/src/main/window-state';
import {
  getWindowTargetPath,
  presentWindowTarget,
} from '../../../apps/electron/src/main/window-target';
import {
  requestRendererReload,
  setReloadTarget,
} from '../../../apps/electron/src/main/renderer-recovery';

import {
  claimWarmWindow,
  handleWindowWarmReady,
  setWindowWarmupEnabled,
} from '../../../apps/electron/src/main/window-warm-service';

class NativeWindow extends EventEmitter {
  id = nativeState.nextId++;
  constructor() {
    super();
    nativeState.windows.set(this.id, this);
  }
  destroyed = false;
  visible = false;
  focused = false;
  loaded: { filePath: string; hash?: string } | string | null = null;
  target: unknown = null;
  webContents = {
    id: this.id,
    send: (_channel: string, target: unknown) => {
      // Navigation can trigger window lifecycle work; adoption must already be complete.
      expect(isWarmWindow(this.native)).toBe(false);
      this.target = target;
    },
  };
  get native() {
    return this as unknown as BrowserWindow;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return false;
  }
  show() {
    this.visible = true;
  }
  focus() {
    this.focused = true;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
    nativeState.windows.delete(this.id);
  }
  async loadFile(filePath: string, options?: { hash?: string }) {
    this.loaded = { filePath, ...options };
  }
  async loadURL(url: string) {
    this.loaded = url;
  }
}

vi.mock('../../../apps/electron/src/main/window', () => ({
  createWarmWindow: () => {
    const window = new NativeWindow();
    registerProductWindow(window.native, true);
    return window.native;
  },
  bindMainWindowTarget: (
    window: BrowserWindow,
    target: { workspace: string; sessionId?: string }
  ) =>
    presentWindowTarget(window, target, {
      type: 'file',
      filePath: '/synthetic/index.html',
      hash: getWindowTargetPath(target),
    }),
}));

afterEach(() => {
  setWindowWarmupEnabled(false);
  setAppQuitting(true);
  for (const window of productWindows) window.destroy();
  setMainWindow(null);
  setAppQuitting(false);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('claimed warm window lifecycle', () => {
  it('keeps the replacement spare timeout when a previously claimed window closes', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LODY_E2E', '0');
    vi.stubEnv('LODY_DISABLE_WINDOW_WARMUP', '0');
    const original = new NativeWindow();
    registerProductWindow(original.native, false);
    setWindowWarmupEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    const warm = [...nativeState.windows.values()].find(
      (candidate) => candidate !== original
    ) as NativeWindow;
    expect(warm).toBeDefined();
    handleWindowWarmReady(warm.webContents.id);
    expect(claimWarmWindow({ workspace: 'work', sessionId: 'first' })).toBe(warm.native);
    await vi.advanceTimersByTimeAsync(0);
    const replacement = [...nativeState.windows.values()].find(
      (candidate) => candidate !== original && candidate !== warm
    ) as NativeWindow;
    expect(replacement).toBeDefined();
    warm.destroy();
    expect(replacement.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replacement.destroyed).toBe(true);
    expect(original.destroyed).toBe(false);
  });

  it('keeps the adopted window alive and makes it the fallback when the original closes', () => {
    const original = new NativeWindow();
    const claimed = new NativeWindow();
    const spare = new NativeWindow();
    registerProductWindow(original.native, false);
    registerProductWindow(claimed.native, true);
    registerProductWindow(spare.native, true);
    setMainWindow(original.native);
    const target = { workspace: 'work', sessionId: 'session-1' };
    presentWindowTarget(claimed.native, target, {
      type: 'file',
      filePath: '/synthetic/index.html',
      hash: getWindowTargetPath(target),
    });
    original.destroy();
    expect(claimed.destroyed).toBe(false);
    expect(claimed.visible && claimed.focused).toBe(true);
    expect(claimed.target).toEqual(target);
    expect(getMainWindow()).toBe(claimed.native);
    expect(spare.destroyed).toBe(false);
    claimed.destroy();
    expect(spare.destroyed).toBe(true);
    expect(productWindows.size).toBe(0);
  });

  it.each([{ workspace: 'work', sessionId: 'session-1' }, { workspace: 'work' }])(
    'recovers the adopted target instead of reentering warm mode: %j',
    (target) => {
      const window = new NativeWindow();
      registerProductWindow(window.native, true);
      setReloadTarget(window.native, {
        type: 'file',
        filePath: '/synthetic/index.html',
        hash: '/?window=workspace&warm=1',
      });
      const path = getWindowTargetPath(target);
      presentWindowTarget(window.native, target, {
        type: 'file',
        filePath: '/synthetic/index.html',
        hash: path,
      });
      requestRendererReload(window.native);
      const route = new URL(path, 'https://synthetic.invalid');
      expect(route.searchParams.has('warm')).toBe(false);
      expect(route.pathname).toBe('sessionId' in target ? '/work/sessions/session-1' : '/work');
      expect(route.searchParams.get('window')).toBe(
        'sessionId' in target ? 'session' : 'workspace'
      );
      expect(route.searchParams.get('tab')).toBe(
        'sessionId' in target ? 'session:session-1' : null
      );
      expect(window.loaded).toEqual({ filePath: '/synthetic/index.html', hash: path });
    }
  );
});

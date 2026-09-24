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
  unmarkWarmWindow,
  productWindows,
  registerProductWindow,
  setAppQuitting,
  setMainWindow,
} from '../../../apps/electron/src/main/window-state';
import {
  getWindowTargetPath,
  handleWindowContentReady,
  presentWindowTarget,
} from '../../../apps/electron/src/main/window-target';
import {
  requestRendererReload,
  setReloadTarget,
} from '../../../apps/electron/src/main/renderer-recovery';

import {
  claimWarmWindow,
  prepareWindow,
  cancelPreparedWindow,
  handlePreparedWindowState,
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
  throttling = true;
  webContents = Object.assign(new EventEmitter(), {
    getBackgroundThrottling: () => this.throttling,
    setBackgroundThrottling: (value: boolean) => {
      this.throttling = value;
    },
    id: this.id,
    send: (_channel: string, target: unknown) => {
      // Navigation can trigger window lifecycle work; adoption must already be complete.
      expect(isWarmWindow(this.native)).toBe(_channel === 'app.prepareWindowTarget');
      this.target = target;
    },
  });
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
    this.emit('show');
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
  adoptPreparedMainWindow: (
    window: BrowserWindow,
    target: { workspace: string; sessionId?: string }
  ) => {
    unmarkWarmWindow(window);
    setReloadTarget(window, {
      type: 'file',
      filePath: '/synthetic/index.html',
      hash: getWindowTargetPath(target),
    });
  },
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
  vi.unstubAllGlobals();
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
    expect(warm.visible).toBe(false);
    handleWindowContentReady(warm.webContents.id, { workspace: 'work', sessionId: 'first' });
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
    expect(claimed.visible).toBe(false);
    expect(claimed.throttling).toBe(false);
    handleWindowContentReady(original.webContents.id, target);
    handleWindowContentReady(claimed.webContents.id, { ...target, sessionId: 'other' });
    expect(claimed.visible).toBe(false);
    handleWindowContentReady(claimed.webContents.id, target);
    expect(claimed.visible && claimed.focused).toBe(true);
    expect(claimed.throttling).toBe(true);
    expect(claimed.target).toEqual(target);
    expect(getMainWindow()).toBe(claimed.native);
    expect(spare.destroyed).toBe(false);
    claimed.destroy();
    expect(spare.destroyed).toBe(true);
    expect(productWindows.size).toBe(0);
  });

  it('exposes recovery on timeout and cancels pending reveals when closed', () => {
    vi.useFakeTimers();
    const window = new NativeWindow();
    registerProductWindow(window.native, true);
    const target = { workspace: 'work', sessionId: 'failed' };
    presentWindowTarget(window.native, target, { type: 'url', url: 'https://synthetic.test' });
    vi.advanceTimersByTime(4999);
    expect(window.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(window.visible && window.focused).toBe(true);
    const closed = new NativeWindow();
    registerProductWindow(closed.native, true);
    presentWindowTarget(closed.native, target, { type: 'url', url: 'https://synthetic.test' });
    closed.destroy();
    vi.advanceTimersByTime(5000);
    handleWindowContentReady(closed.webContents.id, target);
    expect(closed.visible).toBe(false);
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

describe('macOS prepared targets', () => {
  async function fixture() {
    vi.useFakeTimers();
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    vi.stubEnv('LODY_E2E', '0');
    vi.stubEnv('LODY_DISABLE_WINDOW_WARMUP', '0');
    const source = new NativeWindow();
    source.visible = true;
    registerProductWindow(source.native, false);
    setWindowWarmupEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    const spare = [...nativeState.windows.values()].find((w) => w !== source) as NativeWindow;
    handleWindowWarmReady(spare.id);
    const target = { workspace: 'local', sessionId: 'target' };
    prepareWindow(source.native, target, 'first');
    return { source, spare, target, binding: spare.target as { preparationId: string } };
  }

  it('retains a painted target through renewed intent and activates without navigating', async () => {
    const { source, spare, target, binding } = await fixture();
    expect(isWarmWindow(spare.native)).toBe(true);
    expect(spare.visible).toBe(false);
    handlePreparedWindowState(spare.id, { ...target, ...binding, ready: true });
    prepareWindow(source.native, target, 'second');
    cancelPreparedWindow(source.id, 'first');
    await vi.advanceTimersByTimeAsync(2000);
    expect(spare.destroyed).toBe(false);
    expect(claimWarmWindow(target)).toBe(spare.native);
    expect(spare.visible && spare.focused).toBe(true);
    expect(isWarmWindow(spare.native)).toBe(false);
    expect(spare.throttling).toBe(true);
    expect(spare.target).toEqual(binding);
    cancelPreparedWindow(source.id, 'second');
    source.destroy();
    expect(spare.destroyed).toBe(false);
    await requestRendererReload(spare.native);
    expect(spare.loaded).toEqual({
      filePath: '/synthetic/index.html',
      hash: getWindowTargetPath(target),
    });
  });

  it('waits for current readiness after invalidation and ignores stale or foreign signals', async () => {
    const { spare, target, binding } = await fixture();
    handlePreparedWindowState(spare.id, { ...binding, ready: true });
    handlePreparedWindowState(spare.id, { ...binding, ready: false });
    claimWarmWindow(target);
    handlePreparedWindowState(spare.id + 1, { ...binding, ready: true });
    handlePreparedWindowState(spare.id, { ...binding, preparationId: 'old', ready: true });
    expect(spare.visible).toBe(false);
    handlePreparedWindowState(spare.id, { ...binding, ready: true });
    expect(spare.visible).toBe(true);
  });

  it('releases cancelled and expired targets without showing them', async () => {
    const { source, spare } = await fixture();
    cancelPreparedWindow(source.id + 1, 'first');
    await vi.advanceTimersByTimeAsync(2000);
    expect(spare.destroyed).toBe(false);
    cancelPreparedWindow(source.id, 'first');
    await vi.advanceTimersByTimeAsync(2000);
    expect(spare.destroyed).toBe(true);
    expect(spare.visible).toBe(false);
  });

  it('drops a different target and never uses its late readiness', async () => {
    const { spare, binding } = await fixture();
    expect(claimWarmWindow({ workspace: 'local', sessionId: 'different' })).toBeNull();
    handlePreparedWindowState(spare.id, { ...binding, ready: true });
    expect(spare.destroyed).toBe(true);
    expect(spare.visible).toBe(false);
  });

  it('expires an unclaimed view', async () => {
    const { spare } = await fixture();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spare.destroyed).toBe(true);
    expect(spare.visible).toBe(false);
  });

  it('destroys a speculative view when its source closes', async () => {
    const { source, spare } = await fixture();
    source.destroy();
    expect(spare.destroyed).toBe(true);
    expect(spare.visible).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(productWindows.size).toBe(0);
  });

  it('keeps an early claim alive beyond cancellation and reveals only matching readiness', async () => {
    const { source, spare, target, binding } = await fixture();
    cancelPreparedWindow(source.id, 'first');
    expect(claimWarmWindow(target)).toBe(spare.native);
    await vi.advanceTimersByTimeAsync(2000);
    expect(spare.destroyed).toBe(false);
    expect(spare.visible).toBe(false);
    handlePreparedWindowState(spare.id, { ...binding, ready: true });
    expect(spare.visible).toBe(true);
  });

  it('releases a claimed pending window on disable instead of stranding it', async () => {
    const { spare, target } = await fixture();
    claimWarmWindow(target);
    setWindowWarmupEnabled(false);
    expect(spare.destroyed).toBe(false);
    expect(spare.visible).toBe(true);
    expect(spare.throttling).toBe(true);
  });

  it('replenishes a neutral spare after cancelled preparation', async () => {
    const { source, spare } = await fixture();
    cancelPreparedWindow(source.id, 'first');
    await vi.advanceTimersByTimeAsync(2001);
    const replacement = [...nativeState.windows.values()].find((w) => w !== source) as NativeWindow;
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(spare);
    expect(replacement.target).toBeNull();
    expect(replacement.visible).toBe(false);
  });

  it('does not create a target view on other platforms', async () => {
    const { source, spare } = await fixture();
    setWindowWarmupEnabled(false);
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    setWindowWarmupEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    const neutral = [...nativeState.windows.values()].find((w) => w !== source) as NativeWindow;
    handleWindowWarmReady(neutral.id);
    prepareWindow(source.native, { workspace: 'local', sessionId: 'other' }, 'linux');
    expect(spare.destroyed).toBe(true);
    expect(neutral.target).toBeNull();
    expect(neutral.visible).toBe(false);
    expect(isWarmWindow(neutral.native)).toBe(true);
  });

  it('cancels queued intent if a request arrives before the neutral shell is ready', async () => {
    const { source } = await fixture();
    setWindowWarmupEnabled(false);
    setWindowWarmupEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    const neutral = [...nativeState.windows.values()].find((w) => w !== source) as NativeWindow;
    const target = { workspace: 'local', sessionId: 'too-soon' };
    prepareWindow(source.native, target, 'queued');
    expect(claimWarmWindow(target)).toBeNull();
    handleWindowWarmReady(neutral.id);
    expect(neutral.target).toBeNull();
    expect(neutral.visible).toBe(false);
  });

  it('reveals recovery for a claimed view that fails instead of leaving it hidden', async () => {
    const { spare, target } = await fixture();
    claimWarmWindow(target);
    spare.webContents.emit('render-process-gone');
    expect(spare.visible).toBe(true);
    expect(spare.destroyed).toBe(false);
  });
});

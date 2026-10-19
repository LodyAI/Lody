// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useCachedAvatarSrc } from '../src/components/cached-avatar-img';
import { UserAvatar } from '../src/components/user-avatar';
import { useStableAvatarSrc } from '../src/hooks/use-stable-avatar-src';
import {
  clearAvatarImageCache,
  getAvatarBlobUrl,
  peekAvatarBlobUrl,
  rehydrateAvatarMemoryCacheFromPersistent,
} from '../src/lib/avatar-cache';

class CacheStorageMock {
  private stores = new Map<string, Map<string, Response>>();

  async open(name: string) {
    const store = this.stores.get(name) ?? new Map<string, Response>();
    this.stores.set(name, store);
    // Real CacheStorage matches by URL whether given a string or a Request.
    const keyOf = (key: string | { url: string }) => (typeof key === 'string' ? key : key.url);
    return {
      match: async (key: string | { url: string }) => store.get(keyOf(key))?.clone(),
      put: async (key: string, value: Response) => {
        store.set(key, value.clone());
      },
      delete: async (key: string) => store.delete(key),
      keys: async () => Array.from(store.keys()).map((url) => ({ url })),
    };
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }
}

// Render the hook and record every value it returns across renders.
function mountProbe(url: string | null | undefined) {
  const values: Array<string | undefined> = [];
  function Probe({ src }: { src: string | null | undefined }) {
    values.push(useCachedAvatarSrc(src));
    return null;
  }
  const container = document.createElement('div');
  const root: Root = createRoot(container);
  return { values, root, container, render: () => createElement(Probe, { src: url }) };
}

const AVATAR_URL = 'https://avatars.githubusercontent.com/loro-dev?size=80';

// The browser owns when an Image becomes reusable. Drive that boundary through
// explicit load signals; a new Image sees only sources that finished loading.
class ControlledImage {
  static loaded = new Set<string>();
  static pending = new Set<ControlledImage>();
  complete = false;
  naturalWidth = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private source = '';
  private resolveDecode?: () => void;
  private rejectDecode?: (error: Error) => void;

  set src(value: string) {
    this.source = value;
    this.complete = ControlledImage.loaded.has(value);
    this.naturalWidth = this.complete ? 128 : 0;
    if (!this.complete) ControlledImage.pending.add(this);
  }

  get src() {
    return this.source;
  }

  decode(): Promise<void> {
    if (this.complete) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.resolveDecode = resolve;
      this.rejectDecode = reject;
    });
  }

  static settleLoads(failed = false) {
    for (const image of this.pending) {
      image.complete = true;
      if (failed) {
        image.onerror?.();
        image.rejectDecode?.(new Error('invalid image'));
      } else {
        this.loaded.add(image.src);
        image.naturalWidth = 128;
        image.onload?.();
        image.resolveDecode?.();
      }
    }
    this.pending.clear();
  }
}

describe('useCachedAvatarSrc', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;

    (window as unknown as { caches: CacheStorageMock }).caches = new CacheStorageMock();

    let counter = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => `blob:${blob.size}:${(counter += 1)}`),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });

    fetchMock = vi.fn(
      async () =>
        new Response(new Blob(['avatar'], { type: 'image/png' }), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
    );
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    clearAvatarImageCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to the raw URL on first mount, then swaps to the cached blob', async () => {
    const probe = mountProbe(AVATAR_URL);
    await act(async () => {
      probe.root.render(probe.render());
    });
    await act(async () => {});

    // First paint uses the raw URL (so good network shows it immediately)...
    expect(probe.values[0]).toBe(AVATAR_URL);
    // ...then it swaps to the persisted blob once the cache load resolves.
    expect(probe.values.at(-1)).toMatch(/^blob:/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      probe.root.unmount();
    });
  });

  it('serves the avatar from cache on the next session WITHOUT a network request', async () => {
    // First session: load + persist the blob.
    const first = mountProbe(AVATAR_URL);
    await act(async () => {
      first.root.render(first.render());
    });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.root.unmount();
    });

    // New session: in-memory blob URLs are gone, persistent CacheStorage remains.
    clearAvatarImageCache({ memory: true, persistent: false });
    fetchMock.mockClear();

    const second = mountProbe(AVATAR_URL);
    await act(async () => {
      second.root.render(second.render());
    });
    await act(async () => {});

    // The avatar resolves to a blob from CacheStorage — no network needed,
    // so it paints even on a dead/poor connection. This is the fix.
    expect(second.values.at(-1)).toMatch(/^blob:/);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      second.root.unmount();
    });
  });

  it('paints the blob synchronously on first render after startup rehydrate', async () => {
    const first = mountProbe(AVATAR_URL);
    await act(async () => {
      first.root.render(first.render());
    });
    await act(async () => {});
    await act(async () => {
      first.root.unmount();
    });

    // Simulate a fresh app load: memory cleared, then warmed from persistent.
    clearAvatarImageCache({ memory: true, persistent: false });
    fetchMock.mockClear();
    await rehydrateAvatarMemoryCacheFromPersistent();

    const second = mountProbe(AVATAR_URL);
    await act(async () => {
      second.root.render(second.render());
    });

    // No raw-URL flash: the very first value is already the cached blob.
    expect(second.values[0]).toMatch(/^blob:/);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      second.root.unmount();
    });
  });

  it('warms the local blob without delaying the original image, then paints it on return', async () => {
    vi.stubGlobal('Image', ControlledImage);
    ControlledImage.loaded = new Set([AVATAR_URL]);
    ControlledImage.pending.clear();
    const container = document.createElement('div');
    const root = createRoot(container);
    const avatar = (key: string) =>
      createElement(UserAvatar, { key, user: { name: 'Synthetic User', image: AVATAR_URL } });

    try {
      await act(async () => root.render(avatar('A')));
      // Cache filling and first display finish while blob decode is still held.
      const blobUrl = await getAvatarBlobUrl(AVATAR_URL);
      expect(container.querySelector('img')?.getAttribute('src')).toBe(AVATAR_URL);
      expect(peekAvatarBlobUrl(AVATAR_URL)).toBe(blobUrl);

      await act(async () => ControlledImage.settleLoads());
      await act(async () => root.render(null));
      await act(async () => root.render(avatar('A-return')));

      expect(container.querySelector('img')?.getAttribute('src')).toBe(blobUrl);
      expect(container.querySelector('svg')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('warms a restored avatar only when used, then paints it immediately on return offline', async () => {
    vi.stubGlobal('Image', ControlledImage);
    ControlledImage.loaded.clear();
    ControlledImage.pending.clear();
    await getAvatarBlobUrl(AVATAR_URL);
    clearAvatarImageCache({ persistent: false });
    await rehydrateAvatarMemoryCacheFromPersistent();
    // Rehydration finishes without waiting on the browser's held decode.
    const blobUrl = peekAvatarBlobUrl(AVATAR_URL);
    expect(blobUrl).toMatch(/^blob:/);
    ControlledImage.settleLoads();
    fetchMock.mockRejectedValue(new Error('offline'));
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      await act(async () =>
        root.render(createElement(UserAvatar, { user: { image: AVATAR_URL } }))
      );
      // Restoring bytes alone does not start decoding every stored avatar.
      expect(container.querySelector('img')).toBeNull();
      await act(async () => ControlledImage.settleLoads());
      await act(async () => root.render(null));
      await act(async () =>
        root.render(createElement(UserAvatar, { user: { image: AVATAR_URL } }))
      );
      expect(container.querySelector('img')?.getAttribute('src')).toBe(blobUrl);
      expect(container.querySelector('svg')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps the broken-image fallback when background decoding fails', async () => {
    vi.stubGlobal('Image', ControlledImage);
    ControlledImage.loaded.clear();
    ControlledImage.pending.clear();
    const blobUrl = await getAvatarBlobUrl(AVATAR_URL);
    await act(async () => ControlledImage.settleLoads(true));
    expect(await getAvatarBlobUrl(AVATAR_URL)).toBe(blobUrl);
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      await act(async () =>
        root.render(createElement(UserAvatar, { user: { image: AVATAR_URL } }))
      );
      await act(async () => ControlledImage.settleLoads(true));
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('svg')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('commits the current source immediately when metadata arrives, changes or clears', async () => {
    const firstBlob = await getAvatarBlobUrl(AVATAR_URL);
    const otherUrl = 'https://example.test/other-avatar.png';
    const otherBlob = await getAvatarBlobUrl(otherUrl);
    const commits: Array<string | undefined> = [];
    function Probe({ src }: { src?: string | null }) {
      const resolved = useStableAvatarSrc(src);
      useLayoutEffect(() => {
        commits.push(resolved);
      });
      return createElement('span', { 'data-src': resolved });
    }
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      await act(async () => root.render(createElement(Probe)));
      for (const [src, expected] of [
        [AVATAR_URL, firstBlob],
        [otherUrl, otherBlob],
        [null, undefined],
      ] as const) {
        commits.length = 0;
        await act(async () => root.render(createElement(Probe, { src })));
        expect(commits[0]).toBe(expected);
        expect(container.querySelector('span')?.getAttribute('data-src')).toBe(expected ?? null);
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});

// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionId, WorkspaceId } from '@lody/shared';
import {
  clearSessionImageCache,
  getSessionImageBlobUrl,
  getSessionImageDataUrl,
  peekSessionImageUrl,
  seedSessionImageCache,
} from '../src/lib/session-image-cache';

const identity = {
  workspaceId: 'preview-workspace' as WorkspaceId,
  sessionId: 'preview-session' as SessionId,
  imageId: 'preview-image',
};
const blobs = new Map<string, Blob>();
let nextUrl = 0;

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL(blob: Blob) {
        const url = `blob:cache-${++nextUrl}`;
        blobs.set(url, blob);
        return url;
      }
      static revokeObjectURL(url: string) {
        blobs.delete(url);
      }
    }
  );
  // A seeded upload must work with no network available.
  vi.stubGlobal('fetch', async () => {
    throw new Error('Network unavailable');
  });
});

afterEach(() => {
  clearSessionImageCache();
  blobs.clear();
  vi.unstubAllGlobals();
});

it('makes uploaded bytes synchronously available and reuses them for every thumbnail size', async () => {
  const source = new Blob(['synthetic image'], { type: 'image/png' });
  await seedSessionImageCache(identity, source);
  const url = peekSessionImageUrl(identity);
  expect(blobs.get(url!)).toBe(source);
  for (const thumbnailWidth of [96, 160, 320]) {
    expect(
      await getSessionImageBlobUrl({
        ...identity,
        token: 'token',
        variant: 'thumbnail',
        thumbnailWidth,
      })
    ).toBe(url);
  }
  expect(await getSessionImageBlobUrl({ ...identity, token: 'token' })).toBe(url);
});

it.each([
  { workspaceId: 'other-workspace' as WorkspaceId },
  { sessionId: 'other-session' as SessionId },
  { imageId: 'other-image' },
])('does not reuse uploaded bytes across a different identity: %j', async (change) => {
  await seedSessionImageCache(identity, new Blob(['private source']));
  const other = { ...identity, ...change };
  expect(peekSessionImageUrl(other)).toBeNull();
  await expect(getSessionImageBlobUrl({ ...other, token: 'token' })).rejects.toThrow(
    'Network unavailable'
  );
});

it('prepares the native iOS data URL before releasing the source', async () => {
  // jsdom's FileReader operates on its own Blob implementation.
  await seedSessionImageCache(identity, new window.Blob(['image'], { type: 'image/png' }), true);
  const url = peekSessionImageUrl(identity, true);
  expect(url).toBe('data:image/png;base64,aW1hZ2U=');
  expect(await getSessionImageDataUrl({ ...identity, token: 'token', variant: 'thumbnail' })).toBe(
    url
  );
});

it('revokes cached previews when the cache is cleared', async () => {
  await seedSessionImageCache(identity, new Blob(['source']));
  const url = peekSessionImageUrl(identity);
  expect(blobs.has(url!)).toBe(true);
  clearSessionImageCache();
  expect(blobs.has(url!)).toBe(false);
  expect(peekSessionImageUrl(identity)).toBeNull();
});

it('waits for local image decoding before publishing the handoff URL', async () => {
  const started = Promise.withResolvers<string>();
  const finish = Promise.withResolvers<void>();
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      decode() {
        started.resolve(this.src);
        return finish.promise;
      }
    }
  );
  const seeding = seedSessionImageCache(identity, new Blob(['source']));
  const decodedUrl = await started.promise;
  expect(peekSessionImageUrl(identity)).toBeNull();
  finish.resolve();
  await seeding;
  expect(peekSessionImageUrl(identity)).toBe(decodedUrl);
});

it('releases an undecodable preview without publishing it', async () => {
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      async decode() {
        throw new Error('Unable to decode');
      }
    }
  );
  await expect(seedSessionImageCache(identity, new Blob(['invalid']))).rejects.toThrow(
    'Unable to decode'
  );
  expect(peekSessionImageUrl(identity)).toBeNull();
  expect(blobs.size).toBe(0);
});

it.each(['clear', 'cancel'] as const)(
  'releases a decoded preview that finishes after %s',
  async (action) => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        decode() {
          started.resolve();
          return finish.promise;
        }
      }
    );
    const controller = new AbortController();
    const seeding = seedSessionImageCache(identity, new Blob(['source']), false, controller.signal);
    await started.promise;
    if (action === 'clear') clearSessionImageCache();
    else controller.abort();
    finish.resolve();
    await seeding;
    expect(peekSessionImageUrl(identity)).toBeNull();
    expect(blobs.size).toBe(0);
  }
);

it.each(['clear', 'cancel'] as const)(
  'does not publish a late native preview after %s',
  async (action) => {
    let complete!: () => void;
    vi.stubGlobal(
      'FileReader',
      class {
        result = 'data:image/png;base64,aW1hZ2U=';
        onload?: () => void;
        readAsDataURL() {
          complete = () => this.onload?.();
        }
      }
    );
    const controller = new AbortController();
    const seeding = seedSessionImageCache(identity, new Blob(['source']), true, controller.signal);
    if (action === 'clear') clearSessionImageCache();
    else controller.abort();
    complete();
    await seeding;
    expect(peekSessionImageUrl(identity)).toBeNull();
    expect(blobs.size).toBe(0);
  }
);

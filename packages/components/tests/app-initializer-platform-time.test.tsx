// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  LOCAL_PLATFORM_CAPABILITIES,
  createStaticStore,
  type CloudApi,
  type PlatformCapabilities,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { resetTimeSync, getServerTimeOffset, isTimeSynced } from '@lody/shared';
import AppInitializer from '../src/components/AppInitializer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const unusedCloudApi = {} as CloudApi;

function createProvider(capabilities: PlatformCapabilities): PlatformProvider {
  const cloud = capabilities.has('cloudSync');
  return {
    kind: cloud ? 'cloud' : 'local',
    identity: {
      session: createStaticStore({ status: 'unauthenticated' as const }),
      signOut: () => Promise.resolve(),
    },
    workspaces: {
      state: createStaticStore({
        status: 'ready' as const,
        workspaces: [],
        activeWorkspaceId: null,
      }),
      setActive: () => Promise.resolve(),
    },
    capabilities,
    cloudApi: cloud ? unusedCloudApi : null,
    sync: { mode: cloud ? 'cloud' : 'local' },
  };
}

describe('AppInitializer platform time synchronization', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    resetTimeSync();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetTimeSync();
  });

  async function renderWith(platform: PlatformProvider): Promise<void> {
    await act(async () => {
      root.render(
        <PlatformContext.Provider value={platform}>
          <AppInitializer>ready</AppInitializer>
        </PlatformContext.Provider>
      );
      await Promise.resolve();
    });
  }

  it('performs no time-server request on the account-free local platform', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await renderWith(createProvider(LOCAL_PLATFORM_CAPABILITIES));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calibrates against the time endpoint when cloud synchronization is available', async () => {
    const wall = 2_000_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(wall);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ serverTime: wall + 5_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await renderWith(createProvider(CLOUD_PLATFORM_CAPABILITIES));

    expect(isTimeSynced()).toBe(true);
    expect(getServerTimeOffset()).toBe(5_000);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/time$/);
  });

  it('cancels a pending time request when cloud capability is removed', async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => {
            aborted.resolve();
            reject(init.signal?.reason);
          },
          { once: true }
        );
      });
    });
    await renderWith(createProvider(CLOUD_PLATFORM_CAPABILITIES));
    await started.promise;
    await renderWith(createProvider(LOCAL_PLATFORM_CAPABILITIES));
    await aborted.promise;
    expect(isTimeSynced()).toBe(false);
  });
});

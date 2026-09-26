// @vitest-environment jsdom

import React, { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptShortcutRuntime } from '@lody/shared/prompt-shortcuts';

const fixture = vi.hoisted(() => {
  const session = { status: 'authenticated', user: { id: 'user-a' } };
  const makePlatform = () => ({
    capabilities: new Set(['cloudAccount']),
    identity: { session: { get: () => session } },
  });
  return {
    session,
    makePlatform,
    platform: makePlatform(),
    workspaceId: 'workspace-a',
    featureEnabled: true,
    directory: [],
    createRepo: vi.fn(),
    openStore: vi.fn(),
    closeStore: vi.fn(),
  };
});

vi.mock('jotai', () => ({
  useAtomValue: (atom: string) =>
    atom === 'feature' ? fixture.featureEnabled : { workspaceId: fixture.workspaceId },
}));
vi.mock('@/atoms/settings', () => ({ promptShortcutsFeatureEnabledAtom: 'feature' }));
vi.mock('@/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: 'workspace' }));
vi.mock('@/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: ({ enabled }: { enabled: boolean }) => ({
    enabled,
    workspaceId: fixture.workspaceId,
  }),
}));
vi.mock('@lody/platform/react', () => ({
  usePlatform: () => fixture.platform,
  usePlatformSession: () => fixture.session,
  useCloudMutation: () => vi.fn(),
  useCloudAction: () => vi.fn(),
  useCloudQuery: () => fixture.directory,
}));
vi.mock('@/lib/cloud-api-operations', () => ({ cloudOperations: { promptShortcuts: {} } }));
vi.mock('loro-repo', () => ({ LoroRepo: { create: fixture.createRepo } }));
vi.mock('loro-repo/storage/indexeddb', () => ({ IndexedDBStorageAdaptor: class {} }));
vi.mock('@lody/shared/prompt-shortcuts', async () => {
  const { PromptShortcutRuntime } = await import('../../shared/src/prompt-shortcuts/runtime');
  return {
    PromptShortcutRuntime,
    LocalShortcutStore: { open: fixture.openStore },
    PromptShortcutSync: class {
      async dispose() {}
    },
    shortcutByteLength: (value: string) => value.length,
  };
});

import {
  PromptShortcutProvider,
  usePromptShortcuts,
} from '../src/providers/prompt-shortcut-provider';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PromptShortcutProvider lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: PromptShortcutRuntime | null;
  let rendered: (PromptShortcutRuntime | null)[];

  function Consumer() {
    const shortcuts = usePromptShortcuts();
    current = shortcuts.runtime;
    rendered.push(current);
    return createElement('p', null, shortcuts.loading ? 'loading' : current?.workspaceId);
  }

  async function render(enabled = true) {
    await act(async () => {
      root.render(
        <StrictMode>
          <PromptShortcutProvider enabled={enabled}>
            <Consumer />
          </PromptShortcutProvider>
        </StrictMode>
      );
    });
  }

  beforeEach(() => {
    fixture.workspaceId = 'workspace-a';
    fixture.featureEnabled = true;
    fixture.platform = fixture.makePlatform();
    fixture.closeStore.mockReset().mockResolvedValue(undefined);
    fixture.createRepo.mockReset().mockImplementation(async () => ({ destroy: async () => {} }));
    fixture.openStore.mockReset().mockImplementation(async (identity) => ({
      ...identity,
      discovery: () => ({ directory: [], entries: [] }),
      list: () => [],
      applyRemoteDeletions: async () => {},
      cacheDiscovery: async () => {},
      dispose: () => fixture.closeStore(),
    }));
    current = null;
    rendered = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it.each(['readiness', 'feature', 'workspace'] as const)(
    'never resurrects a disposed runtime after %s returns to the same scope',
    async (transition) => {
      await render();
      const first = current!;
      expect(container.textContent).toBe('workspace-a');

      if (transition === 'feature') fixture.featureEnabled = false;
      if (transition === 'workspace') fixture.workspaceId = 'workspace-b';
      await render(transition !== 'readiness');
      expect(() => first.setDirectory([])).toThrow('Shortcut runtime disposed');

      const opening = deferred();
      fixture.createRepo.mockImplementationOnce(async () => {
        await opening.promise;
        return { destroy: async () => {} };
      });
      fixture.featureEnabled = true;
      fixture.workspaceId = 'workspace-a';
      rendered = [];
      await render();
      expect(current).toBeNull();
      expect(container.textContent).toBe('loading');
      expect(rendered).not.toContain(first);
      await act(async () => window.dispatchEvent(new Event('online')));

      await act(async () => opening.resolve());
      expect(current).not.toBeNull();
      expect(current).not.toBe(first);
      expect(container.textContent).toBe('workspace-a');
      await expect(current!.setDirectory([])).resolves.toBeUndefined();
    }
  );

  it('keeps the old runtime hidden until its durable close finishes', async () => {
    await render();
    const first = current!;
    const closing = deferred();
    fixture.closeStore.mockImplementationOnce(() => closing.promise);
    await render(false);
    rendered = [];
    await render();
    expect(current).toBeNull();
    expect(rendered).not.toContain(first);
    expect(container.textContent).toBe('loading');

    await act(async () => closing.resolve());
    expect(current).not.toBeNull();
    expect(current).not.toBe(first);
    expect(container.textContent).toBe('workspace-a');
  });

  it('fences a replacement platform before publishing its new runtime', async () => {
    await render();
    const first = current!;
    const opening = deferred();
    fixture.createRepo.mockImplementationOnce(async () => {
      await opening.promise;
      return { destroy: async () => {} };
    });
    fixture.platform = fixture.makePlatform();
    rendered = [];
    await render();
    expect(current).toBeNull();
    expect(rendered).not.toContain(first);

    await act(async () => opening.resolve());
    expect(current).not.toBeNull();
    expect(current).not.toBe(first);
    expect(container.textContent).toBe('workspace-a');
  });
});

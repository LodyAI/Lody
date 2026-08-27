// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { setWorkspaceContextAtom } from '../src/atoms/workspace-context';
import { docMetaCacheScopeAtom } from '../src/atoms/doc-meta';
import { runtimeAtom } from '../src/atoms/runtime';
import { WorkspaceRouteTargetProvider } from '../src/providers/workspace-route-target';
import {
  useResolvedWorkspaceScope,
  type WorkspaceScopeOptions,
} from '../src/hooks/use-resolved-workspace-scope';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ScopeSnapshot = ReturnType<typeof useResolvedWorkspaceScope>;

function ScopeProbe({
  options,
  onSnapshot,
}: {
  options?: WorkspaceScopeOptions;
  onSnapshot: (snapshot: ScopeSnapshot) => void;
}) {
  const snapshot = useResolvedWorkspaceScope(options);
  useEffect(() => onSnapshot(snapshot), [onSnapshot, snapshot]);
  return null;
}

describe('useResolvedWorkspaceScope', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  async function render(node: ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(node));
  }

  it('fails closed under a new route while its runtime and doc-meta scope are not ready', async () => {
    const store = createStore();
    store.set(setWorkspaceContextAtom, {
      slug: 'workspace-a',
      workspaceId: 'workspace-a-id' as WorkspaceId,
    });
    let snapshot: ScopeSnapshot | undefined;

    await render(
      createElement(
        Provider,
        { store },
        createElement(
          WorkspaceRouteTargetProvider,
          { slug: 'workspace-b' },
          createElement(ScopeProbe, {
            onSnapshot: (value) => {
              snapshot = value;
            },
          })
        )
      )
    );

    expect(snapshot).toEqual({ workspaceId: null, enabled: false });
  });

  it('fails closed when the authoritative id disagrees with a same-slug cached runtime', async () => {
    const store = createStore();
    const runtime = {
      workspaceSlug: 'workspace-a',
      workspaceId: 'cached-workspace-a-id' as WorkspaceId,
    } as WorkspaceRuntime;
    store.set(runtimeAtom, runtime);
    store.set(docMetaCacheScopeAtom, {
      runtime,
      workspaceId: runtime.workspaceId,
      workspaceSlug: runtime.workspaceSlug,
      ready: true,
    });
    store.set(setWorkspaceContextAtom, {
      slug: 'workspace-a',
      workspaceId: 'server-workspace-a-id' as WorkspaceId,
    });
    let snapshot: ScopeSnapshot | undefined;

    await render(
      createElement(
        Provider,
        { store },
        createElement(
          WorkspaceRouteTargetProvider,
          { slug: 'workspace-a' },
          createElement(ScopeProbe, {
            onSnapshot: (value) => {
              snapshot = value;
            },
          })
        )
      )
    );

    expect(snapshot).toEqual({ workspaceId: null, enabled: false });
  });

  it('preserves the default workspace identity outside a workspace route provider', async () => {
    const store = createStore();
    store.set(setWorkspaceContextAtom, {
      slug: 'workspace-a',
      workspaceId: 'workspace-a-id' as WorkspaceId,
    });
    let snapshot: ScopeSnapshot | undefined;

    await render(
      createElement(
        Provider,
        { store },
        createElement(ScopeProbe, {
          onSnapshot: (value) => {
            snapshot = value;
          },
        })
      )
    );

    expect(snapshot).toEqual({
      workspaceId: 'workspace-a-id',
      enabled: true,
    });
  });
});

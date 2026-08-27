import { atom, createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@lody/shared';

import {
  clearWorkspaceContextForSlugAtom,
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  setWorkspaceContextAtom,
} from '../src/atoms/workspace-context';

const workspaceIdentityAtom = atom((get) => ({
  slug: get(currentWorkspaceSlugAtom),
  workspaceId: get(currentWorkspaceIdAtom),
}));

const workspaceId = (value: string) => value as WorkspaceId;

describe('workspace context atoms', () => {
  it('publishes a complete workspace identity in one observable update', () => {
    const store = createStore();
    store.set(setWorkspaceContextAtom, {
      slug: 'workspace-a',
      workspaceId: workspaceId('workspace-a-id'),
    });

    const observed: Array<{ slug: string | null; workspaceId: WorkspaceId | null }> = [];
    const unsubscribe = store.sub(workspaceIdentityAtom, () => {
      observed.push(store.get(workspaceIdentityAtom));
    });

    store.set(setWorkspaceContextAtom, {
      slug: 'workspace-b',
      workspaceId: workspaceId('workspace-b-id'),
    });
    unsubscribe();

    expect(observed).toEqual([{ slug: 'workspace-b', workspaceId: workspaceId('workspace-b-id') }]);
  });

  it('clears the previous id in the same update when the route slug changes', () => {
    const store = createStore();
    store.set(setWorkspaceContextAtom, {
      slug: 'workspace-a',
      workspaceId: workspaceId('workspace-a-id'),
    });

    store.set(currentWorkspaceSlugAtom, 'workspace-b');

    expect(store.get(workspaceIdentityAtom)).toEqual({
      slug: 'workspace-b',
      workspaceId: null,
    });
  });

  it('does not let an old route cleanup clear a newer target', () => {
    const store = createStore();
    store.set(setWorkspaceContextAtom, {
      slug: 'workspace-c',
      workspaceId: workspaceId('workspace-c-id'),
    });

    store.set(clearWorkspaceContextForSlugAtom, 'workspace-b');

    expect(store.get(workspaceIdentityAtom)).toEqual({
      slug: 'workspace-c',
      workspaceId: workspaceId('workspace-c-id'),
    });
  });

  it('preserves a cached id when the same slug is republished', () => {
    const store = createStore();
    store.set(setWorkspaceContextAtom, {
      slug: 'workspace-a',
      workspaceId: workspaceId('workspace-a-id'),
    });

    store.set(currentWorkspaceSlugAtom, 'workspace-a');

    expect(store.get(workspaceIdentityAtom)).toEqual({
      slug: 'workspace-a',
      workspaceId: workspaceId('workspace-a-id'),
    });
  });

  it('keeps compatibility with setup code that stages the id before its initial slug', () => {
    const store = createStore();
    store.set(currentWorkspaceIdAtom, workspaceId('workspace-a-id'));
    store.set(currentWorkspaceSlugAtom, 'workspace-a');

    expect(store.get(workspaceIdentityAtom)).toEqual({
      slug: 'workspace-a',
      workspaceId: workspaceId('workspace-a-id'),
    });
  });
});

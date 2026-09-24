import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@lody/shared';

import { localProjectOrderAtom, moveLocalProjectOrder } from '../src/atoms/sidebar-state';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';

const workspaceId = (value: string) => value as WorkspaceId;

describe('sidebar local project order', () => {
  it('moves visible peers while retaining temporarily hidden and other-machine entries', () => {
    expect(
      moveLocalProjectOrder(
        ['machine-a:project-1', 'machine-a:hidden', 'machine-a:project-2', 'machine-b:project-1'],
        ['machine-a:project-1', 'machine-a:project-2'],
        'machine-a:project-2',
        'machine-a:project-1'
      )
    ).toEqual([
      'machine-a:project-2',
      'machine-a:project-1',
      'machine-a:hidden',
      'machine-b:project-1',
    ]);
  });

  it('keeps an independent machine-qualified order for each workspace', () => {
    const store = createStore();

    store.set(currentWorkspaceIdAtom, workspaceId('workspace-a'));
    store.set(localProjectOrderAtom, ['machine-a:project-2', 'machine-a:project-1']);

    store.set(currentWorkspaceIdAtom, workspaceId('workspace-b'));
    expect(store.get(localProjectOrderAtom)).toEqual([]);
    store.set(localProjectOrderAtom, ['machine-b:project-1']);

    store.set(currentWorkspaceIdAtom, workspaceId('workspace-a'));
    expect(store.get(localProjectOrderAtom)).toEqual([
      'machine-a:project-2',
      'machine-a:project-1',
    ]);

    store.set(currentWorkspaceIdAtom, workspaceId('workspace-b'));
    expect(store.get(localProjectOrderAtom)).toEqual(['machine-b:project-1']);
  });

  it('does not persist an order before a workspace is resolved', () => {
    const store = createStore();

    store.set(localProjectOrderAtom, ['machine-a:project-1']);

    expect(store.get(localProjectOrderAtom)).toEqual([]);
  });
});

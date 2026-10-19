import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import type { MachineId, WorkspaceId } from '@lody/shared';
import { compareSidebarMachineOrder } from '../src/components/sidebar-machine-order';

import { localProjectOrderAtom, moveLocalProjectOrder } from '../src/atoms/sidebar-state';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';

const workspaceId = (value: string) => value as WorkspaceId;

describe('sidebar local project order', () => {
  it('orders the desktop, owned machines, then teammate machines with deterministic ties', () => {
    const machines = [
      { id: 'team' as MachineId, name: 'A', ownerUserId: 'user-2' },
      { id: 'own-z' as MachineId, name: 'B', ownerUserId: 'user-1' },
      { id: 'local' as MachineId, name: 'Z', ownerUserId: 'user-1' },
      { id: 'own-b' as MachineId, name: 'A', ownerUserId: 'user-1' },
      { id: 'own-a' as MachineId, name: 'A', ownerUserId: 'user-1' },
    ];
    expect(
      machines
        .sort((left, right) =>
          compareSidebarMachineOrder(left, right, 'local' as MachineId, 'user-1')
        )
        .map((machine) => machine.id)
    ).toEqual(['local', 'own-a', 'own-b', 'own-z', 'team']);
  });

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

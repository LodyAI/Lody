// @vitest-environment jsdom

import { createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ElectronCliState, MachineId } from '@lody/shared';
import {
  lastKnownLocalMachineIdAtom,
  localCliStartingAtom,
  localMachineIdAtom,
  localProbeEffectAtom,
} from '../src/atoms/local-probe';
import { compareSidebarMachineOrder } from '../src/components/sidebar-machine-order';

const localMachineId = 'machine-local' as MachineId;
const machines = [
  { id: 'machine-remote' as MachineId, name: 'Agent host', ownerUserId: 'user-1' },
  { id: localMachineId, name: 'Desktop', ownerUserId: 'user-1' },
];

function cliState(overrides: Partial<ElectronCliState> = {}): ElectronCliState {
  return {
    phase: 'running',
    desiredState: 'running',
    localAgentEnabled: true,
    preventSleepEnabled: false,
    updatedAtMs: 1,
    startupStage: 'ready',
    runtime: {
      schemaVersion: 1,
      phase: 'running',
      machineId: localMachineId,
      pid: 123,
      updatedAtMs: 1,
      issues: [],
    },
    ...overrides,
  };
}

describe('desktop machine presentation identity', () => {
  let store: ReturnType<typeof createStore>;
  let stateListener: ((state: unknown) => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let resolveInitialState: (state: ElectronCliState) => void;
  let rejectInitialState: (error: Error) => void;

  beforeEach(() => {
    store = createStore();
    const initialState = new Promise<ElectronCliState>((resolve, reject) => {
      resolveInitialState = resolve;
      rejectInitialState = reject;
    });
    window.__LODY_ELECTRON__ = true;
    window.ipc = {
      invoke: () => initialState,
      on: (channel, listener) => {
        if (channel === 'cli.state') stateListener = listener;
        return () => {
          stateListener = undefined;
        };
      },
      send: () => {},
    };
    unsubscribe = store.sub(localProbeEffectAtom, () => {});
  });

  afterEach(() => {
    unsubscribe?.();
    delete window.ipc;
    delete window.__LODY_ELECTRON__;
  });

  function orderedMachines() {
    return [...machines]
      .sort((left, right) =>
        compareSidebarMachineOrder(left, right, store.get(lastKnownLocalMachineIdAtom), 'user-1')
      )
      .map((machine) => machine.id);
  }

  it('keeps machine groups in place through repeated CLI outages without retaining live routing', async () => {
    expect(store.get(lastKnownLocalMachineIdAtom)).toBeNull();
    resolveInitialState(cliState());
    await Promise.resolve();
    const initialOrder = orderedMachines();
    expect(initialOrder).toEqual([localMachineId, 'machine-remote']);

    for (const phase of ['reconnecting', 'offline', 'starting', 'fatal', 'stopped'] as const) {
      stateListener!(cliState({ phase, runtime: undefined, startupStage: undefined }));
      expect(store.get(localMachineIdAtom)).toBeNull();
      expect(store.get(localCliStartingAtom)).toBe(
        phase === 'reconnecting' || phase === 'starting'
      );
      expect(orderedMachines()).toEqual(initialOrder);

      stateListener!(cliState());
      expect(store.get(localMachineIdAtom)).toBe(localMachineId);
      expect(orderedMachines()).toEqual(initialOrder);
    }
  });

  it('clears the presentation identity when the user disables the local agent', () => {
    stateListener!(cliState());
    stateListener!(cliState({ localAgentEnabled: false }));
    expect(store.get(lastKnownLocalMachineIdAtom)).toBeNull();
    expect(store.get(localMachineIdAtom)).toBeNull();
    expect(orderedMachines()).toEqual(['machine-remote', localMachineId]);
  });

  it('replaces the remembered identity when the CLI reports a different machine', () => {
    stateListener!(cliState());
    stateListener!(cliState({ runtime: { ...cliState().runtime!, machineId: 'machine-remote' } }));
    expect(store.get(lastKnownLocalMachineIdAtom)).toBe('machine-remote');
    expect(orderedMachines()).toEqual(['machine-remote', localMachineId]);
  });

  it('keeps a pushed presentation identity when the initial IPC read fails', async () => {
    stateListener!(cliState());
    rejectInitialState(new Error('IPC read failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get(localMachineIdAtom)).toBeNull();
    expect(orderedMachines()).toEqual([localMachineId, 'machine-remote']);
  });
});

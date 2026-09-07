// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMachineFlockDocId,
  getWorkspaceFlockDocId,
  readMachineFlockRowsFromFlock,
  workspaceFlockKeys,
  type McpServerId,
} from '@lody/shared';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import {
  createTourStore,
  DEFAULT_TOUR_IDENTITY,
  TOUR_MACHINE_ID,
  TOUR_WORKSPACE_ID,
} from '../src/components/onboarding/tour/tour-fixtures';
import {
  acquireWorkspaceCatalog,
  type WorkspaceCatalogSnapshot,
} from '../src/lib/workspace-catalog-room';

// The tour repo answers with already-resolved promises, so draining microtasks
// settles every read deterministically — no timers, no wall clock.
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve();
  }
};

const tourRuntime = (): WorkspaceRuntime => {
  const runtime = createTourStore(DEFAULT_TOUR_IDENTITY).get(runtimeAtom);
  if (!runtime) throw new Error('The tour store must publish a runtime');
  return runtime;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the tour repo', () => {
  it('lets the reused product components read the workspace catalog instead of failing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const snapshots: WorkspaceCatalogSnapshot[] = [];
    const lease = acquireWorkspaceCatalog(tourRuntime(), (snapshot) => snapshots.push(snapshot));

    await settle();

    // Authoritative empty, not "still loading": the composer's Role and MCP
    // surfaces must be able to tell the difference.
    const latest = snapshots.at(-1) ?? lease.snapshot;
    expect(latest.synced).toBe(true);
    expect(latest.servers).toEqual([]);
    expect(latest.roles).toEqual([]);
    expect(errors).not.toHaveBeenCalled();

    lease.release();
  });

  it('opens the machine Flock documents the composer reads for its run options', async () => {
    const handle = await tourRuntime().repo.openFlockDoc(
      getMachineFlockDocId(TOUR_WORKSPACE_ID, TOUR_MACHINE_ID)
    );

    expect(readMachineFlockRowsFromFlock(handle.flock)).toEqual({});
    await expect(handle.joinRoom()).resolves.toBeDefined();
  });

  it('refuses a write rather than letting a scripted surface believe it persisted one', async () => {
    const handle = await tourRuntime().repo.openFlockDoc(getWorkspaceFlockDocId(TOUR_WORKSPACE_ID));

    expect(() =>
      handle.flock.set(workspaceFlockKeys.mcpServer('mcp-1' as McpServerId), { id: 'mcp-1' })
    ).toThrow(/does not persist/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  isLocalPlaneFilePathsSource,
  type LocalProjectFilePathsSource,
} from '../src/hooks/use-local-project-file-paths';

const project = (machineId?: string): LocalProjectFilePathsSource => ({
  kind: 'project',
  workspaceId: 'lw_1',
  ...(machineId ? { machineId } : {}),
  localProjectId: 'lp_1',
});

const localIpc = { localMachineId: 'machine-local', hasLocalIpc: true };

// This predicate decides what the mention menu is allowed to re-request on every
// `@`. On the local plane that is a process spawn on this machine; anywhere else
// the identical call is a full project listing across the network, once per menu
// open. The two must not be confused for each other, which is why the transport
// choice and this answer come from one function.
describe('isLocalPlaneFilePathsSource', () => {
  it('accepts a project on the machine running this renderer', () => {
    expect(isLocalPlaneFilePathsSource(project('machine-local'), localIpc)).toBe(true);
  });

  it('accepts a project that names no machine, which means this one', () => {
    expect(isLocalPlaneFilePathsSource(project(), localIpc)).toBe(true);
  });

  it('rejects another machine, whose listing crosses the network', () => {
    // Chat Landing builds a `local` source for whichever machine holds the
    // project, so "local source" and "local plane" are not the same question.
    expect(isLocalPlaneFilePathsSource(project('machine-remote'), localIpc)).toBe(false);
  });

  it('rejects every source when there is no IPC bridge to answer over', () => {
    expect(
      isLocalPlaneFilePathsSource(project('machine-local'), {
        localMachineId: 'machine-local',
        hasLocalIpc: false,
      })
    ).toBe(false);
  });

  it('rejects a project when no local daemon has announced itself yet', () => {
    expect(
      isLocalPlaneFilePathsSource(project('machine-local'), {
        localMachineId: null,
        hasLocalIpc: true,
      })
    ).toBe(false);
  });

  it('accepts a Session worktree, which only the local IPC service can serve', () => {
    expect(
      isLocalPlaneFilePathsSource({ kind: 'worktree', repoKey: 'lodyai/lody', sessionId: 's1' }, {
        localMachineId: null,
        hasLocalIpc: true,
      })
    ).toBe(true);
  });

  it('rejects an absent source', () => {
    expect(isLocalPlaneFilePathsSource(undefined, localIpc)).toBe(false);
  });
});

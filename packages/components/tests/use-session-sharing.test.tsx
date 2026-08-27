// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const visibilityMocks = vi.hoisted(() => ({
  useVisibleLocalProjects: vi.fn(),
  useVisibleMachineMetas: vi.fn(),
}));
const convexProviderMock = vi.hoisted(() => ({
  useAuthClient: () => ({
    useActiveOrganization: () => ({
      data: { id: 'workspace-1', members: [{ userId: 'user-1' }, { userId: 'user-2' }] },
    }),
  }),
}));

vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useAtomValue: (atom: string) => (atom === 'userAtom' ? { id: 'user-1' } : 'workspace-1'),
}));

vi.mock('@/atoms', () => ({
  currentWorkspaceIdAtom: 'workspaceAtom',
  userAtom: 'userAtom',
}));

vi.mock('convex/react', () => ({
  useMutation: () => vi.fn(),
}));

vi.mock('@lody/cloud-api', () => ({
  api: {
    localProjects: { setLocalProjectSharedWithTeam: 'setLocalProjectSharedWithTeam' },
    machines: { setMachineSharedWithTeam: 'setMachineSharedWithTeam' },
  },
}));

vi.mock('@/hooks/use-visible-local-projects', () => ({
  useVisibleLocalProjects: visibilityMocks.useVisibleLocalProjects,
}));
vi.mock('../src/hooks/use-visible-local-projects', () => ({
  useVisibleLocalProjects: visibilityMocks.useVisibleLocalProjects,
}));

vi.mock('@/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: visibilityMocks.useVisibleMachineMetas,
}));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: visibilityMocks.useVisibleMachineMetas,
}));

vi.mock('@/providers/convex-provider', () => convexProviderMock);
vi.mock('../src/providers/convex-provider', () => convexProviderMock);

import { useSessionSharing } from '../src/hooks/use-session-sharing';
import { TestCloudPlatformProvider } from './test-platform';

const machineId = 'machine-1' as MachineId;
const projectId = 'project-1' as LocalProjectId;
const privateProject = {
  key: `${machineId}:${projectId}`,
  machineId,
  machine: {
    id: machineId,
    name: 'Machine 1',
    ownerUserId: 'user-1',
  },
  project: {
    id: projectId,
    name: 'Private project',
    rootPath: '/repo/private',
    createdAtMs: 1,
  },
  isMachineRegistered: true,
};

type SharingResult = ReturnType<typeof useSessionSharing>;

function Probe({
  includeLocalProjectDetails,
  onResult,
}: {
  includeLocalProjectDetails?: boolean;
  onResult: (result: SharingResult) => void;
}) {
  const result = useSessionSharing(
    includeLocalProjectDetails ? { includeLocalProjectDetails: true } : undefined
  );
  useEffect(() => {
    onResult(result);
  }, [onResult, result]);
  return null;
}

describe('useSessionSharing project visibility', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it('loads machine Flock projects only when the consumer requests them', () => {
    visibilityMocks.useVisibleMachineMetas.mockReturnValue({
      machines: new Map(),
      accessByMachineId: new Map(),
      isLoading: false,
    });
    visibilityMocks.useVisibleLocalProjects.mockImplementation(
      (options: { includeMachineFlock?: boolean }) => ({
        projects: options.includeMachineFlock
          ? new Map([[privateProject.key, privateProject]])
          : new Map(),
        accessByProjectKey: new Map(),
        isLoading: false,
      })
    );

    const results: SharingResult[] = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        createElement(
          TestCloudPlatformProvider,
          null,
          createElement(Probe, {
            onResult: (result) => results.push(result),
          })
        )
      );
    });

    expect(results.at(-1)?.projects.size).toBe(0);
    expect(visibilityMocks.useVisibleLocalProjects).toHaveBeenCalledWith({
      includeMachineFlock: false,
      syncMachineFlock: false,
      workspaceId: 'workspace-1',
      enabled: true,
    });

    visibilityMocks.useVisibleLocalProjects.mockClear();
    act(() => {
      root?.render(
        createElement(
          TestCloudPlatformProvider,
          null,
          createElement(Probe, {
            includeLocalProjectDetails: true,
            onResult: (result) => results.push(result),
          })
        )
      );
    });

    expect(results.at(-1)?.projects.get(privateProject.key)?.project.name).toBe('Private project');
    expect(visibilityMocks.useVisibleMachineMetas).toHaveBeenCalledWith({
      includeMachineFlock: false,
      workspaceId: 'workspace-1',
      enabled: true,
    });
    expect(visibilityMocks.useVisibleLocalProjects).toHaveBeenCalledWith({
      includeMachineFlock: true,
      syncMachineFlock: false,
      workspaceId: 'workspace-1',
      enabled: true,
    });
  });
});

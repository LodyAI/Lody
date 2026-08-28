// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineCloudMutation, defineCloudQuery, type PlatformProvider } from '@lody/platform';
import {
  PlatformContext,
  useCloudMutation,
  useCloudQuery,
  usePlatformSession,
  usePlatformWorkspaces,
} from '@lody/platform/react';
import { cloudOperations } from '../src/lib/cloud-api-operations';
import { useAuthenticatedConvex } from '../src/hooks/use-authenticated-convex';
import { TourCloudBoundary } from '../src/components/onboarding/tour/tour-cloud-boundary';
import {
  DEFAULT_TOUR_IDENTITY,
  TOUR_LOCAL_PROJECT_ID,
  TOUR_MACHINE_ID,
  TOUR_WORKSPACE_ID,
} from '../src/components/onboarding/tour/tour-fixtures';
import { TEST_CLOUD_PLATFORM } from './test-platform';

const UNKNOWN_TOUR_QUERY = defineCloudQuery<{ workspaceId: string }, string[]>(
  'remoteMachines',
  'machines:futureTourRead'
);
const TOUR_MUTATION = defineCloudMutation<Record<string, never>, void>(
  'remoteMachines',
  'machines:futureTourWrite'
);

type TourCloudSnapshot = {
  authenticated: boolean;
  machineIds: string[];
  localProjectIds: string[];
  sessionName: string | null;
  workspaceName: string | null;
  unknownQueryResult: string[] | undefined;
  invokeMutation: () => Promise<void>;
};

function TourCloudProbe({ onSnapshot }: { onSnapshot: (snapshot: TourCloudSnapshot) => void }) {
  const { isAuthenticated } = useAuthenticatedConvex();
  const machines = useCloudQuery(cloudOperations.machines.listVisibleMachines, {
    workspaceId: 'onboarding-tour-workspace',
  });
  const localProjects = useCloudQuery(cloudOperations.localProjects.listVisibleLocalProjects, {
    workspaceId: TOUR_WORKSPACE_ID,
  });
  const unknownQueryResult = useCloudQuery(UNKNOWN_TOUR_QUERY, {
    workspaceId: TOUR_WORKSPACE_ID,
  });
  const invokeMutation = useCloudMutation(TOUR_MUTATION);
  const session = usePlatformSession();
  const workspaces = usePlatformWorkspaces();

  useEffect(() => {
    onSnapshot({
      authenticated: isAuthenticated,
      machineIds: (machines ?? []).map((row) => row.machineId),
      localProjectIds: (localProjects ?? []).map((row) => row.localProjectId),
      sessionName: session.status === 'authenticated' ? session.user.name : null,
      workspaceName: workspaces.workspaces[0]?.name ?? null,
      unknownQueryResult,
      invokeMutation,
    });
  }, [
    invokeMutation,
    isAuthenticated,
    localProjects,
    machines,
    onSnapshot,
    session,
    unknownQueryResult,
    workspaces,
  ]);

  return null;
}

describe('TourCloudBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('serves authenticated fixture visibility without reaching the outer cloud API', async () => {
    const useOuterCloudQuery = vi.fn(() => {
      throw new Error('Tour query escaped to the real cloud adapter');
    });
    const outerPlatform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useQuery: useOuterCloudQuery,
      },
    };
    let snapshot: TourCloudSnapshot | undefined;

    await act(async () => {
      root.render(
        <PlatformContext.Provider value={outerPlatform}>
          <TourCloudBoundary
            identity={{
              ...DEFAULT_TOUR_IDENTITY,
              userName: 'Ada',
              userEmail: 'ada@example.com',
              workspaceName: 'Ada Lab',
            }}
          >
            <TourCloudProbe
              onSnapshot={(value) => {
                snapshot = value;
              }}
            />
          </TourCloudBoundary>
        </PlatformContext.Provider>
      );
    });

    expect(snapshot).toEqual({
      authenticated: true,
      machineIds: [TOUR_MACHINE_ID],
      localProjectIds: [TOUR_LOCAL_PROJECT_ID],
      sessionName: 'Ada',
      workspaceName: 'Ada Lab',
      unknownQueryResult: undefined,
      invokeMutation: expect.any(Function),
    });
    expect(useOuterCloudQuery).not.toHaveBeenCalled();
    await expect(snapshot?.invokeMutation()).rejects.toThrow(
      'The onboarding tour does not call cloud operations'
    );
  });
});

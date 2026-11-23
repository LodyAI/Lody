// @vitest-environment jsdom

import { act, StrictMode, useEffect, type ReactNode } from 'react';
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

vi.mock('../src/components/sessions/desktop-session-detail-layout', () => ({
  DesktopSessionDetailLayout: ({ chatSurfaces }: { chatSurfaces: ReactNode }) => chatSurfaces,
}));
vi.mock('../src/components/terminal/terminal-dock', () => ({ TerminalDock: () => null }));

import { cloudOperations } from '../src/lib/cloud-api-operations';
import { useAuthenticatedConvex } from '../src/hooks/use-authenticated-convex';
import { TourApp, type TourAppTracks } from '../src/components/onboarding/tour/tour-app';
import { TourCloudBoundary } from '../src/components/onboarding/tour/tour-cloud-boundary';
import {
  DEFAULT_TOUR_IDENTITY,
  TOUR_LOCAL_PROJECT_ID,
  TOUR_MACHINE_ID,
  TOUR_WORKSPACE_ID,
} from '../src/components/onboarding/tour/tour-fixtures';
import { WorkspaceRouteTargetProvider } from '../src/providers/workspace-route-target';
import { initI18n } from '../src/i18n';
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

describe('TourApp real composer', () => {
  const TRACKS: TourAppTracks = {
    reveal: 9,
    tasks: 4,
    archived: 0,
    childTabs: 1,
    subagents: 0,
    panel: 0,
    changes: 0,
    terminal: 0,
    annotation: 0,
    pr: 0,
    typing: 0,
  };

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    HTMLElement.prototype.scrollIntoView = () => {};
    await import('../src/components/ai-gui/markdown-math-copy');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('supplies composer visibility and empty prompt suggestions inside the tour boundary', async () => {
    const useOuterCloudQuery = vi.fn(() => {
      throw new Error('Tour query escaped to the authenticated app cloud adapter');
    });
    const outerPlatform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useQuery: useOuterCloudQuery,
      },
    };

    await act(async () => {
      root.render(
        <StrictMode>
          <PlatformContext.Provider value={outerPlatform}>
            <WorkspaceRouteTargetProvider slug="vault">
              <TourApp
                tracks={TRACKS}
                configurationState={{
                  step: 'workspace',
                  workspaceStatus: 'ready',
                  agentStatus: 'missing',
                  projectStatus: 'missing',
                  promptValue: '',
                  conversationStatus: 'empty',
                }}
                permissionAnswer={null}
                onPermissionAnswer={vi.fn()}
                activeSidePanelTab="changes"
                onSidePanelTabSelect={vi.fn()}
                selectedTaskId="tour-1"
                activeTabIndex={0}
                onSelectTabIndex={vi.fn()}
              />
            </WorkspaceRouteTargetProvider>
          </PlatformContext.Provider>
        </StrictMode>
      );
    });

    expect(container.querySelector('[data-lody-composer-input]')).not.toBeNull();
    expect(useOuterCloudQuery).not.toHaveBeenCalled();
  });
});

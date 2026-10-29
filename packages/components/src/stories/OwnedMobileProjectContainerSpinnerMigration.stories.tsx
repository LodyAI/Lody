import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Provider, createStore } from 'jotai';
import {
  getMachineRoomId,
  type LocalProjectId,
  type MachineId,
  type MachineViewMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { CloudApi } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { MobileGithubProjectSettings } from '../components/mobile/mobile-github-project-settings';
import { MobileLocalProjectSettings } from '../components/mobile/mobile-local-project-settings';
import { AuthenticatedConvexContext } from '../hooks/use-authenticated-convex';
import { userAtom } from '../atoms';
import { machineMetaCacheAtom } from '../atoms/doc-meta';
import { setWorkspaceContextAtom } from '../atoms/workspace-context';
import { TEST_CLOUD_PLATFORM } from '../../tests/test-platform';

const workspaceId = 'synthetic-spinner-workspace' as WorkspaceId;
const machineId = 'synthetic-spinner-machine' as MachineId;
const projectId = 'synthetic-spinner-project' as LocalProjectId;
const ownerId = 'synthetic-spinner-owner';
const machine: MachineViewMeta = {
  id: machineId,
  name: 'Synthetic project device',
  ownerUserId: ownerId,
  hostType: 'user',
  cliVersion: '1.0.0',
  os: 'darwin',
  sessions: [],
  raceLimits: {},
  protocolCapabilities: {},
  localProjects: {
    [projectId]: {
      id: projectId,
      name: 'Synthetic existing project',
      rootPath: '/synthetic/projects/existing',
      createdAtMs: 1,
    },
  },
};
const repos = [
  {
    repoFullName: 'synthetic/example',
    name: 'example',
    repositoryId: 1,
    private: false,
    enabled: true,
  },
];
const machineAccess = [{ machineId, ownerUserId: ownerId, sharedWithTeam: false, updatedAt: 1 }];
type Mode = 'github-loading' | 'local-loading' | 'local-sharing';

function Fixture({ mode, spacing = false }: { mode: Mode; spacing?: boolean }) {
  const [loaded, setLoaded] = useState(mode === 'local-sharing');
  const [pending, setPending] = useState(false);
  const [shared, setShared] = useState(false);
  const desiredRef = useRef(false);
  const resolveRef = useRef<(() => void) | null>(null);
  const [store] = useState(() => {
    const next = createStore();
    next.set(userAtom, {
      id: ownerId,
      name: 'Synthetic user',
      email: 'fixture@example.com',
      image: null,
    });
    next.set(setWorkspaceContextAtom, { workspaceId, slug: 'synthetic-spinner-workspace' });
    if (mode === 'local-sharing')
      next.set(machineMetaCacheAtom, { [getMachineRoomId(machineId)]: machine });
    return next;
  });
  useLayoutEffect(() => {
    if (!spacing) return;
    const root = document.documentElement;
    const old = root.style.getPropertyValue('--spacing');
    root.style.setProperty('--spacing', '5px');
    return () => {
      if (old) root.style.setProperty('--spacing', old);
      else root.style.removeProperty('--spacing');
    };
  }, [spacing]);
  const access = useMemo(
    () => [
      {
        machineId,
        localProjectId: projectId,
        ownerUserId: ownerId,
        sharedWithTeam: shared,
        updatedAt: shared ? 2 : 1,
      },
    ],
    [shared]
  );
  const cloudApi = useMemo<CloudApi>(
    () => ({
      useQuery: (operation, args) => {
        if (args === 'skip') return undefined;
        if (operation.name === 'github:listWorkspaceReposWithStatus')
          return (loaded ? repos : undefined) as never;
        if (operation.name === 'machines:listVisibleMachines')
          return (loaded ? machineAccess : undefined) as never;
        if (operation.name === 'localProjects:listVisibleLocalProjects')
          return (loaded ? access : undefined) as never;
        throw new Error(`Unexpected synthetic project query: ${operation.name}`);
      },
      useMutation: (operation) => async (args) => {
        if (operation.name !== 'localProjects:setLocalProjectSharedWithTeam')
          throw new Error(`Unexpected synthetic project mutation: ${operation.name}`);
        desiredRef.current = (args as { sharedWithTeam: boolean }).sharedWithTeam;
        setPending(true);
        await new Promise<void>((resolve) => {
          resolveRef.current = resolve;
        });
        return undefined as never;
      },
      useAction: (operation) => async () => {
        throw new Error(`Unexpected synthetic project action: ${operation.name}`);
      },
    }),
    [access, loaded]
  );
  return (
    <Provider store={store}>
      <PlatformContext.Provider value={{ ...TEST_CLOUD_PLATFORM, cloudApi }}>
        <AuthenticatedConvexContext.Provider
          value={{
            authSessionId: 'synthetic-project-spinner',
            isAuthenticated: true,
            isLoading: false,
            isRecovering: false,
            confirmedUnauthenticated: false,
            claimAutomaticCommand: () => false,
            requestAuthRecovery: () => {},
          }}
        >
          <main
            data-owned-project-spinner={mode}
            data-loaded={loaded}
            data-pending={pending}
            data-spacing={spacing}
            style={{
              minHeight: '100dvh',
              maxWidth: 640,
              marginInline: 'auto',
              paddingBlock: 16,
              background: 'hsl(var(--background))',
              color: 'hsl(var(--foreground))',
            }}
          >
            <div style={{ display: 'flex', gap: 12, padding: 12 }}>
              <button
                type="button"
                disabled={loaded}
                onClick={() => {
                  store.set(machineMetaCacheAtom, { [getMachineRoomId(machineId)]: machine });
                  setLoaded(true);
                }}
              >
                Resolve synthetic project data
              </button>
              <button
                type="button"
                disabled={!pending}
                onClick={() => {
                  setShared(desiredRef.current);
                  setPending(false);
                  resolveRef.current?.();
                  resolveRef.current = null;
                }}
              >
                Complete synthetic sharing
              </button>
            </div>
            <section data-owned-project-target="">
              {mode === 'github-loading' ? (
                <MobileGithubProjectSettings repoFullName="synthetic/example" />
              ) : (
                <MobileLocalProjectSettings machineId={machineId} projectId={projectId} />
              )}
            </section>
          </main>
        </AuthenticatedConvexContext.Provider>
      </PlatformContext.Provider>
    </Provider>
  );
}
const meta = {
  title: 'Migration/OwnedMobileProjectContainerSpinner',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const GithubLoading: Story = { render: () => <Fixture mode="github-loading" /> };
export const GithubRootSpacing: Story = { render: () => <Fixture mode="github-loading" spacing /> };
export const LocalLoading: Story = { render: () => <Fixture mode="local-loading" /> };
export const LocalRootSpacing: Story = { render: () => <Fixture mode="local-loading" spacing /> };
export const LocalSharing: Story = { render: () => <Fixture mode="local-sharing" /> };
export const LocalSharingRootSpacing: Story = {
  render: () => <Fixture mode="local-sharing" spacing />,
};

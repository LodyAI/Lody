import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { Provider, createStore } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import {
  settingsActiveTabAtom,
  settingsDialogOpenAtom,
  settingsSelectedMachineIdAtom,
  userAtom,
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
} from '@/atoms';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { installCloudHttpPort } from '@/lib/cloud-http-port';
import {
  AGENT_ROLE_VERSION,
  workspaceFlockKeys,
  getMachineRoomId,
  getLodyMachinePresenceKey,
  getServerNow,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  type AgentRole,
  type MachineId,
  type WorkspaceId,
  type MachineMeta,
  type MachineMonitorSnapshot,
  type LodyPresenceInstanceId,
} from '@lody/shared';
import { type CloudApi } from '@lody/platform';
import { PlatformContext, usePlatform } from '@lody/platform/react';
import { machineMetaCacheAtom } from '@/atoms/doc-meta';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import {
  lodyPresenceStatesAtom,
  lodyPresenceSyncStateAtom,
  lodyPresenceNowMsAtom,
} from '@/atoms/presence';

import type { SettingsTabId } from '@/components/settings/settings-tabs';
import { DesktopSettingsModal } from '@/components/settings/desktop-settings-modal';
import { RoutedStory, SettingsStoryProviders } from './settings-story-shell';

/**
 * Desktop settings modal — the overlay that replaces the full-page settings route on
 * non-mobile viewports. These stories open it at low-dependency tabs (General / About);
 * Agent Roles uses a read-only catalog fixture; Machines uses an isolated runtime
 * fixture with the real page. Other runtime-heavy tabs need a live workspace.
 */
function OpenModalAt({ tab, children }: { tab: SettingsTabId; children: ReactNode }) {
  useHydrateAtoms([
    [settingsDialogOpenAtom, true],
    [settingsActiveTabAtom, tab],
  ]);
  return <>{children}</>;
}

const storyRole: AgentRole = {
  v: AGENT_ROLE_VERSION,
  id: 'settings-story-role' as AgentRole['id'],
  ownerUserId: 'settings-story-user',
  visibility: 'private',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId: 'settings-story-machine' as AgentRole['machineId'],
  agentConfigId: 'settings-story-config' as AgentRole['agentConfigId'],
  runConfig: {},
  promptPrefix: 'Check correctness before style.',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

// A read-only catalog fixture: no transport or real workspace writes.
const rolesStoryRuntime = {
  workspaceId: 'settings-story-workspace',
  workspaceSlug: 'lody',
  repo: {
    openFlockDoc: async () => ({
      flock: {
        scan: (options?: { prefix?: readonly unknown[] }) =>
          options?.prefix?.[0] === 'agentRole'
            ? [{ key: workspaceFlockKeys.agentRole(storyRole.id), value: storyRole }]
            : [],
        subscribe: () => () => {},
      },
      joinRoom: async () => ({ unsubscribe: () => {}, firstSyncedWithRemote: Promise.resolve() }),
    }),
  },
} as unknown as WorkspaceRuntime;

function RolesCatalogFixture({ children }: { children: ReactNode }) {
  useHydrateAtoms([
    [runtimeAtom, rolesStoryRuntime],
    [userAtom, { id: storyRole.ownerUserId, name: 'Example user', email: 'user@example.com' }],
  ]);
  return <>{children}</>;
}

// Only data/transport boundaries are synthetic. The modal, navigation, machines
// page, accordion, monitor, recovery form and nested dialog are production components.
const previewWorkspaceId = 'settings-story-workspace' as WorkspaceId;
const previewOwnerId = 'settings-story-user';
const previewSourceId = 'windows-daemon-current' as MachineId;
const previewMachines: MachineMeta[] = [
  {
    id: previewSourceId,
    name: 'Windows 工作机',
    ownerUserId: previewOwnerId,
    os: 'Windows 11',
    cliVersion: '0.104.0',
    sessions: [],
    protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  },
  {
    id: 'windows-daemon-retired' as MachineId,
    name: 'Windows 工作机（重装前）',
    ownerUserId: previewOwnerId,
    os: 'Windows 11',
    cliVersion: '0.103.0',
    sessions: [],
  },
  {
    id: 'macbook-development' as MachineId,
    name: '开发用 MacBook',
    ownerUserId: previewOwnerId,
    os: 'macOS',
    cliVersion: '0.104.0',
    sessions: [],
  },
];
const previewAccess = previewMachines.map((machine) => ({
  machineId: machine.id,
  ownerUserId: previewOwnerId,
  sharedWithTeam: machine.id !== 'windows-daemon-retired',
  updatedAt: 1,
}));
const previewQueries: Record<string, unknown> = {
  'machines:listVisibleMachines': previewAccess,
  'localProjects:listVisibleLocalProjects': [],
  'machineCredentials:getMachineCredentialState': { revocableCount: 1 },
  'machinePairing:listPendingMachinePairings': [],
};
const previewCloudApi: CloudApi = {
  useQuery: (operation, args) =>
    args === 'skip' ? undefined : (previewQueries[operation.name] as never),
  useMutation: () => async () => {
    throw new Error('预览不会更改真实机器。');
  },
  useAction: () => async () => {
    throw new Error('预览不会更改真实机器。');
  },
};

function MachinesCatalogFixture() {
  useLayoutEffect(() => {
    const originalFetch = window.fetch;
    const previewFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://settings-preview.invalid/')) {
        return Promise.resolve(
          url.endsWith('/api/cli/latest-version')
            ? Response.json({ packageName: 'lody', latestVersion: '0.104.0' })
            : Response.json(
                { error: 'Preview only: no real machine is connected.' },
                { status: 503 }
              )
        );
      }
      return originalFetch(input, init);
    };
    const release = installCloudHttpPort({
      authBaseUrl: 'https://settings-preview.invalid',
      serverBaseUrl: null,
    });
    window.fetch = previewFetch;
    return () => {
      if (window.fetch === previewFetch) window.fetch = originalFetch;
      release();
    };
  }, []);
  const parent = usePlatform();
  const platform = useMemo(
    () => ({ ...parent, kind: 'cloud' as const, cloudApi: previewCloudApi }),
    [parent]
  );
  const [store] = useState(() => {
    const next = createStore();
    const snapshot = (machineId: MachineId): MachineMonitorSnapshot => ({
      kind: 'snapshot',
      protocolVersion: 1,
      machineId,
      instanceId: 'storybook',
      updatedAtMs: getServerNow(),
      sampleWindowMs: 2000,
      platform: 'win32',
      cpuLogicalCores: 12,
      deviceCpuCores: 0.12,
      effectiveMemoryBytes: 32 * 1024 ** 3,
      availableMemoryBytes: 24 * 1024 ** 3,
      sessionAccounting: 'process-tree',
      cliControlPlane: {
        memoryBytes: 184 * 1024 ** 2,
        cpuCores: 0.08,
        cpuPercentOfMachine: 0.7,
        processCount: 1,
        memoryKind: 'physical-footprint',
        quality: 'exact-process',
      },
      sessionsAggregate: {
        memoryBytes: 0,
        cpuCores: 0,
        cpuPercentOfMachine: 0,
        processCount: 0,
        memoryKind: 'physical-footprint-sum',
        quality: 'estimated-tree',
      },
      sessions: [],
      sessionsTruncated: false,
      warnings: [],
    });
    const binding = {
      firstSyncedWithRemote: Promise.resolve(),
      getSyncState: () => 'synced',
      subscribeSyncState: () => () => {},
    };
    const runtime = {
      workspaceId: previewWorkspaceId,
      workspaceSlug: 'lody',
      contentMode: 'plaintext',
      accountId: previewOwnerId,
      repo: {
        openFlockDoc: async () => ({
          flock: { scan: () => [], subscribe: () => () => {} },
          joinRoom: async () => ({
            unsubscribe: () => {},
            transportIds: () => ['local'],
            subscription: () => binding,
          }),
        }),
        getDocMeta: async (id: string) => {
          const meta = next.get(machineMetaCacheAtom)[id];
          return meta ? { meta } : undefined;
        },
      },
      writer: {
        upsertDocMeta: async (id: string, patch: Partial<MachineMeta>) =>
          next.set(machineMetaCacheAtom, (cache) => ({
            ...cache,
            [id]: { ...cache[id], ...patch } as MachineMeta,
          })),
        deleteDoc: async (id: string) =>
          next.set(machineMetaCacheAtom, (cache) =>
            Object.fromEntries(Object.entries(cache).filter(([key]) => key !== id))
          ),
      },
      sendControl: () => {},
      waitForMachineStatusResponse: async (machineId: MachineId) => ({
        type: 'machine/status_response',
        machineId,
        success: true,
        lifecycle: { launchMode: 'daemon', canRemoteRestart: true, canRemoteUpgrade: false },
      }),
      subscribeMachineMonitor: (
        machineId: MachineId,
        listener: (value: MachineMonitorSnapshot) => void
      ) => {
        listener(snapshot(machineId));
        return () => {};
      },
      forceMachineMonitorSample: () => {},
    } as unknown as WorkspaceRuntime;
    next.set(runtimeAtom, runtime);
    next.set(currentWorkspaceIdAtom, previewWorkspaceId);
    next.set(currentWorkspaceSlugAtom, 'lody');
    next.set(workspaceContentModeAtom, {
      accountId: previewOwnerId,
      workspaceId: previewWorkspaceId,
      workspaceSlug: 'lody',
      descriptor: {
        workspaceId: previewWorkspaceId,
        contentMode: 'plaintext',
        contentModeVersion: 1,
      },
    });
    next.set(userAtom, { id: previewOwnerId, name: '示例用户', email: 'preview@example.com' });
    next.set(settingsDialogOpenAtom, true);
    next.set(settingsActiveTabAtom, 'machines');
    next.set(settingsSelectedMachineIdAtom, previewSourceId);
    next.set(
      machineMetaCacheAtom,
      Object.fromEntries(previewMachines.map((machine) => [getMachineRoomId(machine.id), machine]))
    );
    next.set(lodyPresenceSyncStateAtom, 'synced');
    next.set(lodyPresenceNowMsAtom, getServerNow());
    next.set(
      lodyPresenceStatesAtom,
      Object.fromEntries(
        [previewSourceId, 'macbook-development' as MachineId].map((machineId) => [
          getLodyMachinePresenceKey(machineId, 'preview' as LodyPresenceInstanceId),
          {
            kind: 'machine',
            machineId,
            instanceId: 'preview' as LodyPresenceInstanceId,
            updatedAt: getServerNow(),
          },
        ])
      )
    );
    return next;
  });
  return (
    <PlatformContext.Provider value={platform}>
      <Provider store={store}>
        <DesktopSettingsModal />
      </Provider>
    </PlatformContext.Provider>
  );
}

function SettingsModalStory({ tab }: { tab: SettingsTabId }) {
  return (
    <SettingsStoryProviders
      multiMember={tab === 'machines'}
      capabilities={
        tab === 'machines' ? ['cloudAccount', 'remoteMachines', 'teamSharing'] : ['cloudAccount']
      }
    >
      <RoutedStory>
        {tab === 'machines' ? (
          <MachinesCatalogFixture />
        ) : (
          <Provider>
            <OpenModalAt tab={tab}>
              {tab === 'agent-roles' ? (
                <RolesCatalogFixture>
                  <DesktopSettingsModal />
                </RolesCatalogFixture>
              ) : (
                <DesktopSettingsModal />
              )}
            </OpenModalAt>
          </Provider>
        )}
      </RoutedStory>
    </SettingsStoryProviders>
  );
}

const meta = {
  title: 'Settings/DesktopSettingsModal',
  component: DesktopSettingsModal,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof DesktopSettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PreferencesTab: Story = {
  render: () => <SettingsModalStory tab="preferences" />,
};

export const AboutTab: Story = {
  render: () => <SettingsModalStory tab="about" />,
};

/** Unbinding waits for the row: hover or focus a row to see it. Caps read at 12px. */
export const KeyboardShortcutsTab: Story = {
  render: () => <SettingsModalStory tab="keyboard-shortcuts" />,
};

/** An empty catalog: the list's own card with one quiet line. */
export const McpEmptyTab: Story = {
  render: () => <SettingsModalStory tab="mcp" />,
};

export const AgentRolesTab: Story = {
  render: () => <SettingsModalStory tab="agent-roles" />,
};

export const DarkModePreferencesTab: Story = {
  render: () => (
    <div className="dark">
      <SettingsModalStory tab="preferences" />
    </div>
  ),
};

/** Full production modal with synthetic data; run Storybook with VITE_LODY_PLATFORM=cloud. */
export const MachinesIdentityRecovery: Story = {
  render: () => <SettingsModalStory tab="machines" />,
};

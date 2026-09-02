import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import type { LocalProjectBrowseDirectoryResult, LocalProjectId, MachineId } from '@lody/shared';
import {
  AddLocalProjectDialog,
  type RemoteDirectoryOps,
  type RemoteDirectoryPickerMachine,
} from '@/components/local-projects/add-local-project-dialog';
import { Button } from '@lody/ui/button';

type FakeEntry = {
  name: string;
  hints?: { git?: boolean };
  registeredProjectId?: LocalProjectId;
  error?: 'unreadable';
};

const HOME = '/Users/zoe';
const LONG_HOME =
  '/Users/zoe/Workspaces/customer-implementations/north-america/enterprise/accounts/acme-retail-platform/frontend/packages/dashboard/src/features/local-project-import';

const FAKE_TREE: Record<string, FakeEntry[]> = {
  '/Users/zoe': [
    { name: 'Code' },
    { name: 'Documents' },
    { name: 'Downloads' },
    { name: '.config' },
  ],
  '/Users/zoe/Code': [
    { name: 'lody', hints: { git: true } },
    { name: 'loro', hints: { git: true }, registeredProjectId: 'lp_loro' as LocalProjectId },
    { name: 'experiments' },
    { name: 'vault', error: 'unreadable' },
  ],
  '/Users/zoe/Code/lody': [{ name: 'apps' }, { name: 'packages' }, { name: 'docs' }],
  '/Users/zoe/Documents': [],
  '/Users/zoe/Downloads': [{ name: 'archive' }],
  [LONG_HOME]: [{ name: 'scripts' }, { name: 'static' }, { name: 'table' }, { name: 'template' }],
};

function buildBrowseResult(path: string, homeDir = HOME): LocalProjectBrowseDirectoryResult {
  const entries = (FAKE_TREE[path] ?? [])
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({
      name: entry.name,
      absolutePath: `${path}/${entry.name}`,
      isSymlink: false,
      hidden: entry.name.startsWith('.'),
      ...(entry.hints ? { hints: entry.hints } : {}),
      ...(entry.registeredProjectId ? { registeredProjectId: entry.registeredProjectId } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    }));
  const parentPath =
    path === homeDir || path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
  return { path, parentPath, entries, truncated: false };
}

function createFakeOps(homeDir = HOME): RemoteDirectoryOps {
  return {
    listRoots: async () => ({
      ok: true,
      value: { platform: 'darwin', pathSeparator: '/', homeDir },
    }),
    browseDir: async (_machineId, args) => {
      await new Promise((resolve) => setTimeout(resolve, 220));
      return {
        ok: true,
        value: buildBrowseResult(args.absolutePath ?? homeDir, homeDir),
      };
    },
    addProject: async (_machineId, args) => {
      const name = args.rootPath.split('/').pop() || args.rootPath;
      return {
        ok: true,
        value: {
          status: 'added',
          localProjectId: `lp_${name}` as LocalProjectId,
          name,
          rootPath: args.rootPath,
        },
      };
    },
  };
}

const fakeOps = createFakeOps();
const longPathOps = createFakeOps(LONG_HOME);

const offlineOps: RemoteDirectoryOps = {
  listRoots: async () => ({ ok: false, errorCode: 'timeout', message: 'No response' }),
  browseDir: async () => ({ ok: false, errorCode: 'timeout', message: 'No response' }),
  addProject: async () => ({ ok: false, errorCode: 'timeout', message: 'No response' }),
};

const ONE_MACHINE: RemoteDirectoryPickerMachine[] = [
  {
    id: 'm_macbook' as MachineId,
    name: 'MacBook Pro',
    online: true,
    ownerName: 'Zoe',
    canAddProjects: true,
  },
];

const MANY_MACHINES: RemoteDirectoryPickerMachine[] = [
  ...ONE_MACHINE,
  {
    id: 'm_build' as MachineId,
    name: 'build-server-01',
    online: true,
    ownerName: 'Alex Chen',
    canAddProjects: false,
  },
  {
    id: 'm_old' as MachineId,
    name: 'old-laptop',
    online: false,
    ownerName: 'Zoe',
    canAddProjects: true,
  },
];

function StoryShell({
  isMobile,
  machines,
  machinesLoading,
  ops,
  initialMachineId,
}: {
  isMobile: boolean;
  machines: RemoteDirectoryPickerMachine[];
  machinesLoading?: boolean;
  ops: RemoteDirectoryOps;
  initialMachineId?: MachineId;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex h-[680px] items-start justify-center bg-muted/10 p-6">
      <Button type="button" onClick={() => setOpen(true)}>
        Add local project
      </Button>
      <AddLocalProjectDialog
        open={open}
        onOpenChange={setOpen}
        isMobile={isMobile}
        machines={machines}
        machinesLoading={machinesLoading}
        initialMachineId={initialMachineId}
        ops={ops}
        onAdded={fn()}
        onLocateRegistered={fn()}
      />
    </div>
  );
}

const meta = {
  title: 'LocalProjects/AddLocalProjectDialog',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  args: { isMobile: false, machines: ONE_MACHINE, ops: fakeOps },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {};

export const DesktopMultipleMachines: Story = {
  args: { machines: MANY_MACHINES },
};

export const DesktopLoadingMachines: Story = {
  args: { machines: [], machinesLoading: true },
};

export const DesktopMachineOffline: Story = {
  args: { machines: ONE_MACHINE, ops: offlineOps },
};

export const DesktopLongCurrentPath: Story = {
  args: { initialMachineId: ONE_MACHINE[0].id, ops: longPathOps },
};

export const Mobile: Story = {
  args: { isMobile: true },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};

export const MobileMultipleMachines: Story = {
  args: { isMobile: true, machines: MANY_MACHINES },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};

export const MobileLoadingMachines: Story = {
  args: { isMobile: true, machines: [], machinesLoading: true },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};

export const MobileLongCurrentPath: Story = {
  args: { isMobile: true, initialMachineId: ONE_MACHINE[0].id, ops: longPathOps },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};

import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { LocalProjectId, MachineId } from '@lody/shared';

import {
  MobileNewChatProjectSheet,
  type MobileProjectFolder,
  type MobileProjectGroup,
  type MobileProjectMachine,
  type MobileProjectRepo,
} from '@/components/mobile/mobile-new-chat-project-sheet';
import type { UnifiedProjectSelection } from '@/components/chat/unified-project-selector';
import { Button } from '@lody/ui/button';

const spikes = 'spikes-powerbook' as MachineId;
const zx = 'zx-macbook' as MachineId;
const lab = 'lab-m2' as MachineId;

const machines: MobileProjectMachine[] = [
  { id: spikes, name: 'spikes-PowerBook.local', online: true },
  { id: zx, name: 'zx-macbook', online: true },
  { id: lab, name: 'lab-m2', online: false, disabledReason: 'Offline' },
];

const folders: MobileProjectFolder[] = [
  {
    machineId: spikes,
    localProjectId: 'blog' as LocalProjectId,
    name: 'blog',
    rootPath: '~/code/blog',
    lastUsedAt: 5,
  },
  {
    machineId: spikes,
    localProjectId: 'lody' as LocalProjectId,
    name: 'lody',
    rootPath: '~/code/lody',
    lastUsedAt: 3,
  },
  {
    machineId: spikes,
    localProjectId: 'docs' as LocalProjectId,
    name: 'docs',
    rootPath: '~/code/docs',
    lastUsedAt: 1,
  },
  {
    machineId: zx,
    localProjectId: 'loro' as LocalProjectId,
    name: 'loro',
    rootPath: '~/code/loro',
    lastUsedAt: 4,
  },
];

const groups: MobileProjectGroup[] = [
  { projectId: 'loro-stack', name: 'Loro stack', memberCount: 3, lastUsedAt: 4 },
];

const repositories: MobileProjectRepo[] = [
  {
    fullName: 'loro-dev/lody',
    description: 'AI-native local-first coding companion',
    lastUsedAt: 5,
  },
  { fullName: 'loro-dev/loro', description: 'High-performance CRDT framework', lastUsedAt: 2 },
  { fullName: 'loro-dev/lody-web', description: 'Web shell for Lody', lastUsedAt: 1 },
];

function Harness({
  locked = false,
  initialMachines = machines,
  initialSelection = {
    kind: 'local',
    machineId: spikes,
    localProjectId: 'blog',
  } as UnifiedProjectSelection,
  initialMachine = spikes,
}: {
  locked?: boolean;
  initialMachines?: MobileProjectMachine[];
  initialSelection?: UnifiedProjectSelection;
  initialMachine?: MachineId | null;
}) {
  const [open, setOpen] = useState(true);
  const [machineId, setMachineId] = useState<MachineId | null>(initialMachine);
  const [selection, setSelection] = useState<UnifiedProjectSelection>(initialSelection);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/40">
      <Button type="button" onClick={() => setOpen(true)}>
        Open project picker
      </Button>
      <MobileNewChatProjectSheet
        open={open}
        onOpenChange={setOpen}
        machines={initialMachines}
        selectedMachineId={machineId}
        onMachineChange={setMachineId}
        localProjects={folders}
        repositories={repositories}
        groups={groups}
        selection={selection}
        onSelect={setSelection}
        onAddLocalProject={() => undefined}
        onConnectGitHub={() => undefined}
        lockedMachineId={locked ? spikes : null}
        lockedMachineReason={locked ? 'Machine is fixed by the selected Role' : undefined}
      />
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileNewChatProjectSheet',
  component: MobileNewChatProjectSheet,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof MobileNewChatProjectSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    machines,
    selectedMachineId: spikes,
    onMachineChange: () => {},
    localProjects: folders,
    repositories,
    groups,
    selection: { kind: 'local', machineId: spikes, localProjectId: 'blog' as LocalProjectId },
    onSelect: () => {},
    onAddLocalProject: () => {},
    onConnectGitHub: () => {},
  },
  render: () => <Harness />,
};

export const MachineSwitched: Story = {
  args: Open.args,
  render: () => <Harness initialMachine={zx} initialSelection={{ kind: 'none' }} />,
};

export const RoleLocked: Story = {
  args: Open.args,
  render: () => <Harness locked />,
};

export const TwoMachines: Story = {
  args: Open.args,
  render: () => <Harness initialMachines={machines.slice(0, 2)} />,
};

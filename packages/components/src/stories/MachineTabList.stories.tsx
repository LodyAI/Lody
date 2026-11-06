import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import { type MachineId, type MachineViewMeta } from '@lody/shared';
import {
  MachineTabList,
  buildMachineTabItems,
  type MachineTabItem,
} from '@/components/settings/machine-tab-list';
import type { MachineSettingsFilter } from '@/atoms/settings-machine-tab';
const storyLayout = stylex.create({
  frame: {
    height: '480px',
    width: '260px',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--card) / 1) 40%, transparent)',
    padding: 'calc(var(--spacing) * 2)',
  },
});

const makeMachine = (id: string, overrides: Partial<MachineViewMeta> = {}): MachineViewMeta => ({
  id: id as MachineId,
  name: `Machine ${id}`,
  cliVersion: '0.44.0',
  os: 'Linux',
  sessions: [],
  raceLimits: {},
  ...overrides,
});

const currentUserId = 'user-1';

const machines: Map<MachineId, MachineViewMeta> = new Map(
  [
    makeMachine('machine-laptop', {
      name: 'MacBook Pro',
      os: 'macOS 15',
      ownerUserId: currentUserId,
    }),
    makeMachine('machine-desktop', {
      name: 'Work Desktop',
      os: 'Linux',
      ownerUserId: currentUserId,
    }),
    makeMachine('machine-teammate', {
      name: "Teammate's Mac",
      os: 'macOS',
      ownerUserId: 'user-2',
    }),
    makeMachine('machine-ci', {
      name: 'CI Server',
      os: 'Linux',
      ownerUserId: 'user-3',
    }),
  ].map((machine) => [machine.id, machine])
);

// Presence-based liveness: laptop + teammate machines online, the rest offline.
const onlineMachineIds: ReadonlySet<MachineId> = new Set([
  'machine-laptop' as MachineId,
  'machine-teammate' as MachineId,
]);

const isOwn = (machine: MachineViewMeta) => machine.ownerUserId === currentUserId;

type StoryProps = {
  machineMap?: Map<MachineId, MachineViewMeta>;
  initialFilter?: MachineSettingsFilter;
  initialSelected?: MachineId | null;
};

function StoryWrapper({
  machineMap = machines,
  initialFilter = { onlineOnly: false, mineOnly: false },
  initialSelected,
}: StoryProps) {
  const [filter, setFilter] = useState<MachineSettingsFilter>(initialFilter);
  const accessByMachineId = useMemo(() => {
    const map = new Map();
    for (const machine of machineMap.values()) {
      map.set(machine.id, {
        machineId: machine.id,
        ownerUserId: machine.ownerUserId ?? currentUserId,
        sharedWithTeam: machine.ownerUserId !== currentUserId,
        updatedAt: 0,
      });
    }
    return map;
  }, [machineMap]);
  const { items, totalBeforeFilter } = buildMachineTabItems({
    machines: machineMap,
    accessByMachineId,
    onlineMachineIds,
    isOwnMachine: isOwn,
    filter,
  });
  const [selected, setSelected] = useState<MachineId | null>(
    initialSelected ?? items[0]?.machine.id ?? null
  );
  return (
    <div {...stylex.props(storyLayout.frame)}>
      <MachineTabList
        items={items as MachineTabItem[]}
        selectedMachineId={selected}
        onSelect={setSelected}
        filter={filter}
        onFilterChange={setFilter}
        totalBeforeFilter={totalBeforeFilter}
      />
    </div>
  );
}

const meta = {
  title: 'Settings/MachineTabList',
  component: StoryWrapper,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const MineOnly: Story = {
  args: {
    initialFilter: { onlineOnly: false, mineOnly: true },
  },
};

export const OnlineOnly: Story = {
  args: {
    initialFilter: { onlineOnly: true, mineOnly: false },
  },
};

export const Empty: Story = {
  args: {
    machineMap: new Map(),
  },
};

export const FilterHidesEverything: Story = {
  args: {
    machineMap: new Map(
      [
        makeMachine('machine-offline-team', {
          name: 'Offline teammate',
          ownerUserId: 'user-2',
        }),
      ].map((machine) => [machine.id, machine])
    ),
    initialFilter: { onlineOnly: true, mineOnly: true },
  },
};

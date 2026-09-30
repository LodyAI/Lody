import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent, within } from 'storybook/test';
import type { LocalProjectId, MachineId } from '@lody/shared';

import {
  UNIFIED_PROJECT_OPTION_RENDER_LIMIT,
  UnifiedProjectSelectorView,
  type UnifiedLocalProjectOption,
} from '@/components/chat/unified-project-selector';
import { Tooltip } from '@lody/ui/tooltip';

const machineId = 'machine-project-selector-story' as MachineId;

const localProjects = [
  {
    key: `${machineId}:lody`,
    machineId,
    localProjectId: 'lody' as LocalProjectId,
    name: 'lody',
    rootPath: '/Users/zixuan/Code/lody',
    lastUsedAt: 4,
    sharing: {
      visibility: 'private',
      privateReason: 'project',
      canManage: true,
      machineId,
      localProjectId: 'lody' as LocalProjectId,
      machineName: 'Studio Mac',
      projectName: 'lody',
    },
  },
  {
    key: `${machineId}:loro`,
    machineId,
    localProjectId: 'loro' as LocalProjectId,
    name: 'loro',
    rootPath: '/Users/zixuan/Code/loro',
    lastUsedAt: 3,
    sharing: {
      visibility: 'team',
      canManage: true,
      machineId,
      localProjectId: 'loro' as LocalProjectId,
      machineName: 'Studio Mac',
      projectName: 'loro',
    },
  },
  {
    key: `${machineId}:flock`,
    machineId,
    localProjectId: 'flock' as LocalProjectId,
    name: 'flock',
    rootPath: '/Users/zixuan/Code/flock',
    lastUsedAt: 2,
    sharing: {
      visibility: 'private',
      privateReason: 'machine',
      canManage: true,
      machineId,
      localProjectId: 'flock' as LocalProjectId,
      machineName: 'Studio Mac',
      projectName: 'flock',
    },
  },
  {
    key: `${machineId}:mirror`,
    machineId,
    localProjectId: 'mirror' as LocalProjectId,
    name: 'mirror',
    rootPath: '/Users/zixuan/Code/mirror',
    lastUsedAt: 1,
    sharing: {
      visibility: 'unknown',
      canManage: false,
      machineId,
      localProjectId: 'mirror' as LocalProjectId,
      machineName: 'Studio Mac',
      projectName: 'mirror',
    },
  },
  {
    key: `${machineId}:loro-mirror`,
    machineId,
    localProjectId: 'loro-mirror' as LocalProjectId,
    name: 'loro-mirror',
    rootPath: '/Users/zixuan/Code/loro-mirror',
  },
  {
    key: `${machineId}:loro-wasm`,
    machineId,
    localProjectId: 'loro-wasm' as LocalProjectId,
    name: 'loro-wasm',
    rootPath: '/Users/zixuan/Code/loro-wasm',
  },
  {
    key: `${machineId}:loro-inspector`,
    machineId,
    localProjectId: 'loro-inspector' as LocalProjectId,
    name: 'loro-inspector',
    rootPath: '/Users/zixuan/Code/loro-inspector',
  },
  {
    key: `${machineId}:loro-benchmarks`,
    machineId,
    localProjectId: 'loro-benchmarks' as LocalProjectId,
    name: 'loro-benchmarks',
    rootPath: '/Users/zixuan/Code/loro-benchmarks',
  },
  {
    key: `${machineId}:loro-crdt`,
    machineId,
    localProjectId: 'loro-crdt' as LocalProjectId,
    name: 'loro-crdt',
    rootPath: '/Users/zixuan/Code/loro-crdt',
  },
  {
    key: `${machineId}:loro-move`,
    machineId,
    localProjectId: 'loro-move' as LocalProjectId,
    name: 'loro-move',
    rootPath: '/Users/zixuan/Code/loro-move',
  },
  {
    key: `${machineId}:loro-swift`,
    machineId,
    localProjectId: 'loro-swift' as LocalProjectId,
    name: 'loro-swift',
    rootPath: '/Users/zixuan/Code/loro-swift',
  },
  {
    key: `${machineId}:loro-tools`,
    machineId,
    localProjectId: 'loro-tools' as LocalProjectId,
    name: 'loro-tools',
    rootPath: '/Users/zixuan/Code/loro-tools',
  },
  ...Array.from({ length: 18 }, (_, index) => {
    const projectNumber = index + 13;
    const localProjectId = `archived-project-${projectNumber}` as LocalProjectId;
    return {
      key: `${machineId}:${localProjectId}`,
      machineId,
      localProjectId,
      name: `archived-project-${projectNumber}`,
      rootPath: `/Users/zixuan/Code/archived-project-${projectNumber}`,
      lastUsedAt: -index,
    };
  }),
] satisfies UnifiedLocalProjectOption[];

const meta = {
  title: 'Chat/UnifiedProjectSelector',
  component: UnifiedProjectSelectorView,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <Tooltip.Provider>
        <div className="flex min-h-dvh items-end justify-center bg-background pb-24 text-foreground">
          <Story />
        </div>
      </Tooltip.Provider>
    ),
  ],
  args: {
    value: { kind: 'local', machineId, localProjectId: 'lody' as LocalProjectId },
    localProjects,
    repositories: [
      {
        fullName: 'loro-dev/loro-mirror',
        description: 'High-performance CRDT state synchronization',
      },
    ],
    onChange: fn(),
    onAddLocalProject: fn(),
    onConnectGitRepo: fn(),
    onShareLocalProjectWithTeam: fn(async () => undefined),
    renderLimit: UNIFIED_PROJECT_OPTION_RENDER_LIMIT,
  },
} satisfies Meta<typeof UnifiedProjectSelectorView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SelectedPrivate: Story = {};

export const SelectedTeamWithoutStatus: Story = {
  args: {
    value: { kind: 'local', machineId, localProjectId: 'loro' as LocalProjectId },
  },
};

export const MenuOpen: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'lody' }));
  },
};

export const MenuOpenDark: Story = {
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'lody' }));
  },
};

export const SearchBeyondRecent: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'lody' }));
    await userEvent.type(
      within(canvasElement.ownerDocument.body).getByPlaceholderText('Search projects'),
      '30'
    );
  },
};

export const ShareConfirmation: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Share project/ }));
  },
};

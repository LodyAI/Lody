import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import {
  WorkspaceDataSettingContent,
  type WorkspaceBundleApi,
} from '@/components/settings/workspace-data-setting';
import type { WorkspaceBundlePlan } from '@lody/shared/workspace-bundle-control';

const plan: WorkspaceBundlePlan = {
  digest: 'd',
  sourceWorkspaceId: 'lw_source',
  targetWorkspaceId: 'lw_target',
  gaps: [
    { id: 'session-roost', kind: 'roost', reason: 'Roost conversation bodies cannot be read here' },
  ],
  rooms: [
    {
      id: 'session-1',
      kind: 'conversations',
      counted: true,
      action: 'merge',
      state: 'new',
      label: 'Fix login redirect',
    },
    {
      id: 'schedule-1',
      kind: 'schedules',
      counted: true,
      action: 'merge',
      state: 'unchanged',
      label: 'Daily digest',
    },
    {
      id: 'session-3',
      kind: 'conversations',
      counted: true,
      action: 'skip',
      reason: 'unrelated-same-id',
      label: 'Draft notes',
    },
    {
      id: 'lw_source:wf:workspace',
      kind: 'catalog',
      counted: true,
      action: 'merge',
      state: 'merge',
    },
  ],
};

const api: WorkspaceBundleApi = {
  exportWorkspace: async () => ({
    status: 'done',
    summary: {
      file: '/Users/alice/Acme-2026-11-19.lodybundle',
      rooms: 42,
      blobs: 3,
      gaps: [],
      digest: 'd',
    },
  }),
  chooseImportFile: async () => ({
    status: 'chosen',
    token: 'token',
    fileName: 'Acme-2026-11-19.lodybundle',
  }),
  previewImport: async () => ({ status: 'planned', plan }),
  importWorkspace: async () => ({
    status: 'done',
    outcome: { plan, result: { imported: 3, skipped: 1, resumed: 0 }, uploadPending: [] },
  }),
};

const meta = {
  title: 'Settings/WorkspaceData',
  component: WorkspaceDataSettingContent,
  args: { workspaceId: 'lw_target', workspaceName: 'Acme', canManage: true, api },
} satisfies Meta<typeof WorkspaceDataSettingContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Member: Story = { args: { canManage: false } };

export const Exported: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('workspace-bundle-export'));
  },
};

export const ReviewingImport: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('workspace-bundle-choose'));
  },
};

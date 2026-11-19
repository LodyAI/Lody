import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import {
  WorkspaceDataSettingContent,
  type WorkspaceBundleApi,
} from '@/components/settings/workspace-data-setting';

const plan = {
  digest: 'd',
  sourceWorkspaceId: 'lw_source',
  targetWorkspaceId: 'lw_target',
  gaps: [
    { id: 'session-roost', kind: 'roost', reason: 'Roost conversation bodies cannot be read here' },
  ],
  rooms: [
    { id: 'session-1', model: 'loro', action: 'merge', state: 'new' },
    { id: 'session-2', model: 'loro', action: 'merge', state: 'new' },
    { id: 'schedule-1', model: 'loro', action: 'merge', state: 'unchanged' },
    { id: 'session-3', model: 'loro', action: 'skip', reason: 'unrelated-same-id' },
    {
      id: 'meta',
      model: 'meta',
      action: 'merge',
      state: 'merge',
      rows: { added: 12, updated: 2, deleted: 0 },
    },
  ],
};

const api: WorkspaceBundleApi = {
  exportWorkspace: async () => ({
    status: 'done',
    summary: { file: '/Users/alice/Acme-2026-11-19.lodybundle', rooms: 42, blobs: 3, gaps: [] },
  }),
  chooseImportFile: async () => ({
    status: 'chosen',
    token: 'token',
    fileName: 'Acme-2026-11-19.lodybundle',
  }),
  previewImport: async () => ({ status: 'planned', plan }),
  importWorkspace: async () => ({
    status: 'done',
    outcome: { result: { imported: 3, skipped: 1, resumed: 0 }, uploadPending: [] },
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

export const AgentUnavailable: Story = {
  args: {
    api: {
      ...api,
      exportWorkspace: async () => ({ status: 'error', message: 'local_agent_unavailable' }),
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('workspace-bundle-export'));
  },
};

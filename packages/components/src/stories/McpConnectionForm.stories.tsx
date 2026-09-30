import type { Meta, StoryObj } from '@storybook/react';
import type { WorkspaceMcpServerMeta } from '@lody/shared';
import { McpConnectionForm } from '@/components/settings/mcp-connection-form';

const stdioEntry: WorkspaceMcpServerMeta = {
  id: 'stdio-files' as WorkspaceMcpServerMeta['id'],
  name: 'Workspace files',
  description: 'Expose project files to the agent.',
  transport: 'stdio',
  connection: {
    transport: 'stdio',
    command: '/usr/local/bin/mcp-files',
    args: ['--root', '${PROJECT_ROOT}'],
    env: { LOG_LEVEL: 'info' },
    envPassthrough: ['PROJECT_ROOT'],
  },
  enabledByDefault: true,
  createdAt: 1,
  updatedAt: 1,
};

const httpEntry: WorkspaceMcpServerMeta = {
  id: 'http-search' as WorkspaceMcpServerMeta['id'],
  name: 'Search',
  transport: 'http',
  connection: {
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    bearerToken: '${SEARCH_TOKEN}',
  },
  createdAt: 1,
  updatedAt: 1,
};

const meta = {
  title: 'Settings/McpConnectionForm',
  component: McpConnectionForm,
  args: { onSubmit: () => undefined, onCancel: () => undefined, className: 'min-h-0 flex-1' },
  decorators: [
    // Mirrors the settings dialog that hosts the form: a fixed-height panel the
    // form's own scroll body and sticky footer size themselves against. The
    // panel pads its content; the form has no padding of its own.
    (Story) => (
      <div className="mx-auto flex h-[620px] w-[620px] flex-col gap-4 overflow-hidden rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpConnectionForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StdioEmpty: Story = {};
export const StdioConfigured: Story = { args: { initialEntry: stdioEntry } };
export const HttpEmpty: Story = {
  args: { initialEntry: { ...httpEntry, name: '', connection: undefined } },
};
export const HttpWithEnvironmentToken: Story = { args: { initialEntry: httpEntry } };
export const SaveFailedLocally: Story = {
  args: {
    initialEntry: stdioEntry,
    error:
      'Saved on this device, but the workspace has not synced yet (offline). Keep this editor open and retry when the connection recovers.',
  },
};

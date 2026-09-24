import type { Meta, StoryObj } from '@storybook/react';
import type { McpServerId, WorkspaceMcpServerMeta } from '@lody/shared';
import { McpServerRow } from '@/components/settings/mcp-setting';

const base: WorkspaceMcpServerMeta = {
  id: 'files' as McpServerId,
  name: 'Workspace files',
  transport: 'stdio',
  connection: {
    transport: 'stdio',
    command: '/usr/local/bin/mcp-files',
    args: ['--root', '${PROJECT_ROOT}'],
  },
  createdAt: 1,
  updatedAt: 1,
};

const meta = {
  title: 'Settings/McpServerRow',
  component: McpServerRow,
  args: {
    server: base,
    onDiscoverTools: () => undefined,
    canDiscoverTools: true,
    onEdit: () => undefined,
    onToggleDefault: () => undefined,
    onRemove: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[640px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpServerRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Stdio: Story = {};
export const SelectedByDefault: Story = {
  args: { server: { ...base, enabledByDefault: true } },
};
export const WithDescription: Story = {
  args: { server: { ...base, description: 'Expose project files to the agent.' } },
};
export const Http: Story = {
  args: {
    server: {
      ...base,
      id: 'search' as McpServerId,
      name: 'Search',
      transport: 'http',
      connection: { transport: 'http', url: 'https://mcp.example.com/mcp' },
    },
  },
};
export const WithoutConnection: Story = {
  args: {
    server: {
      ...base,
      id: 'draft' as McpServerId,
      name: 'Not configured yet',
      connection: undefined,
    },
  },
};

export const Connected: Story = {
  args: {
    toolList: {
      status: 'success',
      tools: [
        { name: 'read_file', description: 'Read a project file.' },
        { name: 'list_directory', description: 'List files in a directory.' },
        { name: 'search_files' },
      ],
    },
  },
};
export const Connecting: Story = { args: { toolList: { status: 'loading' } } };
export const ConnectionFailed: Story = { args: { toolList: { status: 'error' } } };
export const NoTools: Story = { args: { toolList: { status: 'success', tools: [] } } };
export const ManyTools: Story = {
  args: {
    toolList: {
      status: 'success',
      tools: Array.from({ length: 24 }, (_, i) => ({ name: `workspace_project_tool_${i}` })),
    },
  },
};

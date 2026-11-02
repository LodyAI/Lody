import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ReactNode } from 'react';
import type { McpServerId, WorkspaceMcpServerMeta } from '@lody/shared';
import {
  ProjectDefaultMcpView,
  type ProjectDefaultMcpViewProps,
} from '@/components/settings/project-default-mcp-tab';

const SERVERS: WorkspaceMcpServerMeta[] = [
  {
    id: 'database' as McpServerId,
    name: 'Database',
    transport: 'stdio',
    description: 'Read-only access to the staging Postgres replica.',
    connection: { transport: 'stdio', command: 'mcp-postgres', args: ['--read-only'] },
    enabledByDefault: true,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'docs' as McpServerId,
    name: 'Docs',
    transport: 'http',
    description: 'Search the internal handbook.',
    connection: { transport: 'http', url: 'https://docs.example.com/mcp' },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'files' as McpServerId,
    name: 'Files',
    transport: 'stdio',
    connection: { transport: 'stdio', command: 'mcp-files' },
    enabledByDefault: true,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'tracker' as McpServerId,
    name: 'Issue tracker',
    transport: 'http',
    description: 'Create and update tickets.',
    createdAt: 1,
    updatedAt: 1,
  },
];

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-[720px] max-w-full flex-col gap-3 bg-background p-4">{children}</div>
  );
}

/** Stateful so the switches can be driven by hand; the first edit customizes. */
function Interactive(args: ProjectDefaultMcpViewProps) {
  const [selectedIds, setSelectedIds] = useState(args.selectedIds);
  const [customized, setCustomized] = useState(args.customized);
  return (
    <ProjectDefaultMcpView
      {...args}
      selectedIds={selectedIds}
      customized={customized}
      onToggle={(id, enabled) => {
        setCustomized(true);
        setSelectedIds((current) =>
          enabled
            ? [...current.filter((entry) => entry !== id), id]
            : current.filter((entry) => entry !== id)
        );
      }}
    />
  );
}

const meta = {
  title: 'Settings/ProjectDefaultMcpTab',
  component: ProjectDefaultMcpView,
  parameters: { layout: 'centered' },
  render: (args: ProjectDefaultMcpViewProps) => (
    <Frame>
      <Interactive {...args} />
    </Frame>
  ),
} satisfies Meta<typeof ProjectDefaultMcpView>;

export default meta;
type Story = StoryObj<typeof meta>;

const base: ProjectDefaultMcpViewProps = {
  status: 'ready',
  servers: SERVERS,
  selectedIds: ['database', 'files'] as McpServerId[],
  customized: false,
  readOnlyReason: null,
  saving: false,
  saveFailed: false,
  onToggle: () => {},
  onManageMcp: () => {},
};

export const InheritsWorkspaceDefaults: Story = { args: base };

export const Customized: Story = {
  args: { ...base, customized: true, selectedIds: ['docs'] as McpServerId[] },
};

export const AllOff: Story = {
  args: { ...base, customized: true, selectedIds: [] },
};

export const ReadOnly: Story = {
  args: { ...base, readOnlyReason: 'not_owner' },
};

export const SaveFailed: Story = {
  args: { ...base, customized: true, saveFailed: true },
};

export const Loading: Story = {
  args: { ...base, status: 'loading', servers: [] },
};

export const LoadFailed: Story = {
  args: { ...base, status: 'failed', servers: [] },
};

export const EmptyCatalog: Story = {
  args: { ...base, servers: [], selectedIds: [] },
};

import type { Meta, StoryObj } from '@storybook/react-vite';
import type { BuiltinMcpProviderId } from '@lody/shared';
import { BuiltinMcpConnectorGrid } from '@/components/settings/builtin-mcp-connector-grid';

const meta = {
  title: 'Settings/BuiltinMcpConnectorGrid',
  component: BuiltinMcpConnectorGrid,
  parameters: { layout: 'padded' },
  args: {
    addedProviderIds: new Set<BuiltinMcpProviderId>(['linear', 'notion']),
    connectionStates: { linear: 'connected', notion: 'authorizing' },
    pendingProviderId: undefined,
    onConnect: () => undefined,
    onDisconnect: () => undefined,
    onTest: () => undefined,
  },
} satisfies Meta<typeof BuiltinMcpConnectorGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AddingPostHog: Story = {
  args: { pendingProviderId: 'posthog' },
};

export const EmptyWorkspace: Story = {
  args: { addedProviderIds: new Set<BuiltinMcpProviderId>() },
};

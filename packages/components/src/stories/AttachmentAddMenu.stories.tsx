import { Provider, createStore } from 'jotai';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { McpServerId, WorkspaceMcpServerMeta } from '@lody/shared';
import { AttachmentAddMenu } from '@/components/chat/attachment-add-menu';
import { VaulDrawerEdgeBackZone } from '@/components/mobile/vaul-drawer-edge-back-zone';
import { getSessionChatInputAreaShellClassName } from '@/components/sessions/session-chat-input-area';
const storyLayoutStyles = stylex.create({
  row: {
    display: 'flex',
    width: '100%',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--input-border) / 1)',
    'background-color': 'color-mix(in oklab, hsl(var(--input) / 1) 40%, transparent)',
    padding: 'calc(var(--spacing) * 2)',
  },
  label: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'min-height': '420px',
    'align-items': 'flex-end',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
  stack: {
    position: 'relative',
    display: 'flex',
    'min-height': '420px',
    'flex-direction': 'column',
    'justify-content': 'flex-end',
    'background-color': 'hsl(var(--background) / 1)',
  },
});

const meta = {
  title: 'Chat/AttachmentAddMenu',
  component: AttachmentAddMenu,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AttachmentAddMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

const mcpServers: WorkspaceMcpServerMeta[] = [
  {
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
  },
  {
    id: 'search' as McpServerId,
    name: 'Search',
    description: 'Company-wide document search.',
    transport: 'http',
    connection: { transport: 'http', url: 'https://mcp.example.com/mcp' },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'issues' as McpServerId,
    name: 'Issue tracker',
    transport: 'stdio',
    createdAt: 1,
    updatedAt: 1,
  },
];

/* Live selection so the multi-select second level actually toggles. */
function WithMcp(args: React.ComponentProps<typeof AttachmentAddMenu>) {
  const [selectedIds, setSelectedIds] = useState<McpServerId[]>([mcpServers[0].id]);
  return (
    <AttachmentAddMenu
      {...args}
      mcp={{ ...args.mcp!, selectedIds, onSelectedIdsChange: setSelectedIds }}
    />
  );
}

// Frame that mimics the bottom-left position of the composer footer so the
// menu opens against a realistic anchor.
const Frame = ({ children, dark }: { children: React.ReactNode; dark?: boolean }) => (
  <div className={dark ? 'dark' : ''}>
    <div {...stylex.props(storyLayout.row)}>
      <div {...stylex.props(storyLayoutStyles.row)}>
        {children}
        <span {...stylex.props(storyLayoutStyles.label)}>Message…</span>
      </div>
    </div>
  </div>
);

const NativeSessionFrame = ({ children }: { children: React.ReactNode }) => (
  <div {...stylex.props(storyLayout.stack)}>
    <VaulDrawerEdgeBackZone isNativeApp topInset="0px" />
    <div
      className={getSessionChatInputAreaShellClassName({
        protectFromEdgeBackZone: true,
      })}
    >
      <div {...stylex.props(storyLayoutStyles.row)}>
        {children}
        <span {...stylex.props(storyLayoutStyles.label)}>Message…</span>
      </div>
    </div>
  </div>
);

export const DesktopLight: Story = {
  args: { isMobile: false, onAddAttachment: noop },
  render: (args) => (
    <Frame>
      <AttachmentAddMenu {...args} />
    </Frame>
  ),
};

export const DesktopDark: Story = {
  args: { isMobile: false, onAddAttachment: noop },
  render: (args) => (
    <Frame dark>
      <AttachmentAddMenu {...args} />
    </Frame>
  ),
};

export const Mobile: Story = {
  args: { isMobile: true, onAddAttachment: noop },
  render: (args) => (
    <Frame>
      <AttachmentAddMenu {...args} />
    </Frame>
  ),
};

export const NativeSession: Story = {
  args: { isMobile: true, onAddAttachment: noop },
  render: (args) => (
    <NativeSessionFrame>
      <AttachmentAddMenu {...args} />
    </NativeSessionFrame>
  ),
};

export const Disabled: Story = {
  args: { isMobile: false, disabled: true, onAddAttachment: noop },
  render: (args) => (
    <Frame>
      <AttachmentAddMenu {...args} />
    </Frame>
  ),
};

export const DesktopWithMcp: Story = {
  args: {
    isMobile: false,
    onAddAttachment: noop,
    mcp: { servers: mcpServers, selectedIds: [], onSelectedIdsChange: noop },
  },
  render: (args) => (
    <Frame>
      <WithMcp {...args} />
    </Frame>
  ),
};

export const MobileWithMcp: Story = {
  args: {
    isMobile: true,
    onAddAttachment: noop,
    mcp: {
      servers: mcpServers,
      selectedIds: [],
      onSelectedIdsChange: noop,
      existingSession: true,
    },
  },
  render: (args) => (
    <Frame>
      <WithMcp {...args} />
    </Frame>
  ),
};

export const McpOnly: Story = {
  args: {
    isMobile: false,
    mcp: { servers: mcpServers, selectedIds: [], onSelectedIdsChange: noop },
  },
  render: (args) => (
    <Frame>
      <WithMcp {...args} />
    </Frame>
  ),
};

const scopedStyles = stylex.create({
  scope: { '--spacing': '5px' },
  receipt: { display: 'block', paddingInline: 16, fontSize: 12 },
});
const ScopedFrame = ({ children }: { children: React.ReactNode }) => (
  <div {...stylex.props(scopedStyles.scope)}>
    <Frame>{children}</Frame>
  </div>
);

function ScopedMcpFixture(args: React.ComponentProps<typeof AttachmentAddMenu>) {
  const [selectedIds, setSelectedIds] = useState<McpServerId[]>([mcpServers[0].id]);
  const [attachments, setAttachments] = useState(0);
  return (
    <div data-attachment-fixture data-attachment-requests={attachments}>
      <ScopedFrame>
        <AttachmentAddMenu
          {...args}
          onAddAttachment={
            args.onAddAttachment
              ? () => {
                  args.onAddAttachment?.();
                  setAttachments((count) => count + 1);
                }
              : undefined
          }
          mcp={{ ...args.mcp!, selectedIds, onSelectedIdsChange: setSelectedIds }}
        />
      </ScopedFrame>
      <output {...stylex.props(scopedStyles.receipt)}>Attachment requests: {attachments}</output>
    </div>
  );
}

export const ScopedDesktopWithMcp: Story = {
  args: { ...DesktopWithMcp.args },
  render: (args) => <ScopedMcpFixture {...args} />,
};

export const ScopedMobileWithMcp: Story = {
  args: { ...MobileWithMcp.args },
  render: (args) => <ScopedMcpFixture {...args} />,
};

export const ScopedMobileLandingWithMcp: Story = {
  args: { ...MobileWithMcp.args, isLanding: true },
  render: (args) => <ScopedMcpFixture {...args} />,
};

export const ScopedDisabled: Story = {
  args: { isMobile: true, disabled: true, onAddAttachment: noop },
  render: (args) => (
    <ScopedFrame>
      <AttachmentAddMenu {...args} />
    </ScopedFrame>
  ),
};

export const EncryptedWorkspace: Story = {
  render: (args) => (
    <Frame>
      <AttachmentAddMenu {...args} />
    </Frame>
  ),
  args: { isMobile: false, onAddAttachment: noop, onScheduleSend: noop },
  decorators: [
    (Story) => {
      const [store] = useState(() => {
        const value = createStore();
        value.set(workspaceContentModeAtom, {
          accountId: 'storybook',
          workspaceSlug: 'encrypted',
          workspaceId: 'encrypted',
          descriptor: { contentMode: 'e2ee', contentModeVersion: 1 },
        } as never);
        return value;
      });
      return (
        <Provider store={store}>
          <Story />
        </Provider>
      );
    },
  ],
};

export const EncryptedWorkspaceMobile: Story = {
  ...EncryptedWorkspace,
  args: { ...EncryptedWorkspace.args, isMobile: true },
};

export const ScheduledSendUnavailable: Story = {
  args: {
    isMobile: false,
    onScheduleSend: noop,
    scheduleDisabledReason: 'Update the target machine CLI to schedule messages.',
  },
  render: (args) => (
    <Frame>
      <AttachmentAddMenu {...args} />
    </Frame>
  ),
};

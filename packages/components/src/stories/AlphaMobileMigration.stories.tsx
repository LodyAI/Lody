import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import {
  MobileSessionTabSheet,
  type ConversationTabEntry,
  type ViewerTabEntry,
} from '../components/mobile/mobile-session-tab-sheet';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100dvh',
    padding: themeSpace[4],
    color: themeColors.foreground,
    backgroundColor: themeColors.background,
  },
  toolbar: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: themeSpace[3] },
});
const conversations: ConversationTabEntry[] = [
  {
    id: 'main',
    title: 'Main synthetic conversation 中文',
    active: true,
    main: true,
    running: false,
    unread: false,
    lastActivityAt: null,
  },
  {
    id: 'idle',
    title: 'Idle secondary conversation',
    active: false,
    running: false,
    unread: false,
    lastActivityAt: null,
  },
  {
    id: 'working',
    title: 'Working synthetic conversation',
    active: false,
    running: true,
    unread: false,
    lastActivityAt: null,
  },
  {
    id: 'waiting',
    title: 'Waiting permission outranks working',
    active: false,
    running: true,
    waitingPermission: true,
    unread: true,
    lastActivityAt: null,
  },
  {
    id: 'unread',
    title: 'Unread synthetic conversation',
    active: false,
    running: false,
    unread: true,
    lastActivityAt: null,
  },
  {
    id: 'long',
    title:
      '很长的中文会话标题 / A long conversation title verifies clipping and the unchanged status-slot geometry at narrow widths',
    active: false,
    running: false,
    unread: false,
    lastActivityAt: null,
  },
];
const viewers: ViewerTabEntry[] = [
  { id: 'files', label: 'Files', kind: 'files', active: false },
  { id: 'file', label: 'very-long-file-name-with-中文-and-a-path.tsx', kind: 'file', active: true },
  { id: 'diff', label: 'All changes', kind: 'diff', active: false },
  { id: 'pr', label: 'Synthetic pull request', kind: 'pr', active: false },
  { id: 'browser', label: 'Browser', kind: 'browser', active: false },
];
function TabsFixture({
  compact = false,
  empty = false,
  readOnly = false,
}: {
  compact?: boolean;
  empty?: boolean;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [action, setAction] = useState('Ready');
  const [items, setItems] = useState(conversations);
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.toolbar)}>
        <Button onClick={() => setOpen(true)}>Open session tabs</Button>
        <output data-alpha-tabs-output>{action}</output>
      </div>
      <MobileSessionTabSheet
        open={open}
        onOpenChange={setOpen}
        conversations={empty ? [] : compact ? items.slice(0, 2) : items}
        archivedConversations={
          readOnly
            ? []
            : [
                {
                  id: 'closed',
                  title: 'Closed synthetic conversation',
                  lastActivityAt: Date.parse('2026-10-01T09:00:00Z'),
                },
                {
                  id: 'archived',
                  title: 'Archived synthetic conversation',
                  lastActivityAt: Date.parse('2026-10-01T09:00:00Z'),
                  restoresArchive: true,
                  unread: true,
                },
              ]
        }
        viewers={empty || compact ? [] : viewers}
        onSelectConversation={(id) => {
          setItems((current) => current.map((c) => ({ ...c, active: c.id === id })));
          setAction(`Selected: ${id}`);
        }}
        onSelectViewer={(id) => setAction(`Viewer: ${id}`)}
        onNewConversation={readOnly ? undefined : () => setAction('New conversation')}
        onRestoreConversation={(id) => setAction(`Restored: ${id}`)}
        onCloseConversation={
          readOnly
            ? undefined
            : (id) => {
                setItems((current) => current.filter((c) => c.id !== id));
                setAction(`Closed: ${id}`);
              }
        }
      />
    </div>
  );
}
const meta = {
  title: 'Mobile/AlphaMobileMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const TabsAllStates: Story = { render: () => <TabsFixture /> };
export const TabsCompact: Story = { render: () => <TabsFixture compact /> };
export const TabsEmpty: Story = { render: () => <TabsFixture empty /> };
export const TabsReadOnly: Story = { render: () => <TabsFixture readOnly /> };

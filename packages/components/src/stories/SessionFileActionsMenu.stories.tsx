import type { Meta, StoryObj } from '@storybook/react';
import { Copy, Download, ExternalLink, FolderOpen } from 'lucide-react';
import { fn } from 'storybook/test';
import { SessionFileActionsMenu } from '@/components/sessions/session-file-actions-menu';
import type { SessionFileMenuItem } from '@/hooks/use-session-file-actions';

const copyPath: SessionFileMenuItem = {
  id: 'copy-path',
  label: 'Copy file path',
  icon: Copy,
  run: fn(),
};

// What `useSessionFileActions` resolves in the desktop app for a file on this
// machine: the shell actions, with the editor named after the user's pick.
const LOCAL_ITEMS: SessionFileMenuItem[] = [
  copyPath,
  { id: 'open-in-editor', label: 'Open in VS Code', icon: ExternalLink, run: fn() },
  { id: 'reveal', label: 'Show in Finder', icon: FolderOpen, run: fn() },
];

// A browser tab, or a session whose machine is not this one.
const REMOTE_ITEMS: SessionFileMenuItem[] = [
  copyPath,
  { id: 'download', label: 'Download file', icon: Download, run: fn() },
];

const meta = {
  title: 'Sessions/SessionFileActionsMenu',
  component: SessionFileActionsMenu,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionFileActionsMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalMachine: Story = {
  args: { filePath: 'apps/mobile/T7112-mobile-report.html', items: LOCAL_ITEMS },
};

export const RemoteMachine: Story = {
  args: { filePath: 'apps/mobile/T7112-mobile-report.html', items: REMOTE_ITEMS },
};

export const NoActiveFile: Story = {
  // The ⋯ button is not rendered at all when the panel is not showing a file.
  args: { filePath: null, items: LOCAL_ITEMS },
};

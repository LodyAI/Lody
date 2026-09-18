import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import {
  Archive,
  Copy,
  FileText,
  GitBranch,
  GitFork,
  Image,
  Link,
  Monitor,
  Pencil,
  Search,
} from 'lucide-react';

import {
  MobileSessionMenuSheet,
  type MobileSessionMenuAction,
  type MobileSessionMenuInfoRow,
  type MobileSessionMenuOwner,
} from '@/components/mobile/mobile-session-menu-sheet';

const infoRows: MobileSessionMenuInfoRow[] = [
  {
    id: 'machine',
    icon: <Monitor className="h-3.5 w-3.5" />,
    label: 'Machine',
    value: 'zx-macbook',
    trailing: <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-label="online" />,
  },
  {
    id: 'base',
    icon: <GitBranch className="h-3.5 w-3.5" />,
    label: 'Base',
    value: 'main',
    onCopy: fn(),
  },
  {
    id: 'current',
    icon: <GitBranch className="h-3.5 w-3.5" />,
    label: 'Branch',
    value: 'lody/solve-merge-conflicts-a1b2c3',
    onCopy: fn(),
  },
];

const actions: MobileSessionMenuAction[] = [
  {
    id: 'find',
    icon: <Search className="h-3.5 w-3.5" />,
    label: 'Find in session',
    onClick: fn(),
  },
  {
    id: 'fork',
    icon: <GitFork className="h-3.5 w-3.5" />,
    label: 'Fork session',
    onClick: fn(),
  },
  { id: 'rename', icon: <Pencil className="h-3.5 w-3.5" />, label: 'Rename Chat', onClick: fn() },
  {
    id: 'copy-path',
    icon: <Copy className="h-3.5 w-3.5" />,
    label: 'Copy path',
    onClick: fn(),
    separatorBefore: true,
  },
  {
    id: 'copy-md',
    icon: <FileText className="h-3.5 w-3.5" />,
    label: 'Copy as Markdown',
    onClick: fn(),
  },
  { id: 'copy-url', icon: <Link className="h-3.5 w-3.5" />, label: 'Copy URL', onClick: fn() },
  {
    id: 'share-image',
    icon: <Image className="h-3.5 w-3.5" />,
    label: 'Share as image…',
    onClick: fn(),
  },
  {
    id: 'archive',
    icon: <Archive className="h-3.5 w-3.5" />,
    label: 'Archive session',
    onClick: fn(),
    separatorBefore: true,
  },
];

const owner: MobileSessionMenuOwner = {
  ownerUserId: 'user-rem',
  members: [
    { userId: 'user-rem', name: 'Rem' },
    { userId: 'user-ada', name: 'Ada Lovelace' },
    { userId: 'user-grace', name: 'Grace Hopper' },
  ],
  onSelect: fn(),
};

function Harness({ owner: ownerProp }: { owner?: MobileSessionMenuOwner }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex min-h-dvh flex-col items-center bg-stone-950 p-6">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground"
      >
        Open menu
      </button>
      <MobileSessionMenuSheet
        open={open}
        onOpenChange={setOpen}
        infoRows={infoRows}
        actions={actions}
        owner={ownerProp}
      />
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileSessionMenuSheet',
  component: Harness,
  parameters: { layout: 'fullscreen' },
  globals: { theme: 'dark' },
  tags: ['autodocs'],
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/**
 * Multi-member workspace: an "Owner" disclosure row sits above the actions and
 * expands the member list in place. Solo workspaces pass no `owner`, so the row
 * is absent — that is the `Default` story.
 */
export const WithOwnerTransfer: Story = {
  args: { owner },
};

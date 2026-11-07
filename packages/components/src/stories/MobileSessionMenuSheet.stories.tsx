import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Spinner } from '@lody/ui/spinner';
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
const menuGlyphs = stylex.create({
  action: { height: 'calc(var(--spacing) * 3.5)', width: 'calc(var(--spacing) * 3.5)' },
});
const storyLayoutStyles = stylex.create({
  canvas: {
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    'background-color': 'hsl(var(--background) / 1)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 2)',
    width: 'calc(var(--spacing) * 2)',
    'flex-shrink': '0',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'var(--color-emerald-500)',
  },
  stack: {
    display: 'flex',
    'min-height': '100dvh',
    'flex-direction': 'column',
    'align-items': 'center',
    'background-color': 'var(--color-stone-950)',
    padding: 'calc(var(--spacing) * 6)',
  },
});

const infoRows: MobileSessionMenuInfoRow[] = [
  {
    id: 'machine',
    icon: <Monitor {...stylex.props(menuGlyphs.action)} />,
    label: 'Machine',
    value: 'zx-macbook',
    trailing: <span {...stylex.props(storyLayout.frame)} aria-label="online" />,
  },
  {
    id: 'base',
    icon: <GitBranch {...stylex.props(menuGlyphs.action)} />,
    label: 'Base',
    value: 'main',
    onCopy: fn(),
  },
  {
    id: 'current',
    icon: <GitBranch {...stylex.props(menuGlyphs.action)} />,
    label: 'Branch',
    value: 'lody/solve-merge-conflicts-a1b2c3',
    onCopy: fn(),
  },
];

const actions: MobileSessionMenuAction[] = [
  {
    id: 'find',
    icon: <Search {...stylex.props(menuGlyphs.action)} />,
    label: 'Find in session',
    onClick: fn(),
  },
  {
    id: 'fork',
    icon: <GitFork {...stylex.props(menuGlyphs.action)} />,
    label: 'Fork session',
    onClick: fn(),
  },
  {
    id: 'rename',
    icon: <Pencil {...stylex.props(menuGlyphs.action)} />,
    label: 'Rename Chat',
    onClick: fn(),
  },
  {
    id: 'copy-path',
    icon: <Copy {...stylex.props(menuGlyphs.action)} />,
    label: 'Copy path',
    onClick: fn(),
    separatorBefore: true,
  },
  {
    id: 'copy-md',
    icon: <FileText {...stylex.props(menuGlyphs.action)} />,
    label: 'Copy as Markdown',
    onClick: fn(),
  },
  {
    id: 'copy-url',
    icon: <Link {...stylex.props(menuGlyphs.action)} />,
    label: 'Copy URL',
    onClick: fn(),
  },
  {
    id: 'share-image',
    icon: <Image {...stylex.props(menuGlyphs.action)} />,
    label: 'Share as image…',
    onClick: fn(),
  },
  {
    id: 'archive',
    icon: <Archive {...stylex.props(menuGlyphs.action)} />,
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
    <div {...stylex.props(storyLayout.stack)}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        {...stylex.props(storyLayoutStyles.canvas)}
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

// Source-projected test inputs, generated from this side's three actual SessionDetail
// Spinner JSX nodes. The production menu/Spinner hosts are real; controller/RPC is not run.
function PendingSpinnerProjectionHarness() {
  const [open, setOpen] = useState(false);
  const [receipt, setReceipt] = useState('Ready');
  return (
    <div data-session-spinner-projection="menu">
      <button type="button" onClick={() => setOpen(true)}>
        Open pending session menu
      </button>
      <output data-session-spinner-receipt>{receipt}</output>
      <MobileSessionMenuSheet
        open={open}
        onOpenChange={setOpen}
        infoRows={[
          {
            id: 'visibility',
            icon: <Spinner diameter="calc(var(--spacing) * 3.5)" />,
            label: 'Visibility',
            value: 'Checking sharing',
          },
        ]}
        actions={[
          {
            id: 'fork',
            icon: <Spinner diameter="calc(var(--spacing) * 3.5)" />,
            label: 'Fork session',
            disabled: true,
            onClick: () => setReceipt('Unexpected fork'),
          },
          {
            id: 'share-with-team',
            icon: <Spinner diameter="calc(var(--spacing) * 3.5)" />,
            label: 'Checking sharing',
            disabled: true,
            onClick: () => setReceipt('Unexpected sharing'),
          },
          {
            id: 'complete',
            icon: <Copy aria-hidden="true" />,
            label: 'Close with receipt',
            onClick: () => setReceipt('Completed synthetic action'),
          },
        ]}
      />
    </div>
  );
}

function PendingSpinnerStandaloneProjection() {
  return (
    <div data-session-spinner-projection="standalone">
      <span>Visibility {<Spinner diameter="calc(var(--spacing) * 3.5)" />}</span>
      <span>Pending fork {<Spinner diameter="calc(var(--spacing) * 3.5)" />}</span>
      <span>Checking sharing {<Spinner diameter="calc(var(--spacing) * 3.5)" />}</span>
    </div>
  );
}

export const PendingSpinnersLight: Story = {
  globals: { theme: 'light' },
  render: () => <PendingSpinnerProjectionHarness />,
};
export const PendingSpinnersDark: Story = {
  globals: { theme: 'dark' },
  render: () => <PendingSpinnerProjectionHarness />,
};
export const PendingSpinnerSizesLight: Story = {
  globals: { theme: 'light' },
  render: () => <PendingSpinnerStandaloneProjection />,
};
export const PendingSpinnerSizesDark: Story = {
  globals: { theme: 'dark' },
  render: () => <PendingSpinnerStandaloneProjection />,
};

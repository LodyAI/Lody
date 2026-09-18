import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { MachineId, SessionMeta } from '@lody/shared';

import {
  SessionHeaderMenu,
  type SessionOwnerMenuState,
} from '@/components/sessions/session-chat-interface';

const ownerMenuState: SessionOwnerMenuState = {
  ownerUserId: 'user-story',
  members: [
    { userId: 'user-story', name: 'Rem', email: 'rem@loro.dev', image: null },
    { userId: 'user-teammate', name: 'Ada Lovelace', email: 'ada@loro.dev', image: null },
    { userId: 'user-third', name: 'Grace Hopper', email: 'grace@loro.dev', image: null },
  ],
  onChangeOwner: fn(),
};

const githubWorktreeSession = {
  id: 'session-header-menu-story',
  machineId: 'machine-header-menu-story',
  userId: 'user-story',
  cliType: 'builtin',
  agentType: 'codex',
  createdAt: '2026-07-13T00:00:00.000Z',
  project: {
    kind: 'github',
    repoFullName: 'zxch3n/test-readme',
    branch: 'main',
  },
  repoFullName: 'zxch3n/test-readme',
  baseBranch: 'main',
  branchName: 'docs/append-line-to-readmemd',
  isWorktree: true,
} as SessionMeta;

const meta = {
  title: 'Sessions/SessionHeaderMenu',
  component: SessionHeaderMenu,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-dvh min-w-[32rem] items-start justify-center bg-background pt-24 text-foreground">
        <Story />
      </div>
    ),
  ],
  args: {
    session: githubWorktreeSession,
    workspacePath: '/Users/developer/Code/test-readme',
    machineName: 'Rems-MacBook-Pro.local',
    onCopyConversationHistory: fn(),
    onCopyUrl: fn(),
    onShareWithTeam: fn(),
    sharing: {
      visibility: 'private',
      privateReason: 'machine',
      canManage: true,
      machineId: 'machine-header-menu-story' as MachineId,
      localProjectId: null,
      machineName: 'Rems-MacBook-Pro.local',
      projectName: null,
    },
    onOpenSearch: fn(),
    onFork: fn(),
    forkWorktreeAvailability: 'available',
    onRename: fn(),
    onArchive: fn(),
    t: (_key, fallback, options) =>
      Object.entries(options ?? {}).reduce(
        (message, [name, value]) => message.replaceAll(`{{${name}}}`, String(value)),
        fallback
      ),
  },
} satisfies Meta<typeof SessionHeaderMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GitHubWorktree: Story = {
  globals: { theme: 'dark' },
};

/**
 * Multi-member workspace: the "Change owner" submenu lists members with the
 * current owner checked. Single-member workspaces pass no `owner` at all, so
 * the submenu is absent — that is the `GitHubWorktree` story above.
 */
export const MultiMemberOwnerTransfer: Story = {
  globals: { theme: 'dark' },
  args: { owner: ownerMenuState },
};

/** A transfer that is still writing: every row is inert and the target spins. */
export const OwnerTransferPending: Story = {
  globals: { theme: 'dark' },
  args: { owner: { ...ownerMenuState, pendingUserId: 'user-teammate' } },
};

export const OpenInIde: Story = {
  globals: { theme: 'dark' },
  args: {
    openInIde: {
      options: [
        { kind: 'builtin', id: 'vscode', label: 'VS Code' },
        { kind: 'builtin', id: 'cursor', label: 'Cursor' },
      ],
      selected: { kind: 'builtin', id: 'vscode', label: 'VS Code' },
      onOpen: fn(),
      onSelect: fn(),
    },
  },
};

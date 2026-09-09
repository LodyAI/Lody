import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';

import {
  MobileWorkspaceSwitcherSheet,
  type MobileWorkspaceSwitcherWorkspace,
} from '@/components/mobile/mobile-workspace-switcher-sheet';
import { Button } from '@lody/ui/button';

const workspaces: MobileWorkspaceSwitcherWorkspace[] = [
  { id: 'lody', name: 'Lody', isActive: true },
  { id: 'loro-dev', name: 'loro-dev', avatarUrl: 'https://github.com/loro-dev.png?size=80' },
  { id: 'personal', name: '个人 / zx' },
  { id: 'demo', name: 'Demo workspace' },
];

function StoryShell({
  initialOpen = true,
  withActions,
  withEmail,
}: {
  initialOpen?: boolean;
  withActions: boolean;
  withEmail: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [activeId, setActiveId] = useState('lody');

  const workspacesWithActive = workspaces.map((w) => ({ ...w, isActive: w.id === activeId }));

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="relative h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <Button onClick={() => setOpen(true)}>Open workspace switcher</Button>
          <div className="text-xs text-muted-foreground">
            Active workspace: <code>{activeId}</code>
          </div>
        </div>
        <MobileWorkspaceSwitcherSheet
          open={open}
          onOpenChange={setOpen}
          userEmail={withEmail ? 'zx@loro.dev' : null}
          workspaces={workspacesWithActive}
          onSelect={(id) => {
            setActiveId(id);
            fn()(id);
          }}
          onCreateWorkspace={withActions ? fn() : undefined}
          onInviteMembers={withActions ? fn() : undefined}
          labels={{
            title: '工作空间',
            workspacesHeading: 'Workspaces',
            createWorkspace: 'Create Workspace',
            inviteMembers: 'Invite members',
          }}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileWorkspaceSwitcherSheet',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  args: { withActions: true, withEmail: true },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutActions: Story = {
  args: { withActions: false, withEmail: true },
};

export const Anonymous: Story = {
  args: { withActions: true, withEmail: false },
};

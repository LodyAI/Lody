import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';

import {
  MobileWorkspaceSwitcherSheet,
  type MobileWorkspaceSwitcherWorkspace,
} from '@/components/mobile/mobile-workspace-switcher-sheet';
import { Button } from '@lody/ui/button';
const phoneFrame = stylex.create({
  frame: {
    height: { default: '100dvh', '@media (min-width: 40rem)': '852px' },
    width: { default: '100%', '@media (min-width: 40rem)': '393px' },
    borderRadius: { default: null, '@media (min-width: 40rem)': '34px' },
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflow: 'hidden',
    position: 'relative',
  },
});

const storyViewport = stylex.create({
  canvas: {
    display: 'flex',
    minHeight: '100dvh',
    alignItems: 'center',
    justifyContent: 'center',
    '--story-device-canvas-components': '92.3% 0.003 48.717',
    backgroundColor: 'oklch(var(--story-device-canvas-components))',
    padding: { default: '0px', '@media (min-width: 40rem)': 'calc(var(--spacing) * 6)' },
  },
});

const storyLayoutStyles = stylex.create({
  caption: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  stack: {
    display: 'flex',
    height: '100%',
    'flex-direction': 'column',
    'align-items': 'center',
    'justify-content': 'center',
    gap: 'calc(var(--spacing) * 3)',
  },
});

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
    <div {...stylex.props(storyViewport.canvas)}>
      <div {...stylex.props(phoneFrame.frame)}>
        <div {...stylex.props(storyLayout.stack)}>
          <Button onClick={() => setOpen(true)}>Open workspace switcher</Button>
          <div {...stylex.props(storyLayoutStyles.caption)}>
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

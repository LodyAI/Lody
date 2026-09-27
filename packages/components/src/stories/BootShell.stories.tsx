import type { Meta, StoryObj } from '@storybook/react';

import { BootShell } from '@/components/boot-shell';

const meta = {
  title: 'Components/BootShell',
  component: BootShell,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof BootShell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A workspace route with the sidebar open: the column the real sidebar fills. */
export const WorkspaceWithSidebar: Story = {
  args: { sidebar: true },
};

/** Collapsed sidebar, session windows and non-workspace routes: the mark only. */
export const MarkOnly: Story = {
  args: { sidebar: false },
};

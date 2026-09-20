import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { SidebarFilterPopover } from '@/components/sidebar-filter-popover';
import type { SidebarChatScope, SidebarOrganizeMode } from '@/atoms/sidebar-state';

function FilterShell({
  organize: organizeArg,
  scope: scopeArg,
  defaultOpen,
}: {
  organize: SidebarOrganizeMode;
  scope: SidebarChatScope;
  defaultOpen?: boolean;
}) {
  const [organize, setOrganize] = useState<SidebarOrganizeMode>(organizeArg);
  const [scope, setScope] = useState<SidebarChatScope>(scopeArg);

  return (
    <div className="flex min-h-[260px] items-end gap-6 rounded-2xl bg-sidebar p-6 text-sidebar-foreground">
      <div className="flex flex-1 flex-col gap-2">
        <div className="text-xs uppercase tracking-wide text-sidebar-foreground-muted/70">
          State
        </div>
        <div className="rounded-lg border border-sidebar-border/60 bg-background/40 p-3 text-xs">
          <div>
            <span className="text-sidebar-foreground-muted">Organize:</span>{' '}
            <span className="font-medium">{organize}</span>
          </div>
          <div className="mt-1">
            <span className="text-sidebar-foreground-muted">Scope:</span>{' '}
            <span className="font-medium">{scope}</span>
          </div>
        </div>
        <p className="mt-3 text-xs text-sidebar-foreground-muted">
          Click the filter icon to open the popover. Selections update the panel above.
        </p>
      </div>
      <div className="flex items-center justify-end">
        <SidebarFilterPopover
          organize={organize}
          scope={scope}
          onOrganizeChange={setOrganize}
          onScopeChange={setScope}
          {...(defaultOpen ? { side: 'top', align: 'end' } : null)}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Sidebar/SidebarFilterPopover',
  component: FilterShell,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    organize: 'workspace',
    scope: 'my',
  },
  argTypes: {
    organize: {
      control: 'inline-radio',
      options: ['workspace', 'updated'],
    },
    scope: {
      control: 'inline-radio',
      options: ['my', 'team'],
    },
  },
} satisfies Meta<typeof FilterShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const UpdatedMode: Story = {
  args: {
    organize: 'updated',
    scope: 'my',
  },
};

export const TeamScope: Story = {
  args: {
    organize: 'workspace',
    scope: 'team',
  },
};

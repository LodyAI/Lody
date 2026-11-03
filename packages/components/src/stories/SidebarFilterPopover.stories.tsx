import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { SidebarFilterPopover } from '@/components/sidebar-filter-popover';
import type { SidebarChatScope, SidebarOrganizeMode } from '@/atoms/sidebar-state';
const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'min-height': '260px',
    'align-items': 'flex-end',
    gap: 'calc(var(--spacing) * 6)',
    'border-radius': 'var(--radius-2xl)',
    'background-color': 'hsl(var(--sidebar-background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--sidebar-foreground) / 1)',
  },
  stack: {
    display: 'flex',
    flex: '1',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 2)',
  },
  label: {
    color: 'hsl(var(--sidebar-foreground-muted) / 1)',
  },
  section: {
    'margin-top': 'calc(var(--spacing) * 1)',
  },
  row2: {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'flex-end',
  },
});

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
  const [showUpdatedProjectNames, setShowUpdatedProjectNames] = useState(true);
  const [showBranchNames, setShowBranchNames] = useState(false);

  return (
    <div {...stylex.props(storyLayout.row)}>
      <div {...stylex.props(storyLayout.stack)}>
        <div className="text-xs uppercase tracking-wide text-sidebar-foreground-muted/70">
          State
        </div>
        <div className="rounded-lg border border-sidebar-border/60 bg-background/40 p-3 text-xs">
          <div>
            <span {...stylex.props(storyLayout.label)}>Organize:</span>{' '}
            <span className="font-medium">{organize}</span>
          </div>
          <div {...stylex.props(storyLayout.section)}>
            <span {...stylex.props(storyLayout.label)}>Scope:</span>{' '}
            <span className="font-medium">{scope}</span>
          </div>
          <div {...stylex.props(storyLayout.section)}>
            <span {...stylex.props(storyLayout.label)}>Project line:</span>{' '}
            <span className="font-medium">{showUpdatedProjectNames ? 'on' : 'off'}</span>
          </div>
          <div {...stylex.props(storyLayout.section)}>
            <span {...stylex.props(storyLayout.label)}>Branch line:</span>{' '}
            <span className="font-medium">{showBranchNames ? 'on' : 'off'}</span>
          </div>
        </div>
        <p className="mt-3 text-xs text-sidebar-foreground-muted">
          Click the filter icon to open the popover. Selections update the panel above.
        </p>
      </div>
      <div {...stylex.props(storyLayout.row2)}>
        <SidebarFilterPopover
          organize={organize}
          scope={scope}
          onOrganizeChange={setOrganize}
          onScopeChange={setScope}
          showUpdatedProjectNames={showUpdatedProjectNames}
          onShowUpdatedProjectNamesChange={setShowUpdatedProjectNames}
          showBranchNames={showBranchNames}
          onShowBranchNamesChange={setShowBranchNames}
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

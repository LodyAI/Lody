import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Folder, GitBranch, Github, Monitor, Sparkles } from 'lucide-react';

import {
  MobileInlinePicker,
  MobileInlinePickerCoordinator,
  MobileInlinePickerRowSlot,
  MobileInlineMenu,
  type MobileInlinePickerOption,
} from '@/components/mobile/mobile-inline-picker';
import { Button } from '@lody/ui/button';
const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'min-height': '100dvh',
    'align-items': 'center',
    'justify-content': 'center',
    'background-color': 'var(--color-stone-200)',
    padding: 'calc(var(--spacing) * 6)',
  },
  label: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  row2: {
    display: 'flex',
    width: '100%',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
  },
  section: {
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
  },
  stack: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 1)',
  },
});

const machineOptions: MobileInlinePickerOption[] = [
  { value: 'zx-macbook', label: 'zx-macbook', icon: <Monitor className="h-3.5 w-3.5" /> },
  { value: 'lab-m2', label: 'lab-m2', icon: <Monitor className="h-3.5 w-3.5" /> },
  {
    value: 'mini-offline',
    label: 'mini-offline',
    icon: <Monitor className="h-3.5 w-3.5" />,
    disabled: true,
    disabledReason: 'Offline',
  },
];

const repoOptions: MobileInlinePickerOption[] = Array.from({ length: 12 }).map((_, i) => ({
  value: `repo-${i}`,
  label: `loro-dev/project-${i}`,
  description: i % 2 === 0 ? 'Active' : 'Archived last week',
  icon: <Github className="h-3.5 w-3.5" />,
}));

const branchOptions: MobileInlinePickerOption[] = [
  { value: 'main', label: 'main', icon: <GitBranch className="h-3.5 w-3.5" /> },
  {
    value: 'feat/x',
    label: 'feat/audit-mobile-coupling',
    icon: <GitBranch className="h-3.5 w-3.5" />,
  },
];

function StandaloneShell() {
  const [machine, setMachine] = useState('zx-macbook');

  return (
    <div {...stylex.props(storyLayout.row)}>
      <div className="w-[360px] rounded-2xl bg-background p-6 shadow-2xl">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Standalone picker (no coordinator)
        </div>
        <MobileInlinePicker
          id="story-standalone-machine"
          value={machine}
          onChange={setMachine}
          options={machineOptions}
          ariaLabel="Machine"
          triggerContent={
            <>
              <Monitor className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span {...stylex.props(storyLayout.label)}>{machine}</span>
            </>
          }
        />
        <div className="mt-4 text-xs text-muted-foreground">
          Picked: <code>{machine}</code>
        </div>
      </div>
    </div>
  );
}

function LoadingShell() {
  return (
    <div {...stylex.props(storyLayout.row)}>
      <div className="w-[360px] space-y-4 rounded-2xl bg-background p-6 shadow-2xl">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Loading state (spinner replaces trigger content)
        </div>
        <MobileInlinePicker
          id="story-loading-branch"
          value={null}
          onChange={() => {}}
          options={branchOptions}
          ariaLabel="Branch"
          loading
          loadingText="Loading branches..."
          triggerContent={
            <>
              <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span {...stylex.props(storyLayout.label)}>main</span>
            </>
          }
        />
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Loading without loadingText (spinner prefixes existing content)
        </div>
        <MobileInlinePicker
          id="story-loading-machine"
          value={null}
          onChange={() => {}}
          options={machineOptions}
          ariaLabel="Machine"
          loading
          triggerContent={
            <>
              <Monitor className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span {...stylex.props(storyLayout.label)}>zx-macbook</span>
            </>
          }
        />
      </div>
    </div>
  );
}

function CoordinatorRowShell({ searchable = false }: { searchable?: boolean }) {
  const [repo, setRepo] = useState('repo-0');
  const [branch, setBranch] = useState('main');

  return (
    <div {...stylex.props(storyLayout.row)}>
      <MobileInlinePickerCoordinator>
        <div className="w-[360px] rounded-2xl bg-background p-6 shadow-2xl">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Row slot + coordinator (one open at a time, shared dropdown row)
          </div>
          <MobileInlinePickerRowSlot>
            <div {...stylex.props(storyLayout.row2)}>
              <div {...stylex.props(storyLayout.section)}>
                <MobileInlinePicker
                  id="story-coord-repo"
                  value={repo}
                  onChange={setRepo}
                  options={repoOptions}
                  ariaLabel="Repository"
                  searchable={searchable}
                  searchPlaceholder="Search repositories"
                  triggerContent={
                    <>
                      <Github className="h-3.5 w-3.5 shrink-0 opacity-70" />
                      <span {...stylex.props(storyLayout.label)}>
                        {repoOptions.find((o) => o.value === repo)?.label}
                      </span>
                    </>
                  }
                />
              </div>
              <div {...stylex.props(storyLayout.section)}>
                <MobileInlinePicker
                  id="story-coord-branch"
                  value={branch}
                  onChange={setBranch}
                  options={branchOptions}
                  ariaLabel="Branch"
                  triggerContent={
                    <>
                      <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
                      <span {...stylex.props(storyLayout.label)}>{branch}</span>
                    </>
                  }
                />
              </div>
            </div>
          </MobileInlinePickerRowSlot>
        </div>
      </MobileInlinePickerCoordinator>
    </div>
  );
}

function MenuShell() {
  return (
    <div {...stylex.props(storyLayout.row)}>
      <div className="w-[360px] rounded-2xl bg-background p-6 shadow-2xl">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          MobileInlineMenu (arbitrary content)
        </div>
        <MobileInlineMenu
          id="story-menu"
          ariaLabel="Add"
          triggerClassName="inline-flex h-9 items-center gap-2 rounded-md border border-border/60 bg-card px-3 text-sm"
          triggerContent={
            <>
              <Sparkles className="h-4 w-4" />
              <span>更多操作</span>
            </>
          }
        >
          {({ close }) => (
            <div {...stylex.props(storyLayout.stack)}>
              <Button variant="ghost" className="justify-start" onClick={close}>
                <Folder className="mr-2 h-4 w-4" /> Add file
              </Button>
              <Button variant="ghost" className="justify-start" onClick={close}>
                <GitBranch className="mr-2 h-4 w-4" /> New branch
              </Button>
              <div className="border-t border-border/40" />
              <Button variant="ghost" className="justify-start" onClick={close}>
                Close
              </Button>
            </div>
          )}
        </MobileInlineMenu>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileInlinePicker',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Standalone: Story = {
  render: () => <StandaloneShell />,
};

export const Loading: Story = {
  render: () => <LoadingShell />,
};

export const CoordinatorRow: Story = {
  render: () => <CoordinatorRowShell />,
};

export const SearchableRow: Story = {
  render: () => <CoordinatorRowShell searchable />,
};

export const Menu: Story = {
  render: () => <MenuShell />,
};

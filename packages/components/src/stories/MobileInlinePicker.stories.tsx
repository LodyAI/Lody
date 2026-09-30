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
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-6">
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
              <span className="truncate">{machine}</span>
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
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-6">
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
              <span className="truncate">main</span>
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
              <span className="truncate">zx-macbook</span>
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
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-6">
      <MobileInlinePickerCoordinator>
        <div className="w-[360px] rounded-2xl bg-background p-6 shadow-2xl">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Row slot + coordinator (one open at a time, shared dropdown row)
          </div>
          <MobileInlinePickerRowSlot>
            <div className="flex w-full items-start gap-2">
              <div className="min-w-0 flex-1">
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
                      <span className="truncate">
                        {repoOptions.find((o) => o.value === repo)?.label}
                      </span>
                    </>
                  }
                />
              </div>
              <div className="min-w-0 flex-1">
                <MobileInlinePicker
                  id="story-coord-branch"
                  value={branch}
                  onChange={setBranch}
                  options={branchOptions}
                  ariaLabel="Branch"
                  triggerContent={
                    <>
                      <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
                      <span className="truncate">{branch}</span>
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
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-6">
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
            <div className="flex flex-col gap-1">
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

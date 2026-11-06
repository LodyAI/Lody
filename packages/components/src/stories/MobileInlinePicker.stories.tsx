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
const pickerStory = stylex.create({
  glyphMuted: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
    opacity: '70%',
  },
  glyph: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
  menuGlyph: {
    'margin-right': 'calc(var(--spacing) * 2)',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
  panel: {
    width: '360px',
    'border-radius': 'var(--radius-2xl)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
  },
  caption: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--muted-foreground) / 1)',
    'text-transform': 'uppercase',
  },
  selection: {
    'margin-top': 'calc(var(--spacing) * 4)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  heading: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--muted-foreground) / 1)',
    'text-transform': 'uppercase',
  },
  headingGap: {
    'margin-bottom': 'calc(var(--spacing) * 3)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--muted-foreground) / 1)',
    'text-transform': 'uppercase',
  },
  separator: {
    'border-top-style': 'solid',
    'border-top-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 40%, transparent)',
  },
  canvas: {
    display: 'flex',
    'min-height': '100dvh',
    'align-items': 'center',
    'justify-content': 'center',
    'background-color': 'var(--color-stone-200)',
    padding: 'calc(var(--spacing) * 6)',
  },
  truncate: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  row: {
    display: 'flex',
    width: '100%',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
  },
  grow: {
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
  },
  menuItems: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 1)',
  },
  smallGlyph: { width: 'calc(var(--spacing) * 3.5)', height: 'calc(var(--spacing) * 3.5)' },
  stackedPanel: {
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 4)',
    },
  },
  menuTrigger: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 9)',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-md)',
    borderWidth:"1px",borderStyle:"solid",borderColor:"color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)",
    backgroundColor: 'hsl(var(--card) / 1)',
    paddingInline: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  action: { justifyContent: 'flex-start' },
});

const machineOptions: MobileInlinePickerOption[] = [
  {
    value: 'zx-macbook',
    label: 'zx-macbook',
    icon: <Monitor {...stylex.props(pickerStory.smallGlyph)} />,
  },
  { value: 'lab-m2', label: 'lab-m2', icon: <Monitor {...stylex.props(pickerStory.smallGlyph)} /> },
  {
    value: 'mini-offline',
    label: 'mini-offline',
    icon: <Monitor {...stylex.props(pickerStory.smallGlyph)} />,
    disabled: true,
    disabledReason: 'Offline',
  },
];

const repoOptions: MobileInlinePickerOption[] = Array.from({ length: 12 }).map((_, i) => ({
  value: `repo-${i}`,
  label: `loro-dev/project-${i}`,
  description: i % 2 === 0 ? 'Active' : 'Archived last week',
  icon: <Github {...stylex.props(pickerStory.smallGlyph)} />,
}));

const branchOptions: MobileInlinePickerOption[] = [
  { value: 'main', label: 'main', icon: <GitBranch {...stylex.props(pickerStory.smallGlyph)} /> },
  {
    value: 'feat/x',
    label: 'feat/audit-mobile-coupling',
    icon: <GitBranch {...stylex.props(pickerStory.smallGlyph)} />,
  },
];

function StandaloneShell() {
  const [machine, setMachine] = useState('zx-macbook');

  return (
    <div {...stylex.props(pickerStory.canvas)}>
      <div {...stylex.props(pickerStory.panel)}>
        <div {...stylex.props(pickerStory.caption)}>Standalone picker (no coordinator)</div>
        <MobileInlinePicker
          id="story-standalone-machine"
          value={machine}
          onChange={setMachine}
          options={machineOptions}
          ariaLabel="Machine"
          triggerContent={
            <>
              <Monitor {...stylex.props(pickerStory.glyphMuted)} />
              <span {...stylex.props(pickerStory.truncate)}>{machine}</span>
            </>
          }
        />
        <div {...stylex.props(pickerStory.selection)}>
          Picked: <code>{machine}</code>
        </div>
      </div>
    </div>
  );
}

function LoadingShell() {
  return (
    <div {...stylex.props(pickerStory.canvas)}>
      <div {...stylex.props(pickerStory.panel, pickerStory.stackedPanel)}>
        <div {...stylex.props(pickerStory.heading)}>
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
              <GitBranch {...stylex.props(pickerStory.glyphMuted)} />
              <span {...stylex.props(pickerStory.truncate)}>main</span>
            </>
          }
        />
        <div {...stylex.props(pickerStory.heading)}>
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
              <Monitor {...stylex.props(pickerStory.glyphMuted)} />
              <span {...stylex.props(pickerStory.truncate)}>zx-macbook</span>
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
    <div {...stylex.props(pickerStory.canvas)}>
      <MobileInlinePickerCoordinator>
        <div {...stylex.props(pickerStory.panel)}>
          <div {...stylex.props(pickerStory.headingGap)}>
            Row slot + coordinator (one open at a time, shared dropdown row)
          </div>
          <MobileInlinePickerRowSlot>
            <div {...stylex.props(pickerStory.row)}>
              <div {...stylex.props(pickerStory.grow)}>
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
                      <Github {...stylex.props(pickerStory.glyphMuted)} />
                      <span {...stylex.props(pickerStory.truncate)}>
                        {repoOptions.find((o) => o.value === repo)?.label}
                      </span>
                    </>
                  }
                />
              </div>
              <div {...stylex.props(pickerStory.grow)}>
                <MobileInlinePicker
                  id="story-coord-branch"
                  value={branch}
                  onChange={setBranch}
                  options={branchOptions}
                  ariaLabel="Branch"
                  triggerContent={
                    <>
                      <GitBranch {...stylex.props(pickerStory.glyphMuted)} />
                      <span {...stylex.props(pickerStory.truncate)}>{branch}</span>
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
    <div {...stylex.props(pickerStory.canvas)}>
      <div {...stylex.props(pickerStory.panel)}>
        <div {...stylex.props(pickerStory.headingGap)}>MobileInlineMenu (arbitrary content)</div>
        <MobileInlineMenu
          id="story-menu"
          ariaLabel="Add"
          triggerXstyle={pickerStory.menuTrigger}
          triggerContent={
            <>
              <Sparkles {...stylex.props(pickerStory.glyph)} />
              <span>更多操作</span>
            </>
          }
        >
          {({ close }) => (
            <div {...stylex.props(pickerStory.menuItems)}>
              <Button variant="ghost" xstyle={pickerStory.action} onClick={close}>
                <Folder {...stylex.props(pickerStory.menuGlyph)} /> Add file
              </Button>
              <Button variant="ghost" xstyle={pickerStory.action} onClick={close}>
                <GitBranch {...stylex.props(pickerStory.menuGlyph)} /> New branch
              </Button>
              <div {...stylex.props(pickerStory.separator)} />
              <Button variant="ghost" xstyle={pickerStory.action} onClick={close}>
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

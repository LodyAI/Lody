import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { Archive, Hand } from 'lucide-react';
import { useEffect, useState } from 'react';

import { SidebarRowEndSlot } from '@/components/sidebar-row-shared';

import { clsx } from 'clsx';
import { WorkingGrid, type WorkingGridProps } from '@/ui/working-grid';
import { WorkingStatusMark } from '@/ui/working-status-mark';

const hoverStyles = stylex.create({
  muted: { color: 'hsl(var(--sidebar-foreground-muted) / 1)' },
  primary: { color: 'hsl(var(--primary))' },
  row: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    backgroundColor: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--sidebar-hover) / 1)' },
    },
  },
  selected: {
    backgroundColor: {
      default: 'hsl(var(--sidebar-selection) / 1)',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--sidebar-hover) / 1)' },
    },
  },
  status: {
    display: 'flex',
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    alignItems: 'center',
    justifyContent: 'center',
    transitionProperty: 'opacity',
    transitionDuration: '100ms',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    opacity: { default: 1, '@media (hover: hover)': { ':is(:where(.group):hover *)': 0 } },
  },
  archive: {
    position: 'absolute',
    inset: 'calc(var(--spacing) * 0)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '0.25rem',
    color: {
      default: 'hsl(var(--sidebar-foreground-muted) / 1)',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--sidebar-foreground) / 1)' },
    },
    backgroundColor: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--sidebar-hover) / 1)' },
    },
    opacity: { default: 0, '@media (hover: hover)': { ':is(:where(.group):hover *)': 1 } },
    transitionProperty: 'opacity',
    transitionDuration: '100ms',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
});

const storyLayoutStylesStyles = stylex.create({
  stack: {
    display: 'flex',
    width: '272px',
    flexDirection: 'column',
    overflowY: 'auto',
    borderRightStyle: 'solid',
    borderRightWidth: '1px',
    borderColor: 'hsl(var(--sidebar-border) / 1)',
    backgroundColor: 'hsl(var(--sidebar-background) / 1)',
    paddingInline: 'calc(var(--spacing) * 1.5)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    color: 'hsl(var(--sidebar-foreground) / 1)',
  },
  canvas: {
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingTop: 'calc(var(--spacing) * 3)',
    paddingBottom: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--sidebar-foreground-muted) / 1)',
  },
  canvas2: {
    flex: '1',
    overflowY: 'auto',
    backgroundColor: 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 8)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  row: {
    display: 'flex',
    width: '260px',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'hsl(var(--sidebar-background) / 1)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--sidebar-foreground) / 1)',
  },
});

const storyLayoutStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    color: 'hsl(var(--status-warning) / 1)',
  },
  frame2: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 10)',
    padding: 'calc(var(--spacing) * 6)',
  },
  frame: {
    height: 'calc(var(--spacing) * 2)',
    width: 'calc(var(--spacing) * 2)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--primary))',
  },
  row2: {
    display: 'flex',
    height: '100vh',
  },
  label: {
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  row3: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    'min-width': 'calc(var(--spacing) * 5)',
    'align-items': 'center',
    'justify-content': 'center',
  },
  row4: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  row5: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 16)',
    padding: 'calc(var(--spacing) * 10)',
  },
  caption: {
    'transform-origin': 'center',
    scale: '6',
    color: 'hsl(var(--primary))',
  },
});

const SUPERELLIPSE_OPTIONS = ['none', '6', '5', '4', '3', '2.6'] as const;

const meta = {
  title: 'UI/WorkingGrid',
  component: WorkingGrid,
  tags: ['autodocs'],
  args: {
    size: 12,
    cornerRadius: 0.4,
    scale: 'center',
    maxScale: 0.9,
    minScale: 0.3,
    minOpacity: 0.25,
    maxOpacity: 1,
    rhythm: 0.3,
    speed: 1,
    waves: 1,
    ripple: 0.3,
    gap: 0.18,
    wavelength: 1.2,
    direction: 'across',
    rowPitch: 28,
    lightCompensation: true,
    className: 'primary',
  },
  argTypes: {
    size: { control: { type: 'range', min: 10, max: 96, step: 1 } },
    cornerRadius: { control: { type: 'range', min: 0, max: 0.5, step: 0.02 } },
    superellipse: {
      options: SUPERELLIPSE_OPTIONS,
      mapping: { none: undefined, 6: 6, 5: 5, 4: 4, 3: 3, 2.6: 2.6 },
      control: { type: 'select' },
      description: 'Superellipse exponent n; overrides cornerRadius (4 ≈ iOS squircle).',
    },
    scale: { options: ['center', 'bottom', 'none'], control: { type: 'inline-radio' } },
    maxScale: { control: { type: 'range', min: 0.3, max: 1, step: 0.05 } },
    minScale: {
      control: { type: 'range', min: -0.4, max: 0.9, step: 0.05 },
      description: '≤ 0 lets a tile vanish; below 0 it stays empty for part of each trough.',
    },
    minOpacity: { control: { type: 'range', min: 0, max: 1, step: 0.05 } },
    maxOpacity: { control: { type: 'range', min: 0.1, max: 1, step: 0.05 } },
    rhythm: { control: { type: 'range', min: 0, max: 1, step: 0.05 } },
    speed: { control: { type: 'range', min: 0.1, max: 1.5, step: 0.05 } },
    waves: { options: [1, 2], control: { type: 'inline-radio' } },
    ripple: { control: { type: 'range', min: 0, max: 0.7, step: 0.05 } },
    gap: { control: { type: 'range', min: 0.05, max: 0.5, step: 0.01 } },
    wavelength: { control: { type: 'range', min: 0.5, max: 3, step: 0.1 } },
    direction: { options: ['across', 'down'], control: { type: 'inline-radio' } },
    rowPitch: {
      options: ['stitched', 'real'],
      mapping: { stitched: 28, real: null },
      control: { type: 'inline-radio' },
      description: 'Stitched skips the sea between 28px sidebar rows.',
    },
    className: {
      name: 'colour',
      options: ['muted', 'primary'],
      mapping: {
        muted: stylex.props(hoverStyles.muted).className,
        primary: stylex.props(hoverStyles.primary).className,
      },
      control: { type: 'inline-radio' },
      description: 'Primary is the sidebar default; muted is kept for comparison.',
    },
  },
} satisfies Meta<typeof WorkingGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One mark at sidebar size, plus a magnified one to judge tile shape and motion. */
export const Playground: Story = {
  render: (args) => (
    <div {...stylex.props(storyLayout.row)}>
      <WorkingGrid {...args} />
      <WorkingGrid {...args} size={96} />
    </div>
  ),
};

type RowStatus = 'working' | 'unread' | 'waiting' | 'idle';

const GROUPS: { name: string; rows: [string, RowStatus][] }[] = [
  {
    name: 'lody',
    rows: [
      ['Fix queue drain false failure', 'working'],
      ['Refactor ConversationView', 'working'],
      ['Release v0.100.0', 'unread'],
      ['Investigate renderer worker', 'working'],
      ['Update AGENTS.md', 'idle'],
      ['Presence offline triage', 'working'],
      ['Devbar window warmup', 'working'],
      ['CLI Logger interface fan-out', 'waiting'],
      ['MCP catalog negotiation', 'working'],
    ],
  },
  {
    name: 'loro',
    rows: [
      ['loro-mirror cid issue', 'idle'],
      ['Snapshot import benchmark', 'working'],
      ['Kimi OAuth no reply', 'unread'],
      ['Renderer CRDT worker feasibility', 'working'],
      ['loro-wasm CJS load failure', 'working'],
      ['Shallow snapshot GC', 'idle'],
      ['Movable list diff', 'working'],
    ],
  },
  {
    name: 'afterray',
    rows: [
      ['Notarized DMG fails', 'working'],
      ['Sparkle appcast', 'working'],
      ['Memory index rebuild', 'unread'],
      ['Onboarding copy', 'working'],
      ['Gatekeeper error triage', 'idle'],
    ],
  },
];

function StatusMark({ status, grid }: { status: RowStatus; grid: WorkingGridProps }) {
  if (status === 'working') return <WorkingGrid {...grid} />;
  if (status === 'waiting') return <Hand {...stylex.props(storyLayoutStyles.frame)} />;
  if (status === 'unread') return <span {...stylex.props(storyLayout.frame)} />;
  return null;
}

/**
 * A full-height sidebar at production geometry (28px rows, 14px trailing status
 * slot that swaps to Archive on hover), so the controls can be judged on the
 * surface the mark actually ships in: many marks at once, one shared sea.
 */
export const SidebarSimulation: Story = {
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    <div {...stylex.props(storyLayout.row2)}>
      <aside {...stylex.props(storyLayoutStylesStyles.stack)}>
        {GROUPS.map((group) => (
          <section key={group.name}>
            <div {...stylex.props(storyLayoutStylesStyles.canvas)}>{group.name}</div>
            {group.rows.map(([title, status], index) => (
              <div
                key={title}
                className={clsx(
                  'group',
                  stylex.props(
                    hoverStyles.row,
                    group.name === 'lody' && index === 0 && hoverStyles.selected
                  ).className
                )}
              >
                <span {...stylex.props(storyLayout.label)}>{title}</span>
                <span {...stylex.props(storyLayout.row3)}>
                  <span {...stylex.props(hoverStyles.status)}>
                    <StatusMark status={status} grid={args} />
                  </span>
                  <span {...stylex.props(hoverStyles.archive)}>
                    <Archive {...stylex.props(storyLayoutStyles.frame2)} />
                  </span>
                </span>
              </div>
            ))}
          </section>
        ))}
      </aside>
      <main {...stylex.props(storyLayoutStylesStyles.canvas2)}>
        <div {...stylex.props(storyLayout.row4)}>
          <WorkingGrid {...args} rowPitch={null} />
          <span>Working · 2m 13s</span>
        </div>
      </main>
    </div>
  ),
};

/** Replays the done transition on a loop, at real size and magnified. */
function CompletionDemo() {
  const [working, setWorking] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setWorking((value) => !value), 1800);
    return () => clearInterval(id);
  }, []);
  return (
    <div {...stylex.props(storyLayout.row5)}>
      <div {...stylex.props(storyLayoutStylesStyles.row)}>
        <span {...stylex.props(storyLayout.label)}>Fix queue drain false failure</span>
        <SidebarRowEndSlot isWorking={working} hasUnreadMessages={!working} />
      </div>
      <div {...stylex.props(storyLayout.caption)}>
        <WorkingStatusMark working={working} unread={!working} />
      </div>
    </div>
  );
}

/**
 * The done transition: when a session stops working with new messages, the nine
 * tiles spin and gather into the unread dot, which pops and settles with a
 * bounce while a few sparks fly off. Loops every 1.8s.
 */
export const Completion: Story = {
  render: () => <CompletionDemo />,
};

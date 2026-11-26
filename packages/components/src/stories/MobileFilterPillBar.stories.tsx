import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Monitor } from 'lucide-react';

import {
  MobileFilterPillBar,
  type FilterPill,
} from '@/components/mobile/mobile-filter-pill-bar';

const storyStyles = stylex.create({
  canvas: {
    display: 'flex',
    minHeight: '100dvh',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--color-stone-200, oklch(92.3% 0.003 48.717))',
    padding: { default: 0, '@media (min-width: 40rem)': 'calc(var(--spacing) * 6)' },
  },
  frame: {
    height: { default: '100dvh', '@media (min-width: 40rem)': '852px' },
    width: { default: '100%', '@media (min-width: 40rem)': '393px' },
    borderRadius: { default: null, '@media (min-width: 40rem)': '34px' },
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflow: 'hidden',
  },
  icon: { height: 'calc(var(--spacing) * 3)', width: 'calc(var(--spacing) * 3)' },
  header: {
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    paddingTop: 'calc(var(--spacing) * 3)',
  },
  status: {
    padding: 'calc(var(--spacing) * 4)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 2)',
    },
  },
  hint: { paddingTop: 'calc(var(--spacing) * 3)', color: 'hsl(var(--muted-foreground) / 1)' },
});
const allMachines = ['zx-macbook', 'lab-m2', 'mini-offline'];

function StoryShell() {
  const [scope, setScope] = useState('all');
  const [status, setStatus] = useState('all');
  const [machines, setMachines] = useState<Set<string>>(new Set(allMachines));

  const pills: FilterPill[] = [
    {
      kind: 'single',
      id: 'scope',
      fallbackLabel: 'Scope',
      options: [
        { id: 'all', label: '全部' },
        { id: 'mine', label: '我的' },
        { id: 'team', label: '团队' },
      ],
      selectedId: scope,
      onSelect: setScope,
    },
    {
      kind: 'single',
      id: 'status',
      fallbackLabel: 'Status',
      options: [
        { id: 'all', label: '全部状态' },
        { id: 'working', label: '运行中' },
        { id: 'waiting', label: '等待批准' },
        { id: 'idle', label: '空闲' },
      ],
      selectedId: status,
      onSelect: setStatus,
    },
    {
      kind: 'multi',
      id: 'machines',
      label: 'Machines',
      options: allMachines.map((m) => ({
        id: m,
        label: m,
        icon: <Monitor {...stylex.props(storyStyles.icon)} />,
      })),
      selectedIds: machines,
      defaultIds: new Set(allMachines),
      onChange: setMachines,
    },
  ];

  return (
    <div {...stylex.props(storyStyles.canvas)}>
      <div {...stylex.props(storyStyles.frame)}>
        <div {...stylex.props(storyStyles.header)}>
          <MobileFilterPillBar pills={pills} />
        </div>
        <div {...stylex.props(storyStyles.status)}>
          <div>scope = <code>{scope}</code></div>
          <div>status = <code>{status}</code></div>
          <div>machines = <code>{Array.from(machines).join(', ') || '(none)'}</code></div>
          <p {...stylex.props(storyStyles.hint)}>
            Single-select pills auto-close on commit. Multi-select stays open so the user
            can toggle several. The active-dot on "Machines" appears whenever the selection
            differs from the default (all machines).
          </p>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileFilterPillBar',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

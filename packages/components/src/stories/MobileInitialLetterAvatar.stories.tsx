import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { Folder } from 'lucide-react';

import { MobileInitialLetterAvatar } from '@/components/mobile/mobile-initial-letter-avatar';
const storyLayoutStylesStylesStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
  },
});

const storyLayoutStylesStyles = stylex.create({
  stack: {
    display: 'flex',
    width: '100%',
    'max-width': '28rem',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 6)',
    'border-radius': 'var(--radius-2xl)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
  },
});

const storyLayoutStyles = stylex.create({
  caption: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--muted-foreground) / 1)',
    'text-transform': 'uppercase',
  },
  label: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'min-height': '100dvh',
    'align-items': 'center',
    'justify-content': 'center',
    'background-color': 'var(--color-stone-200)',
    padding: 'calc(var(--spacing) * 6)',
  },
  row2: {
    display: 'flex',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 3)',
  },
  row3: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
});

function StoryShell() {
  const projects = [
    { name: 'lody', seed: 'zx-macbook:lody' },
    { name: 'loro', seed: 'zx-macbook:loro' },
    { name: 'lody-mobile', seed: 'lab-m2:lody-mobile' },
    { name: 'data-platform', seed: 'lab-m2:data-platform' },
    { name: 'Onboarding scratch', seed: 'mini-offline:onboarding' },
    { name: '中文项目', seed: 'zx-macbook:zh-project' },
    { name: '', seed: 'zx-macbook:empty' },
  ];

  return (
    <div {...stylex.props(storyLayout.row)}>
      <div {...stylex.props(storyLayoutStylesStyles.stack)}>
        {(['sm', 'md', 'lg'] as const).map((size) => (
          <div key={size}>
            <div {...stylex.props(storyLayoutStyles.caption)}>size = {size}</div>
            <div {...stylex.props(storyLayout.row2)}>
              {projects.map((p) => (
                <div key={`${size}-${p.seed}`} {...stylex.props(storyLayout.row3)}>
                  <MobileInitialLetterAvatar
                    name={p.name}
                    hashSeed={p.seed}
                    size={size}
                    fallbackIcon={<Folder {...stylex.props(storyLayoutStylesStylesStyles.frame)} />}
                  />
                  <span {...stylex.props(storyLayoutStyles.label)}>{p.name || '(empty)'}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileInitialLetterAvatar',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

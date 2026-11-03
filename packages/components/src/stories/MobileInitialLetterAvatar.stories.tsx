import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { Folder } from 'lucide-react';

import { MobileInitialLetterAvatar } from '@/components/mobile/mobile-initial-letter-avatar';
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
      <div className="flex w-full max-w-md flex-col gap-6 rounded-2xl bg-background p-6 shadow-2xl">
        {(['sm', 'md', 'lg'] as const).map((size) => (
          <div key={size}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              size = {size}
            </div>
            <div {...stylex.props(storyLayout.row2)}>
              {projects.map((p) => (
                <div key={`${size}-${p.seed}`} {...stylex.props(storyLayout.row3)}>
                  <MobileInitialLetterAvatar
                    name={p.name}
                    hashSeed={p.seed}
                    size={size}
                    fallbackIcon={<Folder className="h-3 w-3" />}
                  />
                  <span className="text-xs text-muted-foreground">{p.name || '(empty)'}</span>
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

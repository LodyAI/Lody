import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';

import { MobileArchiveScreen } from '@/components/mobile/mobile-archive-screen';
const phoneFrame = stylex.create({
  frame: {
    height: { default: '100dvh', '@media (min-width: 40rem)': '852px' },
    width: { default: '100%', '@media (min-width: 40rem)': '393px' },
    borderRadius: { default: null, '@media (min-width: 40rem)': '34px' },
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflow: 'hidden',
  },
});

const storyViewport = stylex.create({
  canvas: {
    display: 'flex',
    minHeight: '100dvh',
    alignItems: 'center',
    justifyContent: 'center',
    '--story-device-canvas-components': '92.3% 0.003 48.717',
    backgroundColor: 'oklch(var(--story-device-canvas-components))',
    padding: { default: '0px', '@media (min-width: 40rem)': 'calc(var(--spacing) * 6)' },
  },
});

const storyLayoutStyles = stylex.create({
  row: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 3)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 40%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 3)',
  },
  caption: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  caption2: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  label: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  caption3: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
    'text-decoration-line': 'underline',
  },
});

const storyLayout = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 9)',
    width: 'calc(var(--spacing) * 9)',
    'flex-shrink': '0',
    'border-radius': 'var(--radius-lg)',
    'background-color': 'hsl(var(--muted) / 1)',
  },
  section: {
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
  },
  canvas: {
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-top': 'calc(var(--spacing) * 3)',
  },
});

function ArchiveRow({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div {...stylex.props(storyLayoutStyles.row)}>
      <div {...stylex.props(storyLayout.frame)} />
      <div {...stylex.props(storyLayout.section)}>
        <div {...stylex.props(storyLayoutStyles.caption)}>{title}</div>
        <div {...stylex.props(storyLayoutStyles.caption2)}>{subtitle}</div>
      </div>
      <span {...stylex.props(storyLayoutStyles.label)}>2d</span>
    </div>
  );
}

function ArchiveStoryShell({
  initialMultiSelect = false,
  initialSelectedCount = 0,
}: {
  initialMultiSelect?: boolean;
  initialSelectedCount?: number;
}) {
  const [isMulti, setIsMulti] = useState(initialMultiSelect);
  const [selected, setSelected] = useState(initialSelectedCount);

  return (
    <div {...stylex.props(storyViewport.canvas)}>
      <div {...stylex.props(phoneFrame.frame)}>
        <MobileArchiveScreen
          isMultiSelectMode={isMulti}
          selectedCount={selected}
          isBulkActionBusy={false}
          onExitMultiSelect={() => {
            setIsMulti(false);
            setSelected(0);
          }}
          onBulkRestore={fn()}
          onRequestBulkDelete={fn()}
          onOpenMobileDrawer={fn()}
          dialogs={null}
        >
          <div>
            <ArchiveRow title="重构评估 UI" subtitle="feat/eval-ui-overhaul · zx-macbook" />
            <ArchiveRow title="同步进度提示" subtitle="feat/sync-progress · lab-m2" />
            <ArchiveRow title="权限审批弹窗布局" subtitle="fix/permission-modal · zx-macbook" />
            <ArchiveRow title="移动端归档体验" subtitle="feat/mobile-archive · zx-macbook" />
            <ArchiveRow title="登录页 OAuth 链接" subtitle="fix/oauth-callback · lab-m2" />
            <div {...stylex.props(storyLayout.canvas)}>
              <button
                type="button"
                {...stylex.props(storyLayoutStyles.caption3)}
                onClick={() => {
                  setIsMulti(true);
                  setSelected(2);
                }}
              >
                (story) enter multi-select with 2 items
              </button>
            </div>
          </div>
        </MobileArchiveScreen>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileArchiveScreen',
  component: ArchiveStoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof ArchiveStoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const MultiSelect: Story = {
  args: {
    initialMultiSelect: true,
    initialSelectedCount: 3,
  },
};

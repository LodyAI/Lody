import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';

import { MobileArchiveScreen } from '@/components/mobile/mobile-archive-screen';
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
    <div className="flex items-center gap-3 border-b border-border/40 px-4 py-3">
      <div {...stylex.props(storyLayout.frame)} />
      <div {...stylex.props(storyLayout.section)}>
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <span className="text-xs text-muted-foreground">2d</span>
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
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
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
                className="text-xs text-muted-foreground underline"
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

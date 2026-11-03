import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';

import { EDGE_ZONE_PX } from '@/components/mobile/mobile-edge-back-swipe';
import { VaulDrawerEdgeBackZone } from '@/components/mobile/vaul-drawer-edge-back-zone';
import { Drawer, DrawerContent, DrawerTitle } from '@/ui/drawer';
const storyLayoutStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
  },
});

const storyLayout = stylex.create({
  section: {
    display: 'contents',
  },
});

/* Header height of the mock drawer; the edge zone is offset by this so it never
   covers the back chevron (matching the real PR/Preview `MOBILE_DRAWER_HEADER_INSET`). */
const HEADER_HEIGHT = '56px';

function StoryShell({
  isNativeApp,
  highlightZone,
}: {
  isNativeApp: boolean;
  highlightZone: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="relative h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <div className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>
            打开抽屉后,<strong>只有从左边缘 {EDGE_ZONE_PX}px 内向右滑</strong>
            才会跟手拖动并返回(原生 iOS 边缘返回)。中间右滑只滚动内容,不会触发返回。
          </p>
          <p>
            <code>isNativeApp = {String(isNativeApp)}</code>
          </p>
          <p className="text-xs">
            (Web / isNativeApp=false 时不挂载边缘区域 — 由浏览器 / 路由历史负责返回;内容仍是
            data-vaul-no-drag,所以没有中心右滑返回。)
          </p>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            onClick={() => setOpen(true)}
          >
            打开抽屉
          </button>
        </div>

        <Drawer direction="right" open={open} onOpenChange={setOpen}>
          <DrawerContent className="w-full! max-w-none! inset-0 rounded-none border-0">
            <DrawerTitle className="sr-only">Demo drawer</DrawerTitle>

            <VaulDrawerEdgeBackZone isNativeApp={isNativeApp} topInset={HEADER_HEIGHT} />

            <div data-vaul-no-drag {...stylex.props(storyLayout.section)}>
              <header
                className="flex shrink-0 items-center gap-2 border-b px-4"
                style={{ height: HEADER_HEIGHT }}
              >
                <button type="button" aria-label="Back" onClick={() => setOpen(false)}>
                  <ChevronLeft {...stylex.props(storyLayoutStyles.frame)} />
                </button>
                <span className="text-sm font-medium">详情页</span>
              </header>
              <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 text-sm text-muted-foreground">
                {Array.from({ length: 30 }).map((_, i) => (
                  <p key={i}>
                    第 {i + 1} 行内容。中间区域是 data-vaul-no-drag,右滑只滚动;左边缘右滑才返回。
                  </p>
                ))}
              </div>
            </div>

            {highlightZone && isNativeApp ? (
              <div
                className="pointer-events-none absolute left-0 z-40 bg-primary/20 ring-2 ring-primary/40"
                style={{ top: HEADER_HEIGHT, bottom: 0, width: EDGE_ZONE_PX }}
                aria-hidden="true"
              >
                <span
                  className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-primary px-2 py-1 text-xs text-primary-foreground"
                  style={{ left: EDGE_ZONE_PX }}
                >
                  {EDGE_ZONE_PX}px edge drag zone
                </span>
              </div>
            ) : null}
          </DrawerContent>
        </Drawer>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/VaulDrawerEdgeBackZone',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NativeAppHighlighted: Story = {
  args: { isNativeApp: true, highlightZone: true },
};

export const NativeAppHidden: Story = {
  args: { isNativeApp: true, highlightZone: false },
};

export const WebDisabled: Story = {
  args: { isNativeApp: false, highlightZone: true },
};

import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';

import { EDGE_ZONE_PX } from '@/components/mobile/mobile-edge-back-swipe';
import { VaulDrawerEdgeBackZone } from '@/components/mobile/vaul-drawer-edge-back-zone';
import { Drawer, DrawerContent, DrawerTitle } from '@/ui/drawer';
const drawerDemoStyles = stylex.create({
  stage: {
    display: 'flex',
    minHeight: '100dvh',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--color-stone-200)',
    padding: {
      default: 'calc(var(--spacing) * 0)',
      '@media (width >= 40rem)': 'calc(var(--spacing) * 6)',
    },
  },
  device: {
    position: 'relative',
    height: { default: '100dvh', '@media (width >= 40rem)': '852px' },
    width: { default: '100%', '@media (width >= 40rem)': '393px' },
    overflow: 'hidden',
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / .25)',
    borderRadius: { default: null, '@media (width >= 40rem)': '34px' },
  },
  intro: {
    padding: 'calc(var(--spacing) * 6)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  spacedParagraph: {
    marginBlockStart: 'calc(var(--spacing) * 0)',
    marginBlockEnd: 'calc(var(--spacing) * 3)',
  },
  popup: {
    width: '100%',
    maxWidth: 'none',
    inset: 'calc(var(--spacing) * 0)',
    borderRadius: 0,
    borderStyle: 'solid',
    borderTopWidth: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
  },
  header: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderBottomStyle: 'solid',
    borderBottomWidth: '1px',
    paddingInline: 'calc(var(--spacing) * 4)',
  },
  body: {
    minHeight: 'calc(var(--spacing) * 0)',
    flex: '1',
    overflow: 'auto',
    padding: 'calc(var(--spacing) * 4)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  highlight: {
    pointerEvents: 'none',
    position: 'absolute',
    left: 'calc(var(--spacing) * 0)',
    zIndex: 40,
    backgroundColor: 'color-mix(in oklab, hsl(var(--primary)) 20%, transparent)',
    boxShadow:
      '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 2px color-mix(in oklab, hsl(var(--primary)) 40%, transparent), 0 0 #0000',
  },
  badge: {
    position: 'absolute',
    top: '50%',
    translate: '0 -50%',
    whiteSpace: 'nowrap',
    borderRadius: '.25rem',
    backgroundColor: 'hsl(var(--primary))',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--primary-foreground))',
  },
});

const storyLayoutStylesStyles = stylex.create({
  caption: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
  canvas: {
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'hsl(var(--primary))',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    color: 'hsl(var(--primary-foreground))',
  },
  label: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
  },
});

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
    <div {...stylex.props(drawerDemoStyles.stage)}>
      <div {...stylex.props(drawerDemoStyles.device)}>
        <div {...stylex.props(drawerDemoStyles.intro)}>
          <p {...stylex.props(drawerDemoStyles.spacedParagraph)}>
            打开抽屉后,<strong>只有从左边缘 {EDGE_ZONE_PX}px 内向右滑</strong>
            才会跟手拖动并返回(原生 iOS 边缘返回)。中间右滑只滚动内容,不会触发返回。
          </p>
          <p {...stylex.props(drawerDemoStyles.spacedParagraph)}>
            <code>isNativeApp = {String(isNativeApp)}</code>
          </p>
          <p {...stylex.props(storyLayoutStylesStyles.caption, drawerDemoStyles.spacedParagraph)}>
            (Web / isNativeApp=false 时不挂载边缘区域 — 由浏览器 / 路由历史负责返回;内容仍是
            data-vaul-no-drag,所以没有中心右滑返回。)
          </p>
          <button
            type="button"
            {...stylex.props(storyLayoutStylesStyles.canvas)}
            onClick={() => setOpen(true)}
          >
            打开抽屉
          </button>
        </div>

        <Drawer direction="right" open={open} onOpenChange={setOpen}>
          <DrawerContent xstyle={drawerDemoStyles.popup}>
            <DrawerTitle visuallyHidden>Demo drawer</DrawerTitle>

            <VaulDrawerEdgeBackZone isNativeApp={isNativeApp} topInset={HEADER_HEIGHT} />

            <div data-vaul-no-drag {...stylex.props(storyLayout.section)}>
              <header {...stylex.props(drawerDemoStyles.header)} style={{ height: HEADER_HEIGHT }}>
                <button type="button" aria-label="Back" onClick={() => setOpen(false)}>
                  <ChevronLeft {...stylex.props(storyLayoutStyles.frame)} />
                </button>
                <span {...stylex.props(storyLayoutStylesStyles.label)}>详情页</span>
              </header>
              <div {...stylex.props(drawerDemoStyles.body)}>
                {Array.from({ length: 30 }).map((_, i) => (
                  <p key={i} {...stylex.props(i < 29 && drawerDemoStyles.spacedParagraph)}>
                    第 {i + 1} 行内容。中间区域是 data-vaul-no-drag,右滑只滚动;左边缘右滑才返回。
                  </p>
                ))}
              </div>
            </div>

            {highlightZone && isNativeApp ? (
              <div
                {...stylex.props(drawerDemoStyles.highlight)}
                style={{ top: HEADER_HEIGHT, bottom: 0, width: EDGE_ZONE_PX }}
                aria-hidden="true"
              >
                <span {...stylex.props(drawerDemoStyles.badge)} style={{ left: EDGE_ZONE_PX }}>
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

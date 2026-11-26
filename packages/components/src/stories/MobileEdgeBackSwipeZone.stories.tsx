import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { ChevronLeft } from 'lucide-react';

import { EDGE_ZONE_PX, MobileEdgeBackSwipeZone } from '@/components/mobile/mobile-edge-back-swipe';
const edgeStory = stylex.create({
  copy: {
    padding: 'calc(var(--spacing) * 6)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 3)',
    },
  },
  zone: {
    pointerEvents: 'none',
    position: 'absolute',
    insetBlock: 0,
    left: 0,
    zIndex: 40,
    backgroundColor: 'color-mix(in oklab,hsl(var(--primary)) 20%,transparent)',
    boxShadow:
      '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 2px color-mix(in oklab,hsl(var(--primary)) 40%,transparent), 0 0 #0000',
  },
  label: {
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
const phoneFrame = stylex.create({
  frame: {
    height: { default: '100dvh', '@media (min-width: 40rem)': '852px' },
    width: { default: '100%', '@media (min-width: 40rem)': '393px' },
    borderRadius: { default: null, '@media (min-width: 40rem)': '34px' },
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflow: 'hidden',
    position: 'relative',
  },
});

const storyLayoutStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
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

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 14)',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'padding-inline': 'calc(var(--spacing) * 4)',
  },
  label: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  caption: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
});

function StoryShell({
  isNativeApp,
  highlightZone,
}: {
  isNativeApp: boolean;
  highlightZone: boolean;
}) {
  const [count, setCount] = useState(0);

  return (
    <div {...stylex.props(storyViewport.canvas)}>
      <div {...stylex.props(phoneFrame.frame)}>
        <header {...stylex.props(storyLayout.row)}>
          <ChevronLeft {...stylex.props(storyLayoutStyles.frame)} />
          <span {...stylex.props(storyLayout.label)}>详情页</span>
        </header>
        <div {...stylex.props(edgeStory.copy)}>
          <p>
            从屏幕左边缘向右拉手势(原生应用内)。本 Story 重写了 zone 样式让
            {EDGE_ZONE_PX}px 的命中区域可见。
          </p>
          <p>
            <code>isNativeApp = {String(isNativeApp)}</code>
          </p>
          <p>触发次数: {count}</p>
          <p {...stylex.props(storyLayout.caption)}>
            (Web 端 / isNativeApp=false 时,此组件不挂载 — 让浏览器 / 路由历史负责返回。)
          </p>
        </div>

        <MobileEdgeBackSwipeZone
          isNativeApp={isNativeApp}
          onBack={() => {
            setCount((c) => c + 1);
            fn()();
          }}
        />

        {highlightZone && isNativeApp ? (
          <div {...stylex.props(edgeStory.zone)} style={{ width: EDGE_ZONE_PX }} aria-hidden="true">
            <span {...stylex.props(edgeStory.label)} style={{ left: EDGE_ZONE_PX }}>
              {EDGE_ZONE_PX}px edge zone
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileEdgeBackSwipeZone',
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

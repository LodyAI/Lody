import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { MobileSidebarDrawer } from '@/components/mobile/mobile-sidebar-drawer';
import {
  getMobileMainLayoutContentClassName,
  getMobileMainLayoutRootClassName,
} from '@/components/workspace-layout-utils';
import { Button } from '@lody/ui/button';
const workspaceStory = stylex.create({
  sidebar: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 1.5)',
    },
  },
  body: {
    padding: 'calc(var(--spacing) * 4)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 3)',
    },
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
  caption: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  canvas: {
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    padding: 'calc(var(--spacing) * 2)',
  },
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 14)',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'padding-inline': 'calc(var(--spacing) * 4)',
  },
  caption2: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  canvas2: {
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 40%, transparent)',
    'background-color': 'hsl(var(--card) / 1)',
    padding: 'calc(var(--spacing) * 3)',
  },
});

const storyLayout = stylex.create({
  stack: {
    display: 'flex',
    height: '100%',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 3)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
  frame: {
    'min-height': 'calc(var(--spacing) * 0)',
    flex: '1',
    overflow: 'hidden',
  },
});

/* MobileWorkspaceLayout in production wires `<LoroAppSidebar>` directly,
   which depends on workspace / user / connection atoms not available in
   Storybook. This story renders the same layout chrome (drawer + content
   split + safe-area padding) with mock sidebar content so the shape can
   be inspected without spinning up the whole app store. */
function StoryShell({ initialOpen = false }: { initialOpen?: boolean }) {
  const [drawerOpen, setDrawerOpen] = useState(initialOpen);

  return (
    <div {...stylex.props(storyViewport.canvas)}>
      <div {...stylex.props(phoneFrame.frame)}>
        <div className={getMobileMainLayoutRootClassName()}>
          <MobileSidebarDrawer open={drawerOpen} onOpenChange={setDrawerOpen} width={320}>
            <div {...stylex.props(storyLayout.stack)}>
              <div {...stylex.props(storyLayoutStyles.caption)}>App sidebar (mock)</div>
              <div {...stylex.props(workspaceStory.sidebar)}>
                <div {...stylex.props(storyLayoutStyles.canvas)}>Workspace · Lody</div>
                <div {...stylex.props(storyLayoutStyles.canvas)}>Sessions</div>
                <div {...stylex.props(storyLayoutStyles.canvas)}>Archive</div>
                <div {...stylex.props(storyLayoutStyles.canvas)}>Settings</div>
              </div>
            </div>
          </MobileSidebarDrawer>

          <div className={getMobileMainLayoutContentClassName()}>
            <div {...stylex.props(storyLayout.frame)}>
              <header {...stylex.props(storyLayoutStyles.row)}>
                <Button variant="ghost" size="small" onClick={() => setDrawerOpen(true)}>
                  打开抽屉
                </Button>
                <div {...stylex.props(storyLayoutStyles.caption2)}>MobileWorkspaceLayout shell</div>
              </header>
              <div {...stylex.props(workspaceStory.body)}>
                <p>
                  这是 <code>MobileWorkspaceLayout</code> 的视觉外壳:左侧抽屉
                  <code>MobileSidebarDrawer</code> + 右侧内容区。在生产代码里 抽屉装载的是{' '}
                  <code>LoroAppSidebar</code>(依赖整套 workspace / connection / sessions
                  atoms),Storybook 里用 mock 占位。
                </p>
                <div {...stylex.props(storyLayoutStyles.canvas2)}>
                  路由会把页面内容塞进这里的 ErrorBoundary。
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileWorkspaceLayout',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const DrawerOpen: Story = {
  args: { initialOpen: true },
};

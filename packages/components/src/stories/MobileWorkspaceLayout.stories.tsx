import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { MobileSidebarDrawer } from '@/components/mobile/mobile-sidebar-drawer';
import {
  getMobileMainLayoutContentClassName,
  getMobileMainLayoutRootClassName,
} from '@/components/workspace-layout-utils';
import { Button } from '@lody/ui/button';

/* MobileWorkspaceLayout in production wires `<LoroAppSidebar>` directly,
   which depends on workspace / user / connection atoms not available in
   Storybook. This story renders the same layout chrome (drawer + content
   split + safe-area padding) with mock sidebar content so the shape can
   be inspected without spinning up the whole app store. */
function StoryShell({ initialOpen = false }: { initialOpen?: boolean }) {
  const [drawerOpen, setDrawerOpen] = useState(initialOpen);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <div className={getMobileMainLayoutRootClassName()}>
          <MobileSidebarDrawer open={drawerOpen} onOpenChange={setDrawerOpen} width={320}>
            <div className="flex h-full flex-col gap-3 bg-background p-4">
              <div className="text-sm font-semibold">App sidebar (mock)</div>
              <div className="space-y-1 text-sm text-muted-foreground">
                <div className="rounded-md border p-2">Workspace · Lody</div>
                <div className="rounded-md border p-2">Sessions</div>
                <div className="rounded-md border p-2">Archive</div>
                <div className="rounded-md border p-2">Settings</div>
              </div>
            </div>
          </MobileSidebarDrawer>

          <div className={getMobileMainLayoutContentClassName()}>
            <div className="min-h-0 flex-1 overflow-hidden">
              <header className="flex h-14 items-center gap-2 border-b px-4">
                <Button variant="ghost" size="small" onClick={() => setDrawerOpen(true)}>
                  打开抽屉
                </Button>
                <div className="text-sm font-medium">MobileWorkspaceLayout shell</div>
              </header>
              <div className="space-y-3 p-4 text-sm text-muted-foreground">
                <p>
                  这是 <code>MobileWorkspaceLayout</code> 的视觉外壳:左侧抽屉
                  <code>MobileSidebarDrawer</code> + 右侧内容区。在生产代码里 抽屉装载的是{' '}
                  <code>LoroAppSidebar</code>(依赖整套 workspace / connection / sessions
                  atoms),Storybook 里用 mock 占位。
                </p>
                <div className="rounded-xl border border-border/40 bg-card p-3">
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

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { ArrowUp } from 'lucide-react';

import { MobileChatLandingScreen } from '@/components/mobile/mobile-chat-landing-screen';
import { Button } from '@lody/ui/button';

function MockComposer() {
  return (
    <div className="w-full rounded-2xl border border-input-border/70 bg-input/90 p-3 shadow-sm">
      <textarea
        rows={2}
        placeholder="问 Lody 任何事情。"
        className="w-full resize-none bg-transparent text-sm leading-6 text-input-foreground placeholder:text-input-placeholder focus:outline-none"
      />
      <div className="flex items-center pt-1">
        <span className="text-xs text-muted-foreground">claude-3.5-sonnet · zx-macbook</span>
        <Button
          type="button"
          variant="primary"
          aria-label="Send"
          icon
          shape="pill"
          className="ml-auto"
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function MockContextSwitch() {
  return (
    <div className="flex w-full max-w-md gap-1 rounded-full border border-border/60 bg-muted/40 p-1 text-xs">
      <button className="flex-1 rounded-full bg-background px-3 py-1.5 font-medium shadow">
        Local
      </button>
      <button className="flex-1 rounded-full px-3 py-1.5 text-muted-foreground">GitHub</button>
      <button className="flex-1 rounded-full px-3 py-1.5 text-muted-foreground">Chat</button>
    </div>
  );
}

function ChatLandingStoryShell({ withHints }: { withHints?: boolean }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <MobileChatLandingScreen
          title="开始对话"
          contextSwitch={<MockContextSwitch />}
          composer={<MockComposer />}
          noMachineHint={
            withHints ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                没有可用的机器,请先连接一台。
              </div>
            ) : undefined
          }
          agentConfigHint={
            withHints ? (
              <div className="rounded-md border border-border/60 bg-card px-3 py-2 text-xs text-muted-foreground">
                还未配置 Codex API key — 在设置中添加后即可使用。
              </div>
            ) : undefined
          }
          onOpenMobileDrawer={fn()}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileChatLandingScreen',
  component: ChatLandingStoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof ChatLandingStoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithHints: Story = {
  args: { withHints: true },
};

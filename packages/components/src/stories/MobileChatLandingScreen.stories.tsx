import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import { ArrowUp } from 'lucide-react';

import { MobileChatLandingScreen } from '@/components/mobile/mobile-chat-landing-screen';
import { Button } from '@lody/ui/button';
const landingStory = stylex.create({
  input: {
    width: '100%',
    resize: 'none',
    backgroundColor: 'transparent',
    fontSize: 'var(--text-sm)',
    lineHeight: 'calc(var(--spacing) * 6)',
    color: {
      default: 'hsl(var(--input-foreground) / 1)',
      '::placeholder': 'hsl(var(--input-placeholder) / 1)',
    },
    outlineStyle: { default: null, ':focus': 'none' },
  },
  context: {
    flex: '1',
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: 'hsl(var(--background) / 1)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    fontWeight: 'var(--font-weight-medium)',
    boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  },
  hint: {
    borderRadius: 'var(--radius-md)',
    borderWidth:"1px",borderStyle:"solid",borderColor:"color-mix(in oklab, var(--color-amber-500) 40%, transparent)",
    backgroundColor: 'color-mix(in oklab, var(--color-amber-500) 10%, transparent)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: {
      default: 'var(--color-amber-700)',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'var(--color-amber-300)',
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

const storyLayoutStylesStylesStylesStyles = stylex.create({
  element: {
    marginLeft: 'auto',
  },
});

const storyLayoutStylesStylesStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
});

const storyLayoutStylesStyles = stylex.create({
  frame: {
    width: '100%',
    'border-radius': 'var(--radius-2xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--input-border) / 1) 70%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--input) / 1) 90%, transparent)',
    padding: 'calc(var(--spacing) * 3)',
    'box-shadow':
      '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
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
  label: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  row: {
    display: 'flex',
    width: '100%',
    'max-width': '28rem',
    gap: 'calc(var(--spacing) * 1)',
    'border-radius': 'calc(infinity * 1px)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted) / 1) 40%, transparent)',
    padding: 'calc(var(--spacing) * 1)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  canvas: {
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    'background-color': 'hsl(var(--card) / 1)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'align-items': 'center',
    'padding-top': 'calc(var(--spacing) * 1)',
  },
  canvas: {
    flex: '1',
    'border-radius': 'calc(infinity * 1px)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

function MockComposer() {
  return (
    <div {...stylex.props(storyLayoutStylesStyles.frame)}>
      <textarea rows={2} placeholder="问 Lody 任何事情。" {...stylex.props(landingStory.input)} />
      <div {...stylex.props(storyLayout.row)}>
        <span {...stylex.props(storyLayoutStyles.label)}>claude-3.5-sonnet · zx-macbook</span>
        <Button
          type="button"
          variant="primary"
          aria-label="Send"
          icon
          shape="pill"
          xstyle={storyLayoutStylesStylesStylesStyles.element}
        >
          <ArrowUp {...stylex.props(storyLayoutStylesStylesStyles.frame)} />
        </Button>
      </div>
    </div>
  );
}

function MockContextSwitch() {
  return (
    <div {...stylex.props(storyLayoutStyles.row)}>
      <button {...stylex.props(landingStory.context)}>Local</button>
      <button {...stylex.props(storyLayout.canvas)}>GitHub</button>
      <button {...stylex.props(storyLayout.canvas)}>Chat</button>
    </div>
  );
}

function ChatLandingStoryShell({ withHints }: { withHints?: boolean }) {
  const [sidebarOpens, setSidebarOpens] = useState(0);
  return (
    <div {...stylex.props(storyViewport.canvas)}>
      <div data-sidebar-opens={sidebarOpens} {...stylex.props(phoneFrame.frame)}>
        <MobileChatLandingScreen
          title="开始对话"
          contextSwitch={<MockContextSwitch />}
          composer={<MockComposer />}
          noMachineHint={
            withHints ? (
              <div {...stylex.props(landingStory.hint)}>没有可用的机器,请先连接一台。</div>
            ) : undefined
          }
          agentConfigHint={
            withHints ? (
              <div {...stylex.props(storyLayoutStyles.canvas)}>
                还未配置 Codex API key — 在设置中添加后即可使用。
              </div>
            ) : undefined
          }
          onOpenMobileDrawer={() => setSidebarOpens((count) => count + 1)}
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

export const RtlLocalFont: Story = {
  render: () => (
    <div dir="rtl" style={{ fontFamily: 'monospace', '--ui-font-size': '19px' } as CSSProperties}>
      <ChatLandingStoryShell withHints />
    </div>
  ),
};

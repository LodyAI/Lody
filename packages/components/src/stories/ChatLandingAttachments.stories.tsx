import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ReactNode } from 'react';
import { ArrowUp, Bot, Github } from 'lucide-react';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';

import {
  ChatComposer,
  type ChatComposerFileItem,
  type ChatComposerImageItem,
} from '@/components/chat/chat-composer';
import { ChatLandingView } from '@/components/chat/chat-landing-view';
import {
  MobileNewChatSheetContent,
  type MobileNewChatSheetContentProps,
} from '@/components/mobile/mobile-new-chat-sheet';
import {
  MobileInlinePickerCoordinator,
  MobileInlinePickerRowSlot,
} from '@/components/mobile/mobile-inline-picker';
import { Button } from '@lody/ui/button';
import { registerBuiltInCommands } from '@/lib/commands';
const sceneStyles = stylex.create({
  attachmentGlyph: {
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    opacity: 0.7,
  },
  footerLabel: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  sendGlyph: { width: 'calc(var(--spacing) * 5)', height: 'calc(var(--spacing) * 5)' },
  mobileFrame: {
    height: '720px',
    width: '390px',
    overflow: 'hidden',
    borderRadius: 'var(--radius-3xl)',
    borderWidth: '1px',
    borderStyle: 'solid',
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  },
});

const storyLayoutStyles = stylex.create({
  row: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 9)',
    width: '100%',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    'background-color': 'hsl(var(--card) / 1)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
  },
});

const storyLayout = stylex.create({
  label: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  frame: {
    'min-height': '100vh',
    'background-color': 'hsl(var(--background) / 1)',
  },
  row: {
    display: 'flex',
    'min-height': '100vh',
    'justify-content': 'center',
    'background-color': 'color-mix(in oklab, hsl(var(--muted) / 1) 40%, transparent)',
    'padding-block': 'calc(var(--spacing) * 6)',
  },
});

// So the composer's ⌘L focus hint has a command binding to read.
registerBuiltInCommands();

/**
 * These stories render attachments through the REAL production layout
 * components — desktop via `ChatLandingView` → `ChatComposer`, and the mobile
 * "new chat" flow via `MobileNewChatSheetContent` → `ChatComposer` — instead of
 * a hand-rolled composer wrapper. What renders here is exactly what ships, so
 * the attachment cards (image thumbnails + file cards) match production 1:1.
 *
 * NOTE: mobile mode is viewport-driven (`useIsMobile` = `window.innerWidth <
 * 768`), the same rule the real app uses. Narrow the Storybook window below
 * 768px (or use the mobile story below, which is framed at phone width) to see
 * the mobile rendering.
 */
const noop = () => undefined;

const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'unauthenticated' }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});

function StoryPlatform({ children }: { children: ReactNode }) {
  return <PlatformContext.Provider value={storyPlatform}>{children}</PlatformContext.Provider>;
}

const meta = {
  title: 'Chat/Landing Attachments',
  component: ChatLandingView,
  parameters: { layout: 'fullscreen' },
  // Required ChatLandingView props as defaults so the render-only stories below
  // (which build their own trees) still satisfy the typed args contract.
  args: {
    tone: 'light',
    title: "Let's ship something",
    promptValue: '',
    onPromptChange: noop,
  },
} satisfies Meta<typeof ChatLandingView>;

export default meta;
type Story = StoryObj<typeof meta>;

// Inline SVG data-URI thumbnails so image cards render with no fetch mock.
const imagePreviewDataUri = (label: string, color: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="${color}"/><text x="80" y="86" font-family="sans-serif" font-size="20" fill="white" text-anchor="middle">${label}</text></svg>`
  )}`;

const sampleImageItems: ChatComposerImageItem[] = [
  {
    id: 'img-draft',
    name: 'mockup.png',
    previewUrl: imagePreviewDataUri('PNG', '#2563eb'),
    status: 'draft',
    progress: 0,
  },
  {
    id: 'img-draft-second',
    name: 'screenshot.png',
    previewUrl: imagePreviewDataUri('PNG', '#7c3aed'),
    status: 'draft',
    progress: 0,
  },
];

const sampleFileItems: ChatComposerFileItem[] = [
  {
    id: 'f-epub',
    name: '哥德尔、艾舍尔、巴赫——集异璧之大成.epub',
    sizeLabel: '4.1 MB',
    status: 'draft',
    progress: 0,
  },
  { id: 'f-draft', name: 'build.log', sizeLabel: '2.3 MB', status: 'draft', progress: 0 },
  {
    id: 'f-draft-second',
    name: 'archive.zip',
    sizeLabel: '48.0 MB',
    status: 'draft',
    progress: 0,
  },
];

// A pill that mimics the look of the real selector chips so the mobile sheet
// rows read like the production form without wiring live workspace data.
function SelectorPill({ icon: Icon, label }: { icon: typeof Bot; label: string }) {
  return (
    <button type="button" {...stylex.props(storyLayoutStyles.row)}>
      <Icon {...stylex.props(sceneStyles.attachmentGlyph)} />
      <span {...stylex.props(storyLayout.label)}>{label}</span>
    </button>
  );
}

/**
 * Desktop landing — the actual `ChatLandingView` (which renders
 * `WebChatLandingScreen` → `ChatComposer`) with attachments populated.
 */
function DesktopLandingDemo() {
  const [prompt, setPrompt] = useState('Review the attached spec and screenshots.');
  return (
    <StoryPlatform>
      <div {...stylex.props(storyLayout.frame)}>
        <ChatLandingView
          tone="light"
          isMobile={false}
          title="Let's ship something"
          promptValue={prompt}
          onPromptChange={setPrompt}
          promptPlaceholder="Describe the task, attach files or images…"
          onSubmit={noop}
          submitLabel="Send"
          submittingLabel="Sending…"
          imageItems={sampleImageItems}
          onAttachmentAddClick={noop}
          onImageRemove={noop}
          onImageRetry={noop}
          fileItems={sampleFileItems}
          onFileRemove={noop}
          onFileRetry={noop}
        />
      </div>
    </StoryPlatform>
  );
}

export const DesktopLanding: Story = {
  render: () => <DesktopLandingDemo />,
};

/**
 * Mobile "new chat" — the actual `MobileNewChatSheetContent` hosting a real
 * `ChatComposer` (variant="session"), the same composition `chat-landing.tsx`
 * builds for the mobile new-chat drawer. Framed at phone width; narrow the
 * window below 768px so the composer enters its mobile (larger-card) sizing.
 */
function MobileNewChatDemo() {
  const [prompt, setPrompt] = useState('Add these to the issue.');
  const composer = (
    <MobileInlinePickerRowSlot>
      <ChatComposer
        tone="light"
        variant="session"
        promptId="chat-prompt-mobile-sheet"
        promptValue={prompt}
        onPromptChange={setPrompt}
        promptPlaceholder="Describe the task, attach files or images…"
        promptRows={4}
        imageItems={sampleImageItems}
        onAttachmentAddClick={noop}
        onImageRemove={noop}
        onImageRetry={noop}
        fileItems={sampleFileItems}
        onFileRemove={noop}
        onFileRetry={noop}
        footerSelector={
          <span {...stylex.props(sceneStyles.footerLabel)}>claude-opus-4-8 · Thinking</span>
        }
        primaryAction={
          <Button type="button" variant="primary" aria-label="Send" icon shape="pill">
            <ArrowUp {...stylex.props(sceneStyles.sendGlyph)} />
          </Button>
        }
        autoResize
        maxRows={6}
      />
    </MobileInlinePickerRowSlot>
  );

  const contentProps: MobileNewChatSheetContentProps = {
    labels: {
      title: '新建对话',
      machineLabel: '机器',
      contextTypeLabel: '类型',
      perTypeLabel: '仓库',
    },
    coordinator: MobileInlinePickerCoordinator,
    machineNode: <SelectorPill icon={Bot} label="Aurora · Mac Studio" />,
    contextTypeNode: <SelectorPill icon={Github} label="GitHub" />,
    perTypeNode: <SelectorPill icon={Github} label="loro-dev/lody" />,
    composer,
    showCloseButton: true,
  };

  return (
    // Phone-width frame so the sheet reads like the real mobile drawer even on
    // a wide Storybook canvas. Mobile card sizing still keys off window width.
    <StoryPlatform>
      <div {...stylex.props(storyLayout.row)}>
        <div {...stylex.props(sceneStyles.mobileFrame)}>
          <MobileNewChatSheetContent {...contentProps} />
        </div>
      </div>
    </StoryPlatform>
  );
}

export const MobileNewChat: Story = {
  render: () => <MobileNewChatDemo />,
};

import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
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
import { MobileInlinePickerRowSlot } from '@/components/mobile/mobile-inline-picker';
import { Button } from '@lody/ui/button';
import { registerBuiltInCommands } from '@/lib/commands';

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

/**
 * Desktop landing — the actual `ChatLandingView` (which renders
 * `WebChatLandingScreen` → `ChatComposer`) with attachments populated.
 */
function DesktopLandingDemo() {
  const [prompt, setPrompt] = useState('Review the attached spec and screenshots.');
  return (
    <StoryPlatform>
      <div className="min-h-screen bg-background">
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
          <span className="text-xs text-muted-foreground">claude-opus-4-8 · Thinking</span>
        }
        primaryAction={
          <Button type="button" variant="primary" aria-label="Send" icon shape="pill">
            <ArrowUp className="h-5 w-5" />
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
      backAriaLabel: 'Back',
    },
    targetNode: <span className="text-lg font-semibold">loro-dev/lody</span>,
    composer,
  };

  return (
    // Phone-width frame so the sheet reads like the real mobile drawer even on
    // a wide Storybook canvas. Mobile card sizing still keys off window width.
    <StoryPlatform>
      <div className="flex min-h-screen justify-center bg-muted/40 py-6">
        <div className="h-[720px] w-[390px] overflow-hidden rounded-3xl border bg-background shadow-xl">
          <MobileNewChatSheetContent {...contentProps} />
        </div>
      </div>
    </StoryPlatform>
  );
}

export const MobileNewChat: Story = {
  render: () => <MobileNewChatDemo />,
};

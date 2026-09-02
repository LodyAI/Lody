import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { ArrowUp, Bot, Github } from 'lucide-react';

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
    id: 'img-uploaded',
    name: 'mockup.png',
    previewUrl: imagePreviewDataUri('PNG', '#2563eb'),
    status: 'uploaded',
    progress: 100,
  },
  {
    id: 'img-uploading',
    name: 'screenshot.png',
    previewUrl: imagePreviewDataUri('45%', '#7c3aed'),
    status: 'uploading',
    progress: 45,
  },
  {
    id: 'img-failed',
    name: 'too-big.heic',
    previewUrl: imagePreviewDataUri('ERR', '#475569'),
    status: 'failed',
    progress: 0,
    error: 'Upload failed: file exceeds the 5 MB image limit',
  },
];

const sampleFileItems: ChatComposerFileItem[] = [
  {
    id: 'f-epub',
    name: '哥德尔、艾舍尔、巴赫——集异璧之大成.epub',
    sizeLabel: '4.1 MB',
    status: 'uploaded',
    progress: 100,
  },
  { id: 'f-uploaded', name: 'build.log', sizeLabel: '2.3 MB', status: 'uploaded', progress: 100 },
  { id: 'f-uploading', name: 'data.csv', sizeLabel: '11.0 MB', status: 'uploading', progress: 62 },
  {
    id: 'f-failed',
    name: 'archive.zip',
    sizeLabel: '48.0 MB',
    status: 'failed',
    progress: 0,
    error: 'Network error while uploading — tap to retry',
  },
];

// A pill that mimics the look of the real selector chips so the mobile sheet
// rows read like the production form without wiring live workspace data.
function SelectorPill({ icon: Icon, label }: { icon: typeof Bot; label: string }) {
  return (
    <button
      type="button"
      className="inline-flex h-9 w-full items-center gap-2 rounded-lg border border-border/60 bg-card px-3 text-sm"
    >
      <Icon className="h-4 w-4 opacity-70" />
      <span className="truncate">{label}</span>
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
    <div className="flex min-h-screen justify-center bg-muted/40 py-6">
      <div className="h-[720px] w-[390px] overflow-hidden rounded-3xl border bg-background shadow-xl">
        <MobileNewChatSheetContent {...contentProps} />
      </div>
    </div>
  );
}

export const MobileNewChat: Story = {
  render: () => <MobileNewChatDemo />,
};

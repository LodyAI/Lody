import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { ArrowUp, Bot, Github } from 'lucide-react';

import {
  ChatComposer,
  type ChatComposerFileItem,
  type ChatComposerImageItem,
} from '@/components/chat/chat-composer';
import type { OptionSelectorOption } from '@/components/shared/option-selector';
import { OptionSelector } from '@/components/shared/option-selector';
import { Card, CardContent } from '@/ui/card';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
import { getPastedTextCharacterCount, type PastedTextDraft } from '@/lib/pasted-text-draft';
import { registerBuiltInCommands } from '@/lib/commands';

// So session.focusInput has a binding — the desktop ⌘L focus hint reads it.
registerBuiltInCommands();

const meta = {
  title: 'Chat/ChatComposer',
  component: ChatComposer,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    title: undefined,
    tone: 'light',
    variant: 'landing',
    promptId: undefined,
    promptValue: '',
    onPromptChange: () => {},
    onPromptKeyDown: undefined,
    promptPlaceholder: undefined,
    promptRows: 3,
    promptRef: undefined,
    selector: null,
    primaryAction: null,
    secondaryAction: undefined,
    className: undefined,
  },
} satisfies Meta<typeof ChatComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

const agentOptions: OptionSelectorOption<string>[] = [
  {
    value: 'agent-1',
    label: 'Aurora',
    description: 'Mac Studio',
    startContent: <Bot className="h-4 w-4 opacity-70" />,
  },
  {
    value: 'agent-2',
    label: 'Atlas',
    description: 'MacBook Pro',
    startContent: <Bot className="h-4 w-4 opacity-70" />,
  },
];

const repoOptions: OptionSelectorOption<string>[] = [
  {
    value: 'loro-dev/lody',
    label: 'loro-dev/lody',
    description: 'Realtime collaboration engine',
    startContent: <Github className="h-4 w-4 opacity-70" />,
  },
  {
    value: 'loro-dev/doha',
    label: 'loro-dev/doha',
    description: 'Desktop shell',
    startContent: <Github className="h-4 w-4 opacity-70" />,
  },
];

const samplePastedText = [
  'Design brief:',
  'Users often paste full logs or PR descriptions into the composer before asking a focused question.',
  'We should keep that context available without letting the textarea grow so tall that the actual prompt disappears.',
  'Requirements:',
  '- Show a compact summary block with the pasted character count.',
  '- Let users inspect the full content on hover or tap.',
  '- Preserve the full text when the message is submitted.',
].join('\n');

const samplePromptPlaceholder = "Press '/' for commands, '@' for mentions.";

// Inline SVG data-URI thumbnails so image attachment cards render without any
// network/fetch mock (the composer just needs a non-empty previewUrl).
const imagePreviewDataUri = (label: string, color: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="${color}"/><text x="80" y="86" font-family="sans-serif" font-size="20" fill="white" text-anchor="middle">${label}</text></svg>`
  )}`;

// A full spread of image attachment states: uploaded, mid-upload (progress
// overlay fills from the top), and a failed upload (retry/remove affordances).
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
    error: 'Upload failed',
  },
];

// File attachment states: uploaded (shows size), uploading (shows percent), and
// failed (shows the error message + retry).
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
    error: 'Network error — tap to retry',
  },
];

function DemoComposer({
  tone,
  variant,
  title,
  showSecondary,
  promptRows,
  showPastedText = false,
  showAttachments = false,
  imageItems,
  fileItems,
  initialPrompt,
}: {
  tone: 'light' | 'dark';
  variant: 'landing' | 'session' | 'dialog';
  title?: string;
  showSecondary?: boolean;
  promptRows?: number;
  showPastedText?: boolean;
  showAttachments?: boolean;
  imageItems?: ChatComposerImageItem[];
  fileItems?: ChatComposerFileItem[];
  initialPrompt?: string;
}) {
  const inlinePastedTextLabel = `[Pasted ${getPastedTextCharacterCount(samplePastedText)} chars]`;
  const inlinePastedTextPrompt = `Investigate this context ${inlinePastedTextLabel} and help me extract the root cause.`;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState(
    initialPrompt ??
      (showPastedText
        ? inlinePastedTextPrompt
        : 'Write a quick plan for the CRDT metadata cleanup.')
  );
  const [selectedAgent, setSelectedAgent] = useState<string | null>('agent-1');
  const [selectedRepo, setSelectedRepo] = useState<string | null>('loro-dev/lody');
  const [pastedTextDrafts, setPastedTextDrafts] = useState<PastedTextDraft[]>(
    showPastedText
      ? [
          {
            id: 'paste-1',
            text: samplePastedText,
            displayText: inlinePastedTextLabel,
            start: 'Investigate this context '.length,
            end: 'Investigate this context '.length + inlinePastedTextLabel.length,
          },
        ]
      : []
  );

  const primaryActionClassName = cn(
    variant === 'dialog'
      ? 'border font-semibold transition-all focus-visible:ring-2 focus-visible:ring-offset-2 h-10 rounded-lg px-5 text-sm'
      : 'h-8 w-8 rounded-md border shadow-xs transition-all',
    tone === 'dark'
      ? variant !== 'dialog'
        ? 'border-sky-200/20 bg-sky-300/15 text-white hover:bg-sky-300/25 active:translate-y-[1px] focus-visible:ring-white/40 focus-visible:ring-offset-[#050b1d]'
        : 'border-white/25 bg-white/10 text-white hover:bg-white/15 active:translate-y-[1px] focus-visible:ring-white/30 focus-visible:ring-offset-[#050b1d]'
      : variant !== 'dialog'
        ? 'border-input-border/70 bg-input/70 text-input-foreground hover:bg-muted/60 active:translate-y-[1px] focus-visible:ring-ring'
        : 'border-input-border/70 bg-input/60 text-input-foreground hover:bg-muted/60 active:translate-y-[1px] focus-visible:ring-ring'
  );

  const selectorNode =
    variant === 'dialog' ? (
      <>
        <div className="w-full sm:min-w-[240px] sm:max-w-[280px]">
          <OptionSelector
            value={selectedRepo}
            options={repoOptions}
            onSelect={(option) => setSelectedRepo(option.value)}
            placeholder="Select repo"
            placeholderIcon={Github}
            tone={tone}
            className="w-full"
            contentClassName="w-72"
          />
        </div>
        <div className="w-full sm:max-w-[520px]">
          <OptionSelector
            value={selectedAgent}
            options={agentOptions}
            onSelect={(option) => setSelectedAgent(option.value)}
            placeholder="Select agent"
            placeholderIcon={Bot}
            tone={tone}
            className="w-full"
            contentClassName="w-64"
          />
        </div>
      </>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        <OptionSelector
          value={selectedRepo}
          options={repoOptions}
          onSelect={(option) => setSelectedRepo(option.value)}
          placeholder="Select repo"
          placeholderIcon={Github}
          tone={tone}
          className="w-full"
          contentClassName="w-72"
        />
        <OptionSelector
          value={selectedAgent}
          options={agentOptions}
          onSelect={(option) => setSelectedAgent(option.value)}
          placeholder="Select agent"
          placeholderIcon={Bot}
          tone={tone}
          className="w-full"
          contentClassName="w-64"
        />
      </div>
    );

  const primaryActionNode =
    variant !== 'dialog' ? (
      <Button
        type="button"
        variant="ghost"
        aria-label="Send"
        size="mini"
        icon
        className={cn(primaryActionClassName)}
      >
        <ArrowUp className="h-4 w-4" />
      </Button>
    ) : (
      <Button type="button" className={primaryActionClassName}>
        Send
      </Button>
    );

  const attachmentsEnabled = showAttachments || !!imageItems || !!fileItems;
  const resolvedImageItems = imageItems;
  const resolvedFileItems =
    fileItems ??
    (showAttachments
      ? [
          {
            id: 'f1',
            name: 'build.log',
            sizeLabel: '2.3 MB',
            status: 'uploaded' as const,
            progress: 100,
          },
          {
            id: 'f2',
            name: 'data.csv',
            sizeLabel: '11.0 MB',
            status: 'uploading' as const,
            progress: 62,
          },
        ]
      : undefined);

  return (
    <ChatComposer
      title={title}
      tone={tone}
      variant={variant}
      promptRef={promptRef}
      promptValue={prompt}
      onPromptChange={setPrompt}
      promptPlaceholder={samplePromptPlaceholder}
      promptRows={promptRows ?? 3}
      pastedTextDrafts={pastedTextDrafts}
      onPastedTextDraftsChange={setPastedTextDrafts}
      selector={selectorNode}
      primaryAction={primaryActionNode}
      onAttachmentAddClick={attachmentsEnabled ? () => undefined : undefined}
      imageItems={resolvedImageItems}
      onImageRemove={attachmentsEnabled ? () => undefined : undefined}
      onImageRetry={attachmentsEnabled ? () => undefined : undefined}
      fileItems={resolvedFileItems}
      onFileRemove={attachmentsEnabled ? () => undefined : undefined}
      onFileRetry={attachmentsEnabled ? () => undefined : undefined}
      autoResize={variant === 'session'}
      maxRows={11}
      secondaryAction={
        showSecondary
          ? {
              label: 'Cancel',
              onClick: () => undefined,
            }
          : undefined
      }
    />
  );
}

export const LandingDark: Story = {
  render: () => (
    <div className="relative min-h-screen bg-[#050b1d] text-white">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#050b1d] via-[#081327] to-[#0b1a35]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(88,166,255,0.2),transparent_55%),radial-gradient(circle_at_80%_10%,rgba(35,82,150,0.3),transparent_60%),radial-gradient(circle_at_50%_100%,rgba(8,30,58,0.9),transparent_60%)]" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-12">
        <Card className="w-full rounded-[32px] border-white/10 bg-white/5 shadow-[0_32px_100px_-48px_rgba(4,12,30,0.95)] ring-1 ring-white/10 backdrop-blur-2xl supports-[backdrop-filter]:bg-white/[0.06]">
          <CardContent className="p-8">
            <DemoComposer tone="dark" variant="landing" title="Let's ship something" />
          </CardContent>
        </Card>
      </div>
    </div>
  ),
};

export const DialogLight: Story = {
  render: () => (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-xl rounded-2xl border bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">Start a new chat</h2>
        <DemoComposer tone="light" variant="dialog" showSecondary promptRows={4} />
      </div>
    </div>
  ),
};

export const SessionDark: Story = {
  render: () => (
    <div className="min-h-screen bg-[#050b1d] px-4 py-12 text-white">
      <div className="mx-auto w-full max-w-3xl">
        <DemoComposer tone="dark" variant="session" />
      </div>
    </div>
  ),
};

export const SessionLongPrompt: Story = {
  render: () => (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto w-full max-w-3xl">
        <DemoComposer
          tone="light"
          variant="session"
          initialPrompt={Array.from({ length: 14 }, (_, index) => `Line ${index + 1}`).join('\n')}
        />
      </div>
    </div>
  ),
};

export const SessionWithAttachments: Story = {
  render: () => (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto w-full max-w-3xl">
        <DemoComposer tone="light" variant="session" showAttachments />
      </div>
    </div>
  ),
};

// Full image + file attachment spread across all three upload states
// (uploading / uploaded / failed) — the surface the chat-landing file-upload
// fix wires up. Use this to eyeball the progress overlay, percentage text, and
// failed-state retry/remove affordances.
export const AttachmentUploadStates: Story = {
  render: () => (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto w-full max-w-3xl">
        <DemoComposer
          tone="light"
          variant="session"
          imageItems={sampleImageItems}
          fileItems={sampleFileItems}
        />
      </div>
    </div>
  ),
};

export const AttachmentUploadStatesDark: Story = {
  // Pin the dark theme global so the token-driven file chips (bg-input /
  // text-input-foreground) flip to dark and match the dark composer shell.
  globals: { theme: 'dark' },
  render: () => (
    <div className="relative min-h-screen bg-[#050b1d] text-white">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#050b1d] via-[#081327] to-[#0b1a35]" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-12">
        <Card className="w-full rounded-[32px] border-white/10 bg-white/5 ring-1 ring-white/10 backdrop-blur-2xl">
          <CardContent className="p-8">
            <DemoComposer
              tone="dark"
              variant="landing"
              title="Let's ship something"
              imageItems={sampleImageItems}
              fileItems={sampleFileItems}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  ),
};

export const LandingWithPastedText: Story = {
  render: () => (
    <div className="relative min-h-screen bg-[#050b1d] text-white">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#050b1d] via-[#081327] to-[#0b1a35]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(88,166,255,0.2),transparent_55%),radial-gradient(circle_at_80%_10%,rgba(35,82,150,0.3),transparent_60%),radial-gradient(circle_at_50%_100%,rgba(8,30,58,0.9),transparent_60%)]" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-12">
        <Card className="w-full rounded-[32px] border-white/10 bg-white/5 shadow-[0_32px_100px_-48px_rgba(4,12,30,0.95)] ring-1 ring-white/10 backdrop-blur-2xl supports-[backdrop-filter]:bg-white/[0.06]">
          <CardContent className="p-8">
            <DemoComposer
              tone="dark"
              variant="landing"
              title="Let's ship something"
              showPastedText
            />
          </CardContent>
        </Card>
      </div>
    </div>
  ),
};

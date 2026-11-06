import * as stylex from '@stylexjs/stylex';
import { QueuedScheduledMessagePreview } from './queued-scheduled-message-preview';
import { SessionInfoBar } from '../components/sessions/session-info-bar';
import { QuotaContinueView } from '../components/schedules/quota-continue-action';
import {
  ScheduledMessageInfoChip,
  ScheduledMessageTimeDialog,
} from '../components/schedules/scheduled-message-time';
import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { Clock, ArrowUp, Bot, Github } from 'lucide-react';

import {
  ChatComposer,
  type ChatComposerFileItem,
  type ChatComposerImageItem,
} from '@/components/chat/chat-composer';
import type { OptionSelectorOption } from '@/components/shared/option-selector';
import { OptionSelector } from '@/components/shared/option-selector';
import { Card } from '@/ui/card';
import { Button } from '@lody/ui/button';
import { button } from '@lody/ui/button/button.tokens.stylex';
import { Spinner } from '@lody/ui/spinner';
import { getPastedTextCharacterCount, type PastedTextDraft } from '@/lib/pasted-text-draft';
import { registerBuiltInCommands } from '@/lib/commands';
import { SettingsStoryProviders } from './settings-story-shell';
const composerScene = stylex.create({
  glyph: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  softGlyph: { opacity: 0.7 },
  fullWidth: { width: '100%' },
  repoHost: {
    width: '100%',
    minWidth: { default: null, '@media (width >= 40rem)': '240px' },
    maxWidth: { default: null, '@media (width >= 40rem)': '280px' },
  },
  agentHost: { width: '100%', maxWidth: { default: null, '@media (width >= 40rem)': '520px' } },
  repoPopup: { width: 'calc(var(--spacing) * 72)' },
  agentPopup: { width: 'calc(var(--spacing) * 64)' },
  gradient: {
    pointerEvents: 'none',
    position: 'absolute',
    inset: 0,
    backgroundImage: 'linear-gradient(to bottom in oklab, #050b1d 0%, #081327 50%, #0b1a35 100%)',
  },
  glass: {
    width: '100%',
    borderRadius: '32px',
    borderColor: 'color-mix(in oklab, var(--color-white) 10%, transparent)',
    backgroundColor: 'color-mix(in oklab, var(--color-white) 5%, transparent)',
    boxShadow: {
      default: '0 0 0 1px color-mix(in oklab, var(--color-white) 10%, transparent)',
      ':focus': 'none',
      ':focus-visible': 'none',
    },
    backdropFilter: 'blur(var(--blur-2xl))',
  },
  liftedGlass: {
    backgroundColor: {
      default: 'color-mix(in oklab, var(--color-white) 5%, transparent)',
      '@supports (backdrop-filter: blur(0px))':
        'color-mix(in oklab, var(--color-white) 6%, transparent)',
    },
    boxShadow: {
      default:
        '0 0 0 1px color-mix(in oklab, var(--color-white) 10%, transparent), 0 32px 100px -48px rgba(4,12,30,.95)',
      ':focus': '0 32px 100px -48px rgba(4,12,30,.95)',
      ':focus-visible': '0 32px 100px -48px rgba(4,12,30,.95)',
    },
  },
  whitePanel: {
    width: '100%',
    maxWidth: '36rem',
    borderRadius: 'var(--radius-2xl)',
    borderWidth: '1px',
    borderStyle: 'solid',
    backgroundColor: 'var(--color-white)',
    padding: 'calc(var(--spacing) * 6)',
    boxShadow: '0 10px 15px -3px rgb(0 0 0 / .1), 0 4px 6px -4px rgb(0 0 0 / .1)',
  },
  dialogAction: {
    borderWidth: '1px',
    borderStyle: 'solid',
    fontWeight: 'var(--font-weight-semibold)',
    transitionProperty: 'all',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    height: 'calc(var(--spacing) * 10)',
    borderRadius: 'var(--radius-lg)',
    paddingInline: 'calc(var(--spacing) * 5)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    translate: { default: 'none', ':active': '0 1px' },
    boxShadow: { default: button.primaryEdge, ':focus-visible': 'none', ':active': 'none' },
  },
  darkAction: {
    borderColor: 'color-mix(in oklab, var(--color-white) 25%, transparent)',
    '--composer-action-hover': {
      default: 'color-mix(in oklab, var(--color-white) 10%, transparent)',
      '@media (hover: hover)': 'color-mix(in oklab, var(--color-white) 15%, transparent)',
    },
    backgroundColor: {
      default: 'color-mix(in oklab, var(--color-white) 10%, transparent)',
      ':hover': 'var(--composer-action-hover)',
    },
    color: 'var(--color-white)',
  },
  lightAction: {
    borderColor: 'color-mix(in oklab, hsl(var(--input-border) / 1) 70%, transparent)',
    '--composer-action-hover': {
      default: 'color-mix(in oklab, hsl(var(--input) / 1) 60%, transparent)',
      '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--muted) / 1) 60%, transparent)',
    },
    backgroundColor: {
      default: 'color-mix(in oklab, hsl(var(--input) / 1) 60%, transparent)',
      ':hover': 'var(--composer-action-hover)',
    },
    color: 'hsl(var(--input-foreground) / 1)',
  },
  pendingAction: {
    height: 'calc(var(--spacing) * 8)',
    width: 'calc(var(--spacing) * 8)',
    borderRadius: 'calc(infinity * 1px)',
    boxShadow: '0 1px 2px 0 rgb(0 0 0 / .05)',
    transitionProperty: 'all',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    '--composer-action-hover': {
      default: 'hsl(var(--foreground) / 1)',
      '@media (hover: hover)': 'color-mix(in oklab, hsl(var(--foreground) / 1) 90%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--foreground) / 1)',
      ':hover': 'var(--composer-action-hover)',
    },
    color: 'hsl(var(--background) / 1)',
    translate: { default: 'none', ':active': '0 1px' },
  },
});

const storyLayoutStyles = stylex.create({
  caption: {
    'margin-bottom': 'calc(var(--spacing) * 4)',
    'font-size': 'var(--text-lg)',
    'line-height': 'var(--text-lg--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'var(--color-slate-900)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  frame: {
    position: 'relative',
    'min-height': '100vh',
    'background-color': '#050b1d',
    color: 'var(--color-white)',
  },
  overlay: {
    'pointer-events': 'none',
    position: 'absolute',
    inset: 'calc(var(--spacing) * 0)',
    'background-image':
      'radial-gradient(circle at 20% 0%,rgba(88,166,255,0.2),transparent 55%),radial-gradient(circle at 80% 10%,rgba(35,82,150,0.3),transparent 60%),radial-gradient(circle at 50% 100%,rgba(8,30,58,0.9),transparent 60%)',
  },
  row2: {
    position: 'relative',
    'margin-inline': 'auto',
    display: 'flex',
    'min-height': '100vh',
    width: '100%',
    'max-width': '48rem',
    'align-items': 'center',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 12)',
  },
  row3: {
    position: 'relative',
    display: 'flex',
    'min-height': '100vh',
    'align-items': 'center',
    'background-color': '#050b1d',
    'padding-inline': 'calc(var(--spacing) * 4)',
    color: 'var(--color-white)',
  },
  frame2: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': '48rem',
  },
  row4: {
    display: 'flex',
    'min-height': '100vh',
    'align-items': 'center',
    'justify-content': 'center',
    'background-color': 'var(--color-slate-50)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 12)',
  },
  frame3: {
    'min-height': '100vh',
    'background-color': '#050b1d',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 12)',
    color: 'var(--color-white)',
  },
  stack: {
    display: 'flex',
    'min-height': '100vh',
    'flex-direction': 'column',
    'justify-content': 'flex-end',
    'background-color': 'hsl(var(--background) / 1)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-bottom': 'calc(var(--spacing) * 6)',
  },
  stack2: {
    display: 'flex',
    'min-height': '100vh',
    'flex-direction': 'column',
    'justify-content': 'flex-end',
    'background-color': '#111315',
    'padding-inline': '9vw',
    'padding-bottom': 'calc(var(--spacing) * 6)',
    color: 'var(--color-white)',
  },
  frame4: {
    width: '100%',
    'max-width': '90rem',
  },
  frame5: {
    'min-height': '100vh',
    'background-color': 'hsl(var(--background) / 1)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 12)',
  },
  row5: {
    display: 'flex',
    'min-height': '100vh',
    'align-items': 'center',
    'justify-content': 'center',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
  frame6: {
    width: '100%',
    'max-width': '42rem',
  },
});

// So session.focusInput has a binding — the desktop ⌘L focus hint reads it.
registerBuiltInCommands();

const meta = {
  title: 'Chat/ChatComposer',
  component: ChatComposer,
  parameters: {
    layout: 'fullscreen',
  },
  // The composer's add menu reads cloud queries, which need a platform.
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
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
    startContent: <Bot {...stylex.props(composerScene.glyph, composerScene.softGlyph)} />,
  },
  {
    value: 'agent-2',
    label: 'Atlas',
    description: 'MacBook Pro',
    startContent: <Bot {...stylex.props(composerScene.glyph, composerScene.softGlyph)} />,
  },
];

const repoOptions: OptionSelectorOption<string>[] = [
  {
    value: 'loro-dev/lody',
    label: 'loro-dev/lody',
    description: 'Realtime collaboration engine',
    startContent: <Github {...stylex.props(composerScene.glyph, composerScene.softGlyph)} />,
  },
  {
    value: 'loro-dev/doha',
    label: 'loro-dev/doha',
    description: 'Desktop shell',
    startContent: <Github {...stylex.props(composerScene.glyph, composerScene.softGlyph)} />,
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
const mentionStressCommands = Array.from({ length: 24 }, (_, index) => ({
  name: `command-${String(index + 1).padStart(2, '0')}`,
  description:
    index % 3 === 0
      ? 'Review the current changes, include relevant context, and explain the next action. '.repeat(
          12
        )
      : `Synthetic command ${index + 1}`,
}));

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
  showMentionCommands = false,
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
  showMentionCommands?: boolean;
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

  const selectorNode =
    variant === 'dialog' ? (
      <>
        <div {...stylex.props(composerScene.repoHost)}>
          <OptionSelector
            value={selectedRepo}
            options={repoOptions}
            onSelect={(option) => setSelectedRepo(option.value)}
            placeholder="Select repo"
            placeholderIcon={Github}
            tone={tone}
            xstyle={composerScene.fullWidth}
            contentXstyle={composerScene.repoPopup}
          />
        </div>
        <div {...stylex.props(composerScene.agentHost)}>
          <OptionSelector
            value={selectedAgent}
            options={agentOptions}
            onSelect={(option) => setSelectedAgent(option.value)}
            placeholder="Select agent"
            placeholderIcon={Bot}
            tone={tone}
            xstyle={composerScene.fullWidth}
            contentXstyle={composerScene.agentPopup}
          />
        </div>
      </>
    ) : (
      <div {...stylex.props(storyLayout.row)}>
        <OptionSelector
          value={selectedRepo}
          options={repoOptions}
          onSelect={(option) => setSelectedRepo(option.value)}
          placeholder="Select repo"
          placeholderIcon={Github}
          tone={tone}
          xstyle={composerScene.fullWidth}
          contentXstyle={composerScene.repoPopup}
        />
        <OptionSelector
          value={selectedAgent}
          options={agentOptions}
          onSelect={(option) => setSelectedAgent(option.value)}
          placeholder="Select agent"
          placeholderIcon={Bot}
          tone={tone}
          xstyle={composerScene.fullWidth}
          contentXstyle={composerScene.agentPopup}
        />
      </div>
    );

  const primaryActionNode =
    variant !== 'dialog' ? (
      <Button type="button" variant="primary" aria-label="Send" size="medium" shape="pill" icon>
        <ArrowUp {...stylex.props(composerScene.glyph)} />
      </Button>
    ) : (
      <Button
        type="button"
        xstyle={[
          composerScene.dialogAction,
          tone === 'dark' ? composerScene.darkAction : composerScene.lightAction,
        ]}
      >
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
      availableCommands={showMentionCommands ? mentionStressCommands : undefined}
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
    <div {...stylex.props(storyLayout.frame)}>
      <div {...stylex.props(composerScene.gradient)} />
      <div {...stylex.props(storyLayout.overlay)} />
      <div {...stylex.props(storyLayout.row2)}>
        <Card.Root xstyle={[composerScene.glass, composerScene.liftedGlass]}>
          <Card.Content>
            <DemoComposer tone="dark" variant="landing" title="Let's ship something" />
          </Card.Content>
        </Card.Root>
      </div>
    </div>
  ),
};

export const LandingMentionStress: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.row3)}>
      <div {...stylex.props(storyLayout.frame2)}>
        <DemoComposer
          tone="dark"
          variant="landing"
          title="Let's ship something"
          initialPrompt=""
          showMentionCommands
        />
      </div>
    </div>
  ),
};

export const DialogLight: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.row4)}>
      <div {...stylex.props(composerScene.whitePanel)}>
        <h2 {...stylex.props(storyLayoutStyles.caption)}>Start a new chat</h2>
        <DemoComposer tone="light" variant="dialog" showSecondary promptRows={4} />
      </div>
    </div>
  ),
};

export const DialogMentionStress: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.row4)}>
      <div {...stylex.props(composerScene.whitePanel)}>
        <h2 {...stylex.props(storyLayoutStyles.caption)}>Start a new chat</h2>
        <DemoComposer
          tone="light"
          variant="dialog"
          showSecondary
          promptRows={4}
          initialPrompt=""
          showMentionCommands
        />
      </div>
    </div>
  ),
};

export const SessionDark: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.frame3)}>
      <div {...stylex.props(storyLayout.frame2)}>
        <DemoComposer tone="dark" variant="session" />
      </div>
    </div>
  ),
};

/** Long command lists against the bottom-docked business composer. */
export const SessionMentionStress: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.stack)}>
      <div {...stylex.props(storyLayout.frame2)}>
        <DemoComposer tone="light" variant="session" initialPrompt="" showMentionCommands />
      </div>
    </div>
  ),
};

/** The wide bottom-docked composer seen in a full-size desktop window. */
export const SessionMentionWideDark: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.stack2)}>
      <div {...stylex.props(storyLayout.frame4)}>
        <DemoComposer
          tone="dark"
          variant="session"
          initialPrompt=""
          promptRows={4}
          showMentionCommands
        />
      </div>
    </div>
  ),
};

export const SessionLongPrompt: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.frame5)}>
      <div {...stylex.props(storyLayout.frame2)}>
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
    <div {...stylex.props(storyLayout.frame5)}>
      <div {...stylex.props(storyLayout.frame2)}>
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
    <div {...stylex.props(storyLayout.frame5)}>
      <div {...stylex.props(storyLayout.frame2)}>
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
    <div {...stylex.props(storyLayout.frame)}>
      <div {...stylex.props(composerScene.gradient)} />
      <div {...stylex.props(storyLayout.row2)}>
        <Card.Root xstyle={composerScene.glass}>
          <Card.Content>
            <DemoComposer
              tone="dark"
              variant="landing"
              title="Let's ship something"
              imageItems={sampleImageItems}
              fileItems={sampleFileItems}
            />
          </Card.Content>
        </Card.Root>
      </div>
    </div>
  ),
};

export const LandingWithPastedText: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.frame)}>
      <div {...stylex.props(composerScene.gradient)} />
      <div {...stylex.props(storyLayout.overlay)} />
      <div {...stylex.props(storyLayout.row2)}>
        <Card.Root xstyle={[composerScene.glass, composerScene.liftedGlass]}>
          <Card.Content>
            <DemoComposer
              tone="dark"
              variant="landing"
              title="Let's ship something"
              showPastedText
            />
          </Card.Content>
        </Card.Root>
      </div>
    </div>
  ),
};

function ScheduledSendPreview({
  pickerInitiallyOpen = false,
  infoInitiallyOpen = false,
}: {
  pickerInitiallyOpen?: boolean;
  infoInitiallyOpen?: boolean;
}) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(
    'Review these files tomorrow morning and summarize the remaining issues.'
  );
  const [at, setAt] = useState<string | null>('2026-10-28T01:00:00.000Z');
  const [picker, setPicker] = useState(pickerInitiallyOpen);
  return (
    <div {...stylex.props(storyLayout.row5)}>
      <div {...stylex.props(storyLayout.frame6)}>
        <SessionInfoBar
          status={null}
          machine={{
            machineId: 'story-machine' as never,
            name: 'MacBook Pro',
            onlineStatus: 'online',
          }}
          scheduledMessage={
            at ? (
              <ScheduledMessageInfoChip
                at={at}
                timeZone="Asia/Shanghai"
                defaultOpen={infoInitiallyOpen}
                onEdit={() => setPicker(true)}
              />
            ) : null
          }
        />
        <ChatComposer
          variant="session"
          promptRef={promptRef}
          tone="light"
          promptValue={text}
          onPromptChange={setText}
          onAttachmentAddClick={() => {}}
          onScheduleSend={() => setPicker(true)}
          primaryAction={
            <Button icon aria-label="Schedule send">
              <Clock size={16} />
            </Button>
          }
          autoResize
        />
      </div>
      {picker ? (
        <ScheduledMessageTimeDialog
          finalFocus={promptRef}
          onRemoveTime={
            at
              ? () => {
                  setAt(null);
                  setPicker(false);
                }
              : undefined
          }
          at={at}
          timeZone="Asia/Shanghai"
          now={Date.parse('2026-10-27T08:00:00Z')}
          onClose={() => setPicker(false)}
          onApply={(value) => {
            setAt(value);
            setPicker(false);
          }}
        />
      ) : null}
    </div>
  );
}
export const ScheduledSend: Story = { render: () => <ScheduledSendPreview /> };
export const ScheduledSendTimePicker: Story = {
  render: () => <ScheduledSendPreview pickerInitiallyOpen />,
};
export const ScheduledSendDark: Story = {
  globals: { theme: 'dark' },
  render: () => <ScheduledSendPreview />,
};

function QuotaContinuePreview() {
  const [saved, setSaved] = useState(false);
  const [text, setText] = useState('Keep this draft while waiting for quota.');
  return (
    <div {...stylex.props(storyLayout.row5)}>
      <div {...stylex.props(storyLayout.frame6)}>
        <QuotaContinueView saved={saved} pending={false} onClick={() => setSaved(true)} />
        <ChatComposer
          variant="session"
          tone="light"
          promptValue={text}
          onPromptChange={setText}
          onAttachmentAddClick={() => {}}
          onScheduleSend={() => {}}
          primaryAction={
            <Button icon aria-label="Send">
              <ArrowUp size={16} />
            </Button>
          }
        />
      </div>
    </div>
  );
}
export const QuotaContinue: Story = { render: () => <QuotaContinuePreview /> };
export const QuotaContinueDark: Story = {
  globals: { theme: 'dark' },
  render: () => <QuotaContinuePreview />,
};

export const ScheduledSendInfo: Story = {
  render: () => <ScheduledSendPreview infoInitiallyOpen />,
};

export const QueuedScheduledMessage: Story = { render: () => <QueuedScheduledMessagePreview /> };

export const QueuedTimeLeading: Story = {
  render: () => <QueuedScheduledMessagePreview variant="start" />,
};
export const QueuedTimeAiry: Story = {
  render: () => <QueuedScheduledMessagePreview variant="airy" />,
};

// Source-projected test input: the actual landing owner's Spinner JSX and stable
// Button props, hosted by real ChatComposer. This does not run its controller/RPC.
function PendingLandingSpinnerProjection({ tone }: { tone: 'light' | 'dark' }) {
  const [unexpectedActions, setUnexpectedActions] = useState(0);
  return (
    <div data-landing-spinner-projection>
      <input aria-label="Focus sentinel" />
      <output data-landing-spinner-receipt>{unexpectedActions}</output>
      <ChatComposer
        tone={tone}
        variant="session"
        promptValue="Synthetic pending landing draft"
        onPromptChange={() => {}}
        promptDisabled
        primaryAction={
          <Button
            type="button"
            icon
            variant="ghost"
            xstyle={composerScene.pendingAction}
            disabled
            aria-label="Submitting synthetic draft"
            onClick={() => setUnexpectedActions((count) => count + 1)}
          >
            <Spinner diameter="calc(var(--spacing) * 5)" />
          </Button>
        }
      />
    </div>
  );
}
export const PendingLandingSpinnerLight: Story = {
  globals: { theme: 'light' },
  render: () => <PendingLandingSpinnerProjection tone="light" />,
};
export const PendingLandingSpinnerDark: Story = {
  globals: { theme: 'dark' },
  render: () => <PendingLandingSpinnerProjection tone="dark" />,
};

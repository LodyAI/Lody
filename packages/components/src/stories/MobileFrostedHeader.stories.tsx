import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import type { CSSProperties } from 'react';
import { ChevronLeft, Ellipsis, Github } from 'lucide-react';

import { ChatsIcon } from '@/components/icons/chats-icon';
import { GlassIconButton } from '@/components/mobile/glass-icon-button';
import { cn } from '@/lib/utils';
const storyLayout = stylex.create({
  frame: {
    position: 'relative',
    height: '100dvh',
    width: '100%',
    overflow: 'hidden',
    'background-color': 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  frame2: {
    height: '100%',
    'overflow-y': 'auto',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-bottom': 'calc(var(--spacing) * 8)',
  },
  stack: {
    'margin-inline': 'auto',
    display: 'flex',
    width: '100%',
    'max-width': '800px',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 3)',
  },
  label: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  row: {
    display: 'flex',
    height: '100dvh',
    width: '100%',
    'align-items': 'center',
    'justify-content': 'center',
  },
});

/**
 * The mobile session page's floating frosted header, exercised in isolation
 * with the REAL `GlassIconButton` (canvas glass — see that component). The
 * production wiring lives in `session-detail.tsx` (`if (isMobile)`); this story
 * mirrors its chrome over a mock conversation so the frost/scroll-under
 * behavior and button glass can be judged without the workspace runtime.
 */
const MESSAGES = [
  { from: 'user', text: 'Rebase onto main and resolve the merge conflicts in the composer.' },
  {
    from: 'agent',
    text: 'I found three conflicting hunks in session-chat-input-area.tsx. The composer height logic and the placeholder resolver both moved.',
  },
  { from: 'agent', code: 'const effectivePromptRows = singleLineMobile ? 1 : promptRows;' },
  {
    from: 'agent',
    text: 'I kept your single-line mobile default and took upstream’s placeholder helper. Running the fast gate now.',
  },
  { from: 'user', text: 'Also make sure the run-config sheet still opens.' },
  {
    from: 'agent',
    text: 'Verified — the button face renders and the sheet opens with Agent / Model / Reasoning / Permission / Plan / Fast intact.',
  },
  {
    from: 'agent',
    text: 'pnpm check is green: oxlint clean, all translation keys present, code-collab import guard passed.',
  },
  { from: 'user', text: 'Great, push it.' },
];

function Bubble({ from, text, code }: { from: string; text?: string; code?: string }) {
  const isUser = from === 'user';
  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-2.5 text-[0.95rem] leading-snug',
          isUser ? 'bg-secondary/60 text-foreground' : 'text-foreground'
        )}
      >
        {code ? <code className="font-mono text-[0.8rem] text-foreground/90">{code}</code> : text}
      </div>
    </div>
  );
}

function Prototype() {
  const headerHeight = '3rem';
  return (
    <div
      {...stylex.props(storyLayout.frame)}
      style={{ '--conversation-top-inset': headerHeight } as CSSProperties}
    >
      {/* Scrollable conversation — extends under the header with a top inset so
          the first message clears it but later content scrolls beneath. */}
      <div
        id="proto-scroll"
        {...stylex.props(storyLayout.frame2)}
        style={{ paddingTop: 'calc(var(--conversation-top-inset, 0px) + 0.5rem)' }}
      >
        <div {...stylex.props(storyLayout.stack)}>
          {MESSAGES.map((m, i) => (
            <Bubble key={i} from={m.from} text={m.text} code={m.code} />
          ))}
          {MESSAGES.map((m, i) => (
            <Bubble key={`b${i}`} from={m.from} text={m.text} code={m.code} />
          ))}
        </div>
      </div>

      {/* Floating frosted header — same chrome as production session-detail. */}
      <header
        className="absolute inset-x-0 top-0 z-30 flex items-center gap-1 bg-background/55 px-1 backdrop-blur-xl"
        style={{ height: headerHeight }}
      >
        <GlassIconButton label="Back">
          <ChevronLeft className="h-5 w-5" />
        </GlassIconButton>
        <div className="flex min-w-0 flex-1 flex-col justify-center px-1 leading-tight">
          <span className="truncate text-sm font-semibold text-foreground">
            Solve merge conflicts
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <Github className="h-3 w-3 shrink-0" />
            <span {...stylex.props(storyLayout.label)}>loro-dev/loro</span>
          </span>
        </div>
        <GlassIconButton label="Tabs">
          <ChatsIcon className="h-[1.15rem] w-[1.15rem]" />
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
        </GlassIconButton>
        <GlassIconButton label="More actions">
          <Ellipsis className="h-4 w-4" />
        </GlassIconButton>
      </header>
    </div>
  );
}

/* Target-match view: one large glass back button on a plain dark background —
   the frame used to tune the glass recipe against the reference image. */
function GlassButtonTarget() {
  return (
    <div {...stylex.props(storyLayout.row)} style={{ background: '#0a0a0b' }}>
      <GlassIconButton label="Back" discSize={96} className="h-28 w-28">
        <ChevronLeft className="h-10 w-10" strokeWidth={2} />
      </GlassIconButton>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileFrostedHeader',
  component: Prototype,
  parameters: { layout: 'fullscreen' },
  globals: { theme: 'dark' },
} satisfies Meta<typeof Prototype>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FrostedHeader: Story = { name: 'Frosted floating header' };
export const GlassTarget: StoryObj<typeof GlassButtonTarget> = {
  name: 'Glass button — target match',
  render: () => <GlassButtonTarget />,
};

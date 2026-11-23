import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import type { CSSProperties } from 'react';
import { ChevronLeft, Ellipsis, Github } from 'lucide-react';

import { ChatsIcon } from '@/components/icons/chats-icon';
import { GlassIconButton } from '@/components/mobile/glass-icon-button';
const frostedStory = stylex.create({
  bubbleRow: { display: 'flex', width: '100%', justifyContent: 'flex-start' },
  userRow: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '80%',
    borderRadius: 'var(--radius-2xl)',
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBlock: 'calc(var(--spacing) * 2.5)',
    fontSize: '.95rem',
    lineHeight: 'var(--leading-snug)',
    color: 'hsl(var(--foreground) / 1)',
  },
  userBubble: { backgroundColor: 'color-mix(in oklab,hsl(var(--secondary) / 1) 60%,transparent)' },
  code: {
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: '.8rem',
    color: 'color-mix(in oklab,hsl(var(--foreground) / 1) 90%,transparent)',
  },
  header: {
    position: 'absolute',
    insetInline: 0,
    top: 0,
    zIndex: 30,
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    backgroundColor: 'color-mix(in oklab,hsl(var(--background) / 1) 55%,transparent)',
    paddingInline: 'calc(var(--spacing) * 1)',
    backdropFilter: 'blur(var(--blur-xl))',
  },
  chats: { height: '1.15rem', width: '1.15rem' },
  largeButton: { height: 'calc(var(--spacing) * 28)', width: 'calc(var(--spacing) * 28)' },
});
const storyLayoutStylesStylesStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
  },
  frame2: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    'flex-shrink': '0',
  },
  frame3: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
  frame4: {
    height: 'calc(var(--spacing) * 10)',
    width: 'calc(var(--spacing) * 10)',
  },
});

const storyLayoutStylesStyles = stylex.create({
  overlay: {
    position: 'absolute',
    top: 'calc(var(--spacing) * -0.5)',
    right: 'calc(var(--spacing) * -0.5)',
    height: 'calc(var(--spacing) * 2)',
    width: 'calc(var(--spacing) * 2)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--primary))',
    'box-shadow':
      '0 0 #0000, 0 0 #0000, 0 0 #0000,  0 0 0 calc(2px + 0px) hsl(var(--background) / 1), 0 0 #0000',
  },
});

const storyLayoutStyles = stylex.create({
  stack: {
    display: 'flex',
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
    'flex-direction': 'column',
    'justify-content': 'center',
    'padding-inline': 'calc(var(--spacing) * 1)',
    'line-height': 'var(--leading-tight)',
  },
  label: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'hsl(var(--foreground) / 1)',
  },
  row: {
    display: 'flex',
    'min-width': 'calc(var(--spacing) * 0)',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

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
    <div {...stylex.props(frostedStory.bubbleRow, isUser && frostedStory.userRow)}>
      <div {...stylex.props(frostedStory.bubble, isUser && frostedStory.userBubble)}>
        {code ? <code {...stylex.props(frostedStory.code)}>{code}</code> : text}
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
      <header {...stylex.props(frostedStory.header)} style={{ height: headerHeight }}>
        <GlassIconButton label="Back">
          <ChevronLeft {...stylex.props(storyLayoutStylesStylesStyles.frame)} />
        </GlassIconButton>
        <div {...stylex.props(storyLayoutStyles.stack)}>
          <span {...stylex.props(storyLayoutStyles.label)}>Solve merge conflicts</span>
          <span {...stylex.props(storyLayoutStyles.row)}>
            <Github {...stylex.props(storyLayoutStylesStylesStyles.frame2)} />
            <span {...stylex.props(storyLayout.label)}>loro-dev/loro</span>
          </span>
        </div>
        <GlassIconButton label="Tabs">
          <ChatsIcon {...stylex.props(frostedStory.chats)} />
          <span {...stylex.props(storyLayoutStylesStyles.overlay)} />
        </GlassIconButton>
        <GlassIconButton label="More actions">
          <Ellipsis {...stylex.props(storyLayoutStylesStylesStyles.frame3)} />
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
      <GlassIconButton label="Back" discSize={96} xstyle={frostedStory.largeButton}>
        <ChevronLeft {...stylex.props(storyLayoutStylesStylesStyles.frame4)} strokeWidth={2} />
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
